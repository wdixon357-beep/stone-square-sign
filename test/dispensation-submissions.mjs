import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { connect, initSchema, dbRun, dbGet, close } from '../db.js';
import { createDispensationSubmissions, initDispensationSubmissionSchema, validateSupportingReport, MAX_SUPPORTING_REPORT_BYTES } from '../dispensation-submissions.js';

assert.equal(process.env.DATABASE_URL || '', '', 'This synthetic test must use an isolated in-memory database.');
await connect(); await initSchema(); await initDispensationSubmissionSchema();
const createdAt = new Date().toISOString();
await dbRun(`INSERT INTO users(email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
  ['owner@example.org', 'unused', 'William Dixon-Saunders', 'owner', createdAt]);
const owner = await dbGet('SELECT * FROM users WHERE email = ?', ['owner@example.org']);
const other = { id: owner.id + 1, role: 'owner' };
const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
const original = Buffer.from(await pdf.save());
const reportDoc = await PDFDocument.create(); reportDoc.addPage([500, 700]);
const report = Buffer.from(await reportDoc.save());
const audit = [];
const deliveries = [];
let transport = async message => { deliveries.push(message); return true; };
const service = createDispensationSubmissions({ sendEmail: message => transport(message),
  automaticDeliveryEnabled: true,
  addAudit: async event => audit.push(event), recipient: { to: 'district@example.org', name: 'District Deputy Jones' },
  lodgeName: 'Stone Square Lodge No. 22', mailFrom: 'master@example.org' });
async function make(id, status = 'pending', submitted = false) {
  await dbRun(`INSERT INTO documents (id, title, original_name, stored_name, owner_user_id, file_bytes,
    signed_bytes, status, template_kind, parsed_preview, created_at, updated_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, 'Community event', 'dispensation.pdf', 'unused.pdf', owner.id,
    original, status === 'completed' ? original : null, status, 'dispensation_v1', 'A community meal on October 20, 2026.', createdAt, createdAt, submitted ? createdAt : null]);
  await dbRun(`INSERT INTO document_signers(document_id, signer_role, signer_name, signed_at)
    VALUES (?, ?, ?, ?)`, [id, 'assistant_secretary', 'Adrian Reese', status === 'completed' ? createdAt : null]);
}
const attach = (id, bytes = report) => service.attachReport(id, owner, { buffer: bytes, originalname: '../supporting-report.pdf' }, 'Stone Square Dispensation Reports', { actorUserId: owner.id });

