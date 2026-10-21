import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redisRdbCrc64, decodeRdbLzf, parseBuildingRdb, buildingSnapshotFromRdb } from '../scripts/import-building-rdb.mjs';
import { writeBuildingSourceSnapshot } from '../scripts/export-building-store.mjs';
import { stageBuildingSource } from '../building-store-migration.js';

let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; };
const rejected = (fn, pattern) => { assert.throws(fn, pattern); checks++; };
const length = (size, form) => {
  if (form === 64) { const b = Buffer.alloc(9); b[0] = 0x81; b.writeBigUInt64BE(BigInt(size), 1); return b; }
  if (form === 32 || size > 16383) { const b = Buffer.alloc(5); b[0] = 0x80; b.writeUInt32BE(size, 1); return b; }
  if (size > 63) return Buffer.from([0x40 | (size >> 8), size & 255]);
  return Buffer.from([size]);
};
const string = (value, form) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([length(b.length, form), b]); };
const pair = (key, value, options = {}) => {
  const parts = [];
  if (options.expiry !== undefined) { const b = Buffer.alloc(9); b[0] = 252; b.writeBigInt64LE(BigInt(options.expiry), 1); parts.push(b); }
  parts.push(Buffer.from([options.type ?? 0]), string(key), options.encoded ?? string(value, options.form)); return Buffer.concat(parts);
};
const file = (parts, { zero = false, version = '0011' } = {}) => {
  const body = Buffer.concat([Buffer.from('REDIS' + version), ...parts, Buffer.from([255])]);
  const checksum = Buffer.alloc(8); checksum.writeBigUInt64LE(zero ? 0n : redisRdbCrc64(body)); return Buffer.concat([body, checksum]);
};
const raw = '[\n {"id":"SSL-SYNTHETIC","agreement":{"text":"Exact café\\nterms","signatureData":"data:image/png;base64,c3ludGhldGlj","signedAt":"2026-10-20T12:00:00Z"}}\n]\n';
const expiredAt = 1_000_000_123;
const fenceRecord = { schemaVersion: 1, writersFenced: true, scope: 'all-building-writers', recordedAt: '2026-10-20T12:00:00.000Z', reference: 'Synthetic fence evidence' };
const options = { label: 'Synthetic provider RDB', capturedAt: '2026-10-20T12:01:00.000Z', fenceRecord };

check('Redis primary-source CRC known vector', redisRdbCrc64(Buffer.from('123456789')) === 0xe9c6d914c4b8d9can);
check('Known overlapping LZF back reference', decodeRdbLzf(Buffer.from([2, 97, 98, 99, 224, 0, 2]), 12).toString() === 'abcabcabcabc');
rejected(() => decodeRdbLzf(Buffer.from([224]), 9), /Truncated/);
rejected(() => decodeRdbLzf(Buffer.from([32, 0]), 3), /Invalid/);
rejected(() => decodeRdbLzf(Buffer.from([0, 97]), 2), /length/);

