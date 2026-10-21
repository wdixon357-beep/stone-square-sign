import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectBuildingSourceSnapshot, createBuildingSourceReader, validateBuildingWriterFence, writeBuildingSourceSnapshot } from '../scripts/export-building-store.mjs';
import { stageBuildingSource } from '../building-store-migration.js';

const fixedNow = 1_790_000_000_000;
const fence = { schemaVersion: 1, writersFenced: true, scope: 'all-building-writers', recordedAt: new Date(fixedNow).toISOString(), reference: 'Synthetic operator fencing evidence' };
const archive = '[\n { "id" : "SSL-SYNTHETIC", "agreement":{"signatureData":"synthetic original ink", "signedAt":"2026-01-01T00:00:00Z"}, "statusAccessHash":"preserved" }\n]\n';
const fixture = () => new Map([
  ['resv:all', { value: archive, expiresAt: null }], ['resv:push-subs', { value: ' [ ] \n', expiresAt: null }],
  ['resv:warden-secret', { value: 'synthetic-hash', expiresAt: null }],
  ['resv:private:gapz:session:' + 'a'.repeat(64), { value: 'synthetic@example.invalid', expiresAt: fixedNow + 3600123 }],
]);
function source({ mutate = () => {}, pages = false } = {}) {
  const rows = fixture(), calls = []; let scanCount = 0;
  const command = async args => {
    calls.push(args); const [op, key] = args;
    mutate({ args, rows, scanCount });
    if (op === 'SCAN') {
      if (key === '0') scanCount++;
      const keys = [...rows.keys()];
      if (pages) return key === '0' ? ['7', keys.slice(0,3)] : ['0', keys.slice(2)];
      return ['0', keys];
    }
    const row = rows.get(key);
    if (op === 'GET') return row?.value ?? null;
    if (op === 'TYPE') return row?.type || (row ? 'string' : 'none');
    if (op === 'PTTL') return row ? row.expiresAt === null ? -1 : row.expiresAt - fixedNow : -2;
    if (op === 'PEXPIRETIME') return row ? row.expiresAt ?? -1 : -2;
    assert.fail('Unexpected or mutating source command');
  };
  return { command, rows, calls };
}
const collect = command => collectBuildingSourceSnapshot({ command, label: 'Synthetic isolated source', fenceRecord: fence, now: () => fixedNow });

test('complete paged source export preserves text and exact absolute expiries', async () => {
  const reader = source({ pages: true }); const snapshot = await collect(reader.command);
  assert.equal(snapshot.entries.length, 4); assert.equal(snapshot.source.expectedKeyCount, 4);
  assert.equal(snapshot.entries.find(row => row.key === 'resv:all').value, archive);
  assert.equal(snapshot.entries.find(row => row.key.includes(':session:')).expiresAt, fixedNow + 3600123);
  assert.equal(snapshot.source.evidence.beforeArchiveSha256, snapshot.source.evidence.afterArchiveSha256);
  assert.equal(snapshot.source.evidence.beforeInventorySha256, snapshot.source.evidence.afterInventorySha256);
  assert.equal(snapshot.source.evidence.exactExpiryCommand, 'PEXPIRETIME');
  assert(reader.calls.every(args => ['SCAN','TYPE','GET','PTTL','PEXPIRETIME'].includes(args[0])));
  assert.equal(reader.calls.filter(args => args[0] === 'SCAN').length, 4);
});

test('source changes in an archive, another value, key set or expiry block export', async () => {
  for (const change of [
    rows => { rows.get('resv:all').value = archive + ' '; },
    rows => { rows.get('resv:push-subs').value = '[{}]'; },
    rows => { rows.delete('resv:warden-secret'); },
    rows => { rows.get('resv:private:gapz:session:' + 'a'.repeat(64)).expiresAt++; },
  ]) {
    let changed = false;
    const reader = source({ mutate: ({ args, rows, scanCount }) => { if (args[0] === 'SCAN' && scanCount === 1 && !changed) { change(rows); changed = true; } } });
    await assert.rejects(collect(reader.command), /changed during export/);
  }
});

