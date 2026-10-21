import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildingStoreHash, isBuildingStoreKey, validateBuildingStoreText } from '../building-store.js';
import { validateBuildingSourceSnapshot } from '../building-store-migration.js';
import { validateBuildingWriterFence, writeBuildingSourceSnapshot } from './export-building-store.mjs';

// Independent, deliberately limited offline decoder. Binary format references:
// https://github.com/redis/redis/blob/7.2/src/rdb.h
// https://github.com/redis/redis/blob/7.2/src/rdb.c
// https://github.com/redis/redis/blob/7.2/src/lzf_d.c
// https://github.com/redis/redis/blob/7.2/src/crc64.c
// Never load a backup into a running server: doing so can discard expired keys.
// Unsupported versions, object types, modules and functions require review.
const fail = message => { throw new Error(message); };
const MAX_RDB_BYTES = 128 * 1024 * 1024;
const MAX_STRING_BYTES = 32 * 1024 * 1024;
const MAX_KEYS = 100_000;
const MASK = (1n << 64n) - 1n;
const CRC_POLY = 0x95ac9329ac4bc9b5n;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = BigInt(value);
  for (let bit = 0; bit < 8; bit++) crc = (crc >> 1n) ^ (crc & 1n ? CRC_POLY : 0n);
  return crc;
});
export function redisRdbCrc64(bytes) {
  let crc = 0n;
  for (const byte of bytes) crc = crcTable[Number((crc ^ BigInt(byte)) & 255n)] ^ (crc >> 8n);
  return crc & MASK;
}

export function decodeRdbLzf(input, outputLength) {
  if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > MAX_STRING_BYTES) fail('RDB string exceeds the supported bound.');
  const output = Buffer.alloc(outputLength); let from = 0, to = 0;
  while (from < input.length) {
    const control = input[from++];
    if (control < 32) {
      const count = control + 1;
      if (from + count > input.length || to + count > output.length) fail('Invalid RDB compressed literal.');
      input.copy(output, to, from, from + count); from += count; to += count;
    } else {
      let count = control >> 5;
      if (count === 7) {
        if (from >= input.length) fail('Truncated RDB compressed reference.');
        count += input[from++];
      }
      if (from >= input.length) fail('Truncated RDB compressed reference.');
      const start = to - ((control & 31) << 8) - input[from++] - 1; count += 2;
      if (start < 0 || to + count > output.length) fail('Invalid RDB compressed reference.');
      // Bytewise copying is required when a reference overlaps its destination.
      for (let i = 0; i < count; i++) output[to++] = output[start + i];
    }
  }
  if (to !== output.length) fail('RDB compressed length does not match.');
  return output;
}

