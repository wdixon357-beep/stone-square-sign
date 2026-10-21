import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun, withTransaction, getDatabaseConnectionIdentity, isDatabaseTransactionActive } from './db.js';

export const BUILDING_STORE_MAX_VALUE_BYTES = 5 * 1024 * 1024;
// CAS carries both old and new raw JSON text, escaped in the RPC envelope.
export const BUILDING_STORE_MAX_BODY_BYTES = 24 * 1024 * 1024;
export const buildingStoreError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const buildingStoreHash = value => crypto.createHash('sha256').update(value).digest('hex');
export const isBuildingStoreKey = key => typeof key === 'string' && (
  ['resv:all', 'resv:push-subs', 'resv:warden-secret'].includes(key)
  || /^resv:status-fail:[a-f0-9]{64}$/.test(key)
  || /^resv:private:gapz:(?:cooldown|daily)$/.test(key)
  || /^resv:private:gapz:(?:challenge|attempts):[a-f0-9]{48}$/.test(key)
  || /^resv:private:gapz:session:[a-f0-9]{64}$/.test(key)
);
export const isExpiringBuildingStoreKey = key => isBuildingStoreKey(key)
  && !['resv:all', 'resv:push-subs', 'resv:warden-secret'].includes(key);

export function validateBuildingStoreText(value) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > BUILDING_STORE_MAX_VALUE_BYTES
      || Buffer.from(value).toString('utf8') !== value) {
    throw buildingStoreError(400, 'Building storage requires valid bounded UTF-8 text.');
  }
  return value;
}

