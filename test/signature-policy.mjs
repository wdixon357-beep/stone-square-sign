import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connect, initSchema, dbGet, dbAll, dbRun, close, withTransaction } from '../db.js';
import { initSignaturePolicySchema, pinApprovedOwnerSignature, signatureProfilePolicyForUser, assertApprovedSignature } from '../signature-policy.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Use only an isolated in-memory database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Do not use an existing local database.');
// The policy import above must succeed before connect() has ever been called.
await assert.rejects(signatureProfilePolicyForUser({id:1}), /connect\(\) was never called/,
  'Importing the policy module must leave the database disconnected.');
await connect(); await initSchema(); await initSignaturePolicySchema();
await initSignaturePolicySchema();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const originalDate = '2026-10-15T23:01:02.123Z';
const approved = Buffer.from('synthetic independently inspected owner image');
const different = Buffer.from('synthetic different image, including a typed or initials image');
const note = 'The owner explicitly approved this inspected saved image as the permanent signature.';
const code = value => error => error.code === value;
const policyFor = user => dbGet('SELECT * FROM owner_signature_policies WHERE user_id = ?', [user.id]);
const auditsFor = user => dbAll("SELECT * FROM audit_events WHERE user_id = ? AND action = 'owner_signature_profile_pinned'", [user.id]);
async function user(name, role = 'owner', bytes = approved) {
  const { lastID } = await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
    [`${name}@example.test`, 'unused', name, role, originalDate]);
  if (bytes) await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,style_name,updated_at) VALUES (?,?,?,?,?)',
    [lastID, bytes, 'drawn', 'Synthetic original style', originalDate]);
  return { id: lastID, role };
}
const owner = await user('owner');
const otherOwner = await user('other-owner');
const secretary = await user('secretary', 'secretary');
const assistant = await user('assistant', 'assistant_secretary');
const revoked = await user('revoked');
const missingProfile = await user('missing-profile', 'owner', null);
await dbRun('UPDATE users SET access_revoked_at = ? WHERE id = ?', [originalDate, revoked.id]);
await dbRun(`INSERT INTO documents(id,original_name,stored_name,owner_user_id,file_bytes,status,created_at,updated_at)
  VALUES ('signed-history','signed.pdf','signed.pdf',?,?,'completed',?,?)`, [owner.id, Buffer.from('original signed PDF'), originalDate, originalDate]);
await dbRun(`INSERT INTO document_signers(document_id,user_id,signer_role,signer_name,signed_at,signature_bytes,consent_text)
  VALUES ('signed-history',?,'worshipful_master','Original owner',?,?,'Original consent retained.')`, [owner.id, originalDate, different]);
await dbRun(`INSERT INTO audit_events(user_id,document_id,action,details_json,created_at)
  VALUES (?,'signed-history','document_signed',?,?)`, [owner.id, JSON.stringify({ original: true }), originalDate]);
const beforeProfile = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [owner.id]);
const beforeSigning = await dbAll("SELECT * FROM document_signers WHERE document_id = 'signed-history'");
const beforeSigningAudit = await dbAll("SELECT * FROM audit_events WHERE document_id = 'signed-history'");
const pin = (account, overrides = {}) => pinApprovedOwnerSignature({ownerUserId: account.id, expectedProfileSha256: sha(approved), authorizationNote: note, ...overrides});