export function parseBuildingRdb(bytes, { allowDisabledChecksum = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 18 || bytes.length > MAX_RDB_BYTES) fail('Invalid or oversized RDB file.');
  if (!bytes.subarray(0, 5).equals(Buffer.from('REDIS'))
    || ![...bytes.subarray(5, 9)].every(byte => byte >= 48 && byte <= 57)) fail('The input is not a Redis RDB file.');
  const version = Number(bytes.subarray(5, 9).toString('ascii'));
  if (version < 9 || version > 11) fail('This RDB version requires independent parser review.');
  let offset = 9, database = 0, expiry = null, pendingMetadata = false, totalKeys = 0, ended = false;
  const entries = [], seen = new Set();
  const take = count => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > bytes.length - 8) fail('Truncated RDB file.');
    const part = bytes.subarray(offset, offset + count); offset += count; return part;
  };
  const byte = () => take(1)[0];
  const length = ({ encoded = false } = {}) => {
    const first = byte(), kind = first >> 6;
    if (kind === 0) return { value: first & 63, encoded: false };
    if (kind === 1) return { value: ((first & 63) << 8) | byte(), encoded: false };
    if (kind === 3) {
      if (!encoded) fail('Unexpected encoded RDB length.');
      return { value: first & 63, encoded: true };
    }
    if (first === 0x80) return { value: take(4).readUInt32BE(), encoded: false };
    if (first === 0x81) {
      const result = take(8).readBigUInt64BE();
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('RDB length cannot be represented exactly.');
      return { value: Number(result), encoded: false };
    }
    fail('Unsupported RDB length encoding.');
  };
  const string = () => {
    const size = length({ encoded: true });
    if (!size.encoded) {
      if (size.value > MAX_STRING_BYTES) fail('RDB string exceeds the supported bound.');
      return take(size.value);
    }
    if (size.value <= 2) {
      const count = 1 << size.value, raw = take(count);
      return Buffer.from(String(raw.readIntLE(0, count)), 'ascii');
    }
    if (size.value === 3) {
      const compressed = length().value, uncompressed = length().value;
      if (compressed > MAX_STRING_BYTES) fail('RDB compressed string exceeds the supported bound.');
      return decodeRdbLzf(take(compressed), uncompressed);
    }
    fail('Unsupported RDB string encoding.');
  };
  const count = () => { const size = length().value; if (size > MAX_KEYS) fail('RDB collection exceeds the supported bound.'); return size; };
  const discardObject = type => {
    if (type === 0) { string(); return; }
    if ([9, 10, 11, 12, 13, 16, 17, 20].includes(type)) { string(); return; }
    if ([1, 2, 3, 4, 5, 14, 18].includes(type)) {
      const size = count();
      for (let item = 0; item < size; item++) {
        if (type === 18) { const container = length().value; if (![1, 2].includes(container)) fail('Unknown RDB quicklist container.'); }
        string();
        if (type === 4) string();
        if (type === 5) take(8);
        if (type === 3) { const size = byte(); if (size < 253) take(size); }
      }
      return;
    }
    fail('An unsupported RDB object type requires review before conversion.');
  };
  while (offset < bytes.length - 8) {
    const type = byte();
    if (type === 255) { if (pendingMetadata) fail('Dangling RDB key metadata.'); ended = true; break; }
    if (type === 250) { if (pendingMetadata) fail('Misplaced RDB auxiliary field.'); string(); string(); continue; }
    if (type === 254) { if (pendingMetadata) fail('Misplaced RDB database selector.'); database = length().value; continue; }
    if (type === 251) { if (pendingMetadata) fail('Misplaced RDB resize hint.'); count(); count(); continue; }
    if (type === 252 || type === 253) {
      if (expiry !== null) fail('Duplicate RDB key expiry.');
      const value = type === 252 ? take(8).readBigInt64LE() : BigInt(take(4).readInt32LE()) * 1000n;
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('RDB expiry cannot be represented exactly.');
      expiry = Number(value); pendingMetadata = true; continue;
    }
    if (type === 248) { length(); pendingMetadata = true; continue; }
    if (type === 249) { byte(); pendingMetadata = true; continue; }
    if (type >= 245) fail('RDB modules or functions require independent review.');
    const keyBytes = string();
    const identity = `${database}:${keyBytes.toString('base64')}`;
    if (seen.has(identity)) fail('Duplicate RDB key.');
    seen.add(identity); if (++totalKeys > MAX_KEYS) fail('RDB key count exceeds the supported bound.');
    const building = keyBytes.subarray(0, 5).equals(Buffer.from('resv:'));
    if (building) {
      if (database !== 0) fail('A building key exists outside database zero and requires review.');
      const key = keyBytes.toString('utf8');
      if (!Buffer.from(key).equals(keyBytes) || !isBuildingStoreKey(key)) fail('An unsupported building key requires review.');
      if (type !== 0) fail('A building key has a non-string RDB type.');
      const valueBytes = string(), value = valueBytes.toString('utf8');
      if (!Buffer.from(value).equals(valueBytes)) fail('A building value is not exact UTF-8 text.');
      validateBuildingStoreText(value); entries.push({ key, value, expiresAt: expiry });
    } else discardObject(type);
    expiry = null; pendingMetadata = false;
  }
  if (!ended || offset !== bytes.length - 8) fail('RDB end marker or exact file length failed verification.');
  const checksum = bytes.readBigUInt64LE(offset), computed = redisRdbCrc64(bytes.subarray(0, offset));
  if (checksum === 0n && !allowDisabledChecksum) fail('The RDB checksum is disabled; explicit operator review is required.');
  if (checksum !== 0n && checksum !== computed) fail('RDB checksum verification failed.');
  return { entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
    evidence: { rdbVersion: version, fileBytes: bytes.length, rdbSha256: buildingStoreHash(bytes),
      totalDatabaseKeys: totalKeys, buildingKeys: entries.length, checksum: checksum === 0n ? 'disabled-explicitly-reviewed' : 'verified',
      expiredValuesRetained: true } };
}

export function buildingSnapshotFromRdb(bytes, { label, capturedAt, fenceRecord, allowDisabledChecksum = false } = {}) {
  validateBuildingWriterFence(fenceRecord);
  if (typeof label !== 'string' || !label.trim() || typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) fail('The provider backup label and capture timestamp are required.');
  if (Date.parse(capturedAt) < Date.parse(fenceRecord.recordedAt)) fail('The backup predates the writer fence; capture a fresh backup.');
  const parsed = parseBuildingRdb(bytes, { allowDisabledChecksum });
  const snapshot = { schemaVersion: 1, capturedAt,
    source: { label: label.trim(), complete: true, expectedKeyCount: parsed.entries.length,
      writerFence: { recordedAt: fenceRecord.recordedAt, reference: fenceRecord.reference, scope: fenceRecord.scope,
        sha256: buildingStoreHash(JSON.stringify(fenceRecord)) }, evidence: parsed.evidence }, entries: parsed.entries };
  validateBuildingSourceSnapshot(snapshot); return snapshot;
}

async function main(args) {
  const required = name => { const index = args.indexOf(name), value = index < 0 ? null : args[index + 1]; if (!value || value.startsWith('--')) fail('A required converter argument is missing.'); return value; };
  if (args.includes('--help')) {
    console.log('Offline RDB inspection: --rdb FILE --inspect. Conversion: --rdb FILE --out FILE --source-label LABEL --captured-at ISO --fence-record FILE. Optional --allow-disabled-checksum requires independent operator review. No network or database access is performed.'); return;
  }
  const input = required('--rdb'), stat = await fs.stat(input);
  if (!stat.isFile() || stat.size > MAX_RDB_BYTES) fail('Invalid or oversized RDB input file.');
  const bytes = await fs.readFile(input), allowDisabledChecksum = args.includes('--allow-disabled-checksum');
  if (args.includes('--inspect')) { console.log(JSON.stringify(parseBuildingRdb(bytes, { allowDisabledChecksum }).evidence, null, 2)); return; }
  const fenceRecord = JSON.parse(await fs.readFile(required('--fence-record'), 'utf8'));
  const snapshot = buildingSnapshotFromRdb(bytes, { label: required('--source-label'), capturedAt: required('--captured-at'), fenceRecord, allowDisabledChecksum });
  console.log(JSON.stringify(await writeBuildingSourceSnapshot(snapshot, required('--out')), null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(() => {
  console.error('Offline RDB conversion failed. No verified snapshot was produced. Check format, checksum, complete building inventory, exact text, expiries and writer-fence evidence.'); process.exitCode = 1;
});
