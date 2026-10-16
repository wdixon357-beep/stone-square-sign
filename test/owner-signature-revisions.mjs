import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import UPNGModule from '@pdf-lib/upng';
import { connect, initSchema, dbGet, dbAll, dbRun, close } from '../db.js';
import { replaceSignatureImage } from '../signature-corrections.js';
import { initOwnerSignatureRevisionSchema, createOwnerSignatureRevisions } from '../owner-signature-revisions.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Use only an isolated in-memory database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Do not use an existing local database.');
await connect(); await initSchema(); await initOwnerSignatureRevisionSchema();
await initOwnerSignatureRevisionSchema(); // Explicit initialization is repeatable.
const UPNG = UPNGModule.default || UPNGModule;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = (width, height, color) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    rgba.set([...color, (x + y) % 5 === 0 ? 128 : x % 3 === y % 3 ? 255 : 0], (y * width + x) * 4);
  }
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
};
const oldSignature = stamp(80, 20, [15, 25, 35]);
const replacement = stamp(100, 30, [0, 70, 220]);
const otherSignature = stamp(80, 20, [60, 90, 20]);
const profile = stamp(100, 30, [55, 80, 125]);
const originalDate = '2026-10-15T23:01:02.123Z';
const submittedDate = '2026-10-16T12:46:05.967Z';
const note = 'The owner explicitly authorized replacing the incorrect visual signature with the verified email signature.';
const service = createOwnerSignatureRevisions();
const code = expected => error => error.code === expected;
async function user(email, role) {
  await dbRun(`INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)`, [email, 'unused', email, role, originalDate]);
  return (await dbGet('SELECT id FROM users WHERE email=?', [email])).id;
}
const owner = await user('owner@example.org', 'owner');
const otherOwner = await user('another-owner@example.org', 'owner');
const secretary = await user('secretary@example.org', 'secretary');
await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,style_name,updated_at) VALUES (?,?,?,?,?)',
  [owner, profile, 'drawn', 'verified-profile', originalDate]);
await dbRun(`CREATE TABLE dispensation_submissions (
  document_id TEXT PRIMARY KEY, delivery_state TEXT, signed_sha256 TEXT,
  message_raw BYTEA, message_id TEXT, sent_at TEXT
)`);
const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
page.drawText('Community event: the text and both officers must remain unchanged.', { x: 35, y: 730, size: 11 });
page.drawImage(await pdf.embedPng(oldSignature), { x: 50, y: 400, width: 160, height: 40 });
page.drawImage(await pdf.embedPng(otherSignature), { x: 300, y: 400, width: 160, height: 40 });
const originalPdf = Buffer.from(await pdf.save());