const rdb = file([
  Buffer.concat([Buffer.from([250]), string('redis-ver'), string('7.2.0')]),
  Buffer.from([254, 0, 251, 6, 1]),
  pair('resv:all', raw, { form: 64 }),
  pair('resv:push-subs', ' [] \n', { form: 32 }),
  pair('resv:warden-secret', 'synthetic-passcode-hash'),
  pair('resv:status-fail:' + 'a'.repeat(64), '', { expiry: expiredAt, encoded: Buffer.from([0xc0, 0xf9]) }),
  pair('other:compressed', '', { encoded: Buffer.from([0xc3, 7, 12, 2, 97, 98, 99, 224, 0, 2]) }),
  pair('other:list', '', { type: 1, encoded: Buffer.concat([length(2), string('ignored'), string('also ignored')]) }),
]);
const parsed = parseBuildingRdb(rdb);
check('Full database parsed while building inventory is selected', parsed.evidence.totalDatabaseKeys === 6 && parsed.entries.length === 4);
check('Raw archive UTF-8 and whitespace survive exactly', parsed.entries.find(x => x.key === 'resv:all').value === raw);
check('Absolute expired milliseconds are retained without revival', parsed.entries.find(x => x.key.startsWith('resv:status-fail:')).expiresAt === expiredAt);
const secondsExpiry = Buffer.from([253, 0xff, 0xff, 0xff, 0x7f]);
check('Legacy signed 32-bit seconds upper bound is preserved exactly', parseBuildingRdb(file([pair('resv:all', raw), secondsExpiry, pair('resv:private:gapz:daily', '1')])).entries.find(x => x.key.endsWith('daily')).expiresAt === 2_147_483_647_000);
rejected(() => parseBuildingRdb(file([pair('resv:all', raw), Buffer.from([253, 0, 0, 0, 0x80]), pair('resv:private:gapz:daily', '1')])), /expiry cannot be represented/);
check('Modern millisecond expiry after year 2038 remains exact', parseBuildingRdb(file([pair('resv:all', raw), pair('resv:private:gapz:daily', '1', { expiry: 4_102_444_800_123 })])).entries.find(x => x.key.endsWith('daily')).expiresAt === 4_102_444_800_123);
check('Signed integer encoding becomes exact canonical Redis text', parsed.entries.find(x => x.key.startsWith('resv:status-fail:')).value === '-7');
check('Verified checksum and immutable file hash recorded', parsed.evidence.checksum === 'verified' && /^[a-f0-9]{64}$/.test(parsed.evidence.rdbSha256));
const snapshot = buildingSnapshotFromRdb(rdb, options);
check('Existing snapshot schema includes original archive and source evidence', snapshot.source.complete && snapshot.source.expectedKeyCount === 4 && snapshot.source.evidence.rdbSha256 === parsed.evidence.rdbSha256);
rejected(() => buildingSnapshotFromRdb(rdb, { ...options, capturedAt: '2026-10-20T11:59:00.000Z' }), /predates/);
rejected(() => buildingSnapshotFromRdb(rdb, { ...options, fenceRecord: { ...fenceRecord, writersFenced: false } }), /fencing/);
const corrupt = Buffer.from(rdb); corrupt[corrupt.length - 1] ^= 1;
rejected(() => parseBuildingRdb(corrupt), /checksum/);
const highBitHeader = Buffer.from(rdb); highBitHeader[0] |= 128;
rejected(() => parseBuildingRdb(highBitHeader), /not a Redis/);
rejected(() => parseBuildingRdb(Buffer.concat([rdb, Buffer.from([0])])), /length/);
rejected(() => parseBuildingRdb(rdb.subarray(0, -1)), /Truncated|length/);
rejected(() => parseBuildingRdb(file([pair('resv:all', raw)], { zero: true })), /disabled/);
check('Explicit disabled-checksum review remains visible in evidence', parseBuildingRdb(file([pair('resv:all', raw)], { zero: true }), { allowDisabledChecksum: true }).evidence.checksum === 'disabled-explicitly-reviewed');
rejected(() => parseBuildingRdb(file([pair('resv:all', raw)], { version: '0012' })), /version/);
rejected(() => parseBuildingRdb(file([pair('resv:all', raw), pair('resv:all', raw)])), /Duplicate/);
rejected(() => parseBuildingRdb(file([pair('resv:unknown', raw)])), /unsupported building key/);
rejected(() => parseBuildingRdb(file([Buffer.from([254, 1]), pair('resv:all', raw)])), /database zero/);
rejected(() => parseBuildingRdb(file([pair('resv:all', '', { type: 1, encoded: Buffer.from([0]) })])), /non-string/);
rejected(() => parseBuildingRdb(file([pair('resv:all', Buffer.from([0xff]))])), /UTF-8/);
rejected(() => parseBuildingRdb(file([pair('other:stream', '', { type: 21, encoded: Buffer.from([0]) })])), /unsupported RDB object/);
rejected(() => parseBuildingRdb(file([Buffer.from([245])])), /modules or functions/);
rejected(() => buildingSnapshotFromRdb(file([pair('resv:all', '[]')]), options), /empty source/);
rejected(() => buildingSnapshotFromRdb(file([pair('resv:all', raw, { expiry: expiredAt })]), options), /cannot expire/);
for (const [encoding, value] of [[Buffer.from([0xc1, 0x00, 0x80]), '-32768'], [Buffer.from([0xc2, 0xff, 0xff, 0xff, 0x7f]), '2147483647']]) {
  check('Multi-byte signed integer decode', parseBuildingRdb(file([pair('resv:all', raw), pair('resv:private:gapz:daily', '', { encoded: encoding })])).entries.find(x => x.key.endsWith('daily')).value === value);
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'building-rdb-test-'));
try {
  const output = path.join(directory, 'snapshot.json');
  const summary = await writeBuildingSourceSnapshot(snapshot, output);
  check('Private atomic output exposes only summary metadata', ((await fs.stat(output)).mode & 0o777) === 0o600 && summary.recordCount === 1 && summary.keyCount === 4);
  const stage = await stageBuildingSource(output, path.join(directory, 'stage'));
  check('Converter feeds existing verified-stage contract with unchanged signatures', stage.entries.find(x => x.key === 'resv:all').value === raw && stage.manifest.records[0].signatures.length === 2);
  await assert.rejects(writeBuildingSourceSnapshot(snapshot, output), /EEXIST/); checks++;
  const input = path.join(directory, 'source.rdb'); await fs.writeFile(input, rdb);
  const before = await fs.readFile(input);
  const result = spawnSync(process.execPath, ['scripts/import-building-rdb.mjs', '--rdb', input, '--inspect'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  check('CLI inspection reports hashes and counts without source values', result.status === 0 && JSON.parse(result.stdout).buildingKeys === 4 && !result.stdout.includes('signatureData') && !result.stdout.includes('synthetic-passcode-hash'));
  check('Input RDB remains byte-identical', (await fs.readFile(input)).equals(before));
} finally { await fs.rm(directory, { recursive: true, force: true }); }
console.log(`PASS ${checks} offline RDB checks: CRC, raw text, LZF, integer encodings, absolute expiry, inventory, fencing, private output and existing staging contract.`);
