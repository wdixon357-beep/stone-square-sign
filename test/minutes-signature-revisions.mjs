import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import UPNGModule from '@pdf-lib/upng';
import { connect, initSchema, dbGet, dbAll, dbRun, close } from '../db.js';
import { replaceSignatureImage } from '../signature-corrections.js';
import { createMinutesSignatureRevisions, initMinutesSignatureRevisionSchema } from '../minutes-signature-revisions.js';
import { pinApprovedOwnerSignature } from '../signature-policy.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Use only an isolated in-memory database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Do not use an existing local database.');
await connect(); await initSchema();
assert.equal((await dbGet("SELECT to_regclass('minutes_signature_revisions') AS table_name")).table_name, null, 'Importing the module does not initialize its schema.');
await initMinutesSignatureRevisionSchema(); await initMinutesSignatureRevisionSchema();

const UPNG = UPNGModule.default || UPNGModule;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === expected;
const stamp = (width, height, color) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    rgba.set([...color, (x + y) % 5 === 0 ? 128 : x % 3 === y % 3 ? 255 : 0], (y * width + x) * 4);
  }
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
};
const oldSignature = stamp(80, 20, [15, 25, 35]);
const replacement = stamp(100, 30, [0, 70, 220]);
const otherReplacement = stamp(100, 30, [0, 110, 180]);
const preparerSignature = stamp(80, 20, [60, 90, 20]);
const firstDate = '2026-10-02T01:01:02.123Z';
const masterDate = '2026-10-03T12:46:05.967Z';
const laterDate = '2026-10-04T12:00:00.000Z';
const draft = JSON.stringify({ meetingDate: '2026-10-01', sections: [{ heading: 'New Business', body: '- The committee report was received.' }] });
const submittedDraft = JSON.stringify({ meetingDate: '2026-10-01', sections: [{ heading: 'New Business', body: '- The committee report was presented.' }] });
const note = 'The Worshipful Master explicitly authorized replacing only his incorrect visual signature with the verified blue cursive signature.';

async function user(email, role) {
  await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)', [email, 'unused', email, role, firstDate]);
  return (await dbGet('SELECT id FROM users WHERE email=?', [email])).id;
}
const owner = await user('owner@example.org', 'owner');
const secondOwner = await user('other-owner@example.org', 'owner');
const preparer = await user('assistant-secretary@example.org', 'assistant_secretary');
await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,style_name,updated_at) VALUES (?,?,?,?,?)',
  [owner, replacement, 'drawn', 'approved-blue', masterDate]);
await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,style_name,updated_at) VALUES (?,?,?,?,?)',
  [preparer, preparerSignature, 'drawn', 'preparer-original', firstDate]);

