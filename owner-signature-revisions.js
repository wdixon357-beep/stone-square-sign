import crypto from 'node:crypto';
import { dbGet, dbAll, dbRun, withTransaction } from './db.js';
import { replaceSignatureImage } from './signature-corrections.js';
import { initSignaturePolicySchema, assertApprovedSignature } from './signature-policy.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(value || []);
const conflict = message => Object.assign(new Error(message), { code: 'SIGNATURE_REVISION_CONFLICT', statusCode: 409 });
const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const DELIVERY_NOTE = 'Prior delivery history applies to the previous PDF bytes. The corrected PDF was not resent.';

// Initialization is explicit. Importing this module never connects to or changes a database.
export async function initOwnerSignatureRevisionSchema() {
  await initSignaturePolicySchema();
  await dbRun(`CREATE TABLE IF NOT EXISTS owner_signature_revisions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    wm_signer_id INTEGER NOT NULL REFERENCES document_signers(id),
    before_pdf_bytes BYTEA NOT NULL,
    before_signature_bytes BYTEA NOT NULL,
    before_pdf_sha256 TEXT NOT NULL,
    before_signature_sha256 TEXT NOT NULL,
    after_pdf_sha256 TEXT NOT NULL,
    after_signature_sha256 TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    original_file_sha256 TEXT NOT NULL,
    original_signed_at TEXT NOT NULL,
    authorization_note TEXT NOT NULL,
    corrected_at TEXT NOT NULL,
    details_json TEXT NOT NULL
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS owner_signature_revisions_document ON owner_signature_revisions(document_id, corrected_at)');
  await dbRun(`CREATE OR REPLACE FUNCTION prevent_owner_signature_revision_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Owner signature revisions are append-only.' USING ERRCODE = '55000';
    END
    $$`);
  await dbRun(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'owner_signature_revisions_append_only'
      AND tgrelid = 'owner_signature_revisions'::regclass) THEN
      CREATE TRIGGER owner_signature_revisions_append_only BEFORE UPDATE OR DELETE
        ON owner_signature_revisions FOR EACH ROW EXECUTE FUNCTION prevent_owner_signature_revision_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'owner_signature_revisions_no_truncate'
      AND tgrelid = 'owner_signature_revisions'::regclass) THEN
      CREATE TRIGGER owner_signature_revisions_no_truncate BEFORE TRUNCATE
        ON owner_signature_revisions FOR EACH STATEMENT EXECUTE FUNCTION prevent_owner_signature_revision_change();
    END IF;
  END $$`);
}

async function snapshot(ownerUserId, documentId, lock = false) {
  const owner = await dbGet(`SELECT id, role, access_revoked_at FROM users WHERE id = ?${lock ? ' FOR SHARE' : ''}`, [ownerUserId]);
  if (!owner || owner.role !== 'owner' || owner.access_revoked_at) {
    throw failure(403, 'OWNER_REQUIRED', 'Only the active Worshipful Master account may correct its own visual signature.');
  }
  const document = await dbGet(`SELECT * FROM documents WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [documentId]);
  if (!document) throw failure(404, 'DOCUMENT_NOT_FOUND', 'Dispensation not found.');
  if (document.owner_user_id !== ownerUserId) throw failure(403, 'DOCUMENT_OWNER_REQUIRED', 'Only this document owner may correct its own visual signature.');
  if (document.template_kind !== 'dispensation_v1') throw failure(409, 'DISPENSATION_REQUIRED', 'Visual signature correction is restricted to official dispensations.');
  if (!['completed', 'partially_signed'].includes(document.status)) throw failure(409, 'ACTIVE_SIGNED_DOCUMENT_REQUIRED', 'Only an active signed dispensation may receive this visual correction.');
  const signers = await dbAll(`SELECT * FROM document_signers WHERE document_id = ? ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [documentId]);
  const owned = signers.filter(signer => signer.signer_role === 'worshipful_master' && signer.user_id === ownerUserId && signer.signed_at && !signer.superseded_at);
  if (owned.length !== 1) throw failure(409, 'OWN_SIGNATURE_REQUIRED', 'Exactly one captured Worshipful Master signature belonging to this account is required.');
  const signer = owned[0], pdf = bytes(document.signed_bytes), signature = bytes(signer.signature_bytes), original = bytes(document.file_bytes);
  if (!pdf.length || !signature.length || !original.length) throw failure(409, 'SIGNATURE_RECORD_INCOMPLETE', 'The signed PDF, original PDF, and captured owner signature must all be retained.');
  return { document, signer, signers, pdf, signature, original,
    pdfSha256: hash(pdf), signatureSha256: hash(signature), originalSha256: hash(original) };
}

async function replay(current, replacementHash, expectedPdf, expectedSignature) {
  if (current.signatureSha256 !== replacementHash) return null;
  const revision = await dbGet(`SELECT id, before_pdf_sha256, before_signature_sha256, corrected_at
    FROM owner_signature_revisions WHERE document_id = ? AND owner_user_id = ?
      AND after_pdf_sha256 = ? AND after_signature_sha256 = ? ORDER BY corrected_at DESC, id DESC LIMIT 1`,
  [current.document.id, current.document.owner_user_id, current.pdfSha256, replacementHash]);
  const expectedCurrent = expectedPdf === current.pdfSha256 && expectedSignature === current.signatureSha256;
  const expectedPrior = revision && expectedPdf === revision.before_pdf_sha256 && expectedSignature === revision.before_signature_sha256;
  if (!expectedCurrent && !expectedPrior) throw conflict('The signature or PDF changed after it was inspected. Reload the record before continuing.');
  return { revisionId: revision?.id || null, documentId: current.document.id, alreadyApplied: true,
    beforePdfSha256: revision?.before_pdf_sha256 || current.pdfSha256, afterPdfSha256: current.pdfSha256,
    afterSignatureSha256: replacementHash, correctedAt: revision?.corrected_at || null,
    sent: false, deliveryNote: DELIVERY_NOTE };
}

