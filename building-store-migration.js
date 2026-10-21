import fs from 'node:fs/promises';
import path from 'node:path';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { buildingStoreHash, isBuildingStoreKey, isExpiringBuildingStoreKey,
  validateBuildingStoreText } from './building-store.js';

const fail = message => { throw new Error(message); };
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fileFor = key => `${buildingStoreHash(key)}.txt`;
const signatureEvidence = (value, location = '', output = []) => {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = location ? `${location}.${key}` : key;
    if (/signature|signedat|attestedat/i.test(key) && child !== null && child !== '') {
      output.push({ path: childPath, sha256: buildingStoreHash(JSON.stringify(child)) });
    } else if (child && typeof child === 'object') signatureEvidence(child, childPath, output);
  }
  return output;
};

export function buildingRecordIntegrity(text) {
  let records;
  try { records = JSON.parse(text); } catch { fail('The source request archive is not valid JSON.'); }
  if (!Array.isArray(records)) fail('The source request archive is not an array.');
  if (!records.length) fail('This migration requires the known existing request archive; an empty source cannot initialize the store.');
  const ids = new Set();
  return records.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string'
        || !record.id || ids.has(record.id)) fail('The source request archive has missing or duplicate record IDs.');
    ids.add(record.id);
    return { id: record.id, sha256: buildingStoreHash(JSON.stringify(record)), signatures: signatureEvidence(record) };
  });
}

export function validateBuildingSourceSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || !validTime(snapshot.capturedAt) || snapshot.source?.complete !== true
      || typeof snapshot.source?.label !== 'string' || !snapshot.source.label.trim()
      || !Number.isSafeInteger(snapshot.source.expectedKeyCount) || !Array.isArray(snapshot.entries)
      || snapshot.entries.length !== snapshot.source.expectedKeyCount || snapshot.entries.length < 1
      || snapshot.entries.length > 10_000) fail('A complete, counted source snapshot is required; an unavailable source cannot initialize this store.');
  const keys = new Set();
  for (const entry of snapshot.entries) {
    if (!isBuildingStoreKey(entry?.key) || keys.has(entry.key)) fail('The source snapshot has unsupported or duplicate keys.');
    keys.add(entry.key);
    validateBuildingStoreText(entry.value);
    if (entry.expiresAt !== null && (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0)) {
      fail('Every source key must carry its original absolute expiry or explicit null.');
    }
    if (!isExpiringBuildingStoreKey(entry.key) && entry.expiresAt !== null) fail('Persistent source records cannot expire.');
  }
  const archive = snapshot.entries.find(entry => entry.key === 'resv:all');
  if (!archive) fail('The complete source snapshot must include the original resv:all value.');
  return buildingRecordIntegrity(archive.value);
}

export async function stageBuildingSource(sourceFile, directory) {
  const sourceBytes = await fs.readFile(sourceFile);
  if (!Buffer.from(sourceBytes.toString('utf8')).equals(sourceBytes)) fail('The source snapshot must be valid UTF-8.');
  const snapshot = JSON.parse(sourceBytes.toString('utf8'));
  const records = validateBuildingSourceSnapshot(snapshot);
  const sourceSha256 = buildingStoreHash(sourceBytes);
  const manifest = {
    schemaVersion: 1, snapshotId: `building-${sourceSha256.slice(0, 24)}`,
    source: snapshot.source, capturedAt: snapshot.capturedAt, sourceSha256,
    keyCount: snapshot.entries.length, recordCount: records.length, records,
    entries: [...snapshot.entries].sort((a, b) => a.key.localeCompare(b.key)).map(entry => ({
      key: entry.key, valueFile: fileFor(entry.key), bytes: Buffer.byteLength(entry.value),
      sha256: buildingStoreHash(entry.value), expiresAt: entry.expiresAt,
    })),
  };
  // A fresh private directory prevents an interrupted stage from replacing a
  // prior backup. The original provider remains untouched throughout migration.
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'source.json'), sourceBytes, { flag: 'wx', mode: 0o600 });
  for (const entry of snapshot.entries) await fs.writeFile(path.join(directory, fileFor(entry.key)), entry.value,
    { flag: 'wx', mode: 0o600, encoding: 'utf8' });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return verifyBuildingStage(directory);
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validateManifestEntries = (manifest, entries) => {
  if (manifest?.schemaVersion !== 1 || !/^building-[a-f0-9]{24}$/.test(manifest.snapshotId || '')
      || manifest.source?.complete !== true || !Array.isArray(manifest.entries) || manifest.entries.length < 1
      || manifest.entries.length !== manifest.keyCount || manifest.keyCount !== manifest.source.expectedKeyCount
      || entries.length !== manifest.keyCount) fail('The staged source manifest is incomplete.');
  const keys = new Set();
  for (const entry of entries) {
    const expected = manifest.entries.find(item => item.key === entry.key);
    if (!expected || !isBuildingStoreKey(entry.key) || keys.has(entry.key) || expected.valueFile !== fileFor(entry.key)
        || expected.sha256 !== buildingStoreHash(entry.value) || expected.bytes !== Buffer.byteLength(entry.value)
        || entry.expiresAt !== expected.expiresAt) fail('A staged key failed its byte, checksum, or expiry verification.');
    keys.add(entry.key);
    validateBuildingStoreText(entry.value);
    if (entry.expiresAt !== null && (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0)) fail('Invalid staged expiry.');
    if (!isExpiringBuildingStoreKey(entry.key) && entry.expiresAt !== null) fail('Persistent staged records cannot expire.');
  }
  const archive = entries.find(entry => entry.key === 'resv:all');
  if (!archive) fail('The staged archive is absent.');
  const records = buildingRecordIntegrity(archive.value);
  if (records.length !== manifest.recordCount || !equal(records, manifest.records)) fail('Per-record or signature integrity verification failed.');
  return records;
};

