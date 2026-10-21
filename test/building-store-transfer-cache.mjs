import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
const { connect, close, dbRun, dbGet, withTransaction, getDatabaseConnectionIdentity } = await import('../db.js');
const { initBuildingStoreSchema, buildingStoreHash } = await import('../building-store.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'building-transfer-cache-'));
const source = await fs.readFile(new URL('../building-store.js', import.meta.url), 'utf8');
const databaseImport = "import { dbAll, dbGet, dbRun, withTransaction, getDatabaseConnectionIdentity, isDatabaseTransactionActive } from './db.js';";
assert.equal(source.split(databaseImport).length, 2);
// Observe actual scalar/full-row results from the isolated PostgreSQL driver.
// The injected failure is inside a real transaction and forces its rollback.
const observedSource = source.replace(databaseImport, `import { dbAll, dbGet as actualDbGet, dbRun,
  withTransaction as actualWithTransaction, getDatabaseConnectionIdentity, isDatabaseTransactionActive }
  from ${JSON.stringify(new URL('../db.js', import.meta.url).href)};
export const observations = [];
let failTransaction = false;
let pauseAfterCommit = null;
export const failNextTransaction = () => { failTransaction = true; };
export const pauseNextCommittedTransaction = () => {
  let release, entered;
  const gate = { wait: new Promise(resolve => { release = resolve; }),
    entered: new Promise(resolve => { entered = resolve; }),
    release: () => release(), enter: () => entered() };
  pauseAfterCommit = gate;
  return gate;
};
const withTransaction = async callback => {
  const pause = pauseAfterCommit; pauseAfterCommit = null;
  const result = await actualWithTransaction(async () => {
    const result = await callback();
    if (failTransaction) { failTransaction = false; throw Error('Synthetic transaction rollback'); }
    return result;
  });
  if (pause) { pause.enter(); await pause.wait; }
  return result;
};
const dbGet = async (sql, params) => {
  const row = await actualDbGet(sql, params);
  if (sql.includes('building_store_entries') && sql.includes("key='resv:all'")) {
    observations.push({ raw: typeof row?.value_text === 'string',
      bytes: Buffer.byteLength(JSON.stringify(row ?? null)), sql,
      fields: Object.keys(row || {}) });
  }
  return row;
};`);
const moduleFile = path.join(directory, 'observed-building-store.mjs');
await fs.writeFile(moduleFile, observedSource);
const observed = await import(pathToFileURL(moduleFile).href);
const now = 1_790_000_000_000;
const archive = '[\n {"id":"SSL-SYNTHETIC-ONLY","agreementText":"' + 'Exact agreement \\n'.repeat(18_000)
  + '","signatureData":"data:image/png;base64,c3ludGhldGlj","statusAccessHash":"retained-token-hash","note":"é 🟦"}\n]\n';
assert.doesNotThrow(() => JSON.parse(archive));
let checks = 0;
const check = (description, value) => { assert.ok(value, description); checks += 1; };
const identity = body => ({ requestId: crypto.randomUUID(), payloadSha256: buildingStoreHash(JSON.stringify(body)), now });
const execute = body => observed.executeBuildingStoreOperation(body, identity(body));
const getArchive = () => execute({ operation: 'get', key: 'resv:all' });
const rawReads = () => observed.observations.filter(row => row.raw).length;
const resetReads = () => { observed.observations.length = 0; };
const health = () => execute({ operation: 'health' });
const putArchive = async (value, { revision = 1, checksum = buildingStoreHash(value), expiry = null } = {}) => {
  await dbRun(`INSERT INTO building_store_entries(key,value_text,value_sha256,revision,expires_at,created_at,updated_at)
    VALUES('resv:all',?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
    value_text=excluded.value_text,value_sha256=excluded.value_sha256,revision=excluded.revision,expires_at=excluded.expires_at`,
  [value, checksum, revision, expiry, 'synthetic-created', 'synthetic-updated']);
};
const initialize = async () => {
  await initBuildingStoreSchema();
  await dbRun("UPDATE building_store_state SET state='ready',snapshot_id='synthetic-snapshot',manifest_sha256=?,imported_key_count=2,imported_record_count=1 WHERE id=1", ['a'.repeat(64)]);
  await putArchive(archive);
  await dbRun(`INSERT INTO building_store_entries(key,value_text,value_sha256,created_at,updated_at)
    VALUES('resv:warden-secret',?,?,?,?)`, ['synthetic-only', buildingStoreHash('synthetic-only'), 'synthetic-created', 'synthetic-updated']);
};

await connect();
try {
  await initialize();
  resetReads();
  const ready = await health();
  check('Health preserves the readiness DTO and requires no archive text', ready.ready === true && ready.state === 'ready'
    && ready.snapshotId === 'synthetic-snapshot' && ready.manifestSha256 === 'a'.repeat(64)
    && ready.importedKeyCount === 2 && ready.importedRecordCount === 1 && rawReads() === 0);
  check('Health verifies actual text inside PostgreSQL', observed.observations.length === 1
    && observed.observations[0].sql.includes("sha256(convert_to(value_text,'UTF8'))")
    && !observed.observations[0].fields.includes('value_text'));

  resetReads();
  observed.failNextTransaction();
  await assert.rejects(getArchive(), /Synthetic transaction rollback/); checks += 1;
  check('Failed transaction loaded only its own uncommitted cache candidate', rawReads() === 1);
  resetReads();
  check('Rollback never publishes a candidate: next GET loads full verified bytes', await getArchive() === archive && rawReads() === 1);
  const firstReadBytes = observed.observations.reduce((sum, row) => sum + row.bytes, 0);
  resetReads();
  check('Repeated GET returns every original byte without a full archive DB result', await getArchive() === archive && rawReads() === 0);
  const repeatedReadBytes = observed.observations.reduce((sum, row) => sum + row.bytes, 0);
  check('Warm GET reads a bounded scalar integrity result', repeatedReadBytes < 400 && firstReadBytes > repeatedReadBytes * 1_000);
  check('GET and health create no retry receipts', (await dbGet('SELECT COUNT(*) AS count FROM building_store_receipts')).count === 0);
  resetReads();
  check('An unrelated key read verifies the archive without transferring its text',
    await execute({ operation: 'get', key: 'resv:warden-secret' }) === 'synthetic-only' && rawReads() === 0);

  const corruptArchive = archive.replace('Exact agreement', 'Wrong agreement');
  await putArchive(corruptArchive, { checksum: buildingStoreHash(archive) });
  resetReads();
  await assert.rejects(getArchive(), error => error.statusCode === 503); checks += 1;
  check('Warm cache cannot conceal actual text corruption under an unchanged stored hash', rawReads() === 0 && !(await health()).ready);
  await assert.rejects(execute({ operation: 'get', key: 'resv:warden-secret' }), error => error.statusCode === 503); checks += 1;
  await putArchive(archive, { checksum: '0'.repeat(64) });
  await assert.rejects(getArchive(), error => error.statusCode === 503); checks += 1;
  check('Wrong stored checksum also fails closed for health', !(await health()).ready);

  await putArchive(archive);
  await dbRun("UPDATE building_store_state SET state='uninitialized' WHERE id=1");
  await assert.rejects(getArchive(), error => error.statusCode === 503); checks += 1;
  check('Migration freeze cannot be bypassed by a previously warm cache', !(await health()).ready);
  await dbRun("UPDATE building_store_state SET state='ready' WHERE id=1");
  await putArchive(archive, { expiry: now + 1_000_000 });
  await assert.rejects(getArchive(), error => error.statusCode === 503); checks += 1;
  check('Persistent archive with any expiry is unready even before it expires', !(await health()).ready);
  await putArchive(archive, { revision: 0 });
  await assert.rejects(getArchive(), error => error.statusCode === 503); checks += 1;
  check('Invalid archive revision fails health', !(await health()).ready);

  await putArchive(archive, { revision: 2 });
  resetReads();
  check('A new valid revision reloads and independently hashes its full text', await getArchive() === archive && rawReads() === 1);
  const changed = archive.replace('Exact agreement', 'Updated agreement');
  await putArchive(changed, { revision: 2 });
  resetReads();
  check('An authoritative byte/hash change reloads even when revision is unchanged', await getArchive() === changed && rawReads() === 1);
  const restoredSignatures = JSON.parse(changed)[0];
  check('Revisions preserve all synthetic signature and access-token fields', restoredSignatures.signatureData === JSON.parse(archive)[0].signatureData
    && restoredSignatures.statusAccessHash === JSON.parse(archive)[0].statusAccessHash);

  const next = changed.replace('Updated agreement', 'CAS agreement');
  const cas = { operation: 'cas', key: 'resv:all', expected: changed, value: next };
  const casIdentity = identity(cas);
  resetReads();
  check('Exact CAS retains full current-row verification and writes once', await observed.executeBuildingStoreOperation(cas, casIdentity) === 1 && rawReads() === 1);
  const afterCas = await dbGet("SELECT value_text,value_sha256,revision FROM building_store_entries WHERE key='resv:all'");
  check('Committed CAS preserves exact bytes and checksum', afterCas.value_text === next && afterCas.value_sha256 === buildingStoreHash(next) && Number(afterCas.revision) === 3);
  resetReads();
  check('First GET after committed mutation reloads the new archive', await getArchive() === next && rawReads() === 1);
  resetReads();
  check('The subsequent GET can reuse the new verified archive', await getArchive() === next && rawReads() === 0);
  resetReads();
  check('Retry receipt still returns the original CAS success after verifying the current full row',
    await observed.executeBuildingStoreOperation(cas, casIdentity) === 1 && rawReads() === 1
    && (await dbGet("SELECT revision FROM building_store_entries WHERE key='resv:all'")).revision === afterCas.revision);

  await getArchive();
  const nested = next.replace('CAS agreement', 'Rolled back agreement');
  resetReads();
  await assert.rejects(withTransaction(async () => {
    await execute({ operation: 'cas', key: 'resv:all', expected: next, value: nested });
    assert.equal(await getArchive(), nested);
    throw Error('Synthetic outer transaction rollback');
  }), /Synthetic outer transaction rollback/); checks += 1;
  check('Nested operations bypass cache and independently verify transaction-local text', rawReads() === 2);
  resetReads();
  check('Outer rollback never replaces or invalidates the prior committed cache', await getArchive() === next && rawReads() === 0);
  check('Outer rollback preserves the original archive row and receipts',
    (await dbGet("SELECT value_text FROM building_store_entries WHERE key='resv:all'")).value_text === next
    && (await dbGet('SELECT COUNT(*) AS count FROM building_store_receipts')).count === 1);

  const olderReadText = archive.replace('Exact agreement', 'Older concurrent agreement');
  const newerCommittedText = archive.replace('Exact agreement', 'Newer concurrent agreement');
  await putArchive(olderReadText, { revision: '9007199254740993' });
  const pause = observed.pauseNextCommittedTransaction();
  const olderRead = getArchive();
  await pause.entered;
  check('A read can retain its own precise BIGINT revision while paused after commit',
    await execute({ operation: 'cas', key: 'resv:all', expected: olderReadText, value: newerCommittedText }) === 1);
  check('Concurrent later read sees the newer committed archive', await getArchive() === newerCommittedText);
  pause.release();
  check('Delayed older read only returns its original transaction snapshot', await olderRead === olderReadText);
  resetReads();
  check('Delayed cache publication cannot serve stale bytes after a newer commit', await getArchive() === newerCommittedText && rawReads() === 1);
  resetReads();
  check('After the bounded reload the current archive is cached again', await getArchive() === newerCommittedText && rawReads() === 0);

  await dbRun("DELETE FROM building_store_entries WHERE key='resv:all'");
  await assert.rejects(getArchive(), error => error.statusCode === 503); checks += 1;
  check('A missing authoritative archive cannot be served from memory', !(await health()).ready);

  // Reconnect to another isolated database with identical metadata and bytes.
  // A fresh opaque driver identity must make even this content a cold read.
  await putArchive(archive);
  await getArchive();
  const firstScope = getDatabaseConnectionIdentity();
  check('Database identity exposes no connection or credential fields', Object.isFrozen(firstScope) && Object.keys(firstScope).length === 0);
  await close();
  await connect();
  await initialize();
  check('Every new driver connection has a distinct cache scope', getDatabaseConnectionIdentity() !== firstScope);
  resetReads();
  check('Identical rows in another database cannot reuse the prior database cache', await getArchive() === archive && rawReads() === 1);
  resetReads();
  check('New database cache only activates after its own successful read', await getArchive() === archive && rawReads() === 0);
  console.log(`PASS ${checks} isolated building transfer-cache checks; archive DB result bytes ${firstReadBytes} cold / ${repeatedReadBytes} warm. No live database or records accessed.`);
} finally {
  await close();
  await fs.rm(directory, { recursive: true, force: true });
}
