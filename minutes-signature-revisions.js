import crypto from 'node:crypto';
import { dbGet, dbRun, withTransaction } from './db.js';
import { replaceSignatureImage } from './signature-corrections.js';
import { assertApprovedSignature, initSignaturePolicySchema } from './signature-policy.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(value || []);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const conflict = message => failure(409, 'MINUTES_SIGNATURE_REVISION_CONFLICT', message);
const invalid = message => failure(409, 'MINUTES_SIGNATURE_REVISION_INVALID', message);
const finalStatuses = new Set(['ready_for_distribution', 'distributed', 'approved_by_lodge']);
const deliveryNote = 'The visual signature was corrected without a new attestation. No email was sent or distribution recorded.';

// Importing this module does not connect to, initialize, or change a database.
export async function initMinutesSignatureRevisionSchema() {
  await initSignaturePolicySchema();
  await dbRun(`CREATE TABLE IF NOT EXISTS minutes_signature_revisions (
    id TEXT PRIMARY KEY,
    minutes_id TEXT NOT NULL REFERENCES meeting_minutes(id),
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    master_attestation_id TEXT NOT NULL REFERENCES meeting_minutes_attestations(id),
    preparer_attestation_id TEXT NOT NULL REFERENCES meeting_minutes_attestations(id),
    before_pdf_bytes BYTEA NOT NULL,
    corrected_pdf_bytes BYTEA NOT NULL,
    before_signature_bytes BYTEA NOT NULL,
    replacement_signature_bytes BYTEA NOT NULL,
    before_pdf_sha256 TEXT NOT NULL,
    after_pdf_sha256 TEXT NOT NULL,
    before_signature_sha256 TEXT NOT NULL,
    after_signature_sha256 TEXT NOT NULL,
    preparer_signature_sha256 TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    published_snapshot_sha256 TEXT NOT NULL,
    protected_row_sha256 TEXT NOT NULL,
    original_status TEXT NOT NULL,
    original_approved_by_lodge_on TEXT,
    original_master_attested_at TEXT NOT NULL,
    original_preparer_attested_at TEXT NOT NULL,
    authorization_note TEXT NOT NULL,
    corrected_at TEXT NOT NULL,
    details_json TEXT NOT NULL,
    UNIQUE (minutes_id, master_attestation_id, preparer_attestation_id)
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS minutes_signature_revisions_minutes ON minutes_signature_revisions(minutes_id, corrected_at)');
  await dbRun(`CREATE OR REPLACE FUNCTION prevent_minutes_signature_revision_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Minutes signature revisions are append-only.' USING ERRCODE = '55000';
    END
    $$`);
  await dbRun(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'minutes_signature_revisions_append_only'
      AND tgrelid = 'minutes_signature_revisions'::regclass) THEN
      CREATE TRIGGER minutes_signature_revisions_append_only BEFORE UPDATE OR DELETE
        ON minutes_signature_revisions FOR EACH ROW EXECUTE FUNCTION prevent_minutes_signature_revision_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'minutes_signature_revisions_no_truncate'
      AND tgrelid = 'minutes_signature_revisions'::regclass) THEN
      CREATE TRIGGER minutes_signature_revisions_no_truncate BEFORE TRUNCATE
        ON minutes_signature_revisions FOR EACH STATEMENT EXECUTE FUNCTION prevent_minutes_signature_revision_change();
    END IF;
  END $$`);
}

// The published fingerprint excludes later distribution/approval progress, but
// includes both original attestations and the exact text that was attested.
function publishedFingerprint(row, master, preparer) {
  return hash(JSON.stringify({
    minutesId: row.id, meetingDate: row.meeting_date,
    createdBy: row.created_by_user_id, masterBy: row.master_attested_by_user_id,
    masterAttestedAt: row.master_attested_at, preparerAttestedAt: row.preparer_attested_at,
    master: { id: master.id, userId: master.user_id, phase: master.phase,
      createdAt: master.created_at, draftJson: master.draft_json, signatureSha256: hash(bytes(master.signature_bytes)) },
    preparer: { id: preparer.id, userId: preparer.user_id, phase: preparer.phase,
      createdAt: preparer.created_at, draftJson: preparer.draft_json, signatureSha256: hash(bytes(preparer.signature_bytes)) },
  }));
}