export async function initBuildingStoreSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS building_store_entries (
    key TEXT PRIMARY KEY, value_text TEXT NOT NULL, value_sha256 TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1, expires_at BIGINT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS building_store_state (
    id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL CHECK(state IN ('uninitialized','ready')),
    snapshot_id TEXT, manifest_sha256 TEXT, imported_key_count INTEGER, imported_record_count INTEGER,
    imported_at TEXT
  )`);
  await dbRun("INSERT INTO building_store_state(id,state) VALUES(1,'uninitialized') ON CONFLICT(id) DO NOTHING");
  await dbRun(`CREATE TABLE IF NOT EXISTS building_store_receipts (
    request_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL, result_json TEXT NOT NULL, expires_at BIGINT NOT NULL
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS building_store_receipts_expiry ON building_store_receipts(expires_at)');
  await dbRun(`CREATE TABLE IF NOT EXISTS building_store_imports (
    snapshot_id TEXT PRIMARY KEY,manifest_text TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('staged','verified','activated')),
    staged_at TEXT NOT NULL,verified_at TEXT,activated_at TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS building_store_staged_entries (
    snapshot_id TEXT NOT NULL REFERENCES building_store_imports(snapshot_id),key TEXT NOT NULL,
    value_text TEXT NOT NULL,value_sha256 TEXT NOT NULL,expires_at BIGINT,
    PRIMARY KEY(snapshot_id,key)
  )`);
}

const unavailable = () => buildingStoreError(503, 'Building storage has not passed migration verification.');
const integerSeconds = value => Number.isSafeInteger(value) && value >= 1 && value <= 31_536_000;
const ownKeys = (body, allowed) => Object.keys(body).every(key => allowed.includes(key));

// Keep only the immutable raw archive, never permissions, tokens or filtered
// results. A cache hit still requires the current database row's actual digest
// inside the same singleton transaction. Only committed top-level reads publish
// an entry; work in an enclosing transaction bypasses the cache entirely.
let archiveCache = null;
const archiveMetadata = () => dbGet(`SELECT key,value_sha256,revision::text AS revision,expires_at,
  octet_length(convert_to(value_text,'UTF8')) AS value_bytes,
  encode(sha256(convert_to(value_text,'UTF8')),'hex') AS actual_sha256
  FROM building_store_entries WHERE key='resv:all'`);
const validArchiveMetadata = row => !!row && row.expires_at === null
  && /^[a-f0-9]{64}$/.test(row.value_sha256 || '') && row.actual_sha256 === row.value_sha256
  && /^[1-9][0-9]*$/.test(String(row.revision ?? ''))
  && Number.isSafeInteger(Number(row.value_bytes)) && Number(row.value_bytes) >= 0
  && Number(row.value_bytes) <= BUILDING_STORE_MAX_VALUE_BYTES;
const matchesArchive = (entry, metadata, scope) => !!entry && entry.scope === scope
  && entry.revision === String(metadata.revision) && entry.sha256 === metadata.actual_sha256
  && entry.bytes === Number(metadata.value_bytes);
const readArchive = async metadata => {
  const row = await dbGet("SELECT key,value_text,value_sha256,revision::text AS revision,expires_at FROM building_store_entries WHERE key='resv:all'");
  if (!row || row.expires_at !== null || typeof row.value_text !== 'string'
      || String(row.revision) !== String(metadata.revision) || row.value_sha256 !== metadata.value_sha256
      || Buffer.byteLength(row.value_text) !== Number(metadata.value_bytes)
      || buildingStoreHash(row.value_text) !== metadata.actual_sha256) throw unavailable();
  return row;
};

export function validateBuildingStoreOperation(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body.operation === 'health'
      && ownKeys(body, ['operation'])) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isBuildingStoreKey(body.key)) {
    throw buildingStoreError(400, 'Unsupported building storage key.');
  }
  const fields = {
    get: ['operation', 'key'], set: ['operation', 'key', 'value', 'ex', 'nx'],
    delete: ['operation', 'key'], increment: ['operation', 'key'],
    expire: ['operation', 'key', 'seconds'], cas: ['operation', 'key', 'expected', 'value'],
    consume: ['operation', 'key', 'expected'],
  }[body.operation];
  if (!fields || !ownKeys(body, fields)) throw buildingStoreError(400, 'Unsupported building storage operation.');
  if (['set', 'cas'].includes(body.operation)) validateBuildingStoreText(body.value);
  if (body.key === 'resv:all' && ['set', 'cas'].includes(body.operation)) {
    try { if (!Array.isArray(JSON.parse(body.value))) throw new Error(); }
    catch { throw buildingStoreError(400, 'The building request archive must be a JSON array.'); }
  }
  if (body.operation === 'cas') {
    if (body.key !== 'resv:all') throw buildingStoreError(400, 'Compare-and-set is limited to the building archive.');
    if (body.expected !== '') {
      try { if (!Array.isArray(JSON.parse(body.expected))) throw new Error(); }
      catch { throw buildingStoreError(400, 'The prior building request archive must be a JSON array.'); }
    }
  }
  if (body.operation === 'consume' && !/^resv:private:gapz:challenge:[a-f0-9]{48}$/.test(body.key)) {
    throw buildingStoreError(400, 'Consume is limited to temporary building challenges.');
  }
  if (['cas', 'consume'].includes(body.operation)) validateBuildingStoreText(body.expected);
  if (body.operation === 'set' && ((body.ex !== undefined && !integerSeconds(body.ex))
      || (body.nx !== undefined && body.nx !== true))) throw buildingStoreError(400, 'Invalid building storage set options.');
  if (body.operation === 'expire' && !integerSeconds(body.seconds)) throw buildingStoreError(400, 'Invalid building storage expiry.');
  if (!isExpiringBuildingStoreKey(body.key) && (body.operation === 'expire' || body.ex !== undefined)) {
    throw buildingStoreError(400, 'Persistent building records cannot expire.');
  }
  if (body.key === 'resv:all' && (['set', 'delete', 'consume', 'increment'].includes(body.operation) || body.nx !== undefined)) {
    throw buildingStoreError(400, 'The building request archive cannot be removed.');
  }
  if (body.operation === 'increment' && !isExpiringBuildingStoreKey(body.key)) {
    throw buildingStoreError(400, 'Only temporary building counters can be incremented.');
  }
  return body;
}

const storeValue = async (key, value, expiresAt, now) => {
  const stamp = new Date(now).toISOString();
  await dbRun(`INSERT INTO building_store_entries(key,value_text,value_sha256,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text,
    value_sha256=excluded.value_sha256,expires_at=excluded.expires_at,
    revision=building_store_entries.revision+1,updated_at=excluded.updated_at`,
  [key, value, buildingStoreHash(value), expiresAt, stamp, stamp]);
};

