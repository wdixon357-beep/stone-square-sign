import crypto from 'node:crypto';
import { dbGet, dbRun, withTransaction } from './db.js';

const MODEL = 'gpt-5.6-terra';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const UNITS_PER_DOLLAR = 2_000_000;
const MONTHLY_LIMIT = 5 * UNITS_PER_DOLLAR;
const MAX_OUTPUT_TOKENS = 16_000;
const MAX_INPUT_BOUND = 240_000;
const INPUT_FRAMING_ALLOWANCE = 8_192;
const INPUT_UNITS = 5; // $2.50/M includes the conservative cache-write rate.
const OUTPUT_UNITS = 24; // $12/M; output_tokens already includes reasoning.
const ACTIVE_STATES = "('pending', 'unknown', 'completed')";
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const invalidResult = () => fail('GENERATION_INVALID_RESPONSE', 'The report response was incomplete or invalid. Your source has not been changed.');
const uncertain = () => fail('GENERATION_USAGE_UNKNOWN', 'This request has an unconfirmed charge. Its allowance remains reserved to protect the monthly limit.');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

// Validate the returned data independently of the provider's structured-output
// guarantee. Only the schema features used by the two report contracts are accepted.
function validateSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 40) throw new TypeError('Unsupported report schema');
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description', 'title', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']);
  if (Object.keys(schema).some(key => !supported.has(key))) throw new TypeError('Unsupported report schema keyword');
  if (schema.anyOf) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) throw new TypeError('Invalid report schema alternatives');
    schema.anyOf.forEach(child => validateSchema(child, depth + 1));
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if ((!types.length && !schema.anyOf) || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) throw new TypeError('Invalid report schema type');
  if (types.includes('object')) {
    if (!schema.properties || typeof schema.properties !== 'object' || schema.additionalProperties !== false || !Array.isArray(schema.required)) throw new TypeError('Report objects must have a strict schema');
    if (schema.required.some(key => !Object.hasOwn(schema.properties, key))
      || Object.keys(schema.properties).some(key => !schema.required.includes(key))) throw new TypeError('Every report property must be required; use null for optional values');
    Object.values(schema.properties).forEach(child => validateSchema(child, depth + 1));
  }
  if (types.includes('array')) validateSchema(schema.items, depth + 1);
}

function matches(value, schema, depth = 0) {
  if (depth > 40) return false;
  if (schema.anyOf && !schema.anyOf.some(child => matches(value, child, depth + 1))) return false;
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.includes(type) && !(type === 'number' && Number.isInteger(value) && types.includes('integer'))) return false;
  if (type === 'object') {
    const properties = schema.properties || {};
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, child]) => !Object.hasOwn(properties, key) || matches(child, properties[key], depth + 1));
  }
  if (type === 'array') return (schema.minItems == null || value.length >= schema.minItems)
    && (schema.maxItems == null || value.length <= schema.maxItems)
    && (!schema.items || value.every(child => matches(child, schema.items, depth + 1)));
  if (type === 'string') return (schema.minLength == null || [...value].length >= schema.minLength)
    && (schema.maxLength == null || [...value].length <= schema.maxLength);
  if (type === 'number') return Number.isFinite(value) && (schema.minimum == null || value >= schema.minimum) && (schema.maximum == null || value <= schema.maximum);
  return true;
}

const dollars = units => Number(units) / UNITS_PER_DOLLAR;
const validCount = value => Number.isSafeInteger(value) && value >= 0;

