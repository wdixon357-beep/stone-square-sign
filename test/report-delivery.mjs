import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

assert.equal(process.env.DATABASE_URL || '', '', 'Never use a configured database for delivery tests.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Never reuse a local database for delivery tests.');
process.env.DATABASE_URL = ''; process.env.PGLITE_DIR = ''; process.env.NODE_ENV = 'test';
const { connect, initSchema, dbGet, dbAll, dbRun, withTransaction, close } = await import('../db.js');
const { initReportDeliverySchema, createReportDelivery, mountReportDelivery, reportDeliveryEnvelope } = await import('../report-delivery.js');
const { mountOfficerReportRoutes } = await import('../officer-report-routes.js');
const secret = 'Isolated-server-to-server-secret-not-a-live-credential';
const recipient = 'synthetic-wm@example.test';
const timestamp = new Date('2026-10-19T18:00:00Z');
const now = () => new Date(timestamp);
let listener, checks = 0, calls = [], mode = 'sent', gate, release;
const check = (label, condition) => { assert.ok(condition, label); checks += 1; console.log('PASS ' + label); };
const mail = async message => {
  calls.push(message);
  if (mode === 'hold') await gate;
  if (mode === 'uncertain') throw Object.assign(new Error('Private SMTP connection detail must not leak'), { code: 'ETIMEDOUT' });
  if (mode === 'rejected') throw Object.assign(new Error('Private authentication detail must not leak'), { code: 'EAUTH' });
  return mode !== 'unconfigured';
};
const assertion = (actor, patch = {}) => {
  const issuedAt = Math.floor(timestamp.valueOf() / 1000);
  const encoded = Buffer.from(JSON.stringify({ aud: 'stone-square-report-generator', email: actor.email, name: actor.name,
    role: actor.role, permissions: ['reports.create'], issuedAt, expiresAt: issuedAt + 300, ...patch })).toString('base64url');
  return encoded + '.' + crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
};
const body = (actor, patch = {}) => ({ assertion: assertion(actor), clientId: crypto.randomUUID(), deliveryIntent: crypto.randomUUID(),
  type: 'formal', fields: { title: 'Synthetic report', details: 'Only isolated fictional details.' }, phone: '', title: 'Synthetic report',
  filename: 'Synthetic_Report.pdf', pages: 1, pdf: Buffer.from('%PDF-1.7\nSynthetic immutable first artifact\n%%EOF').toString('base64'), ...patch });
