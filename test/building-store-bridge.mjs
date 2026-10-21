// Opt-in local contract rehearsal. The actual portal module is supplied by path,
// so the normal Sign test suite has no dependency on another checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const adapterPath = process.env.BUILDING_PORTAL_ADAPTER_PATH;
test('actual portal adapter and authenticated Sign bridge share one durable store', { skip: !adapterPath }, async t => {
  process.env.DATABASE_URL = ''; process.env.PGLITE_DIR = ''; process.env.NODE_ENV = 'test';
  const { connect, close, dbRun, dbGet } = await import('../db.js');
  const { initBuildingStoreSchema, buildingStoreHash, executeBuildingStoreOperation } = await import('../building-store.js');
  const { mountBuildingStore } = await import('../building-store-routes.js');
  const { stageBuildingSource, stageBuildingTarget, verifyBuildingTarget, activateBuildingTarget } = await import('../building-store-migration.js');
  const { createBuildingStore, BUILDING_CAS, BUILDING_CONSUME } = await import(pathToFileURL(path.resolve(adapterPath)).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'building-bridge-rehearsal-'));
  const secret = crypto.randomBytes(48).toString('hex');
  const archive = '[\n  { "id" : "SSL-SYNTHETIC", "agreement":{"signatureData":"synthetic unchanged ink","signatureHash":"original hash","textHash":"original text hash","signedAt":"2026-09-01T00:00:00Z","secretaryAttestation":{"attestedAt":"2026-09-02T00:00:00Z"}},"statusAccessHash":"legacy token hash" }\n]\n';
  const expiredKey = 'resv:private:gapz:challenge:' + 'b'.repeat(48);
  const config = { BUILDING_STORE_BACKEND: 'sign-postgres', BUILDING_STORE_BRIDGE_URL: 'https://synthetic-sign.invalid/api/internal/building-store', BUILDING_STORE_BRIDGE_SECRET: secret, KV_REST_API_URL: 'https://forbidden-old-redis.invalid', KV_REST_API_TOKEN: 'must-not-be-used' };
  let listener, origin, lostOperation = null, discardedResponse = false;
  const received = [], executionIds = [];
  const app = express();
  mountBuildingStore(app, { secret, execute: async (body, identity) => {
    executionIds.push({ operation: body.operation, requestId: identity.requestId, hash: identity.payloadSha256 });
    return executeBuildingStoreOperation(body, identity);
  } });
  const localFetcher = async (url, options) => {
    assert.equal(url, config.BUILDING_STORE_BRIDGE_URL, 'The portal attempted an unexpected external destination');
    const op = JSON.parse(options.body);
    received.push({ operation: op.operation, body: options.body, headers: { ...options.headers } });
    // Only the origin is replaced. HMAC headers and the raw request body go
    // unchanged through Express authentication and the real transaction layer.
    const response = await fetch(origin + '/api/internal/building-store', options);
    if (op.operation === lostOperation && !discardedResponse && response.ok) {
      await response.arrayBuffer(); discardedResponse = true;
      throw Error('Synthetic response loss after the bridge committed');
    }
    return response;
  };
  const store = createBuildingStore({ env: config, fetcher: localFetcher, timeoutMs: 1000 });
  await connect();
  try {
    await initBuildingStoreSchema();
    listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
    origin = `http://127.0.0.1:${listener.address().port}`;
    await t.test('uninitialized bridge and wrong HMAC fail without consulting Redis', async () => {
      await assert.rejects(store.command(['GET', 'resv:all']), /unavailable/);
      const wrong = createBuildingStore({ env: { ...config, BUILDING_STORE_BRIDGE_SECRET: 'incorrect-secret-at-least-32-bytes' }, fetcher: localFetcher });
      const before = executionIds.length;
      await assert.rejects(wrong.command(['GET', 'resv:all']), /unavailable/);
      assert.equal(executionIds.length, before, 'Bad HMAC must not enter the database executor');
    });
    const snapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(), source: { label: 'Synthetic local wire rehearsal', complete: true, expectedKeyCount: 3 }, entries: [
      { key: 'resv:all', value: archive, expiresAt: null },
      { key: 'resv:warden-secret', value: 'synthetic unchanged credential hash', expiresAt: null },
      { key: expiredKey, value: 'expired-code-hash', expiresAt: Date.now() - 1000 },
    ] };
    const sourceFile = path.join(directory, 'source.json'); await fs.writeFile(sourceFile, JSON.stringify(snapshot), { mode: 0o600 });
    const stage = await stageBuildingSource(sourceFile, path.join(directory, 'stage'));
    await stageBuildingTarget(stage); await verifyBuildingTarget(stage.manifest.snapshotId);
    await activateBuildingTarget(stage.manifest.snapshotId, stage.manifestSha256);
    await t.test('GET preserves exact original bytes and archived signature/token evidence', async () => {
      assert.equal((await store.command(['GET', 'resv:all'])).result, archive);
      const row = await dbGet("SELECT value_text,value_sha256 FROM building_store_entries WHERE key='resv:all'");
      assert.equal(row.value_text, archive); assert.equal(row.value_sha256, buildingStoreHash(archive));
      assert.equal((await store.command(['GET', 'resv:warden-secret'])).result, snapshot.entries[1].value);
    });
    await t.test('real concurrent CAS permits one winner and keeps all prior signatures', async () => {
      const a = JSON.stringify([...JSON.parse(archive), { id: 'SSL-NEW-A', status: 'pending' }]);
      const b = JSON.stringify([...JSON.parse(archive), { id: 'SSL-NEW-B', status: 'pending' }]);
      const results = await Promise.all([a,b].map(next => store.command(['EVAL', BUILDING_CAS, 1, 'resv:all', archive, next])));
      assert.deepEqual(results.map(row => row.result).sort(), [0,1]);
      const current = (await store.command(['GET', 'resv:all'])).result;
      assert.deepEqual(JSON.parse(current)[0], JSON.parse(archive)[0]);
    });
    await t.test('expired challenge and concurrent one-time consume obey the real database clock', async () => {
      assert.equal((await store.command(['EVAL', BUILDING_CONSUME, 1, expiredKey, 'expired-code-hash'])).result, 0);
      assert.equal((await store.command(['GET', expiredKey])).result, null);
      const active = 'resv:private:gapz:challenge:' + 'c'.repeat(48);
      assert.equal((await store.command(['SET', active, 'active-hash', 'EX', 600])).result, 'OK');
      const results = await Promise.all([1,2].map(() => store.command(['EVAL', BUILDING_CONSUME, 1, active, 'active-hash'])));
      assert.deepEqual(results.map(row => row.result).sort(), [0,1]);
    });
    await t.test('lost committed INCR, consume and CAS responses replay the original SQL receipt', async () => {
      const active = 'resv:private:gapz:challenge:' + 'd'.repeat(48);
      await store.command(['SET', active, 'retry-hash', 'EX', 600]);
      const previous = (await store.command(['GET', 'resv:all'])).result;
      const next = JSON.stringify([...JSON.parse(previous), { id: 'SSL-REPLAY', status: 'pending' }]);
      for (const [operation, input] of [
        ['increment', ['INCR', 'resv:private:gapz:daily']],
        ['consume', ['EVAL', BUILDING_CONSUME, 1, active, 'retry-hash']],
        ['cas', ['EVAL', BUILDING_CAS, 1, 'resv:all', previous, next]],
      ]) {
        lostOperation = operation; discardedResponse = false;
        const before = received.length;
        assert.equal((await store.command(input)).result, 1);
        assert.equal(discardedResponse, true);
        const attempts = received.slice(before); assert.equal(attempts.length, 2);
        assert.deepEqual(attempts[0], attempts[1], 'Transport replay must retain exact HMAC/identity/body');
        const id = attempts[0].headers['x-building-store-request-id'];
        assert.equal((await dbGet('SELECT COUNT(*) AS count FROM building_store_receipts WHERE request_id=?', [id])).count, 1);
      }
      lostOperation = null;
      assert.equal((await store.command(['GET', 'resv:private:gapz:daily'])).result, '1');
      assert.equal((await store.command(['GET', active])).result, null);
      const final = JSON.parse((await store.command(['GET', 'resv:all'])).result);
      assert.equal(final.filter(row => row.id === 'SSL-REPLAY').length, 1);
      assert.deepEqual(final[0], JSON.parse(archive)[0]);
    });
    await t.test('missing archive after activation fails all reads instead of falling back', async () => {
      await dbRun("DELETE FROM building_store_entries WHERE key='resv:all'");
      await assert.rejects(store.command(['GET', 'resv:warden-secret']), /unavailable/);
    });
  } finally {
    if (listener) await new Promise(resolve => listener.close(resolve));
    await close(); await fs.rm(directory, { recursive: true, force: true });
  }
});