try {
  assert.deepEqual(await signatureProfilePolicyForUser(owner), { locked: false });
  assert.equal((await dbGet('SELECT COUNT(*) AS total FROM owner_signature_policies')).total, 0, 'Schema initialization does not pin any image.');
  await assertApprovedSignature(owner, different);
  await assertApprovedSignature(secretary, different);
  await assert.rejects(pin(secretary), code('OWNER_REQUIRED'));
  await assert.rejects(pin({ id: 9999 }), code('OWNER_REQUIRED'));
  await assert.rejects(pin(revoked), code('OWNER_REQUIRED'));
  await assert.rejects(pin(missingProfile), code('SIGNATURE_POLICY_PROFILE_CONFLICT'));
  await assert.rejects(pin(owner, {expectedProfileSha256: sha(different)}), code('SIGNATURE_POLICY_PROFILE_CONFLICT'));
  await assert.rejects(pin(owner, {expectedProfileSha256: 'not-a-sha256'}), code('INVALID_SIGNATURE_POLICY_REQUEST'));
  await assert.rejects(pin(owner, {authorizationNote: ''}), code('SIGNATURE_AUTHORIZATION_REQUIRED'));
  await assert.rejects(pin(owner, {authorizationNote: 'short'}), code('SIGNATURE_AUTHORIZATION_REQUIRED'));
  await assert.rejects(pin(owner, {authorizationNote: 'x'.repeat(2001)}), code('SIGNATURE_AUTHORIZATION_REQUIRED'));
  assert.equal((await dbGet('SELECT COUNT(*) AS total FROM owner_signature_policies')).total, 0);
  assert.equal((await auditsFor(owner)).length, 0);

  const started = Date.now();
  const installed = await pin(owner, {expectedProfileSha256: sha(approved).toUpperCase(), authorizedAt: '1900-01-01T00:00:00.000Z'});
  const finished = Date.now();
  assert.deepEqual(Object.keys(installed).sort(), ['alreadyPinned','authorizedAt','locked','userId']);
  assert.equal(installed.alreadyPinned, false);
  assert.equal(installed.locked, true);
  assert.ok(Date.parse(installed.authorizedAt) >= started && Date.parse(installed.authorizedAt) <= finished,
    'The approval record timestamp is generated by the server, not supplied by the caller.');
  const policy = await policyFor(owner);
  assert.equal(policy.signature_sha256, sha(approved));
  assert.equal(policy.authorization_note, note);
  assert.equal(policy.authorized_at, installed.authorizedAt);
  const audit = (await auditsFor(owner))[0];
  assert.equal(audit.created_at, installed.authorizedAt);
  assert.deepEqual(JSON.parse(audit.details_json), {signatureSha256: sha(approved), authorizationNote: note, authorizedAt: installed.authorizedAt});
  assert.deepEqual(await signatureProfilePolicyForUser(owner), { locked: true }, 'Client policy reveals no image hash or authorization details.');
  assert.deepEqual(await signatureProfilePolicyForUser(otherOwner), { locked: false });
  assert.deepEqual(await signatureProfilePolicyForUser(secretary), { locked: false });
  assert.deepEqual(await signatureProfilePolicyForUser(null), { locked: false });
  await assertApprovedSignature(owner, approved);
  await assertApprovedSignature(owner, new Uint8Array(approved));
  await assert.rejects(assertApprovedSignature(owner, different), code('APPROVED_SIGNATURE_REQUIRED'));
  await assert.rejects(assertApprovedSignature(owner, approved.toString('base64')), code('APPROVED_SIGNATURE_REQUIRED'));
  await assert.rejects(assertApprovedSignature(owner, Buffer.alloc(0)), code('APPROVED_SIGNATURE_REQUIRED'));
  await assert.rejects(assertApprovedSignature(owner, null), code('APPROVED_SIGNATURE_REQUIRED'));
  await assert.rejects(assertApprovedSignature({...owner, role: 'secretary'}, different), code('APPROVED_SIGNATURE_REQUIRED'));
  await assert.rejects(assertApprovedSignature(null, approved), code('SIGNATURE_ACCOUNT_REQUIRED'));
  for (const account of [otherOwner, secretary, assistant]) await assertApprovedSignature(account, different);

  const repeated = await pin(owner, {authorizationNote: 'An idempotent retry must retain the original authorization record.'});
  assert.equal(repeated.alreadyPinned, true);
  assert.equal(repeated.authorizedAt, installed.authorizedAt);
  assert.deepEqual(await policyFor(owner), policy);
  assert.equal((await auditsFor(owner)).length, 1, 'Idempotent retries do not duplicate an approval or audit event.');
  assert.deepEqual(await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [owner.id]), beforeProfile);
  assert.deepEqual(await dbAll("SELECT * FROM document_signers WHERE document_id = 'signed-history'"), beforeSigning);
  assert.deepEqual(await dbAll("SELECT * FROM audit_events WHERE document_id = 'signed-history'"), beforeSigningAudit,
    'Pinning a future-use profile policy does not rewrite historical signing evidence.');

  for (const sql of [
    'UPDATE owner_signature_policies SET signature_sha256 = ? WHERE user_id = ?',
    'UPDATE owner_signature_policies SET authorization_note = ? WHERE user_id = ?',
    'DELETE FROM owner_signature_policies WHERE user_id = ?',
    'TRUNCATE owner_signature_policies',
  ]) {
    const params = sql.startsWith('UPDATE') ? [sql.includes('signature_sha256') ? sha(different) : 'Changed authorization record.', owner.id]
      : sql.startsWith('DELETE') ? [owner.id] : [];
    await assert.rejects(dbRun(sql, params), error => error.code === '55000' && /append-only/.test(error.message));
    assert.deepEqual(await policyFor(owner), policy);
  }
  await assert.rejects(dbRun('INSERT INTO owner_signature_policies(user_id,signature_sha256,authorization_note,authorized_at) VALUES (?,?,?,?)',
    [owner.id, sha(different), note, originalDate]), error => error.code === '23505');
  await dbRun('UPDATE profile_signatures SET signature_bytes = ? WHERE user_id = ?', [different, owner.id]);
  await assert.rejects(pin(owner), code('SIGNATURE_POLICY_PROFILE_CONFLICT'));
  await assert.rejects(pin(owner, {expectedProfileSha256: sha(different)}), code('SIGNATURE_POLICY_CONFLICT'));
  await assert.rejects(assertApprovedSignature(owner, different), code('APPROVED_SIGNATURE_REQUIRED'));
  await dbRun('UPDATE profile_signatures SET signature_bytes = ? WHERE user_id = ?', [approved, owner.id]);

  const rollbackOwner = await user('rollback-owner');
  await dbRun(`ALTER TABLE audit_events ADD CONSTRAINT reject_policy_test_audit CHECK (action <> 'owner_signature_profile_pinned' OR user_id <> ${rollbackOwner.id})`);
  await assert.rejects(pin(rollbackOwner), error => error.code === '23514');
  assert.equal(await policyFor(rollbackOwner), undefined, 'An audit failure rolls back the policy installation.');
  assert.equal((await auditsFor(rollbackOwner)).length, 0);
  await dbRun('ALTER TABLE audit_events DROP CONSTRAINT reject_policy_test_audit');
  await pin(rollbackOwner);

  const concurrentOwner = await user('concurrent-owner');
  const concurrent = await Promise.all([pin(concurrentOwner), pin(concurrentOwner)]);
  assert.deepEqual(concurrent.map(result => result.alreadyPinned).sort(), [false, true]);
  assert.equal((await auditsFor(concurrentOwner)).length, 1);
  const outerRollbackOwner = await user('outer-rollback-owner');
  await assert.rejects(withTransaction(async () => {await pin(outerRollbackOwner); throw new Error('Synthetic caller rollback.');}), /Synthetic caller rollback/);
  assert.equal(await policyFor(outerRollbackOwner), undefined);
  assert.equal((await auditsFor(outerRollbackOwner)).length, 0);
  console.log('PASS: approved owner signature policy, active-owner and exact-profile checks, private lock status, other-officer independence, idempotency, conflicts, concurrent pinning, append-only history and atomic rollback.');
} finally {
  await close();
}