// The singleton row locks only this small private store. It serializes a command,
// its compare-and-set, and its retry receipt together on the production driver.
export async function executeBuildingStoreOperation(body, { requestId, payloadSha256, now = Date.now() } = {}) {
  validateBuildingStoreOperation(body);
  if (!/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(requestId || '')
      || !/^[a-f0-9]{64}$/.test(payloadSha256 || '') || !Number.isSafeInteger(now)) {
    throw buildingStoreError(400, 'Invalid building storage request identity.');
  }
  const scope = getDatabaseConnectionIdentity();
  const cacheAllowed = !!scope && !isDatabaseTransactionActive();
  let pendingCache = null;
  const result = await withTransaction(async () => {
    const state = await dbGet('SELECT * FROM building_store_state WHERE id=1 FOR UPDATE');
    const metadata = await archiveMetadata();
    if (body.operation === 'health') {
      const ready = state?.state === 'ready' && validArchiveMetadata(metadata);
      return { ready, state: ready ? 'ready' : 'uninitialized', snapshotId: state?.snapshot_id ?? null,
        manifestSha256: state?.manifest_sha256 ?? null, importedKeyCount: state?.imported_key_count ?? null,
        importedRecordCount: state?.imported_record_count ?? null };
    }
    if (state?.state !== 'ready') throw unavailable();
    if (!validArchiveMetadata(metadata)) throw unavailable();
    // Reads need current values and leave no retry rows. In particular, polling
    // must never duplicate the signed archive into a receipt for each GET.
    const mutation = body.operation !== 'get';
    // Mutations retain their full current-row verification and receipt ordering.
    // Other-key reads and health only need scalar archive integrity evidence.
    let archive = null;
    if (mutation || body.key === 'resv:all') {
      if (!mutation && cacheAllowed && matchesArchive(archiveCache, metadata, scope)) {
        archive = { ...metadata, value_text: archiveCache.valueText };
      } else {
        archive = await readArchive(metadata);
        if (!mutation && cacheAllowed) pendingCache = Object.freeze({ scope,
          revision: String(metadata.revision), sha256: metadata.actual_sha256,
          bytes: Number(metadata.value_bytes), valueText: archive.value_text });
      }
    }
    if (mutation) await dbRun('DELETE FROM building_store_receipts WHERE expires_at<=?', [now]);
    const prior = mutation ? await dbGet('SELECT * FROM building_store_receipts WHERE request_id=?', [requestId]) : null;
    if (prior) {
      if (prior.payload_sha256 !== payloadSha256) throw buildingStoreError(409, 'Building storage request identity was already used.');
      return JSON.parse(prior.result_json);
    }
    // The locked transaction already read and verified this exact archive row.
    // Reuse it instead of transferring the signed archive from PostgreSQL twice.
    let row = body.key === 'resv:all' ? archive
      : await dbGet('SELECT * FROM building_store_entries WHERE key=?', [body.key]);
    if (row && row.expires_at !== null && Number(row.expires_at) <= now) {
      await dbRun('DELETE FROM building_store_entries WHERE key=?', [body.key]);
      row = undefined;
    }
    if (row && buildingStoreHash(row.value_text) !== row.value_sha256) throw unavailable();
    let result;
    if (body.operation === 'get') result = row?.value_text ?? null;
    if (body.operation === 'set') {
      result = body.nx && row ? null : 'OK';
      if (result) await storeValue(body.key, body.value, body.ex ? now + body.ex * 1000 : null, now);
    }
    if (body.operation === 'delete') {
      result = row ? 1 : 0;
      if (row) await dbRun('DELETE FROM building_store_entries WHERE key=?', [body.key]);
    }
    if (body.operation === 'expire') {
      result = row ? 1 : 0;
      if (row) await dbRun('UPDATE building_store_entries SET expires_at=? WHERE key=?', [now + body.seconds * 1000, body.key]);
    }
    if (body.operation === 'increment') {
      if (row && !/^-?(?:0|[1-9]\d*)$/.test(row.value_text)) throw buildingStoreError(409, 'Building counter does not contain an integer.');
      result = Number(row?.value_text || '0') + 1;
      if (!Number.isSafeInteger(result)) throw buildingStoreError(409, 'Building counter is outside its supported range.');
      await storeValue(body.key, String(result), row?.expires_at ?? null, now);
    }
    if (body.operation === 'cas') {
      result = (row?.value_text ?? '') === body.expected ? 1 : 0;
      if (result) await storeValue(body.key, body.value, null, now);
    }
    if (body.operation === 'consume') {
      result = row?.value_text === body.expected ? 1 : 0;
      if (result) await dbRun('DELETE FROM building_store_entries WHERE key=?', [body.key]);
    }
    if (mutation) await dbRun('INSERT INTO building_store_receipts(request_id,payload_sha256,result_json,expires_at) VALUES(?,?,?,?)',
      [requestId, payloadSha256, JSON.stringify(result), now + 86_400_000]);
    return result;
  });
  // withTransaction only guarantees a commit when it was not already nested.
  // A failed operation or failed COMMIT never publishes transaction-local text.
  if (cacheAllowed) {
    if (!['get', 'health'].includes(body.operation)) archiveCache = null;
    else if (pendingCache) archiveCache = pendingCache;
  }
  return result;
}

export async function buildingStoreInventory() {
  return dbAll('SELECT key,value_text,value_sha256,revision,expires_at FROM building_store_entries ORDER BY key');
}