export async function verifyBuildingStage(directory) {
  const manifestText = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const sourceBytes = await fs.readFile(path.join(directory, 'source.json'));
  if (buildingStoreHash(sourceBytes) !== manifest.sourceSha256) fail('The retained original source checksum differs.');
  const source = JSON.parse(sourceBytes.toString('utf8'));
  validateBuildingSourceSnapshot(source);
  if (!equal(source.source, manifest.source) || source.capturedAt !== manifest.capturedAt
      || `building-${buildingStoreHash(sourceBytes).slice(0, 24)}` !== manifest.snapshotId) fail('The manifest no longer matches its original source.');
  const entries = [];
  for (const expected of manifest.entries || []) {
    if (expected.valueFile !== fileFor(expected.key)) fail('Unsafe staged filename.');
    const bytes = await fs.readFile(path.join(directory, expected.valueFile));
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('A staged value is not valid UTF-8.');
    const value = bytes.toString('utf8');
    const original = source.entries.find(entry => entry.key === expected.key);
    if (!original || original.value !== value || original.expiresAt !== expected.expiresAt) fail('A staged value differs from its retained original source.');
    entries.push({ key: expected.key, value, expiresAt: expected.expiresAt });
  }
  validateManifestEntries(manifest, entries);
  return { manifest, manifestText, manifestSha256: buildingStoreHash(manifestText), entries };
}

const readTargetStage = async snapshotId => {
  const staged = await dbGet('SELECT * FROM building_store_imports WHERE snapshot_id=?', [snapshotId]);
  if (!staged) fail('The target has no such staged snapshot.');
  if (buildingStoreHash(staged.manifest_text) !== staged.manifest_sha256) fail('The target manifest checksum differs.');
  const manifest = JSON.parse(staged.manifest_text);
  const rows = await dbAll('SELECT * FROM building_store_staged_entries WHERE snapshot_id=? ORDER BY key', [snapshotId]);
  const entries = rows.map(row => {
    if (row.value_sha256 !== buildingStoreHash(row.value_text)) fail('A target staged checksum differs.');
    return { key: row.key, value: row.value_text, expiresAt: row.expires_at === null ? null : Number(row.expires_at) };
  });
  validateManifestEntries(manifest, entries);
  return { staged, manifest, entries };
};