async function snapshot(minutesId, { ownerUserId = null, lock = false } = {}) {
  if (ownerUserId != null) {
    const owner = await dbGet(`SELECT id, role, access_revoked_at FROM users WHERE id = ?${lock ? ' FOR SHARE' : ''}`, [ownerUserId]);
    if (!owner || owner.role !== 'owner' || owner.access_revoked_at) {
      throw failure(403, 'OWNER_REQUIRED', 'Only the active Worshipful Master account may correct its own visual signature.');
    }
  }
  const row = await dbGet(`SELECT * FROM meeting_minutes WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [minutesId]);
  if (!row) throw failure(404, 'MINUTES_NOT_FOUND', 'Meeting minutes not found.');
  if (!finalStatuses.has(row.status) || !row.master_attested_at || !row.preparer_attested_at) {
    throw failure(409, 'FINAL_MINUTES_REQUIRED', 'Only finalized minutes with both original attestations may receive this visual correction.');
  }
  const master = await dbGet(`SELECT * FROM meeting_minutes_attestations WHERE minutes_id = ? AND phase = 'master'
    ORDER BY created_at DESC, id DESC LIMIT 1${lock ? ' FOR SHARE' : ''}`, [minutesId]);
  const preparer = await dbGet(`SELECT * FROM meeting_minutes_attestations WHERE minutes_id = ? AND phase = 'preparer'
    ORDER BY created_at DESC, id DESC LIMIT 1${lock ? ' FOR SHARE' : ''}`, [minutesId]);
  if (!master || !preparer || master.user_id !== row.master_attested_by_user_id ||
      preparer.user_id !== row.created_by_user_id || master.created_at !== row.master_attested_at ||
      preparer.created_at !== row.preparer_attested_at || !bytes(master.signature_bytes).length || !bytes(preparer.signature_bytes).length) {
    throw failure(409, 'MINUTES_SIGNATURE_SNAPSHOT_REQUIRED', 'The exact original preparing officer and Worshipful Master attestations must be retained.');
  }
  if (ownerUserId != null && master.user_id !== ownerUserId) {
    throw failure(403, 'MINUTES_SIGNATURE_OWNER_REQUIRED', 'Only the Worshipful Master who attested these minutes may correct that signature.');
  }
  const names = await dbGet(`SELECT creator.name AS created_by_name, creator.role AS created_by_role,
    master.name AS master_attested_by_name FROM users creator CROSS JOIN users master WHERE creator.id = ? AND master.id = ?`,
  [row.created_by_user_id, master.user_id]);
  return { row: { ...row, ...names }, masterAttestation: master, preparerAttestation: preparer,
    signature: bytes(master.signature_bytes), signatureSha256: hash(bytes(master.signature_bytes)),
    preparerSignatureSha256: hash(bytes(preparer.signature_bytes)), contentSha256: hash(master.draft_json),
    publishedSnapshotSha256: publishedFingerprint(row, master, preparer),
    protectedRowSha256: hash(JSON.stringify({ row, names })) };
}

async function retainedRevision(minutesId) {
  return dbGet('SELECT * FROM minutes_signature_revisions WHERE minutes_id = ? ORDER BY corrected_at DESC, id DESC LIMIT 1', [minutesId]);
}

function verifyRevision(current, revision) {
  if (revision.minutes_id !== current.row.id || revision.owner_user_id !== current.masterAttestation.user_id ||
      revision.master_attestation_id !== current.masterAttestation.id || revision.preparer_attestation_id !== current.preparerAttestation.id ||
      revision.content_sha256 !== current.contentSha256 || revision.published_snapshot_sha256 !== current.publishedSnapshotSha256 ||
      revision.before_signature_sha256 !== current.signatureSha256 || revision.preparer_signature_sha256 !== current.preparerSignatureSha256 ||
      revision.original_master_attested_at !== current.row.master_attested_at || revision.original_preparer_attested_at !== current.row.preparer_attested_at) {
    throw conflict('The published minutes or their original attestations changed after the visual correction. Nothing was substituted.');
  }
  for (const [dataKey, hashKey] of [['before_pdf_bytes', 'before_pdf_sha256'], ['corrected_pdf_bytes', 'after_pdf_sha256'],
    ['before_signature_bytes', 'before_signature_sha256'], ['replacement_signature_bytes', 'after_signature_sha256']]) {
    if (!bytes(revision[dataKey]).length || !validHash(revision[hashKey]) || hash(bytes(revision[dataKey])) !== revision[hashKey]) {
      throw invalid('A retained minutes visual-correction artifact could not be verified. Nothing was substituted.');
    }
  }
  if (!bytes(revision.before_signature_bytes).equals(current.signature) || revision.before_pdf_sha256 === revision.after_pdf_sha256 ||
      revision.before_signature_sha256 === revision.after_signature_sha256 || !finalStatuses.has(revision.original_status)) {
    throw invalid('The retained visual correction does not identify a distinct, verified signature replacement.');
  }
}

const resultFor = (revision, alreadyApplied) => ({ revisionId: revision.id, minutesId: revision.minutes_id, alreadyApplied,
  beforePdfSha256: revision.before_pdf_sha256, afterPdfSha256: revision.after_pdf_sha256,
  beforeSignatureSha256: revision.before_signature_sha256, afterSignatureSha256: revision.after_signature_sha256,
  correctedAt: revision.corrected_at, sent: false, deliveryNote });

export function createMinutesSignatureRevisions({ buildOriginalPdf, replaceSignature = replaceSignatureImage } = {}) {
  async function inspect({ ownerUserId, minutesId } = {}) {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || typeof minutesId !== 'string' || !minutesId.trim() || minutesId.length > 200) {
      throw failure(400, 'INVALID_MINUTES_SIGNATURE_REVISION_REQUEST', 'Meeting minutes and their attesting Worshipful Master account are required.');
    }
    return snapshot(minutesId, { ownerUserId });
  }

  async function resolve({ minutesId, masterAttestationId, preparerAttestationId, draftJson } = {}) {
    if (typeof minutesId !== 'string' || !minutesId.trim() || minutesId.length > 200) {
      throw failure(400, 'INVALID_MINUTES_SIGNATURE_REVISION_REQUEST', 'A meeting minutes record is required.');
    }
    const revision = await retainedRevision(minutesId);
    if (!revision) return null;
    const current = await snapshot(minutesId);
    if (masterAttestationId !== current.masterAttestation.id || preparerAttestationId !== current.preparerAttestation.id ||
        typeof draftJson !== 'string' || draftJson !== current.masterAttestation.draft_json) {
      throw conflict('The requested minutes do not match the current published attestation snapshots.');
    }
    verifyRevision(current, revision);
    return { pdfBytes: bytes(revision.corrected_pdf_bytes), masterSignature: bytes(revision.replacement_signature_bytes),
      useRetainedPdf: current.row.status === revision.original_status &&
        (current.row.approved_by_lodge_on || null) === (revision.original_approved_by_lodge_on || null),
      revisionId: revision.id, beforePdfSha256: revision.before_pdf_sha256, afterPdfSha256: revision.after_pdf_sha256 };
  }

  async function apply({ ownerUserId, minutesId, replacementSignaturePng, expectedPdfSha256,
    expectedSignatureSha256, authorizationNote } = {}) {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || typeof minutesId !== 'string' || !minutesId.trim() || minutesId.length > 200) {
      throw failure(400, 'INVALID_MINUTES_SIGNATURE_REVISION_REQUEST', 'Meeting minutes and their attesting Worshipful Master account are required.');
    }
    if (!validHash(expectedPdfSha256) || !validHash(expectedSignatureSha256)) {
      throw failure(400, 'EXPECTED_SIGNATURE_HASHES_REQUIRED', 'Provide the inspected PDF and signature SHA-256 hashes.');
    }
    expectedPdfSha256 = expectedPdfSha256.toLowerCase(); expectedSignatureSha256 = expectedSignatureSha256.toLowerCase();
    const note = String(authorizationNote || '').trim();
    if (note.length < 10 || note.length > 2000) throw failure(400, 'AUTHORIZATION_NOTE_REQUIRED', 'Record the owner authorization and correction reason in 10 to 2000 characters.');
    const replacement = bytes(replacementSignaturePng);
    if (!replacement.length || replacement.length > 8_000_000) throw failure(400, 'REPLACEMENT_SIGNATURE_REQUIRED', 'Provide the verified replacement signature PNG.');
    const replacementHash = hash(replacement);
    const initial = await snapshot(minutesId, { ownerUserId });
    await assertApprovedSignature({ id: ownerUserId }, replacement);
    const replay = async current => {
      const revision = await retainedRevision(minutesId);
      if (!revision) return null;
      verifyRevision(current, revision);
      const originalPair = expectedPdfSha256 === revision.before_pdf_sha256 && expectedSignatureSha256 === revision.before_signature_sha256;
      const correctedPair = expectedPdfSha256 === revision.after_pdf_sha256 && expectedSignatureSha256 === revision.after_signature_sha256;
      if (replacementHash !== revision.after_signature_sha256 || (!originalPair && !correctedPair)) {
        throw conflict('The minutes already have a visual correction that differs from the inspected request. Reload the record before continuing.');
      }
      return resultFor(revision, true);
    };
    const prior = await replay(initial);
    if (prior) return prior;
    if (initial.signatureSha256 !== expectedSignatureSha256) throw conflict('The captured Worshipful Master signature differs from the inspected signature.');
    if (typeof buildOriginalPdf !== 'function') throw failure(500, 'MINUTES_SIGNATURE_RENDERER_REQUIRED', 'The original signed minutes renderer is not configured.');
    const originalPdf = bytes(await buildOriginalPdf(initial));
    if (!originalPdf.length || hash(originalPdf) !== expectedPdfSha256) throw conflict('The original published minutes PDF differs from the inspected PDF. Nothing was corrected.');
    const prepared = await replaceSignature({ pdfBytes: originalPdf, oldSignaturePng: initial.signature, replacementSignaturePng: replacement, alignInkBottom: true });
    const correctedPdf = bytes(prepared.pdfBytes), correctedHash = hash(correctedPdf);
    if (!correctedPdf.length || prepared.replacementCount !== 1 || prepared.beforeSha256 !== expectedPdfSha256 ||
        prepared.oldSignatureSha256 !== initial.signatureSha256 || prepared.replacementSignatureSha256 !== replacementHash ||
        prepared.afterSha256 !== correctedHash || correctedHash === expectedPdfSha256) {
      throw failure(409, 'MINUTES_SIGNATURE_CORRECTION_NOT_VERIFIED', 'The visual correction did not produce a verified replacement PDF.');
    }
    return withTransaction(async () => {
      const current = await snapshot(minutesId, { ownerUserId, lock: true });
      await assertApprovedSignature({ id: ownerUserId }, replacement);
      const repeated = await replay(current);
      if (repeated) return repeated;
      if (current.protectedRowSha256 !== initial.protectedRowSha256 || current.publishedSnapshotSha256 !== initial.publishedSnapshotSha256) {
        throw conflict('The minutes or their original attestations changed while the visual correction was prepared. Nothing was corrected.');
      }
      const revisionId = crypto.randomUUID(), correctedAt = new Date().toISOString();
      const details = { revisionId, minutesId, correctionType: 'minutes_owner_visual_signature_only', authorizationNote: note,
        masterAttestationId: current.masterAttestation.id, preparerAttestationId: current.preparerAttestation.id,
        originalMasterAttestedAt: current.row.master_attested_at, originalPreparerAttestedAt: current.row.preparer_attested_at,
        originalStatus: current.row.status, contentSha256: current.contentSha256, protectedRowSha256: current.protectedRowSha256,
        publishedSnapshotSha256: current.publishedSnapshotSha256, beforePdfSha256: expectedPdfSha256, afterPdfSha256: correctedHash,
        beforeSignatureSha256: current.signatureSha256, afterSignatureSha256: replacementHash,
        preparerSignatureSha256: current.preparerSignatureSha256, pageNumber: prepared.pageNumber,
        imageReference: prepared.imageReference, originalDistributionAt: current.row.distributed_at || null,
        originalAuthorizationAt: current.row.authorized_at || null, originalLodgeApprovalOn: current.row.approved_by_lodge_on || null,
        originalDates: Object.fromEntries(Object.entries(current.row).filter(([key]) => /_(?:at|on)$/.test(key))),
        correctedPdfResent: false, deliveryNote };
      await dbRun(`INSERT INTO minutes_signature_revisions
        (id, minutes_id, owner_user_id, master_attestation_id, preparer_attestation_id,
         before_pdf_bytes, corrected_pdf_bytes, before_signature_bytes, replacement_signature_bytes,
         before_pdf_sha256, after_pdf_sha256, before_signature_sha256, after_signature_sha256,
         preparer_signature_sha256, content_sha256, published_snapshot_sha256, protected_row_sha256,
         original_status, original_approved_by_lodge_on, original_master_attested_at, original_preparer_attested_at, authorization_note, corrected_at, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [revisionId, minutesId, ownerUserId, current.masterAttestation.id, current.preparerAttestation.id,
        originalPdf, correctedPdf, current.signature, replacement, expectedPdfSha256, correctedHash, current.signatureSha256,
        replacementHash, current.preparerSignatureSha256, current.contentSha256, current.publishedSnapshotSha256,
        current.protectedRowSha256, current.row.status, current.row.approved_by_lodge_on || null, current.row.master_attested_at, current.row.preparer_attested_at,
        note, correctedAt, JSON.stringify(details)]);
      await dbRun(`INSERT INTO audit_events (user_id, action, details_json, created_at)
        VALUES (?, 'minutes_owner_signature_visual_corrected', ?, ?)`, [ownerUserId, JSON.stringify(details), correctedAt]);
      return resultFor({ id: revisionId, minutes_id: minutesId, before_pdf_sha256: expectedPdfSha256,
        after_pdf_sha256: correctedHash, before_signature_sha256: current.signatureSha256,
        after_signature_sha256: replacementHash, corrected_at: correctedAt }, false);
    });
  }
  return { apply, resolve, inspect };
}