const env = data => reportDeliveryEnvelope(data, secret, Math.floor(timestamp.valueOf() / 1000));
const expectError = async (label, callback, status) => {
  await assert.rejects(callback, error => error.statusCode === status); check(label, true);
};
const count = async table => Number((await dbGet('SELECT COUNT(*) AS n FROM ' + table)).n);
await connect();
try {
  await initSchema(); await initReportDeliverySchema(); await initReportDeliverySchema();
  const users = [];
  for (const [name, role] of [['Synthetic Assistant Treasurer', 'assistant_treasurer'], ['Synthetic Secretary', 'secretary'], ['Synthetic Owner', 'owner']]) {
    const email = name.toLowerCase().replaceAll(' ', '-') + '@example.test';
    await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)', [email, 'unused-synthetic-password', name, role, timestamp.toISOString()]);
    users.push(await dbGet('SELECT * FROM users WHERE email=?', [email]));
  }
  const [actor, secretary] = users;
  const service = createReportDelivery({ secret, recipient, sendEmail: mail, now });
  const app = express(); app.use(express.json({ limit: '4mb' }));
  mountReportDelivery(app, { secret, recipient, sendEmail: mail, now });
  mountOfficerReportRoutes(app, { requireAuth: async (req, res, next) => {
    req.user = await dbGet('SELECT * FROM users WHERE id=?', [Number(req.get('x-synthetic-user'))]);
    if (!req.user) return res.sendStatus(401); next();
  }, requireOwner: (req, res, next) => req.user.role === 'owner' ? next() : res.sendStatus(403) });
  // Match the real application's generic handler, which intentionally strips
  // machine codes. The delivery route must preserve only its own safe contract.
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Request failed.' }));
  listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = 'http://127.0.0.1:' + listener.address().port;
  const api = async (envelope, path = '/api/officer-reports/deliver', extra = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(envelope) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const original = body(actor);
  const sent = await api(env(original));
  check('Authenticated final report is retained and delivered through the actual HTTP route', sent.status === 200 && sent.data.mailed && sent.data.delivery === 'sent' && calls.length === 1);
  check('Response has stable native/web RPT receipt, exact PDF and private cache policy', /^RPT-[A-F0-9-]+$/.test(sent.data.id) && sent.data.pdf === original.pdf && sent.headers.get('cache-control') === 'private, no-store');
  const stored = await dbGet('SELECT * FROM officer_reports WHERE external_id=?', [sent.data.id]);
  check('Archive identity comes from active Dashboard account and delivery uses fixed recipient', stored.prepared_by_user_id === actor.id && stored.prepared_by_name === actor.name && stored.emailed && calls[0].to === recipient && calls[0].attachment.content.toString('base64') === original.pdf);
  const rerendered = { ...original, pdf: Buffer.from('%PDF-1.7\nDifferent render metadata only\n%%EOF').toString('base64'), pages: 2, filename: 'Metadata_Difference.pdf' };
  const repeat = await api(env(rerendered));
  check('Repeated request returns first immutable PDF/filename/pages without SMTP', repeat.status === 200 && repeat.data.repeat && repeat.data.id === sent.data.id && repeat.data.pdf === original.pdf && repeat.data.pages === 1 && repeat.data.filename === original.filename && calls.length === 1);
  const archiveRepeat = await api({ externalId: sent.data.id, clientId: original.clientId, type: original.type, title: original.title,
    filename: original.filename, pdf: original.pdf, emailed: true }, '/api/officer-reports', { 'x-synthetic-user': String(actor.id) });
  check('Existing native/web archive follow-up is idempotent with server-created archive', archiveRepeat.status === 200 && archiveRepeat.data.duplicate && await count('officer_reports') === 1);
  const changed = await api(env({ ...original, fields: { ...original.fields, details: 'Changed final content.' } }));
  check('Same final-send intent with changed content conflicts without extra email', changed.status === 409 && changed.data.code === 'REPORT_DELIVERY_INTENT_CONFLICT' && calls.length === 1);
  const other = body(secretary, { clientId: original.clientId, deliveryIntent: original.deliveryIntent });
  await service.deliver(env(other));
  check('Same client reference in another account is isolated by current actor', calls.length === 2 && await count('officer_reports') === 2);
  const tampered = env(body(actor)); tampered.payload = tampered.payload.slice(0, -1) + (tampered.payload.endsWith('A') ? 'B' : 'A');
  check('Payload tampering fails before writes or mail', (await api(tampered)).status === 401 && calls.length === 2);
  for (const [label, envelope] of [
    ['Missing server authentication', { ...env(body(actor)), signature: '' }],
    ['Wrong server key', reportDeliveryEnvelope(body(actor), 'wrong-key', Math.floor(timestamp.valueOf() / 1000))],
    ['Expired server envelope', reportDeliveryEnvelope(body(actor), secret, Math.floor(timestamp.valueOf() / 1000) - 301)],
    ['Future server envelope', reportDeliveryEnvelope(body(actor), secret, Math.floor(timestamp.valueOf() / 1000) + 31)],
    ['Expired actor assertion', env(body(actor, { assertion: assertion(actor, { expiresAt: Math.floor(timestamp.valueOf() / 1000) }) }))],
    ['Wrong actor audience', env(body(actor, { assertion: assertion(actor, { aud: 'candidate-tracker' }) }))],
    ['Client-visible assertion alone is insufficient', { payload: body(actor).assertion }],
  ]) check(label + ' is rejected', (await api(envelope)).status === 401);
  const domainMismatch = env(body(actor)); domainMismatch.signature = crypto.createHmac('sha256', secret).update(domainMismatch.payload).digest('base64url');
  check('Another HMAC protocol cannot authorize delivery', (await api(domainMismatch)).status === 401);
  for (const [label, patch] of [['Recipient injection', { to: 'unapproved@example.test' }], ['Malformed PDF', { pdf: Buffer.from('Not PDF').toString('base64') }],
    ['Invalid fields', { fields: { details: { nested: 'not allowed' } } }], ['Path filename', { filename: '../escape.pdf' }], ['Invalid intent', { deliveryIntent: 'not-a-valid-new-intent' }]]) {
    check(label + ' fails strict validation', (await api(env(body(actor, patch)))).status === 400);
  }
  await dbRun('UPDATE users SET access_revoked_at=? WHERE id=?', [timestamp.toISOString(), actor.id]);
  check('Revoked account cannot retrieve a sent duplicate', (await api(env(original))).status === 403);
  await dbRun('UPDATE users SET access_revoked_at=NULL, permissions_json=? WHERE id=?', [JSON.stringify([]), actor.id]);
  check('Removed report permission overrides prior assertion', (await api(env(body(actor)))).status === 403);
  await dbRun('UPDATE users SET permissions_json=NULL,role=? WHERE id=?', ['viewer', actor.id]);
  check('Changed account role overrides assertion', (await api(env(body(actor)))).status === 403);
  await dbRun('UPDATE users SET role=? WHERE id=?', [actor.role, actor.id]);
  const legacyNoRecord = await api(env(body(actor, { deliveryIntent: '' })));
  check('Unverified old in-progress draft fails closed with explicit new-report guidance', legacyNoRecord.status === 409 && legacyNoRecord.data.code === 'REPORT_DELIVERY_LEGACY_UNVERIFIED' && legacyNoRecord.data.error.includes('Start over'));
  const legacy = body(actor, { deliveryIntent: '' });
  await api({ externalId: 'RPT-LEGACY-SYNTHETIC', clientId: legacy.clientId, type: legacy.type, title: legacy.title, filename: legacy.filename, pdf: legacy.pdf, emailed: true }, '/api/officer-reports', { 'x-synthetic-user': String(actor.id) });
  const beforeLegacy = calls.length, prior = await service.deliver(env(legacy));
  check('Archived emailed legacy report is returned without another send', prior.id === 'RPT-LEGACY-SYNTHETIC' && prior.mailed && calls.length === beforeLegacy);
  await dbRun('UPDATE officer_reports SET emailed=FALSE WHERE external_id=?', ['RPT-LEGACY-SYNTHETIC']);
  check('Unconfirmed legacy archive remains pending and never resends', (await service.deliver(env(legacy))).delivery === 'pending' && calls.length === beforeLegacy);
  await expectError('Legacy changed content cannot silently create a new send', () => service.deliver(env({ ...legacy, deliveryIntent: crypto.randomUUID() })), 409);
  const concurrent = body(actor); mode = 'hold'; gate = new Promise(resolve => { release = resolve; });
  const first = service.deliver(env(concurrent));
  while (calls.length === beforeLegacy) await new Promise(resolve => setTimeout(resolve, 5));
  const pending = await service.deliver(env(concurrent));
  check('Simultaneous duplicate sees durable pending receipt while first SMTP is held', pending.delivery === 'pending' && pending.repeat && calls.length === beforeLegacy + 1);
  release(); await first; mode = 'sent';
  const uncertain = body(actor); mode = 'uncertain'; const beforeUncertain = calls.length;
  const ambiguous = await service.deliver(env(uncertain));
  mode = 'sent'; const ambiguousRepeat = await service.deliver(env(uncertain));
  check('Unknown SMTP outcome stays reserved across retries without duplicate email', ambiguous.delivery === 'pending' && ambiguousRepeat.delivery === 'pending' && calls.length === beforeUncertain + 1);
  const retryable = body(actor); mode = 'rejected'; const refused = await service.deliver(env(retryable));
  const beforeMissingIntent = calls.length;
  await service.deliver(env({ ...retryable, deliveryIntent: '' }));
  await service.deliver(env({ ...retryable, deliveryIntent: crypto.randomUUID() }));
  check('A missing or changed intent can retrieve but never retry a failed reservation', calls.length === beforeMissingIntent);
  mode = 'sent'; const retried = await service.deliver(env(retryable));
  check('A definite SMTP refusal allows a deliberate retry of the same retained artifact', refused.delivery === 'failed' && retried.mailed && retried.id === refused.id && retried.pdf === refused.pdf);
  const committedButLost = body(actor); let transactionCalls = 0;
  const ambiguousCommitService = createReportDelivery({ secret, recipient, sendEmail: mail, now, transaction: async callback => {
    const result = await withTransaction(callback); transactionCalls += 1;
    if (transactionCalls === 1) throw new Error('Synthetic COMMIT acknowledgment lost after real durable commit'); return result;
  } });
  const beforeCommit = calls.length;
  await assert.rejects(() => ambiguousCommitService.deliver(env(committedButLost)));
  const commitRepeat = await service.deliver(env(committedButLost));
  check('Ambiguous reservation COMMIT never starts SMTP and retry remains pending', calls.length === beforeCommit && commitRepeat.delivery === 'pending');
  let finishCalls = 0;
  const lostResultService = createReportDelivery({ secret, recipient, sendEmail: mail, now, transaction: callback => {
    finishCalls += 1; if (finishCalls === 2) throw new Error('Synthetic delivery state persistence unavailable'); return withTransaction(callback);
  } });
  const lostResult = body(actor), beforeLost = calls.length;
  const lostReceipt = await lostResultService.deliver(env(lostResult));
  const lostRepeat = await service.deliver(env(lostResult));
  check('SMTP acceptance followed by persistence failure cannot reopen email delivery', lostReceipt.delivery === 'pending' && lostRepeat.delivery === 'pending' && calls.length === beforeLost + 1);
  const beforeRollback = await count('officer_reports');
  const rollbackService = createReportDelivery({ secret, recipient, sendEmail: mail, now, transaction: callback => withTransaction(async () => { await callback(); throw Error('Synthetic forced rollback'); }) });
  await assert.rejects(() => rollbackService.deliver(env(body(actor))));
  check('Failed reservation transaction rolls back archive and audit before any SMTP', await count('officer_reports') === beforeRollback && calls.length === beforeLost + 1);
  await expectError('Missing shared secret is not a public delivery fallback', () => createReportDelivery({ secret: '', recipient, sendEmail: mail, now }).deliver(env(body(actor))), 503);
  await expectError('Missing fixed recipient never trusts form-provided contact', () => createReportDelivery({ secret, recipient: '', sendEmail: mail, now }).deliver(env(body(actor))), 503);
  const events = await dbAll("SELECT details_json FROM audit_events WHERE action LIKE 'officer_report_delivery_%'");
  check('Delivery audit is durable and excludes original content and transport secrets', events.length > 3 && !JSON.stringify(events).includes('Only isolated fictional') && !JSON.stringify(events).includes('Private SMTP'));
  const attempts = Number((await dbGet("SELECT COUNT(*) AS n FROM audit_events WHERE user_id=? AND action='officer_report_delivery_reserved'", [actor.id])).n);
  for (let index = attempts; index < 20; index += 1) await dbRun('INSERT INTO audit_events(user_id,action,details_json,created_at) VALUES(?,?,?,?)', [actor.id, 'officer_report_delivery_reserved', '{}', timestamp.toISOString()]);
  const beforeLimit = calls.length;
  await expectError('Durable per-actor send limit works without KV', () => service.deliver(env(body(actor))), 429);
  check('Rate limit never blocks retrieving a previously sent receipt', (await service.deliver(env(original))).mailed && calls.length === beforeLimit);
  console.log(`${checks} isolated report delivery checks passed. No external mail, provider call or live database used.`);
} finally { if (listener) await new Promise(resolve => listener.close(resolve)); await close(); }