async function make(id, options = {}) {
  const ownerId = options.ownerId || owner;
  await dbRun(`INSERT INTO documents(id,title,original_name,stored_name,owner_user_id,owner_email,
    file_bytes,signed_bytes,status,parsed_preview,created_at,updated_at,completed_at,template_kind,
    signing_mode,submitted_at,submitted_to,submitted_error,approval_status,approved_by,approved_on,
    approval_source,approval_note,approved_bytes,approval_recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, 'Synthetic community event', 'request.pdf', `${id}.pdf`, ownerId, 'owner@example.org',
    originalPdf, originalPdf, options.status || 'completed', 'Keep this event text.', originalDate, originalDate,
    options.status === 'partially_signed' ? null : originalDate, options.template || 'dispensation_v1',
    'any', submittedDate, 'district@example.org', 'Historical receipt not retained.', 'approved', 'District Deputy',
    '2026-10-16', 'email', 'Original decision evidence.', originalPdf, submittedDate]);
  await dbRun(`INSERT INTO document_signers(document_id,user_id,signer_role,signer_name,signed_at,
    signature_bytes,signed_ip,signed_user_agent,consent_text) VALUES (?,?,?,?,?,?,?,?,?)`,
  [id, options.wmUserId || ownerId, 'worshipful_master', 'Worshipful Master', originalDate, oldSignature,
    '127.0.0.1', 'Synthetic test', 'Original owner attestation.']);
  await dbRun(`INSERT INTO document_signers(document_id,user_id,signer_role,signer_name,signed_at,
    signature_bytes,signed_ip,signed_user_agent,consent_text) VALUES (?,?,?,?,?,?,?,?,?)`,
  [id, secretary, 'secretary', 'Secretary', options.status === 'partially_signed' ? null : originalDate,
    options.status === 'partially_signed' ? null : otherSignature, '127.0.0.2', 'Officer test client', 'Original secretary consent.']);
  await dbRun('INSERT INTO document_signers(document_id,signer_role,signer_name,superseded_at) VALUES (?,?,?,?)',
    [id, 'assistant_secretary', 'Assistant Secretary', originalDate]);
  await dbRun('INSERT INTO dispensation_submissions VALUES (?,?,?,?,?,?)',
    [id, 'sent', sha(originalPdf), Buffer.from('Original historical raw email.'), `<${id}@example.org>`, submittedDate]);
}
const request = (documentId, overrides = {}) => ({ ownerUserId: owner, documentId,
  replacementSignaturePng: replacement, expectedPdfSha256: sha(originalPdf),
  expectedSignatureSha256: sha(oldSignature), authorizationNote: note, ...overrides });
const record = id => dbGet('SELECT * FROM documents WHERE id=?', [id]);
const signers = id => dbAll('SELECT * FROM document_signers WHERE document_id=? ORDER BY id', [id]);
const revisionCount = async id => (await dbGet('SELECT COUNT(*) AS total FROM owner_signature_revisions WHERE document_id=?', [id])).total;
const auditCount = async id => (await dbGet("SELECT COUNT(*) AS total FROM audit_events WHERE document_id=? AND action='owner_signature_visual_corrected'", [id])).total;

try {
  await make('preserved');
  const beforeDocument = await record('preserved'), beforeSigners = await signers('preserved');
  const beforeDelivery = await dbGet('SELECT * FROM dispensation_submissions WHERE document_id=?', ['preserved']);
  const beforeProfile = await dbGet('SELECT * FROM profile_signatures WHERE user_id=?', [owner]);
  const result = await service.apply(request('preserved'));
  assert.equal(result.alreadyApplied, false); assert.ok(result.revisionId); assert.equal(result.sent, false);
  assert.match(result.deliveryNote, /previous PDF bytes.*not resent/);
  const afterDocument = await record('preserved'), afterSigners = await signers('preserved');
  assert.equal(sha(afterDocument.signed_bytes), result.afterPdfSha256);
  assert.notEqual(result.beforePdfSha256, result.afterPdfSha256);
  for (const [key, value] of Object.entries(beforeDocument)) {
    if (!['signed_bytes', 'updated_at'].includes(key)) assert.deepEqual(afterDocument[key], value, `Document ${key} remains unchanged.`);
  }
  for (let index = 0; index < beforeSigners.length; index += 1) {
    for (const [key, value] of Object.entries(beforeSigners[index])) {
      if (!(index === 0 && key === 'signature_bytes')) assert.deepEqual(afterSigners[index][key], value, `Signer ${index} ${key} remains unchanged.`);
    }
  }
  assert.deepEqual(Buffer.from(afterSigners[0].signature_bytes), replacement);
  assert.deepEqual(await dbGet('SELECT * FROM profile_signatures WHERE user_id=?', [owner]), beforeProfile, 'No signature profile changes are made by a document correction.');
  assert.deepEqual(await dbGet('SELECT * FROM dispensation_submissions WHERE document_id=?', ['preserved']), beforeDelivery, 'Historical delivery evidence remains untouched.');
  const revision = await dbGet('SELECT * FROM owner_signature_revisions WHERE id=?', [result.revisionId]);
  assert.deepEqual(Buffer.from(revision.before_pdf_bytes), originalPdf);
  assert.deepEqual(Buffer.from(revision.before_signature_bytes), oldSignature);
  assert.equal(revision.before_pdf_sha256, sha(originalPdf)); assert.equal(revision.before_signature_sha256, sha(oldSignature));
  assert.equal(revision.after_pdf_sha256, sha(afterDocument.signed_bytes)); assert.equal(revision.after_signature_sha256, sha(replacement));
  assert.equal(revision.source_sha256, sha(replacement)); assert.equal(revision.original_file_sha256, sha(beforeDocument.file_bytes));
  assert.equal(revision.original_signed_at, originalDate); assert.equal(revision.authorization_note, note);
  const audit = await dbGet("SELECT * FROM audit_events WHERE document_id=? AND action='owner_signature_visual_corrected'", ['preserved']);
  const details = JSON.parse(audit.details_json);
  assert.equal(audit.user_id, owner); assert.equal(details.revisionId, result.revisionId);
  assert.equal(details.ownerSignerId, beforeSigners[0].id); assert.equal(details.originalSignatureDate, originalDate);
  assert.equal(details.correctedPdfResent, false); assert.equal(details.submittedAtBeforeCorrection, submittedDate);
  assert.match(details.deliveryNote, /previous PDF bytes/); assert.deepEqual(details.unchangedSignerIds, beforeSigners.slice(1).map(row => row.id));
  assert.equal((await service.apply(request('preserved'))).revisionId, result.revisionId, 'A retry with original inspected hashes is idempotent.');
  assert.equal((await service.apply(request('preserved', { expectedPdfSha256: result.afterPdfSha256, expectedSignatureSha256: sha(replacement) }))).alreadyApplied, true);
  assert.equal(await revisionCount('preserved'), 1); assert.equal(await auditCount('preserved'), 1);
  await assert.rejects(dbRun('UPDATE owner_signature_revisions SET authorization_note=? WHERE id=?', ['tamper', result.revisionId]), /append-only/);
  await assert.rejects(dbRun('DELETE FROM owner_signature_revisions WHERE id=?', [result.revisionId]), /append-only/);
  await assert.rejects(dbRun('TRUNCATE owner_signature_revisions'), /append-only/);

  await make('partial', { status: 'partially_signed' });
  await service.apply(request('partial'));
  assert.equal((await record('partial')).status, 'partially_signed');
  assert.equal((await record('partial')).completed_at, null);
  assert.equal((await signers('partial'))[1].signed_at, null, 'A visual correction does not sign for the Secretary.');

  await make('access');
  await assert.rejects(service.apply(request('access', { ownerUserId: secretary })), code('OWNER_REQUIRED'));
  await assert.rejects(service.apply(request('access', { ownerUserId: otherOwner })), code('DOCUMENT_OWNER_REQUIRED'));
  await assert.rejects(service.apply(request('not-found')), code('DOCUMENT_NOT_FOUND'));
  await assert.rejects(service.apply(request('access', { authorizationNote: 'short' })), code('AUTHORIZATION_NOTE_REQUIRED'));
  await assert.rejects(service.apply(request('access', { expectedPdfSha256: '' })), code('EXPECTED_SIGNATURE_HASHES_REQUIRED'));
  await assert.rejects(service.apply(request('access', { expectedPdfSha256: '0'.repeat(64) })), code('SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(service.apply(request('access', { expectedSignatureSha256: '0'.repeat(64) })), code('SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(service.apply(request('access', { replacementSignaturePng: Buffer.from('invalid') })), code('INVALID_SIGNATURE_PNG'));
  await assert.rejects(service.apply(request('preserved', { expectedPdfSha256: '0'.repeat(64) })), code('SIGNATURE_REVISION_CONFLICT'));
  await make('wrong-template', { template: 'other' });
  await assert.rejects(service.apply(request('wrong-template')), code('DISPENSATION_REQUIRED'));
  await make('rescinded', { status: 'rescinded' });
  await assert.rejects(service.apply(request('rescinded')), code('ACTIVE_SIGNED_DOCUMENT_REQUIRED'));
  await make('wrong-wm', { wmUserId: otherOwner });
  await assert.rejects(service.apply(request('wrong-wm')), code('OWN_SIGNATURE_REQUIRED'));
  await make('missing-bytes');
  await dbRun('UPDATE documents SET signed_bytes=NULL WHERE id=?', ['missing-bytes']);
  await assert.rejects(service.apply(request('missing-bytes')), code('SIGNATURE_RECORD_INCOMPLETE'));
  assert.equal(await revisionCount('access'), 0); assert.equal(await auditCount('access'), 0);

  await make('rollback');
  const rollbackDocument = await record('rollback'), rollbackSigners = await signers('rollback');
  await dbRun(`ALTER TABLE audit_events ADD CONSTRAINT reject_revision_test_audit
    CHECK (document_id IS DISTINCT FROM 'rollback' OR action <> 'owner_signature_visual_corrected')`);
  await assert.rejects(service.apply(request('rollback')), /reject_revision_test_audit/);
  await dbRun('ALTER TABLE audit_events DROP CONSTRAINT reject_revision_test_audit');
  assert.deepEqual(await record('rollback'), rollbackDocument); assert.deepEqual(await signers('rollback'), rollbackSigners);
  assert.equal(await revisionCount('rollback'), 0, 'Archive, PDF, signature snapshot, and audit roll back together.');
  assert.equal(await auditCount('rollback'), 0);

  await make('concurrent');
  const concurrent = await Promise.all([service.apply(request('concurrent')), service.apply(request('concurrent'))]);
  assert.equal(concurrent.filter(row => !row.alreadyApplied).length, 1);
  assert.equal(concurrent[0].revisionId, concurrent[1].revisionId);
  assert.equal(await revisionCount('concurrent'), 1); assert.equal(await auditCount('concurrent'), 1);

  await make('changed-pdf');
  const pdfRace = createOwnerSignatureRevisions({ replaceSignature: async input => {
    const prepared = await replaceSignatureImage(input);
    await dbRun('UPDATE documents SET signed_bytes=? WHERE id=?', [Buffer.from('A concurrently changed PDF.'), 'changed-pdf']);
    return prepared;
  } });
  await assert.rejects(pdfRace.apply(request('changed-pdf')), code('SIGNATURE_REVISION_CONFLICT'));
  assert.deepEqual(Buffer.from((await record('changed-pdf')).signed_bytes), Buffer.from('A concurrently changed PDF.'));
  assert.equal(await revisionCount('changed-pdf'), 0); assert.equal(await auditCount('changed-pdf'), 0);

  await make('changed-signature');
  const signatureRace = createOwnerSignatureRevisions({ replaceSignature: async input => {
    const prepared = await replaceSignatureImage(input);
    await dbRun("UPDATE document_signers SET signature_bytes=? WHERE document_id=? AND signer_role='worshipful_master'", [otherSignature, 'changed-signature']);
    return prepared;
  } });
  await assert.rejects(signatureRace.apply(request('changed-signature')), code('SIGNATURE_REVISION_CONFLICT'));
  assert.deepEqual(Buffer.from((await record('changed-signature')).signed_bytes), originalPdf);
  assert.equal(await revisionCount('changed-signature'), 0); assert.equal(await auditCount('changed-signature'), 0);

  await make('changed-role');
  const roleRace = createOwnerSignatureRevisions({ replaceSignature: async input => {
    const prepared = await replaceSignatureImage(input);
    await dbRun('UPDATE users SET role=? WHERE id=?', ['viewer', owner]);
    return prepared;
  } });
  await assert.rejects(roleRace.apply(request('changed-role')), code('OWNER_REQUIRED'));
  await dbRun('UPDATE users SET role=? WHERE id=?', ['owner', owner]);
  assert.equal(await revisionCount('changed-role'), 0); assert.equal(await auditCount('changed-role'), 0);

  await make('unchanged');
  const unchanged = await service.apply(request('unchanged', { replacementSignaturePng: oldSignature }));
  assert.equal(unchanged.alreadyApplied, true); assert.equal(unchanged.revisionId, null);
  assert.equal(await revisionCount('unchanged'), 0); assert.equal(await auditCount('unchanged'), 0);
  console.log('Owner signature revision checks passed: exact ownership and concurrency, append-only archived originals, atomic rollback, unchanged other signatures/attestations/approvals/delivery/profile, idempotent retries, and no sending.');
} finally {
  await close();
}
