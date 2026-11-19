import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { easternDate } from './treasury-period.js';
import { validDate } from './treasury.js';
import { buildCheckOrderPdf, assertCheckOrderPdfText } from './check-order-pdf.js';

const secretaries = ['secretary', 'assistant_secretary'];
const treasurers = ['treasurer', 'assistant_treasurer'];
const signingRoles = [...secretaries, ...treasurers];
const accessRoles = new Set(['owner', ...signingRoles]);
const base = '/api/check-orders';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxPdfBytes = 2 * 1024 * 1024;
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const now = () => new Date();
const digest = value => createHash('sha256').update(value).digest('hex');

const consentText = {
  owner: 'I confirm the Lodge authorized this disbursement and I issue this check order for the stated payee and amount.',
  secretary: 'I certify that I reviewed this check order, its authorization, and its supporting record for transmission to the Treasurer.',
  treasurer: 'I confirm the check was issued for the payee and exact amount on this order, and that the check number and issue date are accurate.',
};

export const mayViewCheckOrders = role => accessRoles.has(role);

export async function initCheckOrderSchema() {
  await dbRun([
    'CREATE TABLE IF NOT EXISTS check_orders (',
    '  id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),',
    '  owner_name TEXT NOT NULL, owner_signature BYTEA NOT NULL, owner_consent TEXT NOT NULL,',
    '  details_json TEXT NOT NULL, request_hash TEXT NOT NULL,',
    '  supporting_name TEXT, supporting_pdf BYTEA, requested_at TEXT NOT NULL, updated_at TEXT NOT NULL,',
    "  status TEXT NOT NULL CHECK (status IN ('awaiting_secretaries','ready_for_treasurer','payment_recorded','filed','voided')),",
    '  revision INTEGER NOT NULL DEFAULT 1, payment_json TEXT, filing_json TEXT, void_reason TEXT',
    ')',
  ].join('\n'));
  await dbRun([
    'CREATE TABLE IF NOT EXISTS check_order_assignees (',
    '  order_id TEXT NOT NULL REFERENCES check_orders(id), user_id INTEGER NOT NULL REFERENCES users(id),',
    "  role TEXT NOT NULL CHECK (role IN ('secretary','assistant_secretary','treasurer','assistant_treasurer')),",
    '  name TEXT NOT NULL, signed_at TEXT, signature_bytes BYTEA, consent_text TEXT,',
    '  PRIMARY KEY (order_id, role), UNIQUE (order_id, user_id)',
    ')',
  ].join('\n'));
  await dbRun('CREATE INDEX IF NOT EXISTS check_order_assignees_user_idx ON check_order_assignees(user_id, order_id)');
}

