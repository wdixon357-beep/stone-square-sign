import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { connect, initSchema, dbRun, dbGet, close } from '../db.js';
import { createDispensationSubmissions, initDispensationSubmissionSchema } from '../dispensation-submissions.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Use only an isolated in-memory database.');
await connect(); await initSchema(); await initDispensationSubmissionSchema();
const timestamp = new Date().toISOString();
await dbRun('INSERT INTO users(email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ['owner@example.org', 'unused', 'Fixture Owner', 'owner', timestamp]);
const owner = await dbGet('SELECT * FROM users WHERE email = ?', ['owner@example.org']);
const pdf = await PDFDocument.create(); pdf.addPage();
const bytes = Buffer.from(await pdf.save());
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
let sends = 0;
const audits = [];
const service = createDispensationSubmissions({
  sendEmail: async () => { sends++; throw new Error('Sending is prohibited in this test.'); },
  addAudit: async event => audits.push(event), recipient: { to: 'deputy@example.org' }, lodgeName: 'Fixture Lodge',
});
async function document(id, status = 'completed', submittedAt = null) {
  await dbRun(`INSERT INTO documents(id, title, original_name, stored_name, owner_user_id, file_bytes,
    signed_bytes, template_kind, status, submitted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, 'Fixture event', 'fixture.pdf', 'fixture.pdf', owner.id, bytes, status === 'completed' ? bytes : null,
    'dispensation_v1', status, submittedAt, timestamp, timestamp]);
}
const app = express(); app.use(express.json());
service.mount(app, {
  requireAuth: (req, res, next) => { if (!req.headers['x-fixture-user']) return res.sendStatus(401); req.user = owner; next(); },
  requireOwner: (req, res, next) => req.headers['x-fixture-user'] === 'owner' ? next() : res.sendStatus(403),
  upload: multer({ storage: multer.memoryStorage() }), broadcast: () => {}, rateLimit: () => (req, res, next) => next(),
});
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (suffix, options = {}) => fetch(`${base}/api/documents/completed/${suffix}`, {
  ...options, headers: { 'x-fixture-user': 'owner', ...options.headers },
});
try {
  assert.equal(service.automaticDeliveryEnabled, false);
  await document('completed'); await document('pending', 'pending'); await document('historical', 'completed', timestamp);
  assert.equal((await service.packet('pending', owner)).state, 'disabled');
  const attached = await service.attachReport('completed', owner,
    { buffer: bytes, originalname: 'event-report.pdf' }, 'Fixture archive', { actorUserId: owner.id });
  assert.equal(attached.state, 'disabled'); assert.equal(attached.draft, null);
  assert.equal(attached.automaticDeliveryEnabled, false); assert.equal(attached.report.sha256, digest);
  assert.match(attached.message, /turned off/);
  await assert.rejects(service.packet('completed', { ...owner, id: owner.id + 1 }), /Only the document owner/);
  // Simulate a packet queued before sending was disconnected. Never drain it,
  // mutate its previous evidence, or authorize a retry on process startup.
  const oldDraft = JSON.stringify({ to: 'deputy@example.org', body: 'Previously prepared fixture email' });
  await dbRun(`UPDATE dispensation_submissions SET delivery_state = 'ready', message_raw = ?, message_json = ?, message_id = ? WHERE document_id = ?`,
    [Buffer.from('historical MIME fixture'), oldDraft, '<fixture@example.org>', 'completed']);
  await Promise.all([service.deliver('completed'), service.deliver('completed', {}, { retry: true }), service.runPending()]);
  const stop = service.startWorker(); stop();
  assert.equal(sends, 0);
  assert.equal((await dbGet('SELECT delivery_state FROM dispensation_submissions WHERE document_id = ?', ['completed'])).delivery_state, 'ready');
  assert.equal((await dbGet('SELECT submitted_at FROM documents WHERE id = ?', ['completed'])).submitted_at, null);
  const historical = await service.packet('historical', owner);
  assert.equal(historical.state, 'sent'); assert.equal(historical.delivery.sentAt, timestamp);
  assert.match(historical.message, /does not confirm receipt/);
  await dbRun(`UPDATE dispensation_submissions SET delivery_state = 'uncertain', attempted_at = ? WHERE document_id = ?`, [timestamp, 'completed']);
  assert.equal((await service.packet('completed', owner)).state, 'uncertain');
  await assert.rejects(service.resolveDelivery('completed', owner, 'not_delivered', 'Verified fixture retry.', {}, timestamp), /turned off/);
  for (const [suffix, method] of [['submit', 'POST'], ['submission-resolution', 'POST'], ['submission-draft', 'GET'], ['submission-email', 'GET']]) {
    const response = await request(suffix, { method });
    assert.equal(response.status, 409, `${method} ${suffix} must reject stale clients.`);
    assert.match((await response.json()).error, /turned off/);
  }
  const packet = await request('submission-packet');
  assert.equal((await packet.json()).packet.automaticDeliveryEnabled, false);
  const signer = await dbRun(`INSERT INTO document_signers(document_id,user_id,signer_role,signer_name,signed_at,signature_bytes)
    VALUES (?,?,'worshipful_master','Fixture Owner',?,?)`, ['completed', owner.id, timestamp, bytes]);
  await dbRun(`INSERT INTO owner_signature_revisions(id,document_id,owner_user_id,wm_signer_id,
    before_pdf_bytes,before_signature_bytes,before_pdf_sha256,before_signature_sha256,
    after_pdf_sha256,after_signature_sha256,source_sha256,original_file_sha256,original_signed_at,
    authorization_note,corrected_at,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['fixture-revision', 'completed', owner.id, signer.lastID, bytes, bytes, digest, digest, digest,
      digest, digest, digest, timestamp, 'Fixture owner authorized the visual correction.', timestamp, '{}']);
  const correctedPacket = await service.packet('completed', owner);
  assert.equal(correctedPacket.correction.correctedAt, timestamp);
  assert.equal(correctedPacket.correction.previousDeliveryAppliesToPreviousPdf, true);
  assert.equal(correctedPacket.correction.correctedPdfSha256, digest);
  assert.equal(correctedPacket.correction.currentPdfSha256, undefined, 'A revision hash must not claim to include a later secretary signature.');
  assert.match(correctedPacket.message, /Earlier email history refers to the previous PDF/);
  assert.equal(correctedPacket.automaticDeliveryEnabled, false);
  assert.equal(correctedPacket.draft, null, 'Signature corrections never recreate an outgoing email.');
  const savedReport = await request('supporting-report');
  assert.equal(savedReport.status, 200); assert.deepEqual(Buffer.from(await savedReport.arrayBuffer()), bytes);
  assert.equal((await request('submit', { method: 'POST', headers: { 'x-fixture-user': '' } })).status, 401);
  assert.equal((await request('submit', { method: 'POST', headers: { 'x-fixture-user': 'secretary' } })).status, 403);
  assert.equal(sends, 0, 'Uploads, signatures, queued packets, workers, stale clients and retries must never send.');
  assert.equal((await dbGet('SELECT message_json FROM dispensation_submissions WHERE document_id = ?', ['completed'])).message_json, oldDraft);
  assert.equal(audits.filter(event => event.action === 'dispensation_submitted_to_district_deputy').length, 0);
  const source = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /createDispensationSubmissions\(\{[\s\S]*?automaticDeliveryEnabled: false/);
  assert.match(source, /if \(dispensationSubmissions\.automaticDeliveryEnabled\) dispensationSubmissions\.startWorker/);
  console.log('PASS: automatic District Deputy email is off; uploads, completion, queue startup, stale clients and retries cannot send; PDFs, authorization and previous evidence remain intact.');
} finally { await new Promise(resolve => server.close(resolve)); await close(); }
