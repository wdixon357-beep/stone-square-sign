import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import express from 'express';

process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
const { connect, close, initSchema, dbRun, dbGet } = await import('../db.js');
const directory = new URL(`../tmp/correspondence-transfer-${process.pid}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const originalSource = await readFile(new URL('../correspondence.js', import.meta.url), 'utf8');
const databaseImport = "import { dbAll, dbGet, dbRun } from './db.js';";
assert.equal(originalSource.split(databaseImport).length, 2);
let observedSource = originalSource.replace(databaseImport, `
import { dbAll as actualDbAll, dbGet, dbRun } from ${JSON.stringify(new URL('../db.js', import.meta.url).href)};
export const returnedRows = [];
const dbAll = async (sql, params) => {
  const rows = await actualDbAll(sql, params);
  if (sql.includes('FROM correspondence_drafts')) returnedRows.push(...rows);
  return rows;
};`);
observedSource = observedSource.replace(/from '(\.\/[^']+)'/g,
  (_, name) => `from ${JSON.stringify(new URL(name, new URL('../correspondence.js', import.meta.url)).href)}`);
const observedPath = new URL('observed.mjs', directory);
await writeFile(observedPath, observedSource);
const { mountCorrespondenceRoutes, returnedRows } = await import(observedPath.href);
let listener;
await connect();
try {
  await initSchema();
  const stamp = '2026-10-21T00:00:00.000Z';
  const user = await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES(?,?,?,?,?)',
    ['synthetic@example.invalid', 'not-a-login', 'Synthetic Secretary', 'secretary', stamp]);
  const signature = Buffer.alloc(300_000, 42);
  await dbRun(`INSERT INTO correspondence_drafts
    (id,matter,recipient_lodge,recipient_name,subject,body,status,prepared_by_user_id,
    prepared_by_name,prepared_by_office,assigned_to_user_id,assigned_to_name,
    assigned_to_office,signing_mode,shared_signer_1_id,signed_by_user_id,signed_by_name,
    signed_at,signed_signature_bytes,return_note,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['synthetic-letter', 'general', 'Example Lodge', 'Example Recipient', 'Synthetic subject',
    'Existing letter content', 'signed', user.lastID, 'Synthetic Secretary', 'Secretary',
    user.lastID, 'Synthetic Secretary', 'Secretary', 'either', user.lastID, user.lastID,
    'Synthetic Secretary', stamp, signature, 'Existing note', stamp, stamp]);
  const before = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', ['synthetic-letter']);
  const expectedDraft = {
    id: 'synthetic-letter', matter: 'general', recipientLodge: 'Example Lodge',
    recipientName: 'Example Recipient', subject: 'Synthetic subject', body: 'Existing letter content',
    status: 'signed', preparedByName: 'Synthetic Secretary', preparedByOffice: 'Secretary',
    preparedByUserId: user.lastID, assignedToUserId: user.lastID, assignedToName: 'Synthetic Secretary',
    assignedToOffice: 'Secretary', signingMode: 'either', sharedSignerUserIds: [user.lastID],
    signedByUserId: user.lastID, signedByName: 'Synthetic Secretary', signedAt: stamp,
    returnNote: 'Existing note', updatedAt: stamp,
  };
  const app = express();
  mountCorrespondenceRoutes(app, {
    requireAuth: (req, _res, next) => {
      req.user = { id: user.lastID, role: req.headers['x-synthetic-role'] || 'signer',
        permissions: req.headers['x-synthetic-permission'] === 'yes' ? ['reports.create'] : [] };
      next();
    },
    broadcast: () => { throw new Error('A list read must not broadcast a change.'); },
  });
  listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${listener.address().port}/api/correspondence`;
  for (const role of ['owner', 'secretary', 'assistant_secretary']) {
    const response = await fetch(url, { headers: { 'x-synthetic-role': role, 'x-synthetic-permission': 'yes' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.deepEqual(await response.json(), { drafts: [expectedDraft] });
  }
  assert.equal(returnedRows.length, 3);
  assert.ok(returnedRows.every(row => !Object.hasOwn(row, 'signed_signature_bytes')),
    'Queue reads must omit signature bytes before the database result reaches the application.');
  assert.ok(returnedRows.every(row => Buffer.byteLength(JSON.stringify(row)) < 2000),
    'The synthetic 300 KB signature must not be transferred for a queue refresh.');
  for (const headers of [{ 'x-synthetic-role': 'secretary' }, { 'x-synthetic-role': 'signer', 'x-synthetic-permission': 'yes' }]) {
    assert.equal((await fetch(url, { headers })).status, 403);
  }
  assert.equal(returnedRows.length, 3, 'Denied requests must not read the correspondence table.');
  const after = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', ['synthetic-letter']);
  assert.deepEqual(after, before, 'Queue reads preserve every field and captured signature byte.');
  console.log(JSON.stringify({ pass: true, baselineSignatureBytes: signature.length,
    projectedRowBytes: Buffer.byteLength(JSON.stringify(returnedRows[0])),
    signatureStillStored: Buffer.from(after.signed_signature_bytes).equals(signature), rolesChecked: 3 }));
} finally {
  if (listener) await new Promise(resolve => listener.close(resolve));
  await close();
  await rm(directory, { recursive: true, force: true });
}
