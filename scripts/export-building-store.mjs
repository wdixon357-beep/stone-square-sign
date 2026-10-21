import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildingStoreHash, isBuildingStoreKey, isExpiringBuildingStoreKey, validateBuildingStoreText } from '../building-store.js';
import { validateBuildingSourceSnapshot } from '../building-store-migration.js';

const fail = message => { throw new Error(message); };
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateBuildingWriterFence(record) {
  if (record?.schemaVersion !== 1 || record.writersFenced !== true || record.scope !== 'all-building-writers'
    || !validDate(record.recordedAt) || typeof record.reference !== 'string' || !record.reference.trim()) {
    fail('An external fencing record must confirm every building writer is fenced, with recordedAt and reference.');
  }
  return record;
}

export function createBuildingSourceReader({ url, token, fetcher = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { fail('An explicit HTTPS source Redis REST URL is required.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || typeof token !== 'string' || !token.trim()) fail('An explicit HTTPS source Redis REST URL and token are required.');
  return async command => {
    if (!['SCAN','GET','TYPE','PTTL','PEXPIRETIME'].includes(command?.[0])) fail('The source export permits read-only commands only.');
    try {
      const response = await fetcher(endpoint.href, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) fail('Source storage could not be read.');
      const data = await response.json();
      if (!data || data.error || !Object.hasOwn(data, 'result')) fail('Source storage could not be read.');
      return data.result;
    } catch { fail('Source storage could not be read; no complete snapshot was produced.'); }
  };
}

export async function collectBuildingSourceSnapshot({ command, label, fenceRecord, now = Date.now } = {}) {
  validateBuildingWriterFence(fenceRecord);
  if (typeof command !== 'function' || typeof label !== 'string' || !label.trim()) fail('A source reader and source label are required.');
  const read = async args => {
    try { return await command(args); }
    catch { fail('Source read failed; no complete snapshot was produced.'); }
  };
  const readArchive = async () => {
    const value = await read(['GET', 'resv:all']);
    if (typeof value !== 'string' || !value) fail('The known original building archive is unavailable.');
    validateBuildingStoreText(value);
    return buildingStoreHash(value);
  };
  const inventory = async () => {
    const keys = new Set(), cursors = new Set(); let cursor = '0';
    for (let page = 0; page < 10000; page++) {
      const result = await read(['SCAN', cursor, 'MATCH', 'resv:*', 'COUNT', 1000]);
      if (!Array.isArray(result) || result.length !== 2 || !/^\d+$/.test(String(result[0])) || !Array.isArray(result[1])) fail('The complete building key inventory could not be verified.');
      for (const key of result[1]) {
        if (!isBuildingStoreKey(key)) fail('An unsupported building key requires review before export.');
        keys.add(key);
      }
      if (keys.size > 10000) fail('The building key inventory exceeds the supported limit.');
      cursor = String(result[0]);
      if (cursor === '0') return [...keys].sort();
      if (cursors.has(cursor)) fail('The source scan did not complete.');
      cursors.add(cursor);
    }
    fail('The source scan did not complete.');
  };
  const sweep = async () => {
    const keys = await inventory();
    if (!keys.length || !keys.includes('resv:all')) fail('The known original building archive is missing from the complete inventory.');
    const entries = [];
    for (const key of keys) {
      if (await read(['TYPE', key]) !== 'string') fail('An unsupported building storage type requires review before export.');
      const value = await read(['GET', key]);
      if (typeof value !== 'string') fail('A source key disappeared or returned invalid text during export.');
      validateBuildingStoreText(value);
      const ttl = await read(['PTTL', key]);
      // PTTL alone cannot recover an exact expiry across network latency.
      // PEXPIRETIME is read only and preserves the original epoch milliseconds.
      const expiresAt = await read(['PEXPIRETIME', key]);
      if (!Number.isSafeInteger(ttl) || ttl < -1 || !Number.isSafeInteger(expiresAt) || expiresAt < -1
        || (ttl === -1) !== (expiresAt === -1)) fail('A source key expired, changed expiry, or lacks exact expiry support.');
      const absoluteExpiry = expiresAt === -1 ? null : expiresAt;
      if (!isExpiringBuildingStoreKey(key) && absoluteExpiry !== null) fail('A persistent building key unexpectedly has an expiry.');
      entries.push({ key, value, expiresAt: absoluteExpiry });
    }
    return entries;
  };
  const capturedAt = new Date(now()).toISOString();
  const beforeArchiveSha256 = await readArchive();
  const before = await sweep(), after = await sweep();
  const afterArchiveSha256 = await readArchive();
  const inventoryHash = entries => buildingStoreHash(JSON.stringify(entries.map(entry => ({ key: entry.key, valueSha256: buildingStoreHash(entry.value), expiresAt: entry.expiresAt }))));
  const beforeInventorySha256 = inventoryHash(before), afterInventorySha256 = inventoryHash(after);
  if (beforeArchiveSha256 !== afterArchiveSha256 || beforeInventorySha256 !== afterInventorySha256
    || buildingStoreHash(before.find(entry => entry.key === 'resv:all').value) !== beforeArchiveSha256) {
    fail('The source changed during export. Verify every writer is fenced, then start a fresh export.');
  }
  const snapshot = {
    schemaVersion: 1, capturedAt,
    source: { label: label.trim(), complete: true, expectedKeyCount: before.length,
      writerFence: { recordedAt: fenceRecord.recordedAt, reference: fenceRecord.reference, scope: fenceRecord.scope,
        sha256: buildingStoreHash(JSON.stringify(fenceRecord)) },
      evidence: { scans: 2, beforeArchiveSha256, afterArchiveSha256, beforeInventorySha256, afterInventorySha256,
        completedAt: new Date(now()).toISOString(), exactExpiryCommand: 'PEXPIRETIME' } },
    entries: before,
  };
  validateBuildingSourceSnapshot(snapshot);
  return snapshot;
}

export async function writeBuildingSourceSnapshot(snapshot, outputFile) {
  const records = validateBuildingSourceSnapshot(snapshot);
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
  const temporary = path.join(path.dirname(outputFile), '.building-export-' + crypto.randomUUID() + '.tmp');
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600); created = true;
    try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    // Linking creates the final file atomically and refuses an existing backup.
    await fs.link(temporary, outputFile);
  } finally { if (created) await fs.unlink(temporary); }
  const stored = await fs.readFile(outputFile);
  if (!stored.equals(bytes) || ((await fs.stat(outputFile)).mode & 0o777) !== 0o600) fail('The private export file failed verification.');
  return { file: path.resolve(outputFile), sha256: buildingStoreHash(bytes), keyCount: snapshot.entries.length,
    recordCount: records.length, archiveSha256: buildingStoreHash(snapshot.entries.find(entry => entry.key === 'resv:all').value) };
}

async function main(args) {
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const required = name => { const value = option(name); if (!value || value.startsWith('--')) fail(`Missing ${name}.`); return value; };
  if (args.includes('--help')) {
    console.log('Export read-only building storage: --out FILE --source-label LABEL --fence-record FILE. Supply BUILDING_SOURCE_REDIS_REST_URL and BUILDING_SOURCE_REDIS_REST_TOKEN explicitly. The external fence record is JSON: {schemaVersion:1,writersFenced:true,scope:"all-building-writers",recordedAt:"ISO timestamp",reference:"operator evidence reference"}. No .env file is loaded.');
    return;
  }
  const output = required('--out'), label = required('--source-label');
  let fenceRecord;
  try { fenceRecord = JSON.parse(await fs.readFile(required('--fence-record'), 'utf8')); }
  catch { fail('The external writer fencing record could not be read.'); }
  const command = createBuildingSourceReader({ url: process.env.BUILDING_SOURCE_REDIS_REST_URL, token: process.env.BUILDING_SOURCE_REDIS_REST_TOKEN });
  const snapshot = await collectBuildingSourceSnapshot({ command, label, fenceRecord });
  console.log(JSON.stringify(await writeBuildingSourceSnapshot(snapshot, output), null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    // Provider errors can contain credentials and raw records. Print no such data.
    console.error('Building source export failed. No verified new snapshot was produced; inspect source access, writer fencing, inventory and exact expiry support.');
    process.exitCode = 1;
  });
}