const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
page.drawText('Meeting Minutes, October 1, 2026. Committee report received.', { x: 35, y: 730, size: 11 });
page.drawText('Original preparing officer and Worshipful Master attestation dates.', { x: 35, y: 350, size: 11 });
page.drawImage(await pdf.embedPng(preparerSignature), { x: 50, y: 400, width: 160, height: 40 });
page.drawImage(await pdf.embedPng(oldSignature), { x: 300, y: 400, width: 160, height: 40 });
const originalPdf = Buffer.from(await pdf.save());
let renderCalls = 0;
const buildOriginalPdf = async ({ masterAttestation, preparerAttestation, publishedSnapshotSha256, protectedRowSha256 }) => {
  renderCalls += 1;
  assert.equal(masterAttestation.draft_json, draft);
  assert.deepEqual(Buffer.from(masterAttestation.signature_bytes), oldSignature);
  assert.deepEqual(Buffer.from(preparerAttestation.signature_bytes), preparerSignature);
  assert.match(publishedSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(protectedRowSha256, /^[a-f0-9]{64}$/);
  return originalPdf;
};
const service = createMinutesSignatureRevisions({ buildOriginalPdf });
const make = async (id, options = {}) => {
  await dbRun(`INSERT INTO meeting_minutes
    (id,meeting_date,source_name,transcript_text,draft_json,status,created_by_user_id,updated_by_user_id,created_at,updated_at,
     submitted_for_review_at,preparer_attested_at,master_attested_by_user_id,master_attested_at,authorized_by_user_id,authorized_at,
     distributed_by_user_id,distributed_at,approved_by_lodge_on,approval_note,submitted_draft_json,master_changes_json,
     preparer_signature_bytes,master_signature_bytes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, '2026-10-01', 'Original source notes', 'Private source must stay unchanged.', draft, options.status || 'ready_for_distribution',
    preparer, owner, firstDate, masterDate, firstDate, firstDate, owner, masterDate, owner, masterDate,
    null, null, null, 'Original approval note.', submittedDraft, JSON.stringify([{ field: 'New Business', before: 'Presented.', after: 'Received.' }]),
    preparerSignature, oldSignature]);
  if (!options.noPreparer) await dbRun(`INSERT INTO meeting_minutes_attestations(id,minutes_id,user_id,phase,draft_json,signature_bytes,created_at)
    VALUES (?,?,?,?,?,?,?)`, [`${id}-preparer`, id, preparer, 'preparer', submittedDraft, preparerSignature, firstDate]);
  if (!options.noMaster) await dbRun(`INSERT INTO meeting_minutes_attestations(id,minutes_id,user_id,phase,draft_json,signature_bytes,created_at)
    VALUES (?,?,?,?,?,?,?)`, [`${id}-master`, id, options.masterUserId || owner, 'master', draft, oldSignature, masterDate]);
  await dbRun('INSERT INTO minutes_distribution_alerts(minutes_id,user_id,created_at,seen_at) VALUES (?,?,?,?)', [id, preparer, masterDate, laterDate]);
};
const request = (minutesId, overrides = {}) => ({ ownerUserId: owner, minutesId, replacementSignaturePng: replacement,
  expectedPdfSha256: sha(originalPdf), expectedSignatureSha256: sha(oldSignature), authorizationNote: note, ...overrides });
const resolve = (minutesId, overrides = {}) => service.resolve({ minutesId, masterAttestationId: `${minutesId}-master`,
  preparerAttestationId: `${minutesId}-preparer`, draftJson: draft, ...overrides });
const record = id => dbGet('SELECT * FROM meeting_minutes WHERE id=?', [id]);
const attestations = id => dbAll('SELECT * FROM meeting_minutes_attestations WHERE minutes_id=? ORDER BY id', [id]);
const alerts = id => dbAll('SELECT * FROM minutes_distribution_alerts WHERE minutes_id=? ORDER BY user_id', [id]);
const revisionCount = async id => (await dbGet('SELECT COUNT(*) AS total FROM minutes_signature_revisions WHERE minutes_id=?', [id])).total;
const auditCount = async id => (await dbGet("SELECT COUNT(*) AS total FROM audit_events WHERE action='minutes_owner_signature_visual_corrected' AND details_json::jsonb->>'minutesId'=?", [id])).total;

try {
  await make('preserved');
  assert.equal(await resolve('preserved'), null, 'No revision means the original captured snapshot remains in use.');
  const before = { row: await record('preserved'), attestations: await attestations('preserved'), alerts: await alerts('preserved'),
    profiles: await dbAll('SELECT * FROM profile_signatures ORDER BY user_id') };
  const inspected = await service.inspect({ ownerUserId: owner, minutesId: 'preserved' });
  assert.equal(inspected.masterAttestation.id, 'preserved-master'); assert.equal(inspected.preparerAttestation.id, 'preserved-preparer');
  const result = await service.apply(request('preserved'));
  assert.equal(result.alreadyApplied, false); assert.ok(result.revisionId); assert.equal(result.sent, false);
  assert.match(result.deliveryNote, /without a new attestation.*No email/);
  assert.deepEqual(await record('preserved'), before.row, 'The complete minutes row, source, corrections, status and every date remain unchanged.');
  assert.deepEqual(await attestations('preserved'), before.attestations, 'Both original signed attestation snapshots and signature bytes remain unchanged.');
  assert.deepEqual(await alerts('preserved'), before.alerts, 'No notification is created, reopened or marked seen.');
  assert.deepEqual(await dbAll('SELECT * FROM profile_signatures ORDER BY user_id'), before.profiles, 'No profile is changed by a visual correction.');
  const revision = await dbGet('SELECT * FROM minutes_signature_revisions WHERE id=?', [result.revisionId]);
  assert.deepEqual(Buffer.from(revision.before_pdf_bytes), originalPdf); assert.deepEqual(Buffer.from(revision.before_signature_bytes), oldSignature);
  assert.deepEqual(Buffer.from(revision.replacement_signature_bytes), replacement);
  assert.equal(revision.before_pdf_sha256, sha(originalPdf)); assert.equal(revision.after_pdf_sha256, sha(revision.corrected_pdf_bytes));
  assert.equal(revision.before_signature_sha256, sha(oldSignature)); assert.equal(revision.after_signature_sha256, sha(replacement));
  assert.equal(revision.content_sha256, sha(draft)); assert.equal(revision.preparer_signature_sha256, sha(preparerSignature));
  assert.equal(revision.master_attestation_id, 'preserved-master'); assert.equal(revision.preparer_attestation_id, 'preserved-preparer');
  assert.equal(revision.original_master_attested_at, masterDate); assert.equal(revision.original_preparer_attested_at, firstDate);
  assert.equal(revision.original_status, 'ready_for_distribution'); assert.equal(revision.authorization_note, note);
  const audit = await dbGet("SELECT * FROM audit_events WHERE action='minutes_owner_signature_visual_corrected' AND details_json::jsonb->>'minutesId'=?", ['preserved']);
  const details = JSON.parse(audit.details_json);
  assert.equal(audit.user_id, owner); assert.equal(details.revisionId, result.revisionId); assert.equal(details.correctedPdfResent, false);
  assert.equal(details.originalDates.created_at, firstDate); assert.equal(details.originalDates.master_attested_at, masterDate);
  assert.equal(details.originalAuthorizationAt, masterDate); assert.equal(details.originalDistributionAt, null);
  assert.equal(details.preparerSignatureSha256, sha(preparerSignature)); assert.equal(details.contentSha256, sha(draft));
  const retrieved = await resolve('preserved');
  assert.equal(retrieved.revisionId, result.revisionId); assert.equal(retrieved.useRetainedPdf, true);
  assert.deepEqual(retrieved.masterSignature, replacement); assert.deepEqual(retrieved.pdfBytes, Buffer.from(revision.corrected_pdf_bytes));
  assert.equal(sha(retrieved.pdfBytes), result.afterPdfSha256);
  const replayRenderCount = renderCalls;
  assert.equal((await service.apply(request('preserved'))).revisionId, result.revisionId);
  assert.equal((await service.apply(request('preserved', { expectedPdfSha256: result.afterPdfSha256, expectedSignatureSha256: sha(replacement) }))).alreadyApplied, true);
  assert.equal(renderCalls, replayRenderCount, 'Idempotent retries do not rebuild an original or repeat the visual correction.');
  assert.equal(await revisionCount('preserved'), 1); assert.equal(await auditCount('preserved'), 1);
  await assert.rejects(dbRun('UPDATE minutes_signature_revisions SET authorization_note=? WHERE id=?', ['tamper', result.revisionId]), /append-only/);
  await assert.rejects(dbRun('DELETE FROM minutes_signature_revisions WHERE id=?', [result.revisionId]), /append-only/);
  await assert.rejects(dbRun('TRUNCATE minutes_signature_revisions'), /append-only/);

  await dbRun("UPDATE meeting_minutes SET status='distributed',distributed_by_user_id=?,distributed_at=?,updated_at=? WHERE id=?", [preparer, laterDate, laterDate, 'preserved']);
  const distributed = await resolve('preserved');
  assert.equal(distributed.useRetainedPdf, false, 'Legitimate status progress uses the corrected signature with a current-metadata render.');
  assert.deepEqual(distributed.masterSignature, replacement);
  await dbRun("UPDATE meeting_minutes SET status='approved_by_lodge',approved_by_lodge_on=?,updated_at=? WHERE id=?", ['2026-10-15', laterDate, 'preserved']);
  const approved = await resolve('preserved');
  assert.equal(approved.useRetainedPdf, false, 'An old retained PDF never conceals a later Lodge approval footer/date.');
  assert.equal((await service.apply(request('preserved'))).alreadyApplied, true, 'An identical retry remains idempotent after legitimate workflow progress.');
  await dbRun('UPDATE meeting_minutes SET draft_json=? WHERE id=?', ['{"editable":"unpublished working change"}', 'preserved']);
  assert.deepEqual((await resolve('preserved')).masterSignature, replacement, 'Retrieval binds to the published attestation, not an unrelated editable draft.');

  await make('access');
  await assert.rejects(service.apply(request('access', { ownerUserId: preparer })), code('OWNER_REQUIRED'));
  await assert.rejects(service.apply(request('access', { ownerUserId: secondOwner })), code('MINUTES_SIGNATURE_OWNER_REQUIRED'));
  await assert.rejects(service.inspect({ ownerUserId: preparer, minutesId: 'access' }), code('OWNER_REQUIRED'));
  await assert.rejects(service.apply(request('not-found')), code('MINUTES_NOT_FOUND'));
  await assert.rejects(service.apply(request('access', { authorizationNote: 'short' })), code('AUTHORIZATION_NOTE_REQUIRED'));
  await assert.rejects(service.apply(request('access', { expectedPdfSha256: '' })), code('EXPECTED_SIGNATURE_HASHES_REQUIRED'));
  await assert.rejects(service.apply(request('access', { expectedPdfSha256: '0'.repeat(64) })), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(service.apply(request('access', { expectedSignatureSha256: '0'.repeat(64) })), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(service.apply(request('access', { replacementSignaturePng: Buffer.from('invalid') })), code('INVALID_SIGNATURE_PNG'));
  await assert.rejects(service.apply(request('access', { replacementSignaturePng: oldSignature })), code('SIGNATURE_UNCHANGED'));
  await assert.rejects(createMinutesSignatureRevisions().apply(request('access')), code('MINUTES_SIGNATURE_RENDERER_REQUIRED'));
  await assert.rejects(service.apply(request('preserved', { replacementSignaturePng: otherReplacement })), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(service.apply(request('preserved', { expectedPdfSha256: '0'.repeat(64) })), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(resolve('preserved', { masterAttestationId: 'another-master' }), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(resolve('preserved', { preparerAttestationId: 'another-preparer' }), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await assert.rejects(resolve('preserved', { draftJson: submittedDraft }), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await make('unsigned', { status: 'draft' });
  await assert.rejects(service.apply(request('unsigned')), code('FINAL_MINUTES_REQUIRED'));
  await make('missing-master', { noMaster: true });
  await assert.rejects(service.apply(request('missing-master')), code('MINUTES_SIGNATURE_SNAPSHOT_REQUIRED'));
  await make('missing-preparer', { noPreparer: true });
  await assert.rejects(service.apply(request('missing-preparer')), code('MINUTES_SIGNATURE_SNAPSHOT_REQUIRED'));
  await make('wrong-master', { masterUserId: secondOwner });
  await assert.rejects(service.apply(request('wrong-master')), code('MINUTES_SIGNATURE_SNAPSHOT_REQUIRED'));
  assert.equal(await revisionCount('access'), 0); assert.equal(await auditCount('access'), 0);

  await make('rollback');
  const rollback = { row: await record('rollback'), attestations: await attestations('rollback'), alerts: await alerts('rollback') };
  await dbRun(`ALTER TABLE audit_events ADD CONSTRAINT reject_minutes_visual_test_audit
    CHECK (action <> 'minutes_owner_signature_visual_corrected' OR details_json::jsonb->>'minutesId' IS DISTINCT FROM 'rollback')`);
  await assert.rejects(service.apply(request('rollback')), /reject_minutes_visual_test_audit/);
  await dbRun('ALTER TABLE audit_events DROP CONSTRAINT reject_minutes_visual_test_audit');
  assert.equal(await revisionCount('rollback'), 0); assert.equal(await auditCount('rollback'), 0);
  assert.deepEqual(await record('rollback'), rollback.row); assert.deepEqual(await attestations('rollback'), rollback.attestations);
  assert.deepEqual(await alerts('rollback'), rollback.alerts, 'A failed audit rolls back the archive and leaves workflow evidence unchanged.');

  await make('concurrent');
  const concurrent = await Promise.all([service.apply(request('concurrent')), service.apply(request('concurrent'))]);
  assert.equal(concurrent.filter(result => !result.alreadyApplied).length, 1); assert.equal(concurrent[0].revisionId, concurrent[1].revisionId);
  assert.equal(await revisionCount('concurrent'), 1); assert.equal(await auditCount('concurrent'), 1);
  await make('competing');
  const competing = await Promise.allSettled([service.apply(request('competing')), service.apply(request('competing', { replacementSignaturePng: otherReplacement }))]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'MINUTES_SIGNATURE_REVISION_CONFLICT');
  assert.equal(await revisionCount('competing'), 1); assert.equal(await auditCount('competing'), 1);

  for (const [id, change] of [
    ['changed-draft', async () => dbRun('UPDATE meeting_minutes SET draft_json=? WHERE id=?', ['{"changed":true}', 'changed-draft'])],
    ['changed-status', async () => dbRun("UPDATE meeting_minutes SET status='distributed' WHERE id=?", ['changed-status'])],
    ['changed-master', async () => dbRun('UPDATE meeting_minutes_attestations SET signature_bytes=? WHERE id=?', [otherReplacement, 'changed-master-master'])],
    ['changed-preparer', async () => dbRun('UPDATE meeting_minutes_attestations SET signature_bytes=? WHERE id=?', [otherReplacement, 'changed-preparer-preparer'])],
    ['changed-name', async () => dbRun('UPDATE users SET name=? WHERE id=?', ['New display name', preparer])],
  ]) {
    await make(id);
    const racing = createMinutesSignatureRevisions({ buildOriginalPdf, replaceSignature: async input => {
      const result = await replaceSignatureImage(input); await change(); return result;
    } });
    await assert.rejects(racing.apply(request(id)), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
    assert.equal(await revisionCount(id), 0); assert.equal(await auditCount(id), 0);
    if (id === 'changed-name') await dbRun('UPDATE users SET name=? WHERE id=?', ['assistant-secretary@example.org', preparer]);
  }
  await make('changed-owner');
  const changedOwner = createMinutesSignatureRevisions({ buildOriginalPdf, replaceSignature: async input => {
    const result = await replaceSignatureImage(input); await dbRun("UPDATE users SET role='viewer' WHERE id=?", [owner]); return result;
  } });
  await assert.rejects(changedOwner.apply(request('changed-owner')), code('OWNER_REQUIRED'));
  await dbRun("UPDATE users SET role='owner' WHERE id=?", [owner]);
  assert.equal(await revisionCount('changed-owner'), 0); assert.equal(await auditCount('changed-owner'), 0);

  await make('stale'); await service.apply(request('stale'));
  await dbRun('INSERT INTO meeting_minutes_attestations(id,minutes_id,user_id,phase,draft_json,signature_bytes,created_at) VALUES (?,?,?,?,?,?,?)',
    ['stale-new-master', 'stale', owner, 'master', draft, oldSignature, laterDate]);
  await dbRun('UPDATE meeting_minutes SET master_attested_at=? WHERE id=?', [laterDate, 'stale']);
  await assert.rejects(resolve('stale', { masterAttestationId: 'stale-new-master' }), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));
  await make('changed-content'); await service.apply(request('changed-content'));
  await dbRun('UPDATE meeting_minutes_attestations SET draft_json=? WHERE id=?', [submittedDraft, 'changed-content-master']);
  await assert.rejects(resolve('changed-content', { draftJson: submittedDraft }), code('MINUTES_SIGNATURE_REVISION_CONFLICT'));

  // Insert corrupted artifacts into separate synthetic records. The real
  // append-only revision is never modified or stripped of its protections.
  for (const [id, overrides] of [
    ['bad-pdf', { corrected_pdf_bytes: Buffer.from('corrupted PDF') }],
    ['bad-original', { before_pdf_bytes: Buffer.from('corrupted original') }],
    ['bad-signature', { replacement_signature_bytes: Buffer.from('corrupted signature') }],
    ['bad-hash', { after_signature_sha256: '0'.repeat(64) }],
  ]) {
    await make(id); const current = await service.inspect({ ownerUserId: owner, minutesId: id });
    const bad = { ...revision, id: crypto.randomUUID(), minutes_id: id, master_attestation_id: `${id}-master`,
      preparer_attestation_id: `${id}-preparer`, published_snapshot_sha256: current.publishedSnapshotSha256,
      protected_row_sha256: current.protectedRowSha256, ...overrides };
    const keys = Object.keys(bad);
    await dbRun(`INSERT INTO minutes_signature_revisions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => bad[key]));
    await assert.rejects(resolve(id), code('MINUTES_SIGNATURE_REVISION_INVALID'));
  }
  await make('unverified');
  const unverified = createMinutesSignatureRevisions({ buildOriginalPdf, replaceSignature: async input => ({ ...(await replaceSignatureImage(input)), replacementCount: 2 }) });
  await assert.rejects(unverified.apply(request('unverified')), code('MINUTES_SIGNATURE_CORRECTION_NOT_VERIFIED'));
  assert.equal(await revisionCount('unverified'), 0); assert.equal(await auditCount('unverified'), 0);

  await make('pinned-during-preparation');
  const pinRace = createMinutesSignatureRevisions({ buildOriginalPdf, replaceSignature: async input => {
    const result = await replaceSignatureImage(input);
    await pinApprovedOwnerSignature({ ownerUserId: owner, expectedProfileSha256: sha(replacement), authorizationNote: note });
    return result;
  } });
  await assert.rejects(pinRace.apply(request('pinned-during-preparation', { replacementSignaturePng: otherReplacement })), code('APPROVED_SIGNATURE_REQUIRED'));
  assert.equal(await revisionCount('pinned-during-preparation'), 0); assert.equal(await auditCount('pinned-during-preparation'), 0);
  await make('pinned-policy');
  const renderCountBeforePolicyRejection = renderCalls;
  await assert.rejects(service.apply(request('pinned-policy', { replacementSignaturePng: otherReplacement })), code('APPROVED_SIGNATURE_REQUIRED'));
  assert.equal(renderCalls, renderCountBeforePolicyRejection, 'An alternate pinned-owner image is rejected before any expensive rendering.');
  assert.equal((await service.apply(request('pinned-policy'))).alreadyApplied, false, 'The approved replacement remains usable for the authorized visual correction.');
  console.log('Minutes signature revisions passed: exact published snapshots, immutable original PDFs and attestations, preparer/profile/notification preservation, ownership, append-only audit, atomic rollback, idempotent and competing concurrency, stale/corrupt retrieval rejection, current-render metadata, and no sending.');
} finally {
  await close();
}
