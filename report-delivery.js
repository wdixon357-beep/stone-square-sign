import crypto from 'node:crypto';
import { dbGet, dbRun, withTransaction } from './db.js';
import { hasPermission } from './access-control.js';

export const REPORT_DELIVERY_DOMAIN = 'stone-square-report-delivery-v1';
const MAX_PDF = 2 * 1024 * 1024;
const fail = (statusCode, message, code = 'REPORT_DELIVERY_INVALID') => Object.assign(new Error(message), { statusCode, code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const office = role => ({ owner: 'Worshipful Master', secretary: 'Secretary', assistant_secretary: 'Assistant Secretary',
  treasurer: 'Treasurer', assistant_treasurer: 'Assistant Treasurer', treasury_preparer: 'Treasury Report Preparer',
  warden: 'Warden', officer: 'Lodge Officer', member: 'Lodge Member' }[role] || 'Lodge Officer');
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000]/.test(value) ? value : null;
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
function decoded(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}
export function reportDeliveryEnvelope(payload, secret, issuedAt = Math.floor(Date.now() / 1000)) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { issuedAt, payload: encoded, signature: crypto.createHmac('sha256', secret)
    .update(`${REPORT_DELIVERY_DOMAIN}\n${issuedAt}\n${encoded}`).digest('base64url') };
}
function authenticatedPayload(envelope, secret, now) {
  if (!secret) throw fail(503, 'Report delivery is not configured.', 'REPORT_DELIVERY_UNAVAILABLE');
  const issuedAt = envelope?.issuedAt;
  if (!Number.isInteger(issuedAt) || issuedAt > now + 30 || issuedAt < now - 300) throw fail(401, 'The report delivery request expired. Refresh the Report Generator.');
  const encoded = decoded(envelope?.payload, 4 * 1024 * 1024);
  const supplied = decoded(envelope?.signature, 100);
  const expected = crypto.createHmac('sha256', secret).update(`${REPORT_DELIVERY_DOMAIN}\n${issuedAt}\n${envelope?.payload}`).digest();
  if (!encoded || !supplied || !equal(supplied, expected)) throw fail(401, 'The report delivery request could not be verified.');
  let body;
  try { body = JSON.parse(encoded.toString('utf8')); } catch { throw fail(400, 'The report delivery request is invalid.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key =>
    !['assertion', 'clientId', 'type', 'fields', 'phone', 'title', 'filename', 'pdf', 'pages', 'deliveryIntent'].includes(key))) throw fail(400, 'The report delivery fields are invalid.');
  const assertion = String(body.assertion || '').split('.');
  const claims = decoded(assertion[0], 8192), mac = decoded(assertion[1], 100);
  const assertionMac = crypto.createHmac('sha256', secret).update(assertion[0] || '').digest();
  if (assertion.length !== 2 || !claims || !mac || !equal(mac, assertionMac)) throw fail(401, 'Your Dashboard sign-in could not be verified.');
  let actor;
  try { actor = JSON.parse(claims.toString('utf8')); } catch { throw fail(401, 'Your Dashboard sign-in could not be verified.'); }
  if (actor?.aud !== 'stone-square-report-generator' || !Number.isInteger(actor.issuedAt) || !Number.isInteger(actor.expiresAt)
    || actor.issuedAt > now + 30 || actor.expiresAt <= now || actor.expiresAt <= actor.issuedAt || actor.expiresAt - actor.issuedAt > 300
    || typeof actor.email !== 'string' || typeof actor.name !== 'string' || typeof actor.role !== 'string'
    || !Array.isArray(actor.permissions) || !actor.permissions.includes('reports.create')) throw fail(401, 'Your Report Generator sign-in expired. Sign in again.');
  if (!/^[a-z0-9-]{8,64}$/i.test(body.clientId || '') || !/^[a-z][a-z0-9_-]{0,39}$/i.test(body.type || '')
    || !text(body.title, 240)?.trim() || !text(body.filename, 240)?.toLowerCase().endsWith('.pdf') || /[\r\n"\\/]/.test(body.filename)
    || !text(body.phone, 80) && body.phone !== '' || !Number.isInteger(body.pages) || body.pages < 1 || body.pages > 100
    || !body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields) || Object.keys(body.fields).length > 60) throw fail(400, 'The completed report details are invalid.');
  const fields = {};
  for (const key of Object.keys(body.fields).sort()) {
    if (!/^[a-zA-Z]{1,20}$/.test(key) || text(body.fields[key], 20000) === null) throw fail(400, 'The report content is invalid.');
    fields[key] = body.fields[key];
  }
  if (JSON.stringify(fields).length > 150000) throw fail(400, 'The report content is too large.');
  if (typeof body.pdf !== 'string' || body.pdf.length > Math.ceil(MAX_PDF * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.pdf)) throw fail(400, 'The report PDF is invalid.');
  const pdf = Buffer.from(body.pdf, 'base64');
  if (!pdf.length || pdf.length > MAX_PDF || pdf.toString('base64') !== body.pdf || pdf.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'The report PDF is invalid.');
  const intent = body.deliveryIntent || '';
  if (intent && !uuid(intent)) throw fail(400, 'The final report delivery reference is invalid.');
  return { body: { ...body, fields, deliveryIntent: intent }, actor, pdf };
}