function printable(value, label, limit, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw failure(400, 'Enter ' + label + '.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text && required) throw failure(400, 'Enter ' + label + '.');
  if (text.length > limit) throw failure(400, label + ' must be ' + limit + ' characters or fewer.');
  return text;
}

function orderedAmount(value) {
  const match = typeof value === 'string' && /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/.exec(value.trim());
  if (!match) throw failure(400, 'Enter a dollar amount with up to two decimal places.');
  const dollars = Number(match[1]);
  const cents = (match[2] || '').padEnd(2, '0');
  if (dollars === 0 && cents === '00') throw failure(400, 'Enter an amount greater than zero.');
  return dollars + '.' + cents;
}

function requireConsent(req) {
  if (req.body?.consent !== true) throw failure(400, 'Confirm the statement before applying your saved signature.');
}

function readDate(value, label, fromDate, today, required = true) {
  if (!value && !required) return null;
  if (!validDate(value) || value < fromDate || value > today) {
    throw failure(400, label + ' must be between ' + fromDate + ' and ' + today + '.');
  }
  return value;
}

async function parseSupportingDocument(document) {
  if (document == null) return { name: null, bytes: null };
  const name = printable(document.name, 'a supporting PDF filename', 160);
  const base64 = document.base64;
  if (!/^[^/\\\x00-\x1f\x7f]+\.pdf$/i.test(name) || typeof base64 !== 'string' ||
      base64.length > Math.ceil(maxPdfBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw failure(400, 'Choose a PDF attachment no larger than 2 MB.');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxPdfBytes || bytes.toString('base64') !== base64 || bytes.subarray(0, 5).toString() !== '%PDF-') {
    throw failure(400, 'Choose a PDF attachment no larger than 2 MB.');
  }
  try { await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch { throw failure(400, 'The supporting PDF could not be opened. Choose an unlocked PDF.'); }
  return { name, bytes };
}

async function currentAccount(user) {
  // Recheck revocation and office under the same account lock used by signature saves.
  const account = await dbGet('SELECT id, name, role, access_revoked_at FROM users WHERE id = ? FOR UPDATE', [user.id]);
  if (!account || account.access_revoked_at || account.role !== user.role) {
    throw failure(403, 'Your officer access changed. Sign in again.');
  }
  return account;
}

async function assignedOfficers() {
  const active = await dbAll(
    "SELECT id, name, role FROM users WHERE access_revoked_at IS NULL AND role IN ('secretary','assistant_secretary','treasurer','assistant_treasurer')",
  );
  return signingRoles.map(role => {
    const matches = active.filter(officer => officer.role === role);
    if (matches.length !== 1) throw failure(409, 'Each Secretary and Treasurer office needs one active dashboard account before a check order can be issued.');
    return matches[0];
  });
}

const orderFields = 'id, owner_user_id, owner_name, details_json, supporting_name, requested_at, updated_at, status, revision, payment_json, filing_json, void_reason';
const assignmentFor = (officers, user) => officers.find(officer => officer.user_id === user.id && officer.role === user.role);
const ownedBy = (row, user) => user.role === 'owner' && row.owner_user_id === user.id;

function permissions(row, officers, user) {
  const assignment = assignmentFor(officers, user);
  const isSecretary = secretaries.includes(assignment?.role);
  const filing = JSON.parse(row.filing_json ?? 'null');
  return {
    certify: row.status === 'awaiting_secretaries' && isSecretary && !assignment.signed_at,
    recordPayment: row.status === 'ready_for_treasurer' && treasurers.includes(assignment?.role),
    file: isSecretary && (row.status === 'payment_recorded' || (row.status === 'filed' && !filing?.deliveredOn)),
    void: ownedBy(row, user) && ['awaiting_secretaries', 'ready_for_treasurer'].includes(row.status),
  };
}

function serialize(row, officers, user) {
  const people = roles => roles.map(role => {
    const officer = officers.find(item => item.role === role);
    return { name: officer.name, role, signedAt: officer.signed_at };
  });
  return {
    id: row.id, revision: row.revision, status: row.status,
    ...JSON.parse(row.details_json),
    requestedBy: row.owner_name, requestedAt: row.requested_at, updatedAt: row.updated_at,
    supportingDocumentName: row.supporting_name,
    secretaries: people(secretaries), treasurers: people(treasurers),
    ...JSON.parse(row.payment_json ?? '{}'), ...JSON.parse(row.filing_json ?? '{}'),
    voidReason: row.void_reason, permissions: permissions(row, officers, user),
  };
}

async function readOrder(id, user, { lock = false, signatures = false } = {}) {
  const row = await dbGet('SELECT ' + orderFields + (signatures ? ', owner_signature' : '') +
    ' FROM check_orders WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [id]);
  if (!row) throw failure(404, 'Check order not found.');
  const officers = await dbAll(
    'SELECT user_id, role, name, signed_at' + (signatures ? ', signature_bytes' : '') +
    ' FROM check_order_assignees WHERE order_id = ?', [id],
  );
  if (!ownedBy(row, user) && !assignmentFor(officers, user)) throw failure(404, 'Check order not found.');
  return { row, officers };
}

async function listOrders(user) {
  const [access, params] = user.role === 'owner'
    ? ['o.owner_user_id = ?', [user.id]]
    : ['EXISTS (SELECT 1 FROM check_order_assignees a WHERE a.order_id = o.id AND a.user_id = ? AND a.role = ?)', [user.id, user.role]];
  const rows = await dbAll('SELECT ' + orderFields + ', (SELECT json_agg(a) FROM ' +
    '(SELECT user_id, role, name, signed_at FROM check_order_assignees WHERE order_id = o.id) a) AS officers ' +
    'FROM check_orders o WHERE ' + access + ' ORDER BY o.requested_at DESC, o.id DESC', params);
  return rows.map(row => serialize(row, row.officers, user));
}

async function audit(req, id, action, extra = {}) {
  await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
    [req.user.id, action, req.ip, JSON.stringify({ checkOrderId: id, role: req.user.role, ...extra }), now().toISOString()]);
}

async function saveSignature(id, user, signature, at, statement) {
  await assertCheckOrderPdfText([user.name]);
  await dbRun(
    'UPDATE check_order_assignees SET name = ?, signed_at = ?, signature_bytes = ?, consent_text = ? WHERE order_id = ? AND user_id = ?',
    [user.name, at, signature, statement, id, user.id],
  );
}

function currentRevision(req, row) {
  if (req.body?.revision !== row.revision) throw failure(409, 'The check order changed. Reopen it before continuing.');
}

export function mountCheckOrderRoutes(app, { requireAuth, lockSavedSignature, broadcast, rateLimit }) {
  const route = handler => async (req, res, next) => {
    try {
      if (req.assistant || !mayViewCheckOrders(req.user.role)) throw failure(403, 'Check Orders is available to the Worshipful Master, Secretaries and Treasurers.');
      await handler(req, res);
    } catch (error) { next(error); }
  };
  const write = (path, handler) => app.post(base + path, requireAuth,
    rateLimit({ key: 'check-orders-write' + path, maximum: 30, windowMs: 60_000 }), route(handler));

  app.get(base, requireAuth, route(async (req, res) => res.json({ orders: await listOrders(req.user) })));

  write('', async (req, res) => {
    if (req.user.role !== 'owner') throw failure(403, 'Only the Worshipful Master can issue a check order.');
    requireConsent(req);
    const input = req.body;
    if (typeof input.clientRequestId !== 'string' || !uuidPattern.test(input.clientRequestId)) {
      throw failure(400, 'Open Check Orders again before issuing the request.');
    }
    const id = input.clientRequestId.toLowerCase();
    const details = {
      payee: printable(input.payee, 'the check payee', 160),
      amount: orderedAmount(input.amount),
      reason: printable(input.reason, 'the reason for the payment', 1200),
      authorizationReference: printable(input.authorizationReference, 'the Lodge authorization reference', 240),
      category: printable(input.category, 'the budget or account category', 150, false),
      supportingReference: printable(input.supportingReference, 'the supporting document reference', 240, false),
    };
    const supporting = await parseSupportingDocument(input.supportingDocument);
    await assertCheckOrderPdfText([details.payee, details.reason, details.authorizationReference, details.category,
      details.supportingReference, supporting.name]);
    const detailsJson = JSON.stringify(details);
    const hash = digest(JSON.stringify([detailsJson, supporting.name, supporting.bytes ? digest(supporting.bytes) : null]));
    const created = await withTransaction(async () => {
      const account = await currentAccount(req.user);
      const existing = await dbGet('SELECT owner_user_id, request_hash FROM check_orders WHERE id = ?', [id]);
      if (existing) {
        if (existing.owner_user_id !== account.id || existing.request_hash !== hash) {
          throw failure(409, 'This request was already used for a different check order. Review your recent orders.');
        }
        return false;
      }
      const officers = await assignedOfficers();
      await assertCheckOrderPdfText([account.name, ...officers.map(officer => officer.name)]);
      const signature = await lockSavedSignature(account);
      const at = now().toISOString();
      await dbRun([
        'INSERT INTO check_orders (id, owner_user_id, owner_name, owner_signature, owner_consent, details_json,',
        'request_hash, supporting_name, supporting_pdf, requested_at, updated_at, status)',
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,'awaiting_secretaries')",
      ].join(' '), [id, account.id, account.name, signature, consentText.owner, detailsJson,
        hash, supporting.name, supporting.bytes, at, at]);
      for (const officer of officers) {
        await dbRun('INSERT INTO check_order_assignees (order_id,user_id,role,name) VALUES (?,?,?,?)',
          [id, officer.id, officer.role, officer.name]);
      }
      await audit(req, id, 'check_order_issued');
      return true;
    });
    const { row, officers } = await readOrder(id, req.user);
    if (created) broadcast('check_orders_changed', {}, [row.owner_user_id, ...officers.map(officer => officer.user_id)]);
    res.status(created ? 201 : 200).json({ order: serialize(row, officers, req.user) });
  });

  const update = (action, handler) => write('/:id/' + action, async (req, res) => {
    const id = req.params.id;
    const { order, recipients } = await withTransaction(async () => {
      const { row, officers } = await readOrder(id, req.user, { lock: true });
      const user = await currentAccount(req.user);
      const available = permissions(row, officers, user);
      const mutated = await handler(req, { row, officers, user, available, id, time: now() });
      const updated = mutated === false ? { row, officers } : await readOrder(id, user);
      return {
        order: serialize(updated.row, updated.officers, user),
        recipients: mutated === false ? null : [row.owner_user_id, ...officers.map(officer => officer.user_id)],
      };
    });
    if (recipients) broadcast('check_orders_changed', {}, recipients);
    res.json({ order });
  });

  update('certify', async (req, { row, officers, user, available, id, time }) => {
    requireConsent(req);
    const assignment = assignmentFor(officers, user);
    if (!secretaries.includes(assignment?.role)) throw failure(403, 'Only the assigned Secretaries can certify this order.');
    if (assignment.signed_at) return false;
    if (!available.certify) throw failure(409, 'This check order is no longer awaiting Secretary certification.');
    // Both Secretaries may open the same original revision. A first certification
    // leaves the exact request intact, so the second can still sign that version.
    if (![1, row.revision].includes(req.body?.revision)) currentRevision(req, row);
    const signature = await lockSavedSignature(user);
    const completed = officers.some(officer => secretaries.includes(officer.role) && officer.signed_at);
    const at = time.toISOString();
    await saveSignature(id, user, signature, at, consentText.secretary);
    await dbRun('UPDATE check_orders SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      [completed ? 'ready_for_treasurer' : 'awaiting_secretaries', at, id]);
    await audit(req, id, 'check_order_secretary_certified');
    return true;
  });

  update('record-payment', async (req, { row, officers, user, available, id, time }) => {
    requireConsent(req);
    const assignment = assignmentFor(officers, user);
    if (!treasurers.includes(assignment?.role)) throw failure(403, 'Only an assigned Treasurer can record the check.');
    const prior = JSON.parse(row.payment_json ?? 'null');
    const checkNumber = printable(req.body?.checkNumber, 'the issued check number', 60);
    if (prior && assignment.signed_at && prior.checkNumber === checkNumber && prior.issuedOn === req.body?.issuedOn) return false;
    if (!available.recordPayment) throw failure(409, 'Both Secretaries must certify before one Treasurer can record the check. If a check is already recorded, review its details.');
    currentRevision(req, row);
    const certifiedAt = officers.filter(officer => secretaries.includes(officer.role)).map(officer => officer.signed_at).sort().at(-1);
    const issuedOn = readDate(req.body?.issuedOn, 'The check issue date', easternDate(new Date(certifiedAt)), easternDate(time));
    await assertCheckOrderPdfText([checkNumber]);
    const signature = await lockSavedSignature(user);
    const paidAt = time.toISOString();
    const payment = { checkNumber, issuedOn, paidBy: user.name, paidAt };
    await saveSignature(id, user, signature, paidAt, consentText.treasurer);
    await dbRun("UPDATE check_orders SET status = 'payment_recorded', payment_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      [JSON.stringify(payment), paidAt, id]);
    await audit(req, id, 'check_order_payment_recorded');
    return true;
  });

  update('file', async (req, { row, officers, user, available, id, time }) => {
    const assignment = assignmentFor(officers, user);
    if (!secretaries.includes(assignment?.role)) throw failure(403, 'Only an assigned Secretary can file this check order.');
    if (!available.file) throw failure(409, 'A Treasurer must record the check before it can be filed. Review the order for any filing already recorded.');
    currentRevision(req, row);
    const prior = JSON.parse(row.filing_json ?? 'null');
    const { issuedOn } = JSON.parse(row.payment_json);
    const ledgerReference = printable(req.body?.ledgerReference, 'the ledger reference', 120);
    const deliveredOn = readDate(req.body?.deliveredOn, 'The delivery date', issuedOn, easternDate(time), Boolean(prior));
    const filingNotes = printable(req.body?.filingNotes, 'the filing notes', 600, false);
    if (prior && (ledgerReference !== prior.ledgerReference || filingNotes !== prior.filingNotes)) {
      throw failure(409, 'Keep the original filing details when recording the delivery date.');
    }
    await assertCheckOrderPdfText([ledgerReference, filingNotes, user.name]);
    const at = time.toISOString();
    const filing = prior
      ? { ...prior, deliveredOn, deliveryRecordedBy: user.name, deliveryRecordedAt: at }
      : { ledgerReference, deliveredOn, filingNotes, filedBy: user.name, filedAt: at };
    await dbRun("UPDATE check_orders SET status = 'filed', filing_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      [JSON.stringify(filing), at, id]);
    await audit(req, id, prior ? 'check_order_delivery_recorded' : 'check_order_filed');
    return true;
  });

  update('void', async (req, { row, available, id, time }) => {
    if (req.user.role !== 'owner') throw failure(403, 'Only the Worshipful Master can void an open order.');
    if (!available.void) throw failure(409, 'Only an open order without a recorded check can be voided.');
    currentRevision(req, row);
    const reason = printable(req.body?.reason, 'the reason for voiding', 600);
    await assertCheckOrderPdfText([reason]);
    await dbRun("UPDATE check_orders SET status = 'voided', void_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      [reason, time.toISOString(), id]);
    await audit(req, id, 'check_order_voided');
    return true;
  });

  app.get(base + '/:id/pdf', requireAuth, route(async (req, res) => {
    const record = await withTransaction(() => readOrder(req.params.id, req.user, { lock: true, signatures: true }));
    const { row, officers } = record;
    const order = serialize(row, officers, req.user);
    const contents = await buildCheckOrderPdf(order, row.owner_signature, officers);
    res.attachment('Check-Order-' + order.id + '.pdf').type('application/pdf').send(Buffer.from(contents));
  }));

  app.get(base + '/:id/supporting-document', requireAuth, route(async (req, res) => {
    const { row } = await readOrder(req.params.id, req.user);
    if (!row.supporting_name) throw failure(404, 'This check order has no supporting PDF.');
    const file = await dbGet('SELECT supporting_pdf FROM check_orders WHERE id = ?', [row.id]);
    res.attachment(row.supporting_name).type('application/pdf').send(Buffer.from(file.supporting_pdf));
  }));
}
