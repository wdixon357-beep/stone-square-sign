import crypto from 'node:crypto';
import { dbGet, dbRun, withTransaction } from './db.js';

const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const validUserId = value => Number.isSafeInteger(value) && value > 0;
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const signatureBytes = value => Buffer.isBuffer(value) ? value : value instanceof Uint8Array
  ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Initialization is explicit. Importing this module does not open a database,
// select an image, or approve a signature on anyone's behalf.
export async function initSignaturePolicySchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS owner_signature_policies (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    signature_sha256 TEXT NOT NULL CHECK (signature_sha256 ~ '^[a-f0-9]{64}$'),
    authorization_note TEXT NOT NULL CHECK (length(authorization_note) BETWEEN 10 AND 2000),
    authorized_at TEXT NOT NULL
  )`);
  await dbRun(`CREATE OR REPLACE FUNCTION prevent_owner_signature_policy_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Approved owner signature policies are append-only.' USING ERRCODE = '55000';
    END
    $$`);
  await dbRun(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'owner_signature_policies_append_only'
      AND tgrelid = 'owner_signature_policies'::regclass) THEN
      CREATE TRIGGER owner_signature_policies_append_only BEFORE UPDATE OR DELETE
        ON owner_signature_policies FOR EACH ROW EXECUTE FUNCTION prevent_owner_signature_policy_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'owner_signature_policies_no_truncate'
      AND tgrelid = 'owner_signature_policies'::regclass) THEN
      CREATE TRIGGER owner_signature_policies_no_truncate BEFORE TRUNCATE
        ON owner_signature_policies FOR EACH STATEMENT EXECUTE FUNCTION prevent_owner_signature_policy_change();
    END IF;
  END $$`);
}

// Pin only the current, independently inspected saved image. The same users
// row lock must precede a profile write, so a pre-pin save cannot race the pin.
export async function pinApprovedOwnerSignature({ ownerUserId, expectedProfileSha256, authorizationNote } = {}) {
  if (!validUserId(ownerUserId) || !validHash(expectedProfileSha256)) {
    throw failure(400, 'INVALID_SIGNATURE_POLICY_REQUEST', 'Provide the owner account and the inspected saved signature SHA-256.');
  }
  const note = typeof authorizationNote === 'string' ? authorizationNote.trim() : '';
  if (note.length < 10 || note.length > 2000) {
    throw failure(400, 'SIGNATURE_AUTHORIZATION_REQUIRED', 'Record the owner authorization in 10 to 2000 characters.');
  }
  const expected = expectedProfileSha256.toLowerCase();
  return withTransaction(async () => {
    const owner = await dbGet('SELECT id, role, access_revoked_at FROM users WHERE id = ? FOR UPDATE', [ownerUserId]);
    if (!owner || owner.role !== 'owner' || owner.access_revoked_at) {
      throw failure(403, 'OWNER_REQUIRED', 'Only the active Worshipful Master account may pin its approved signature.');
    }
    const profile = await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id = ? FOR UPDATE', [ownerUserId]);
    const current = signatureBytes(profile?.signature_bytes);
    if (!current?.length || sha256(current) !== expected) {
      throw failure(409, 'SIGNATURE_POLICY_PROFILE_CONFLICT', 'The saved signature differs from the image inspected for approval. Nothing was pinned.');
    }
    const existing = await dbGet('SELECT signature_sha256, authorized_at FROM owner_signature_policies WHERE user_id = ?', [ownerUserId]);
    if (existing) {
      if (existing.signature_sha256 !== expected) {
        throw failure(409, 'SIGNATURE_POLICY_CONFLICT', 'A different approved signature is already pinned to this account.');
      }
      return { userId: ownerUserId, locked: true, alreadyPinned: true, authorizedAt: existing.authorized_at };
    }
    const authorizedAt = new Date().toISOString();
    await dbRun(`INSERT INTO owner_signature_policies (user_id, signature_sha256, authorization_note, authorized_at)
      VALUES (?, ?, ?, ?)`, [ownerUserId, expected, note, authorizedAt]);
    await dbRun(`INSERT INTO audit_events (user_id, action, details_json, created_at)
      VALUES (?, 'owner_signature_profile_pinned', ?, ?)`,
    [ownerUserId, JSON.stringify({ signatureSha256: expected, authorizationNote: note, authorizedAt }), authorizedAt]);
    return { userId: ownerUserId, locked: true, alreadyPinned: false, authorizedAt };
  });
}

// Return only presentation policy. The image digest and approval record stay
// server-side. Resolve by identity, not a possibly stale caller role string.
export async function signatureProfilePolicyForUser(user) {
  if (!validUserId(user?.id)) return { locked: false };
  const policy = await dbGet('SELECT 1 FROM owner_signature_policies WHERE user_id = ?', [user.id]);
  return { locked: Boolean(policy) };
}

export async function assertApprovedSignature(user, bytes) {
  if (!validUserId(user?.id)) {
    throw failure(403, 'SIGNATURE_ACCOUNT_REQUIRED', 'A signed-in account is required to use a signature.');
  }
  const policy = await dbGet('SELECT signature_sha256 FROM owner_signature_policies WHERE user_id = ?', [user.id]);
  if (!policy) return;
  const supplied = signatureBytes(bytes);
  if (!supplied?.length || sha256(supplied) !== policy.signature_sha256) {
    throw failure(409, 'APPROVED_SIGNATURE_REQUIRED', 'Use the approved saved Worshipful Master signature. A different signature cannot replace it.');
  }
}