export async function stageBuildingTarget(verifiedStage, { now = Date.now(), afterEntry = async () => {} } = {}) {
  const { manifest, manifestText, manifestSha256, entries } = verifiedStage;
  if (buildingStoreHash(manifestText) !== manifestSha256) fail('The source manifest checksum differs.');
  validateManifestEntries(manifest, entries);
  return withTransaction(async () => {
    await dbGet('SELECT id FROM building_store_state WHERE id=1 FOR UPDATE');
    const prior = await dbGet('SELECT * FROM building_store_imports WHERE snapshot_id=?', [manifest.snapshotId]);
    if (prior) {
      if (prior.manifest_sha256 !== manifestSha256 || prior.manifest_text !== manifestText) fail('The snapshot ID already belongs to different source evidence.');
      await readTargetStage(manifest.snapshotId);
      return { snapshotId: manifest.snapshotId, state: prior.state, repeated: true };
    }
    await dbRun(`INSERT INTO building_store_imports(snapshot_id,manifest_text,manifest_sha256,state,staged_at)
      VALUES(?,?,?,'staged',?)`, [manifest.snapshotId, manifestText, manifestSha256, new Date(now).toISOString()]);
    for (const entry of entries) {
      await dbRun('INSERT INTO building_store_staged_entries(snapshot_id,key,value_text,value_sha256,expires_at) VALUES(?,?,?,?,?)',
        [manifest.snapshotId, entry.key, entry.value, buildingStoreHash(entry.value), entry.expiresAt]);
      await afterEntry(entry.key);
    }
    await readTargetStage(manifest.snapshotId);
    return { snapshotId: manifest.snapshotId, state: 'staged', keyCount: manifest.keyCount, recordCount: manifest.recordCount };
  });
}

export async function verifyBuildingTarget(snapshotId, { now = Date.now() } = {}) {
  return withTransaction(async () => {
    await dbGet('SELECT id FROM building_store_state WHERE id=1 FOR UPDATE');
    const { staged, manifest } = await readTargetStage(snapshotId);
    if (staged.state === 'staged') await dbRun("UPDATE building_store_imports SET state='verified',verified_at=? WHERE snapshot_id=?",
      [new Date(now).toISOString(), snapshotId]);
    return { snapshotId, state: staged.state === 'activated' ? 'activated' : 'verified',
      manifestSha256: staged.manifest_sha256, keyCount: manifest.keyCount, recordCount: manifest.recordCount };
  });
}

export async function activateBuildingTarget(snapshotId, manifestSha256, { now = Date.now() } = {}) {
  return withTransaction(async () => {
    const state = await dbGet('SELECT * FROM building_store_state WHERE id=1 FOR UPDATE');
    const { staged, manifest, entries } = await readTargetStage(snapshotId);
    if (staged.manifest_sha256 !== manifestSha256) fail('Activation requires the verified manifest checksum.');
    if (!['verified', 'activated'].includes(staged.state)) fail('Verify the target snapshot before activation.');
    const active = await dbAll('SELECT * FROM building_store_entries ORDER BY key');
    if (state?.state === 'ready') {
      if (state.snapshot_id !== snapshotId || state.manifest_sha256 !== manifestSha256) fail('A ready store cannot be replaced by a source import.');
      const expected = entries.filter(entry => entry.expiresAt === null || entry.expiresAt > now);
      const current = active.filter(entry => entry.expires_at === null || Number(entry.expires_at) > now);
      if (current.length !== expected.length || expected.some(entry => !current.some(row => row.key === entry.key
          && row.value_text === entry.value && Number(row.expires_at) === Number(entry.expiresAt)))) {
        fail('The active store changed after import; a retry cannot replace newer records.');
      }
      return { snapshotId, state: 'ready', repeated: true };
    }
    if (!state || active.length) fail('The uninitialized target contains records and requires investigation.');
    const stamp = new Date(now).toISOString();
    for (const entry of entries) await dbRun(`INSERT INTO building_store_entries
      (key,value_text,value_sha256,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
    [entry.key, entry.value, buildingStoreHash(entry.value), entry.expiresAt, stamp, stamp]);
    const written = await dbAll('SELECT key,value_text,value_sha256,expires_at FROM building_store_entries ORDER BY key');
    if (written.length !== entries.length || written.some(row => row.value_sha256 !== buildingStoreHash(row.value_text))) fail('Active target checksum verification failed.');
    validateManifestEntries(manifest, written.map(row => ({ key: row.key, value: row.value_text,
      expiresAt: row.expires_at === null ? null : Number(row.expires_at) })));
    await dbRun(`UPDATE building_store_state SET state='ready',snapshot_id=?,manifest_sha256=?,
      imported_key_count=?,imported_record_count=?,imported_at=? WHERE id=1`,
    [snapshotId, manifestSha256, manifest.keyCount, manifest.recordCount, stamp]);
    await dbRun("UPDATE building_store_imports SET state='activated',activated_at=? WHERE snapshot_id=?", [stamp, snapshotId]);
    return { snapshotId, state: 'ready', keyCount: manifest.keyCount, recordCount: manifest.recordCount };
  });
}