try {
  await assert.rejects(validateSupportingReport(Buffer.from('not a pdf')), /valid PDF/);
  await assert.rejects(validateSupportingReport(Buffer.from('%PDF-broken')), /unreadable/);
  await assert.rejects(validateSupportingReport(Buffer.alloc(MAX_SUPPORTING_REPORT_BYTES + 1)), /12 MB/);
  const empty = Buffer.from(await (await PDFDocument.create()).save({ addDefaultPage: false }));
  await assert.rejects(validateSupportingReport(empty), /empty/);
  await make('before-sign');
  assert.equal((await service.packet('before-sign', owner)).state, 'awaiting_signature');
  await assert.rejects(service.packet('before-sign', other), /Only the document owner/);
  await attach('before-sign');
  assert.equal(deliveries.length, 0, 'An attached report never sends an unsigned dispensation.');
  await dbRun('UPDATE documents SET status = ?, signed_bytes = ? WHERE id = ?', ['completed', original, 'before-sign']);
  await dbRun('UPDATE document_signers SET signed_at = ? WHERE document_id = ?', [createdAt, 'before-sign']);
  await Promise.all([service.deliver('before-sign'), service.deliver('before-sign'), service.runPending()]);
  assert.equal(deliveries.length, 1, 'Concurrent completion, queue recovery, and retry produce one email.');
  const packet = await service.packet('before-sign', owner);
  assert.equal(packet.state, 'sent'); assert.equal(packet.report.filename, 'supporting-report.pdf');
  assert.equal(packet.report.sha256, crypto.createHash('sha256').update(report).digest('hex'));
  assert.equal(packet.recipient.to, 'district@example.org');
  assert.equal(deliveries[0].attachments.length, 2);
  assert.deepEqual(deliveries[0].attachments[0].content, original);
  assert.deepEqual(deliveries[0].attachments[1].content, report);
  assert.equal(deliveries[0].raw.toString().match(/Content-Type: application\/pdf/g).length, 2);
  assert.match(deliveries[0].raw.toString(), /Message-ID:\s*<dispensation-/i);
  assert.match(packet.draft.body, /Summary: A community meal/);
  assert.equal((await dbGet('SELECT submitted_to FROM documents WHERE id = ?', ['before-sign'])).submitted_to, 'district@example.org');
  await attach('before-sign'); assert.equal(deliveries.length, 1, 'Identical upload is idempotent.');
  await assert.rejects(attach('before-sign', original), /cannot be replaced/);
  await make('signature-first', 'completed');
  assert.equal((await service.deliver('signature-first')).state, 'awaiting_report');
  assert.equal(deliveries.length, 1, 'A signature alone cannot send without the matching report.');
  assert.equal((await attach('signature-first')).state, 'sent'); assert.equal(deliveries.length, 2);
  await make('rejected', 'completed');
  transport = async () => { throw Object.assign(new Error('Rejected'), { responseCode: 550 }); };
  assert.equal((await attach('rejected')).state, 'failed');
  transport = async message => { deliveries.push(message); return true; };
  await service.runPending(); assert.equal(deliveries.length, 2, 'A failed delivery requires an explicit retry.');
  assert.equal((await service.deliver('rejected', {}, { retry: true })).state, 'sent');
  assert.equal(deliveries.length, 3);
  await make('ambiguous', 'completed');
  transport = async () => { throw Object.assign(new Error('Socket lost after DATA'), { code: 'ESOCKET' }); };
  assert.equal((await attach('ambiguous')).state, 'uncertain');
  transport = async message => { deliveries.push(message); return true; };
  assert.equal((await service.deliver('ambiguous', {}, { retry: true })).state, 'uncertain');
  assert.equal(deliveries.length, 3, 'An ambiguous SMTP result cannot be resent automatically or manually.');
  await make('historical', 'completed', true);
  await assert.rejects(attach('historical'), /already prepared or sent/);
  await service.deliver('historical'); assert.equal(deliveries.length, 3);
  await make('rescinded', 'rescinded');
  await assert.rejects(attach('rescinded'), /rescinded/);
  await make('no-signed-bytes', 'completed');
  await dbRun('UPDATE documents SET signed_bytes = NULL WHERE id = ?', ['no-signed-bytes']);
  assert.equal((await attach('no-signed-bytes')).state, 'failed');
  assert.equal(deliveries.length, 3, 'Never fall back to unsigned original bytes.');
  await make('recovered', 'completed');
  await dbRun(`INSERT INTO dispensation_submissions(document_id, report_bytes, report_filename, report_sha256, updated_at)
    VALUES (?, ?, ?, ?, ?)`, ['recovered', report, 'recovered.pdf', crypto.createHash('sha256').update(report).digest('hex'), createdAt]);
  await service.runPending(); assert.equal(deliveries.length, 4, 'Durable worker recovers a completed signature missed before initial delivery.');
  await dbRun(`UPDATE dispensation_submissions SET delivery_state = 'sending', attempted_at = ? WHERE document_id = ?`, [new Date(Date.now() - 600_000).toISOString(), 'ambiguous']);
  await initDispensationSubmissionSchema();
  assert.equal((await service.packet('ambiguous', owner)).state, 'uncertain');
  await assert.rejects(service.resolveDelivery('ambiguous', owner, 'delivered', 'short'), /10 to 600/);
  await assert.rejects(service.resolveDelivery('ambiguous', other, 'delivered', 'Confirmed by recipient.'), /Only the document owner/);
  const confirmed = await service.resolveDelivery('ambiguous', owner, 'delivered', 'The District Deputy confirmed receipt of both PDFs.',
    { actorUserId: owner.id }, (await service.packet('ambiguous', owner)).delivery.attemptedAt);
  assert.equal(confirmed.state, 'sent'); assert.equal(confirmed.delivery.confirmationOutcome, 'delivered');
  assert.match(confirmed.message, /You confirmed/); assert.equal(deliveries.length, 4, 'Owner confirmation does not send another message.');
  await assert.rejects(service.resolveDelivery('ambiguous', owner, 'not_delivered', 'Duplicate confirmation attempt.'), /Only an uncertain/);
  await make('confirmed-retry', 'completed');
  transport = async () => { throw new Error('Connection ended after DATA'); };
  await attach('confirmed-retry');
  transport = async message => { deliveries.push(message); return true; };
  assert.equal((await service.resolveDelivery('confirmed-retry', owner, 'not_delivered', 'Checked with the District Deputy: neither PDF arrived.',
    { actorUserId: owner.id }, (await service.packet('confirmed-retry', owner)).delivery.attemptedAt)).state, 'sent');
  assert.equal(deliveries.length, 5, 'Only explicit owner verification authorizes retry after uncertainty.');
  await dbRun(`UPDATE dispensation_submissions SET delivery_state = 'sending', attempted_at = ?, sent_at = NULL WHERE document_id = ?`, [new Date().toISOString(), 'confirmed-retry']);
  await dbRun('UPDATE documents SET submitted_at = NULL WHERE id = ?', ['confirmed-retry']);
  await initDispensationSubmissionSchema();
  assert.equal((await service.packet('confirmed-retry', owner)).state, 'sending', 'A recent active delivery survives overlapping process startup.');
  await dbRun('UPDATE dispensation_submissions SET attempted_at = ? WHERE document_id = ?', [new Date(Date.now() - 600_000).toISOString(), 'confirmed-retry']);
  const recoveryEvents = [];
  await service.runPending((type, data) => recoveryEvents.push({ type, data }));
  assert.equal((await dbGet('SELECT delivery_state FROM dispensation_submissions WHERE document_id = ?', ['confirmed-retry'])).delivery_state, 'uncertain');
  assert.equal(deliveries.length, 5, 'A delivery interrupted shortly before startup becomes uncertain after its lease expires, without another email.');
  assert.ok(recoveryEvents.some(event => event.data.reason === 'dispensation_submission_interrupted'));
  await make('replay-fence', 'completed');
  let ambiguousAttempts = 0;
  transport = async () => { ambiguousAttempts += 1; throw new Error('Lost DATA acknowledgement'); };
  await attach('replay-fence');
  const futureAttempt = new Date(Date.now() + 10_000).toISOString();
  await dbRun('UPDATE dispensation_submissions SET attempted_at = ? WHERE document_id = ?', [futureAttempt, 'replay-fence']);
  const firstUncertain = await service.packet('replay-fence', owner);
  const verification = 'Confirmed with the District Deputy that neither attachment arrived.';
  await assert.rejects(service.resolveDelivery('replay-fence', owner, 'not_delivered', verification), /delivery attempt changed/);
  const secondUncertain = await service.resolveDelivery('replay-fence', owner, 'not_delivered', verification,
    { actorUserId: owner.id }, firstUncertain.delivery.attemptedAt);
  assert.equal(secondUncertain.state, 'uncertain');
  assert.equal(ambiguousAttempts, 2);
  assert.ok(secondUncertain.delivery.attemptedAt > firstUncertain.delivery.attemptedAt,
    'A retry advances its visible revision even when the clock has not advanced.');
  await assert.rejects(service.resolveDelivery('replay-fence', owner, 'not_delivered', verification,
    { actorUserId: owner.id }, firstUncertain.delivery.attemptedAt), /delivery attempt changed/);
  assert.equal(ambiguousAttempts, 2, 'Replaying a confirmation after a lost retry response cannot send a third email.');
  const latest = await service.packet('replay-fence', owner);
  assert.equal((await service.resolveDelivery('replay-fence', owner, 'delivered',
    'The District Deputy has now confirmed receipt of both attachments.', { actorUserId: owner.id }, latest.delivery.attemptedAt)).state, 'sent');
  assert.equal(ambiguousAttempts, 2, 'The latest verified attempt can be resolved without another email.');
  assert.ok(audit.some(event => event.action === 'dispensation_supporting_report_associated'));
  assert.ok(audit.some(event => event.action === 'dispensation_submission_packet_prepared'));
  assert.ok(audit.some(event => event.action === 'dispensation_submitted_to_district_deputy' && event.details.attachments.length === 2));
  assert.ok(audit.some(event => event.action === 'dispensation_submission_delivery_resolved' && event.details.ownerConfirmed));
  assert.ok(audit.some(event => event.action === 'dispensation_submission_delivery_interrupted'));
  console.log('Dispensation submission checks passed: exact report association, two signed attachments, durable recovery, no duplicates, safe retries, owner access, and PDF validation.');
} finally { await close(); }
