import crypto from 'node:crypto';

// Keep reservation snapshots as text: parsing and serializing them here would
// invalidate the existing byte-for-byte compare-and-set contract.
export const BUILDING_CAS = "local current=redis.call('GET',KEYS[1]) or ''; if current~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
export const BUILDING_CONSUME = "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('DEL',KEYS[1]); return 1 else return 0 end";

const buildingKey = key => typeof key === 'string' && (
  ['resv:all', 'resv:push-subs', 'resv:warden-secret', 'resv:private:gapz:cooldown', 'resv:private:gapz:daily'].includes(key)
  || /^resv:status-fail:[a-f0-9]{64}$/.test(key)
  || /^resv:private:gapz:(challenge|attempts):[a-f0-9]{48}$/.test(key)
  || /^resv:private:gapz:session:[a-f0-9]{64}$/.test(key)
);
const unavailable = () => Object.assign(new Error('Building storage is unavailable'), { statusCode: 503 });
const positiveSeconds = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function buildingOperation(command) {
  if (!Array.isArray(command) || !command.length) throw unavailable();
  const [name, key, ...args] = command;
  if (name === 'EVAL') {
    const [count, target, expected, value] = args;
    if (count !== 1 || !buildingKey(target) || typeof expected !== 'string') throw unavailable();
    if (key === BUILDING_CAS && target === 'resv:all' && args.length === 4 && typeof value === 'string')
      return { operation: 'cas', key: target, expected, value };
    if (key === BUILDING_CONSUME && /^resv:private:gapz:challenge:[a-f0-9]{48}$/.test(target) && args.length === 3)
      return { operation: 'consume', key: target, expected };
    throw unavailable();
  }
  if (!buildingKey(key)) throw unavailable();
  if (name === 'GET' && args.length === 0) return { operation: 'get', key };
  if (name === 'DEL' && args.length === 0) return { operation: 'delete', key };
  if (name === 'INCR' && args.length === 0) return { operation: 'increment', key };
  if (name === 'EXPIRE' && args.length === 1 && positiveSeconds(args[0]))
    return { operation: 'expire', key, seconds: Number(args[0]) };
  if (name === 'SET' && typeof args[0] === 'string') {
    const operation = { operation: 'set', key, value: args[0] };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'NX' && operation.nx === undefined) operation.nx = true;
      else if (args[i] === 'EX' && operation.ex === undefined && positiveSeconds(args[i + 1])) operation.ex = Number(args[++i]);
      else throw unavailable();
    }
    return operation;
  }
  throw unavailable();
}

function validResult(operation, result) {
  if (operation.operation === 'get') return result === null || typeof result === 'string';
  if (operation.operation === 'set') return result === 'OK' || (operation.nx && result === null);
  if (operation.operation === 'increment') return Number.isSafeInteger(result);
  return result === 0 || result === 1;
}

export function createBuildingStore({ env = process.env, fetcher = (...args) => globalThis.fetch(...args), timeoutMs = 15000 } = {}) {
  const backend = () => env.BUILDING_STORE_BACKEND || 'redis';
  const configuration = () => {
    if (backend() === 'redis') return {
      url: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL,
      token: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN,
    };
    if (backend() !== 'sign-postgres') throw unavailable();
    let endpoint;
    try { endpoint = new URL(env.BUILDING_STORE_BRIDGE_URL); } catch { throw unavailable(); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/api/internal/building-store'
      || Buffer.byteLength(env.BUILDING_STORE_BRIDGE_SECRET || '', 'utf8') < 32) throw unavailable();
    return { url: endpoint.href, secret: env.BUILDING_STORE_BRIDGE_SECRET };
  };
  const hasStore = () => {
    const config = configuration();
    return backend() === 'sign-postgres' || Boolean(config.url && config.token);
  };
  const command = async input => {
    const operation = buildingOperation(input);
    const config = configuration();
    if (!hasStore()) throw unavailable();
    const postgres = backend() === 'sign-postgres';
    const body = JSON.stringify(postgres ? operation : input);
    const headers = { 'Content-Type': 'application/json' };
    if (postgres) {
      const timestamp = String(Date.now()), requestId = crypto.randomUUID();
      headers['x-building-store-timestamp'] = timestamp;
      headers['x-building-store-request-id'] = requestId;
      headers['x-building-store-signature'] = crypto.createHmac('sha256', config.secret)
        .update(timestamp + '\n' + requestId + '\n' + body).digest('hex');
    } else headers.Authorization = `Bearer ${config.token}`;
    const deadline = performance.now() + timeoutMs;
    for (let attempt = 0; attempt < (postgres ? 2 : 1); attempt++) {
      const controller = new AbortController();
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw unavailable();
      const timer = setTimeout(() => controller.abort(), postgres && attempt === 0 ? Math.min(remaining, timeoutMs / 2) : remaining);
      let response, data;
      try {
        response = await fetcher(config.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
        if (response.ok !== false) data = await response.json();
      } catch {
        // The bridge stores mutation receipts atomically. Replaying the exact
        // same ID and bytes resolves a lost response without repeating a write.
        if (postgres && attempt === 0) continue;
        throw unavailable();
      } finally { clearTimeout(timer); }
      // A configured cutover has one destination. Explicit failures must never
      // retry against Redis or make a missing queue look successfully empty.
      if (response.ok === false || !data || data.error || !Object.hasOwn(data, 'result') || !validResult(operation, data.result)) throw unavailable();
      if (postgres && operation.operation === 'get' && operation.key === 'resv:all' && data.result === null) throw unavailable();
      return { result: data.result };
    }
  };
  return { command, hasStore, backend };
}

const store = createBuildingStore();
export const buildingCommand = store.command;
export const hasBuildingStore = store.hasStore;
export const buildingStoreBackend = store.backend;
