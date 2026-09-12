import assert from 'node:assert/strict';

// Always use an isolated, in-memory PostgreSQL driver. No provider call or
// credential from the developer's environment is allowed in this test process.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'synthetic-env-key-that-must-never-be-used';
const { connect, close, dbGet, dbRun } = await import('../db.js');
const { createGenerator, generationFor, generationStatus, setGenerationForTests } = await import('../ai-generation.js');

const KEY = 'synthetic-injected-key';
const MODEL = 'gpt-5.6-terra';
const month = '2026-09';
const fixedNow = () => new Date('2026-09-12T18:00:00.000Z');
const schema = { type: 'object', properties: {
  title: { type: 'string', maxLength: 80 }, amount: { type: ['number', 'null'] },
  tags: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 30 } }, approved: { type: 'boolean' },
}, required: ['title', 'amount', 'tags', 'approved'], additionalProperties: false };
const result = { title: 'Synthetic result', amount: null, tags: [], approved: false };
const request = { purpose: 'minutes', schemaName: 'synthetic_minutes', schema, instructions: 'Organize only the supplied synthetic facts.', input: 'Synthetic meeting source. No actual meeting or banking data is used.' };
const response = (overrides = {}) => new Response(JSON.stringify({ id: 'resp_synthetic', model: MODEL, status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  usage: { input_tokens: 1000, output_tokens: 200, output_tokens_details: { reasoning_tokens: 120 } }, ...overrides }), { status: 200 });
const factory = fetchImpl => createGenerator({ apiKey: KEY, fetchImpl, now: fixedNow });
let checks = 0;
let databaseClosed = false;
async function test(name, body) { await body(); checks++; console.log(`PASS: ${name}`); }
async function reset() {
  await dbRun('DELETE FROM ai_generation_requests');
  await dbRun('DELETE FROM ai_generation_months');
  await dbRun('UPDATE ai_generation_control SET halted = 0, reason = NULL WHERE id = 1');
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Synthetic concurrent requests did not reach their expected states'); }
const ledger = () => dbGet('SELECT * FROM ai_generation_months WHERE month_key = ?', [month]);

await connect();
try {
  await factory(() => { throw new Error('Unexpected synthetic call'); }).initSchema();

  await test('missing key leaves local mode available and hides budget from ordinary status', async () => {
    const generator = createGenerator({ now: fixedNow, fetchImpl: () => { throw new Error('No fetch allowed'); } });
    assert.equal(generator.forUser(1), undefined);
    assert.deepEqual(await generator.status(), { configured: false, model: MODEL, monthlyLimitDollars: 5, committedDollars: null, reservedDollars: null, remainingDollars: null });
    assert.equal((await generator.status({ includeBudget: true })).remainingDollars, 5);
  });

  await test('production-shaped call fixes model, tier, retention, output limit, schema and timeout', async () => {
    await reset(); let calls = 0, sent;
    const generator = factory(async (url, options) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
      sent = JSON.parse(options.body); return response();
    });
    assert.deepEqual(await generator.forUser(1)(request), result);
    assert.equal(sent.model, MODEL); assert.equal(sent.service_tier, 'default'); assert.equal(sent.store, false);
    assert.equal(sent.max_output_tokens, 16000); assert.deepEqual(sent.reasoning, { effort: 'medium' });
    assert.deepEqual(sent.text.format, { type: 'json_schema', name: request.schemaName, strict: true, schema });
    assert.equal(sent.input, request.input); assert.equal(sent.instructions, request.instructions);
    assert.equal(sent.tools, undefined); assert.equal(sent.previous_response_id, undefined);
    const row = await dbGet('SELECT * FROM ai_generation_requests');
    assert.equal(row.input_bound, Buffer.byteLength(JSON.stringify(sent), 'utf8') + 8192);
    assert.equal(row.reserve_units, row.input_bound * 5 + 16000 * 24);
    assert.equal(row.charged_units, 1000 * 5 + 200 * 24, 'reasoning is already inside output_tokens');
    assert.equal((await generator.status({ includeBudget: true })).committedDollars, 0.0049);
    assert.equal(calls, 1);
  });

  await test('completed cache is isolated by user and cannot be mutated by a caller', async () => {
    await reset(); let calls = 0; const generator = factory(async () => { calls++; return response(); });
    const first = await generator.forUser(1)(request); first.title = 'Caller changed this';
    assert.deepEqual(await generator.forUser(1)(request), result); assert.equal(calls, 1);
    const reordered = { ...request, schema: { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).reverse()) } };
    assert.deepEqual(await generator.forUser(1)(reordered), result); assert.equal(calls, 1);
    await generator.forUser(2)(request); assert.equal(calls, 2);
  });

  await test('simultaneous duplicate request has one reservation and one provider call', async () => {
    await reset(); const entered = deferred(), release = deferred(); let calls = 0;
    const generator = factory(async () => { calls++; entered.resolve(); await release.promise; return response(); });
    const first = generator.forUser(1)(request); await entered.promise;
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_ALREADY_PENDING');
    assert.equal(calls, 1); assert.ok((await ledger()).reserved_units > 0);
    release.resolve(); assert.deepEqual(await first, result); assert.equal((await ledger()).reserved_units, 0);
  });

  await test('atomic reservations across independent instances cannot exceed the shared $5 cap', async () => {
    await reset(); const release = deferred(); let entered = 0, rejected = 0;
    const fetchImpl = async () => { entered++; await release.promise; return response(); };
    const a = factory(fetchImpl), b = factory(fetchImpl); await a.initSchema(); await b.initSchema();
    const pending = Array.from({ length: 10 }, (_, index) => (index % 2 ? a : b).forUser(index + 1)({ ...request, input: 'x'.repeat(220000) + index })
      .then(value => ({ value }), error => { rejected++; return { error }; }));
    await until(() => entered + rejected === 10);
    const budget = await ledger(); assert.equal(entered, 6); assert.equal(rejected, 4);
    assert.ok(budget.reserved_units + budget.charged_units <= 10000000);
    release.resolve(); const settled = await Promise.all(pending);
    assert.equal(settled.filter(item => item.error?.code === 'GENERATION_MONTHLY_LIMIT').length, 4);
    assert.equal((await ledger()).reserved_units, 0);
  });

  await test('already committed usage blocks a call before the network', async () => {
    await reset(); await dbRun('INSERT INTO ai_generation_months (month_key, limit_units, charged_units) VALUES (?, 10000000, 9900000)', [month]);
    let calls = 0; const generator = factory(async () => { calls++; return response(); });
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_MONTHLY_LIMIT');
    assert.equal(calls, 0); assert.equal((await generator.status({ includeBudget: true })).remainingDollars, 0.05);
  });

  await test('UTF-8 bytes, instructions and schema all count toward the preflight bound', async () => {
    await reset(); let calls = 0; const generator = factory(async () => { calls++; return response(); });
    for (const changed of [{ input: '😀'.repeat(60000) }, { instructions: 'x'.repeat(240000) }, { schema: { ...schema, description: 'x'.repeat(240000) } }]) {
      await assert.rejects(generator.forUser(1)({ ...request, ...changed }), error => error.code === 'GENERATION_SOURCE_TOO_LARGE');
    }
    assert.equal(calls, 0); assert.equal((await dbGet('SELECT COUNT(*) AS count FROM ai_generation_requests')).count, 0);
  });

  await test('optional object fields and unsupported schema keywords fail before a paid call', async () => {
    await reset(); let calls = 0; const generator = factory(async () => { calls++; return response(); });
    for (const changed of [{ ...schema, required: ['title'] }, { ...schema, patternProperties: {} }]) {
      await assert.rejects(generator.forUser(1)({ ...request, schema: changed }), TypeError);
    }
    assert.equal(calls, 0);
  });

  for (const status of [400, 401, 403, 404, 413, 422, 429]) await test(`definite HTTP ${status} rejection releases its reservation without exposing provider text`, async () => {
    await reset(); const generator = factory(async () => new Response('Synthetic provider detail must not be exposed', { status }));
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_REQUEST_REJECTED' && !error.message.includes('Synthetic provider detail'));
    const budget = await ledger(); assert.equal(budget.reserved_units, 0); assert.equal(budget.charged_units, 0);
  });

  await test('an explicitly retried rejected request obtains a new reservation', async () => {
    await reset(); let calls = 0; const generator = factory(async () => ++calls === 1 ? new Response('', { status: 401 }) : response());
    await assert.rejects(generator.forUser(1)(request));
    assert.deepEqual(await generator.forUser(1)(request), result);
    assert.equal(calls, 2); assert.equal((await dbGet('SELECT COUNT(*) AS count FROM ai_generation_requests')).count, 2);
  });

  for (const [name, mock] of [
    ['timeout', async () => { throw Object.assign(new Error('Synthetic timeout'), { name: 'AbortError' }); }],
    ['disconnect', async () => { throw new Error('Synthetic disconnect'); }],
    ['HTTP 408', async () => new Response('', { status: 408 })],
    ['HTTP 500', async () => new Response('', { status: 500 })],
    ['missing usage', async () => response({ usage: null })],
    ['invalid usage', async () => response({ usage: { input_tokens: -1, output_tokens: 200 } })],
    ['malformed JSON', async () => new Response('{')],
  ]) await test(`${name} keeps the full reservation and blocks a duplicate`, async () => {
    await reset(); let calls = 0; const generator = factory(async (...args) => { calls++; return mock(...args); });
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_USAGE_UNKNOWN');
    const budget = await ledger(); assert.ok(budget.reserved_units > 0); assert.equal(budget.charged_units, 0);
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_ALREADY_PENDING');
    assert.equal(calls, 1);
  });

  await test('ordinary HTTP 503 JSON error reserves only that request without globally pausing generation', async () => {
    await reset(); let calls = 0;
    const generator = factory(async () => ++calls === 1 ? new Response(JSON.stringify({ error: { message: 'Synthetic outage' } }), { status: 503 }) : response());
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_USAGE_UNKNOWN');
    const reserved = (await ledger()).reserved_units; assert.ok(reserved > 0);
    assert.equal((await dbGet('SELECT halted FROM ai_generation_control WHERE id = 1')).halted, 0);
    assert.deepEqual(await generator.forUser(1)({ ...request, input: `${request.input} Another synthetic record.` }), result);
    assert.equal(calls, 2); assert.equal((await ledger()).reserved_units, reserved);
  });

  await test('incomplete and refused responses with valid usage are charged', async () => {
    for (const override of [{ status: 'incomplete' }, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }] }]) {
      await reset(); const generator = factory(async () => response(override));
      await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_INVALID_RESPONSE');
      assert.equal((await ledger()).reserved_units, 0); assert.equal((await ledger()).charged_units, 9800);
      assert.equal((await dbGet('SELECT state FROM ai_generation_requests')).state, 'failed');
    }
  });

  await test('valid token usage is charged when returned JSON violates the exact schema', async () => {
    for (const invalid of [{ ...result, extra: true }, { ...result, amount: '123' }, { title: 'Missing fields' }, { ...result, tags: ['a', 'b', 'c'] }]) {
      await reset(); const generator = factory(async () => response({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(invalid) }] }] }));
      await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_INVALID_RESPONSE');
      assert.equal((await ledger()).charged_units, 9800); assert.equal((await ledger()).reserved_units, 0);
    }
  });

  await test('model mismatch retains the full reservation and halts later paid calls persistently', async () => {
    await reset(); const generator = factory(async () => response({ model: 'gpt-5.6-terra-pro' }));
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_USAGE_UNKNOWN');
    assert.ok((await ledger()).reserved_units > 0); assert.equal((await ledger()).charged_units, 0);
    let calls = 0; const restarted = factory(async () => { calls++; return response(); });
    await assert.rejects(restarted.forUser(2)(request), error => error.code === 'GENERATION_BUDGET_PAUSED'); assert.equal(calls, 0);
  });

  await test('recognized dated Terra snapshot is accepted', async () => {
    await reset(); assert.deepEqual(await factory(async () => response({ model: 'gpt-5.6-terra-2026-09-01' })).forUser(1)(request), result);
  });

  await test('observed usage beyond the bound is recorded truthfully and halts paid generation', async () => {
    await reset(); const generator = factory(async () => response({ usage: { input_tokens: 250000, output_tokens: 16001 } }));
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_INVALID_RESPONSE');
    assert.equal((await ledger()).charged_units, 250000 * 5 + 16001 * 24);
    assert.equal((await ledger()).reserved_units, 0);
    await assert.rejects(generator.forUser(2)(request), error => error.code === 'GENERATION_BUDGET_PAUSED');
  });

  await test('unsafe usage arithmetic is never written to SQL or used to release allowance', async () => {
    await reset(); const generator = factory(async () => response({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } }));
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_USAGE_UNKNOWN');
    assert.ok((await ledger()).reserved_units > 0); assert.equal((await ledger()).charged_units, 0);
    assert.equal((await dbGet('SELECT halted FROM ai_generation_control WHERE id = 1')).halted, 1);
  });

  await test('month rollover settles the original month and retains completed cache', async () => {
    await reset(); let current = '2026-09-30T23:59:59Z', calls = 0;
    const generator = createGenerator({ apiKey: KEY, now: () => new Date(current), fetchImpl: async () => { calls++; current = '2026-10-01T00:00:01Z'; return response(); } });
    await generator.forUser(1)(request); assert.equal((await ledger()).charged_units, 9800); assert.equal((await ledger()).reserved_units, 0);
    assert.equal((await generator.status({ includeBudget: true })).remainingDollars, 5);
    await generator.forUser(1)(request); assert.equal(calls, 1);
  });

  await test('database settlement failure leaves the original reservation counted', async () => {
    await reset(); const generator = factory(async () => { await dbRun('DROP TABLE ai_generation_control'); return response(); });
    await assert.rejects(generator.forUser(1)(request), error => error.code === 'GENERATION_USAGE_UNKNOWN');
    assert.ok((await ledger()).reserved_units > 0); assert.equal((await ledger()).charged_units, 0);
    const recovered = factory(async () => { throw new Error('No retry should be sent'); }); await recovered.initSchema();
    await assert.rejects(recovered.forUser(1)(request), error => error.code === 'GENERATION_ALREADY_PENDING');
  });

  await test('ordinary NODE_ENV=test execution ignores an environment key; explicit injection works', async () => {
    await reset(); assert.equal(generationFor(1), undefined); assert.equal((await generationStatus()).configured, false);
    setGenerationForTests(factory(async () => response()));
    assert.deepEqual(await generationFor(1)(request), result);
  });

  await test('database failure before reservation commit prevents a provider call', async () => {
    await reset(); let calls = 0; const generator = factory(async () => { calls++; return response(); }); await generator.initSchema();
    await close(); databaseClosed = true; await assert.rejects(generator.forUser(1)(request)); assert.equal(calls, 0);
  });
  console.log(`${checks} paid generation adapter checks passed using synthetic transports and isolated PGlite.`);
} finally { if (!databaseClosed) await close(); }
