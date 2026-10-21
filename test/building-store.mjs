import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
process.env.DATABASE_URL = ''; process.env.PGLITE_DIR = ''; process.env.NODE_ENV = 'test';
const { connect, close, dbRun, dbGet, dbAll } = await import('../db.js');
const { initBuildingStoreSchema, buildingStoreHash, BUILDING_STORE_MAX_VALUE_BYTES, executeBuildingStoreOperation: execute,
  isBuildingStoreKey, validateBuildingStoreOperation } = await import('../building-store.js');
const { mountBuildingStore, buildingStoreSignature, BUILDING_STORE_PATH } = await import('../building-store-routes.js');
const { stageBuildingSource, verifyBuildingStage, stageBuildingTarget, verifyBuildingTarget,
  activateBuildingTarget, validateBuildingSourceSnapshot } = await import('../building-store-migration.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'building-store-test-'));
let listener, checks = 0;
const check = (description, value) => { assert.ok(value, description); checks++; };
const now = 1_790_000_000_000;
const secret = crypto.randomBytes(48).toString('hex');
const archive = '[\n { "id" : "SSL-SYNTHETIC", "agreementText":"Exact agreement\\nwith spacing", "signatureData":"data:image/png;base64,c3ludGhldGlj", "attestedAt": "2026-09-01T01:02:03Z" }\n]\n';
const snapshot = {
  schemaVersion: 1, capturedAt: new Date(now).toISOString(),
  source: { label: 'Synthetic complete provider export', complete: true, expectedKeyCount: 4 },
  entries: [
    { key: 'resv:all', value: archive, expiresAt: null },
    { key: 'resv:push-subs', value: ' [ ] \n', expiresAt: null },
    { key: 'resv:warden-secret', value: 'synthetic-only-hash', expiresAt: null },
    { key: 'resv:status-fail:' + 'a'.repeat(64), value: '2', expiresAt: now + 3600_000 },
  ],
};
const identity = body => ({ requestId: crypto.randomUUID(), payloadSha256: buildingStoreHash(JSON.stringify(body)), now });
const operation = body => execute(body, identity(body));
await connect();
try {
  await initBuildingStoreSchema();
  const app = express(); mountBuildingStore(app, { secret, now: () => now });
  listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const request = async (body, options = {}) => {
    const raw = options.raw ?? JSON.stringify(body);
    const timestamp = String(options.timestamp ?? now), id = options.id ?? crypto.randomUUID();
    const signature = buildingStoreSignature(options.secret ?? secret, timestamp, id, Buffer.from(raw));
    const response = await fetch(origin + BUILDING_STORE_PATH, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-building-store-timestamp': timestamp,
      'x-building-store-request-id': id, 'x-building-store-signature': signature, ...options.headers,
    }, body: raw });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  const health = await request({ operation: 'health' });
  check('Authenticated health is available before initialization', health.status === 200 && health.data.result.ready === false);
  check('Health performs no writes', (await dbGet('SELECT COUNT(*) AS count FROM building_store_receipts')).count === 0);
  check('Uninitialized read fails closed', (await request({ operation: 'get', key: 'resv:all' })).status === 503);
  check('Authentication rejects wrong secret', (await request({ operation: 'health' }, { secret: 'x'.repeat(48) })).status === 401);
  check('Authentication rejects old timestamp', (await request({ operation: 'health' }, { timestamp: now - 300_001 })).status === 401);
  check('Authentication rejects changed raw bytes', (await request({ operation: 'health' }, { headers: { 'x-building-store-signature': '0'.repeat(64) } })).status === 401);
  check('All bridge responses disable caches', health.cache.includes('no-store'));
  check('Malformed authenticated JSON is rejected', (await request(null, { raw: '{bad' })).status === 400);
  const sourcePath = path.join(directory, 'source-original.json');
  const sourceBytes = Buffer.from(JSON.stringify(snapshot)); await fs.writeFile(sourcePath, sourceBytes);
  const stageDir = path.join(directory, 'immutable-stage');
  const stage = await stageBuildingSource(sourcePath, stageDir);
  check('Local manifest counts records and signature evidence', stage.manifest.keyCount === 4 && stage.manifest.recordCount === 1
    && stage.manifest.records[0].signatures.length === 2);
  check('Original source backup is byte-identical', (await fs.readFile(path.join(stageDir, 'source.json'))).equals(sourceBytes));
  check('Raw archive file preserves every byte', (await fs.readFile(path.join(stageDir, stage.manifest.entries.find(row => row.key === 'resv:all').valueFile))).equals(Buffer.from(archive)));
  await assert.rejects(stageBuildingSource(sourcePath, stageDir), /EEXIST/); checks++;
  await assert.rejects(stageBuildingTarget(stage, { now, afterEntry: async () => { throw new Error('Synthetic import interruption'); } }), /Synthetic/); checks++;
  check('Interrupted target staging rolls back every staged row', (await dbGet('SELECT COUNT(*) AS count FROM building_store_staged_entries')).count === 0
    && (await dbGet('SELECT COUNT(*) AS count FROM building_store_imports')).count === 0);
  await stageBuildingTarget(stage, { now });
  check('Staging never activates an empty-success queue', (await request({ operation: 'get', key: 'resv:all' })).status === 503);
  await assert.rejects(activateBuildingTarget(stage.manifest.snapshotId, stage.manifestSha256, { now }), /Verify/); checks++;
  const verified = await verifyBuildingTarget(stage.manifest.snapshotId, { now });
  check('Target verification independently reads all staged bytes', verified.state === 'verified');
  await assert.rejects(activateBuildingTarget(stage.manifest.snapshotId, '0'.repeat(64), { now }), /checksum/); checks++;
  await activateBuildingTarget(stage.manifest.snapshotId, stage.manifestSha256, { now });
  check('Only verified activation makes the bridge ready', (await request({ operation: 'health' })).data.result.ready === true);
  check('Original request and signatures survive exact text roundtrip', (await request({ operation: 'get', key: 'resv:all' })).data.result === archive);
  const receiptsBeforePolling = (await dbGet('SELECT COUNT(*) AS count FROM building_store_receipts')).count;
  await Promise.all(Array.from({ length: 30 }, () => operation({ operation: 'get', key: 'resv:all' })));
  check('Archive polling never duplicates raw archives into receipts', (await dbGet('SELECT COUNT(*) AS count FROM building_store_receipts')).count === receiptsBeforePolling);
  check('Original expiries survive staging and activation', Number((await dbGet('SELECT expires_at FROM building_store_entries WHERE key=?', [snapshot.entries[3].key])).expires_at) === snapshot.entries[3].expiresAt);
  check('Unchanged activation retry is idempotent', (await activateBuildingTarget(stage.manifest.snapshotId, stage.manifestSha256, { now })).repeated);
  const nextArchive = archive.replace('Exact agreement', 'Exact agreement retained');
  const raceBodies = [nextArchive, archive.replace('Exact agreement', 'Concurrent edit')].map(value => ({ operation: 'cas', key: 'resv:all', expected: archive, value }));
  const races = await Promise.all(raceBodies.map(operation));
  check('Concurrent compare-and-set permits one winner', races.filter(value => value === 1).length === 1 && races.filter(value => value === 0).length === 1);
  const current = await operation({ operation: 'get', key: 'resv:all' });
  check('Winning archive still retains original signature', JSON.parse(current)[0].signatureData === JSON.parse(archive)[0].signatureData);
  await assert.rejects(activateBuildingTarget(stage.manifest.snapshotId, stage.manifestSha256, { now }), /newer records/); checks++;
  const counter = 'resv:private:gapz:daily';
  const increment = { operation: 'increment', key: counter }, retryIdentity = identity(increment);
  check('A mutation is applied once across retry receipts', await execute(increment, retryIdentity) === 1 && await execute(increment, retryIdentity) === 1
    && await operation({ operation: 'get', key: counter }) === '1');
  await assert.rejects(execute({ operation: 'increment', key: counter }, { ...retryIdentity, payloadSha256: buildingStoreHash('different') }), error => error.statusCode === 409); checks++;
  check('Expired mutation receipts do not return stale prior results', await execute(increment,
    { ...retryIdentity, now: now + 86_400_001 }) === 2);
  check('NX set preserves an existing value', await operation({ operation: 'set', key: counter, value: '999', nx: true, ex: 1 }) === null
    && await operation({ operation: 'get', key: counter }) === '2');
  check('Expiry can be applied to temporary keys', await operation({ operation: 'expire', key: counter, seconds: 1 }) === 1);
  check('Expired temporary values disappear', await execute({ operation: 'get', key: counter }, { ...identity({}), now: now + 1001 }) === null);
  const challenge = 'resv:private:gapz:challenge:' + 'c'.repeat(48);
  await operation({ operation: 'set', key: challenge, value: 'challenge-hash', ex: 600 });
  check('Wrong challenge value cannot consume token', await operation({ operation: 'consume', key: challenge, expected: 'wrong' }) === 0);
  const consumes = await Promise.all([1, 2].map(() => operation({ operation: 'consume', key: challenge, expected: 'challenge-hash' })));
  check('Concurrent challenge consume has one winner', consumes.reduce((a, b) => a + b, 0) === 1);
  for (const body of [{ operation: 'get', key: 'users' }, { operation: 'delete', key: 'resv:all' },
    { operation: 'set', key: 'resv:all', value: '{}' }, { operation: 'expire', key: 'resv:all', seconds: 60 },
    { operation: 'get', key: 'resv:all', sql: 'SELECT * FROM users' }]) {
    assert.throws(() => validateBuildingStoreOperation(body)); checks++;
  }
  check('Unsupported prefix and malformed keys are rejected', !isBuildingStoreKey('resv:private:gapz:session:nope'));
  assert.throws(() => validateBuildingSourceSnapshot({ ...snapshot, source: { ...snapshot.source, complete: false } })); checks++;
  assert.throws(() => validateBuildingSourceSnapshot({ ...snapshot, entries: [] })); checks++;
  assert.throws(() => validateBuildingSourceSnapshot({ ...snapshot, entries: snapshot.entries.map(row => row.key === 'resv:all' ? { ...row, value: '[]' } : row) })); checks++;
  assert.throws(() => validateBuildingSourceSnapshot({ ...snapshot, emptyVerified: true,
    entries: snapshot.entries.map(row => row.key === 'resv:all' ? { ...row, value: '[]' } : row) })); checks++;
  const file = stage.manifest.entries.find(row => row.key === 'resv:all').valueFile;
  await fs.appendFile(path.join(stageDir, file), ' ');
  await assert.rejects(verifyBuildingStage(stageDir), /differs/); checks++;
  const largeArchive = JSON.stringify([{ id: 'SSL-LARGE-SYNTHETIC', signatureData: '\\'.repeat((BUILDING_STORE_MAX_VALUE_BYTES - 200) / 2) }]);
  check('Near-limit synthetic archive fits its value bound', Buffer.byteLength(largeArchive) < BUILDING_STORE_MAX_VALUE_BYTES);
  check('Small-to-large CAS is accepted', (await request({ operation: 'cas', key: 'resv:all', expected: current, value: largeArchive })).data.result === 1);
  const largeCas = { operation: 'cas', key: 'resv:all', expected: largeArchive, value: largeArchive };
  check('Near-limit escaped CAS exceeds the obsolete body ceiling', Buffer.byteLength(JSON.stringify(largeCas)) > 8 * 1024 * 1024);
  const largeReply = await request(largeCas);
  check('Near-limit escaped CAS fits the aligned transport bound', largeReply.status === 200 && largeReply.data.result === 1);
  await dbRun("DELETE FROM building_store_entries WHERE key='resv:all'");
  check('Missing archive after activation fails closed for every normal operation', (await request({ operation: 'get', key: 'resv:warden-secret' })).status === 503);
  check('Missing archive changes health to unready', (await request({ operation: 'health' })).data.result.ready === false);
  console.log(`PASS ${checks} synthetic building-store checks: auth, exact bytes, signatures, manifests, staging rollback, readiness, CAS races, retry receipts, expiry and consumed tokens.`);
} finally {
  if (listener) await new Promise(resolve => listener.close(resolve));
  await close(); await fs.rm(directory, { recursive: true, force: true });
}