export async function initReportDeliverySchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS officer_report_deliveries (
    id TEXT PRIMARY KEY, actor_user_id INTEGER NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
    delivery_intent TEXT NOT NULL, logical_sha256 TEXT NOT NULL, logical_json TEXT NOT NULL,
    report_id TEXT NOT NULL REFERENCES officer_reports(id), pdf_sha256 TEXT NOT NULL, pages INTEGER NOT NULL,
    recipient TEXT NOT NULL, subject TEXT NOT NULL, message_text TEXT NOT NULL, message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('sending','sent','failed','uncertain')), attempt_token TEXT,
    created_at TEXT NOT NULL, attempted_at TEXT NOT NULL, sent_at TEXT, updated_at TEXT NOT NULL,
    UNIQUE(actor_user_id,client_id,logical_sha256), UNIQUE(actor_user_id,delivery_intent)
  )`);
}

export function createReportDelivery({ secret, recipient, sendEmail, transaction = withTransaction, now = () => new Date() }) {
  const audit = (userId, action, details, timestamp) => dbRun(`INSERT INTO audit_events
    (user_id,action,details_json,created_at) VALUES (?,?,?,?)`, [userId, action, JSON.stringify(details), timestamp]);
  async function reserveRate(userId, time) {
    const cutoff = new Date(time.valueOf() - 60 * 60 * 1000).toISOString();
    const attempts = await dbGet("SELECT COUNT(*) AS count FROM audit_events WHERE user_id=? AND action='officer_report_delivery_reserved' AND created_at>=?", [userId, cutoff]);
    if (Number(attempts.count) >= 20) throw fail(429, 'Too many final reports were sent from this account. Please try again later.', 'REPORT_DELIVERY_RATE_LIMITED');
  }
  async function receipt(row, repeat = true) {
    const report = await dbGet('SELECT * FROM officer_reports WHERE id=?', [row.report_id]);
    if (!report || hash(Buffer.from(report.pdf_bytes)) !== row.pdf_sha256) throw fail(409, 'The retained report copy could not be verified. Ask the Worshipful Master to review the record.');
    return { ok: true, id: row.id, mailed: row.state === 'sent', delivery: ['sending', 'uncertain'].includes(row.state) ? 'pending' : row.state,
      pages: row.pages, filename: report.filename, pdf: Buffer.from(report.pdf_bytes).toString('base64'), repeat };
  }
  async function deliver(envelope) {
    const time = now();
    const { body, actor, pdf } = authenticatedPayload(envelope, secret, Math.floor(time.valueOf() / 1000));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient || '')) throw fail(503, 'Report email delivery is not configured.', 'REPORT_DELIVERY_UNAVAILABLE');
    const claimed = await transaction(async () => {
      // The user lock also serializes distinct first reservations, including
      // legacy client IDs. Assertions never override current revoked access.
      const user = await dbGet('SELECT * FROM users WHERE lower(email)=? FOR UPDATE', [actor.email.trim().toLowerCase()]);
      if (!user || user.access_revoked_at || !hasPermission(user, 'reports.create') || user.role !== actor.role
        || user.name !== actor.name) throw fail(403, 'Report Generator access is no longer enabled for this account.');
      const logical = JSON.stringify({ clientId: body.clientId, type: body.type, fields: body.fields, phone: body.phone,
        title: body.title, actor: { id: user.id, name: user.name, email: user.email, role: user.role } });
      const logicalHash = hash(logical);
      let existing = await dbGet('SELECT * FROM officer_report_deliveries WHERE actor_user_id=? AND client_id=? AND logical_sha256=? FOR UPDATE', [user.id, body.clientId, logicalHash]);
      if (existing) {
        if (existing.logical_json !== logical) throw fail(409, 'The report delivery reference conflicts with another report.');
        if (existing.state !== 'failed') return { row: existing, send: false };
        if (!body.deliveryIntent || body.deliveryIntent !== existing.delivery_intent) return { row: existing, send: false };
        await reserveRate(user.id, time);
        const attempt = crypto.randomUUID(), stamp = time.toISOString();
        await dbRun("UPDATE officer_report_deliveries SET state='sending',attempt_token=?,attempted_at=?,updated_at=? WHERE id=?", [attempt, stamp, stamp, existing.id]);
        await audit(user.id, 'officer_report_delivery_reserved', { reportId: existing.report_id, externalId: existing.id, retryAfterRefusal: true }, stamp);
        return { row: { ...existing, state: 'sending', attempt_token: attempt }, send: true };
      }
      const intentUsed = body.deliveryIntent && await dbGet('SELECT id FROM officer_report_deliveries WHERE actor_user_id=? AND delivery_intent=?', [user.id, body.deliveryIntent]);
      if (intentUsed) throw fail(409, 'This final report was changed. Start a new report before sending the revision.', 'REPORT_DELIVERY_INTENT_CONFLICT');
      const legacy = await dbGet('SELECT * FROM officer_reports WHERE prepared_by_user_id=? AND client_id=? ORDER BY received_at ASC LIMIT 1', [user.id, body.clientId]);
      if (legacy) {
        if (body.deliveryIntent || legacy.report_type !== body.type || legacy.title !== body.title) throw fail(409, 'A previous report uses this draft reference. Start a new report for changed information.', 'REPORT_DELIVERY_LEGACY_UNVERIFIED');
        return { legacy };
      }
      if (!body.deliveryIntent) throw fail(409, 'This older draft has no verified delivery reference. Save your notes, then select Start over and create a new report before sending.', 'REPORT_DELIVERY_LEGACY_UNVERIFIED');
      await reserveRate(user.id, time);
      const id = `RPT-${crypto.randomUUID().toUpperCase()}`;
      const reportId = `officer-report-${hash(id).slice(0, 24)}`;
      const stamp = time.toISOString(), attempt = crypto.randomUUID();
      const subject = `${body.title} | Stone Square Lodge No. 22`;
      const message = `A reviewed final report from ${user.name}, ${office(user.role)}, is attached.\n\nTitle: ${body.title}\nReport contact: ${user.email}\nReference: ${id}\n\nThis copy does not record Lodge approval.`;
      await dbRun(`INSERT INTO officer_reports
        (id,external_id,client_id,report_type,title,filename,pdf_bytes,prepared_by_user_id,prepared_by_name,prepared_by_office,prepared_by_email,emailed,source_label,submitted_at,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,FALSE,'Lodge Report Generator',?,?)`,
      [reportId, id, body.clientId, body.type, body.title, body.filename, pdf, user.id, user.name, office(user.role), user.email, stamp, stamp]);
      await dbRun(`INSERT INTO officer_report_deliveries
        (id,actor_user_id,client_id,delivery_intent,logical_sha256,logical_json,report_id,pdf_sha256,pages,recipient,subject,message_text,message_id,state,attempt_token,created_at,attempted_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'sending',?,?,?,?)`,
      [id, user.id, body.clientId, body.deliveryIntent, logicalHash, logical, reportId, hash(pdf), body.pages, recipient, subject, message,
        `<${id.toLowerCase()}@stonesquare22pha.org>`, attempt, stamp, stamp, stamp]);
      await audit(user.id, 'officer_report_received', { reportId, externalId: id, deliveryReserved: true }, stamp);
      await audit(user.id, 'officer_report_delivery_reserved', { reportId, externalId: id, pdfSha256: hash(pdf) }, stamp);
      return { row: await dbGet('SELECT * FROM officer_report_deliveries WHERE id=?', [id]), send: true };
    });
    // No SMTP is attempted until the reservation, immutable archive and audit
    // transaction has definitely committed. A COMMIT error is never replayed.
    if (claimed.legacy) return { ok: true, id: claimed.legacy.external_id, mailed: Boolean(claimed.legacy.emailed),
      delivery: claimed.legacy.emailed ? 'sent' : 'pending', pages: body.pages, filename: claimed.legacy.filename,
      pdf: Buffer.from(claimed.legacy.pdf_bytes).toString('base64'), repeat: true };
    if (!claimed.send) return receipt(claimed.row);
    const row = claimed.row, retained = await receipt(row, false);
    let state = 'uncertain';
    try {
      const sent = await sendEmail({ to: row.recipient, subject: row.subject, text: row.message_text, messageId: row.message_id,
        attachment: { filename: retained.filename, content: Buffer.from(retained.pdf, 'base64') } });
      state = sent === true ? 'sent' : 'failed';
    } catch (cause) {
      // Only a definite SMTP refusal is retryable. An unknown transport result
      // remains reserved even if the response or persistence is lost.
      state = ['EAUTH', 'EENVELOPE'].includes(cause?.code) || Number(cause?.responseCode) >= 400 ? 'failed' : 'uncertain';
    }
    try {
      await transaction(async () => {
        const current = await dbGet('SELECT * FROM officer_report_deliveries WHERE id=? FOR UPDATE', [row.id]);
        if (!current || current.state !== 'sending' || current.attempt_token !== row.attempt_token) throw fail(409, 'The report delivery state changed.');
        const stamp = now().toISOString();
        await dbRun('UPDATE officer_report_deliveries SET state=?,attempt_token=NULL,sent_at=?,updated_at=? WHERE id=?', [state, state === 'sent' ? stamp : null, stamp, row.id]);
        if (state === 'sent') await dbRun('UPDATE officer_reports SET emailed=TRUE WHERE id=?', [row.report_id]);
        await audit(row.actor_user_id, 'officer_report_delivery_' + state, { reportId: row.report_id, externalId: row.id, messageId: row.message_id }, stamp);
      });
    } catch {
      // SMTP may have accepted the message. Keep the durable reservation and
      // return its pending receipt; never invite a second automatic send.
      return { ...retained, mailed: false, delivery: 'pending' };
    }
    return { ...retained, mailed: state === 'sent', delivery: state === 'uncertain' ? 'pending' : state };
  }
  return { deliver };
}

export function mountReportDelivery(app, options) {
  const service = createReportDelivery(options);
  app.post('/api/officer-reports/deliver', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await service.deliver(req.body));
    } catch (error) {
      const safeCodes = new Set(['REPORT_DELIVERY_INVALID', 'REPORT_DELIVERY_UNAVAILABLE',
        'REPORT_DELIVERY_LEGACY_UNVERIFIED', 'REPORT_DELIVERY_INTENT_CONFLICT', 'REPORT_DELIVERY_RATE_LIMITED']);
      if (safeCodes.has(error.code) && [400, 401, 403, 409, 429, 503].includes(error.statusCode)) {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      next(error);
    }
  });
}