export function createOwnerSignatureRevisions({ replaceSignature = replaceSignatureImage } = {}) {
  async function apply({ ownerUserId, documentId, replacementSignaturePng, expectedPdfSha256,
    expectedSignatureSha256, authorizationNote } = {}) {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || typeof documentId !== 'string' || !documentId.trim() || documentId.length > 200) {
      throw failure(400, 'INVALID_SIGNATURE_REVISION_REQUEST', 'A document and its owner account are required.');
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
    await assertApprovedSignature({ id: ownerUserId }, replacement);
    const initial = await snapshot(ownerUserId, documentId);
    const prior = await replay(initial, replacementHash, expectedPdfSha256, expectedSignatureSha256);
    if (prior) return prior;
    if (initial.pdfSha256 !== expectedPdfSha256 || initial.signatureSha256 !== expectedSignatureSha256) {
      throw conflict('The signature or PDF changed after it was inspected. Reload the record before continuing.');
    }

    // PDF parsing and validation can be expensive; never hold database row locks while preparing it.
    const prepared = await replaceSignature({ pdfBytes: initial.pdf, oldSignaturePng: initial.signature, replacementSignaturePng: replacement });
    const corrected = bytes(prepared.pdfBytes), correctedHash = hash(corrected);
    if (!corrected.length || prepared.replacementCount !== 1 || prepared.beforeSha256 !== initial.pdfSha256 ||
        prepared.oldSignatureSha256 !== initial.signatureSha256 || prepared.replacementSignatureSha256 !== replacementHash ||
        prepared.afterSha256 !== correctedHash || correctedHash === initial.pdfSha256) {
      throw failure(409, 'SIGNATURE_CORRECTION_NOT_VERIFIED', 'The visual correction did not produce a verified replacement PDF.');
    }

    return withTransaction(async () => {
      const current = await snapshot(ownerUserId, documentId, true);
      await assertApprovedSignature({ id: ownerUserId }, replacement);
      const repeated = await replay(current, replacementHash, expectedPdfSha256, expectedSignatureSha256);
      if (repeated) return repeated;
      if (current.pdfSha256 !== initial.pdfSha256 || current.signatureSha256 !== initial.signatureSha256 ||
          current.originalSha256 !== initial.originalSha256 || current.signer.id !== initial.signer.id ||
          current.signer.signed_at !== initial.signer.signed_at) {
        throw conflict('The dispensation or its signature changed while the visual correction was prepared. Nothing was corrected.');
      }
      const revisionId = crypto.randomUUID(), correctedAt = new Date().toISOString();
      const details = {
        revisionId, correctionType: 'owner_visual_signature_only', ownerSignerId: current.signer.id,
        originalSignatureDate: current.signer.signed_at, authorizationNote: note,
        beforePdfSha256: current.pdfSha256, afterPdfSha256: correctedHash,
        beforeSignatureSha256: current.signatureSha256, afterSignatureSha256: replacementHash,
        sourceSha256: replacementHash, originalFileSha256: current.originalSha256,
        unchangedSignerIds: current.signers.filter(signer => signer.id !== current.signer.id).map(signer => signer.id),
        pageNumber: prepared.pageNumber, imageReference: prepared.imageReference,
        submittedAtBeforeCorrection: current.document.submitted_at || null,
        submittedToBeforeCorrection: current.document.submitted_to || null,
        deliveryNote: DELIVERY_NOTE, correctedPdfResent: false,
      };
      await dbRun(`INSERT INTO owner_signature_revisions
        (id, document_id, owner_user_id, wm_signer_id, before_pdf_bytes, before_signature_bytes,
         before_pdf_sha256, before_signature_sha256, after_pdf_sha256, after_signature_sha256,
         source_sha256, original_file_sha256, original_signed_at, authorization_note, corrected_at, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [revisionId, documentId, ownerUserId, current.signer.id, current.pdf, current.signature,
        current.pdfSha256, current.signatureSha256, correctedHash, replacementHash,
        replacementHash, current.originalSha256, current.signer.signed_at, note, correctedAt, JSON.stringify(details)]);
      const changedDocument = await dbRun('UPDATE documents SET signed_bytes = ?, updated_at = ? WHERE id = ?', [corrected, correctedAt, documentId]);
      const changedSigner = await dbRun('UPDATE document_signers SET signature_bytes = ? WHERE id = ? AND document_id = ? AND user_id = ?',
        [replacement, current.signer.id, documentId, ownerUserId]);
      if (changedDocument.changes !== 1 || changedSigner.changes !== 1) throw conflict('The visual signature correction could not be stored atomically.');
      await dbRun(`INSERT INTO audit_events (user_id, document_id, action, details_json, created_at)
        VALUES (?, ?, 'owner_signature_visual_corrected', ?, ?)`, [ownerUserId, documentId, JSON.stringify(details), correctedAt]);
      return { revisionId, documentId, alreadyApplied: false, beforePdfSha256: current.pdfSha256,
        afterPdfSha256: correctedHash, afterSignatureSha256: replacementHash, correctedAt,
        sent: false, deliveryNote: DELIVERY_NOTE };
    });
  }
  return { apply };
}