export function createGenerator({ apiKey = '', fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const key = String(apiKey || '').trim();
  let initialization;
  const clock = () => {
    const date = new Date(now());
    if (!Number.isFinite(date.valueOf())) throw new TypeError('Invalid generation clock');
    return date.toISOString();
  };
  const initSchema = () => initialization ||= (async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS ai_generation_months (
      month_key TEXT PRIMARY KEY,
      limit_units BIGINT NOT NULL CHECK (limit_units >= 0 AND limit_units <= ${MONTHLY_LIMIT}),
      charged_units BIGINT NOT NULL DEFAULT 0 CHECK (charged_units >= 0),
      reserved_units BIGINT NOT NULL DEFAULT 0 CHECK (reserved_units >= 0)
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS ai_generation_requests (
      id TEXT PRIMARY KEY, month_key TEXT NOT NULL REFERENCES ai_generation_months(month_key),
      user_id TEXT NOT NULL, request_hash TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'unknown', 'completed', 'failed', 'released')),
      reserve_units BIGINT NOT NULL CHECK (reserve_units >= 0), charged_units BIGINT,
      input_bound INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      response_id TEXT, result_json TEXT, created_at TEXT NOT NULL, settled_at TEXT
    )`);
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_active_request
      ON ai_generation_requests(user_id, request_hash) WHERE state IN ${ACTIVE_STATES}`);
    await dbRun(`CREATE TABLE IF NOT EXISTS ai_generation_control (
      id INTEGER PRIMARY KEY CHECK (id = 1), halted INTEGER NOT NULL DEFAULT 0,
      reason TEXT
    )`);
    await dbRun('INSERT INTO ai_generation_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  })().catch(error => { initialization = undefined; throw error; });

  async function reserve({ userId, hash, kind, inputBound, reserveUnits }) {
    await initSchema();
    return withTransaction(async () => {
      // One short lock also prevents a newly detected pricing/usage anomaly from
      // racing another reservation. This transaction ends before the HTTP call.
      const control = await dbGet('SELECT halted FROM ai_generation_control WHERE id = 1 FOR UPDATE');
      const existing = await dbGet(`SELECT * FROM ai_generation_requests WHERE user_id = ? AND request_hash = ? AND state IN ${ACTIVE_STATES}`, [userId, hash]);
      if (existing?.state === 'completed') return { cached: existing.result_json };
      if (existing) throw fail('GENERATION_ALREADY_PENDING', 'This report request is already processing or has an unconfirmed charge. Its allowance remains reserved.', 409);
      if (control.halted) throw fail('GENERATION_BUDGET_PAUSED', 'Paid report generation is paused because reported usage needs review.', 503);
      const timestamp = clock(), month = timestamp.slice(0, 7), id = crypto.randomUUID();
      await dbRun('INSERT INTO ai_generation_months (month_key, limit_units) VALUES (?, ?) ON CONFLICT (month_key) DO NOTHING', [month, MONTHLY_LIMIT]);
      const budget = await dbGet(`UPDATE ai_generation_months SET reserved_units = reserved_units + ?
        WHERE month_key = ? AND charged_units + reserved_units + ? <= limit_units RETURNING month_key`, [reserveUnits, month, reserveUnits]);
      if (!budget) throw fail('GENERATION_MONTHLY_LIMIT', 'The $5 monthly report allowance is fully used or reserved. You can continue editing reports manually.', 429);
      await dbRun(`INSERT INTO ai_generation_requests
        (id, month_key, user_id, request_hash, kind, state, reserve_units, input_bound, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`, [id, month, userId, hash, kind, reserveUnits, inputBound, timestamp]);
      return { id, month, reserveUnits, inputBound };
    });
  }

  async function settle(reservation, { state, usage, result, responseId, halt = false }) {
    return withTransaction(async () => {
      await dbGet('SELECT halted FROM ai_generation_control WHERE id = 1 FOR UPDATE');
      const row = await dbGet('SELECT * FROM ai_generation_requests WHERE id = ? FOR UPDATE', [reservation.id]);
      if (!row || !['pending', 'unknown'].includes(row.state)) return;
      const units = usage ? usage.input_tokens * INPUT_UNITS + usage.output_tokens * OUTPUT_UNITS : 0;
      await dbRun(`UPDATE ai_generation_months SET reserved_units = reserved_units - ?, charged_units = charged_units + ? WHERE month_key = ?`, [row.reserve_units, units, row.month_key]);
      await dbRun(`UPDATE ai_generation_requests SET state = ?, charged_units = ?, input_tokens = ?, output_tokens = ?,
        response_id = ?, result_json = ?, settled_at = ? WHERE id = ?`,
      [state, units, usage?.input_tokens ?? null, usage?.output_tokens ?? null, responseId || null, result == null ? null : JSON.stringify(result), clock(), row.id]);
      if (halt) await dbRun("UPDATE ai_generation_control SET halted = 1, reason = 'reported_usage_exceeded_bound' WHERE id = 1");
    });
  }

  async function markUnknown(reservation) {
    // If even this write fails, the original pending reservation still counts.
    try { await dbRun("UPDATE ai_generation_requests SET state = 'unknown' WHERE id = ? AND state = 'pending'", [reservation.id]); } catch { /* Preserve the reservation. */ }
  }

  async function haltUnconfirmed(reservation, reason) {
    await withTransaction(async () => {
      await dbGet('SELECT halted FROM ai_generation_control WHERE id = 1 FOR UPDATE');
      await dbRun("UPDATE ai_generation_requests SET state = 'unknown' WHERE id = ? AND state = 'pending'", [reservation.id]);
      await dbRun('UPDATE ai_generation_control SET halted = 1, reason = ? WHERE id = 1', [reason]);
    });
  }

  const forUser = userId => {
    if (!key) return undefined;
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw new TypeError('A valid officer account is required');
    const user = String(Number(userId));
    return async ({ purpose, schemaName, schema, instructions, input }) => {
      if (!['minutes', 'treasury'].includes(purpose)) throw new TypeError('Unsupported report generation kind');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(schemaName || '') || typeof instructions !== 'string' || !instructions.trim()) throw new TypeError('A report schema and instructions are required');
      validateSchema(schema);
      const source = typeof input === 'string' ? input : JSON.stringify(input);
      if (typeof source !== 'string' || !source.trim()) throw new TypeError('Report source text is required');
      const body = { model: MODEL, service_tier: 'default', store: false, reasoning: { effort: 'medium' },
        max_output_tokens: MAX_OUTPUT_TOKENS, instructions, input: source,
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } } };
      const serialized = JSON.stringify(body);
      const inputBound = Buffer.byteLength(serialized, 'utf8') + INPUT_FRAMING_ALLOWANCE;
      if (inputBound > MAX_INPUT_BOUND) throw fail('GENERATION_SOURCE_TOO_LARGE', 'This source is too large for one report within the monthly allowance. Use one meeting or reporting period.', 413);
      const hash = crypto.createHash('sha256').update(JSON.stringify(stable({ purpose, body }))).digest('hex');
      const reservation = await reserve({ userId: user, hash, kind: purpose, inputBound, reserveUnits: inputBound * INPUT_UNITS + MAX_OUTPUT_TOKENS * OUTPUT_UNITS });
      if (reservation.cached != null) {
        let cached;
        try { cached = JSON.parse(reservation.cached); } catch { throw invalidResult(); }
        if (!matches(cached, schema)) throw invalidResult();
        return cached;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 75_000);
      timer.unref?.();
      let response, payload;
      try {
        response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: serialized, signal: controller.signal });
        // A definite request rejection is the only provider failure that frees
        // its unused allowance. A timeout or server failure might be billable.
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          await settle(reservation, { state: 'released' });
          throw fail('GENERATION_REQUEST_REJECTED', 'The report service could not accept the request. Ask the Worshipful Master to check the service configuration.');
        }
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > 4_000_000) throw invalidResult();
        payload = JSON.parse(text);
      } catch (error) {
        if (error.code === 'GENERATION_REQUEST_REJECTED') throw error;
        await markUnknown(reservation);
        throw uncertain();
      } finally { clearTimeout(timer); }

      if (!response.ok) {
        await markUnknown(reservation); throw uncertain();
      }
      if (typeof payload?.model !== 'string' || !/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/.test(payload.model)) {
        try { await haltUnconfirmed(reservation, 'unconfirmed_response_model'); } catch { await markUnknown(reservation); }
        throw uncertain();
      }
      const usage = payload?.usage;
      if (!usage || !validCount(usage.input_tokens) || !validCount(usage.output_tokens)) {
        await markUnknown(reservation); throw uncertain();
      }
      const observedUnits = usage.input_tokens * INPUT_UNITS + usage.output_tokens * OUTPUT_UNITS;
      if (!Number.isSafeInteger(observedUnits) || usage.input_tokens > 2_147_483_647 || usage.output_tokens > 2_147_483_647) {
        try { await haltUnconfirmed(reservation, 'invalid_usage_bounds'); } catch { await markUnknown(reservation); }
        throw uncertain();
      }
      const exceedsBound = usage.input_tokens > inputBound || usage.output_tokens > MAX_OUTPUT_TOKENS || observedUnits > reservation.reserveUnits;
      let result, error;
      try {
        if (!response.ok || payload.status !== 'completed' || exceedsBound) throw invalidResult();
        const content = (Array.isArray(payload.output) ? payload.output : []).flatMap(item => Array.isArray(item.content) ? item.content : []);
        const texts = content.filter(item => item.type === 'output_text');
        if (content.some(item => item.type === 'refusal') || texts.length !== 1 || typeof texts[0].text !== 'string') throw invalidResult();
        result = JSON.parse(texts[0].text);
        if (!matches(result, schema)) throw invalidResult();
      } catch { error = invalidResult(); }
      try {
        await settle(reservation, { state: error ? 'failed' : 'completed', usage, result: error ? null : result,
          responseId: typeof payload.id === 'string' ? payload.id.slice(0, 200) : null, halt: exceedsBound });
      } catch {
        await markUnknown(reservation); throw uncertain();
      }
      if (error) throw error;
      return result;
    };
  };

  const status = async ({ includeBudget = false } = {}) => {
    const result = { configured: Boolean(key), model: MODEL, monthlyLimitDollars: 5,
      committedDollars: null, reservedDollars: null, remainingDollars: null };
    if (!includeBudget) return result;
    await initSchema();
    const budget = await dbGet('SELECT charged_units, reserved_units FROM ai_generation_months WHERE month_key = ?', [clock().slice(0, 7)]);
    result.committedDollars = dollars(budget?.charged_units || 0);
    result.reservedDollars = dollars(budget?.reserved_units || 0);
    result.remainingDollars = dollars(Math.max(0, MONTHLY_LIMIT - Number(budget?.charged_units || 0) - Number(budget?.reserved_units || 0)));
    return result;
  };
  return { initSchema, forUser, status };
}

let defaultGenerator;
const defaultInstance = () => defaultGenerator ||= createGenerator({ apiKey: process.env.NODE_ENV === 'test' ? '' : process.env.OPENAI_API_KEY });
export const initGenerationSchema = () => defaultInstance().initSchema();
export const generationFor = userId => defaultInstance().forUser(userId);
export const generationStatus = options => defaultInstance().status(options);

// Child-process integration tests install a synthetic transport explicitly. An
// environment API key alone can never make ordinary tests send real sources.
export function setGenerationForTests(generator) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Generation test injection is only available in tests');
  if (!generator || ['initSchema', 'forUser', 'status'].some(name => typeof generator[name] !== 'function')) throw new TypeError('Invalid test generator');
  defaultGenerator = generator;
}