test('missing, empty, duplicate-ID, unsupported and expired source data fail closed', async () => {
  for (const change of [
    rows => rows.clear(), rows => rows.delete('resv:all'), rows => { rows.get('resv:all').value = '[]'; },
    rows => { rows.get('resv:all').value = '[{"id":"same"},{"id":"same"}]'; },
    rows => rows.set('resv:unknown', { value: 'unrecognized', expiresAt: null }),
    rows => { rows.get('resv:push-subs').type = 'list'; },
    rows => { rows.get('resv:all').expiresAt = fixedNow + 1000; },
  ]) { const reader = source(); change(reader.rows); await assert.rejects(collect(reader.command)); }
  for (const replacement of [ ['PTTL', -2], ['PEXPIRETIME', -2], ['PEXPIRETIME', 'unsupported'] ]) {
    const reader = source();
    await assert.rejects(collect(args => args[0] === replacement[0] ? replacement[1] : reader.command(args)));
  }
  const reader = source();
  await assert.rejects(collect(args => args[0] === 'GET' && args[1] === 'resv:push-subs' ? null : reader.command(args)), /disappeared/);
});

test('fencing is explicit and API errors never escape as credentials or record text', async () => {
  for (const override of [ { writersFenced: false }, { scope: 'only-one-deployment' }, { recordedAt: '' }, { reference: '' } ])
    assert.throws(() => validateBuildingWriterFence({ ...fence, ...override }));
  await assert.rejects(collect(async () => { throw Error('secret-token and raw signed records'); }), error => !/secret-token|raw signed/.test(error.message));
  const command = createBuildingSourceReader({ url: 'https://synthetic.invalid', token: 'secret-token', fetcher: async () => ({ ok: false, json: async () => ({ error: 'secret-token raw records' }) }) });
  await assert.rejects(command(['GET','resv:all']), error => !/secret-token|raw records/.test(error.message));
  await assert.rejects(command(['SET','resv:all','[]']), /read-only/);
  assert.throws(() => createBuildingSourceReader({ url: 'http://synthetic.invalid', token: 'secret-token' }));
});

test('malformed scans and repeated cursors cannot claim complete inventory', async () => {
  for (const response of [ null, [], ['0', null], ['not-a-cursor', []] ]) {
    const reader = source(); await assert.rejects(collect(args => args[0] === 'SCAN' ? response : reader.command(args)));
  }
  const reader = source(); await assert.rejects(collect(args => args[0] === 'SCAN' ? ['7',['resv:all']] : reader.command(args)), /did not complete/);
});

test('export is private, cannot overwrite a backup, and passes the real staging validator', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'building-export-test-'));
  try {
    const snapshot = await collect(source().command), file = path.join(directory, 'source.json');
    const summary = await writeBuildingSourceSnapshot(snapshot, file);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(summary.keyCount, 4); assert.equal(summary.recordCount, 1);
    assert.doesNotMatch(JSON.stringify(summary), /signatureData|synthetic original ink|statusAccessHash|secret-token/);
    const bytes = await fs.readFile(file);
    await assert.rejects(writeBuildingSourceSnapshot(snapshot, file), error => error.code === 'EEXIST');
    assert((await fs.readFile(file)).equals(bytes));
    assert.deepEqual((await fs.readdir(directory)).sort(), ['source.json']);
    const stage = await stageBuildingSource(file, path.join(directory, 'stage'));
    assert.equal(stage.manifest.keyCount, 4); assert.equal(stage.manifest.recordCount, 1);
    assert.equal(stage.entries.find(row => row.key === 'resv:all').value, archive);
    assert.deepEqual(stage.manifest.source.writerFence, snapshot.source.writerFence);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
