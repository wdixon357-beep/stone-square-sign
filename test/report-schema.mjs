import assert from 'node:assert/strict';
import { reportSchema, organizeReport } from '../report-ai.js';

// All schema responses and generation output are local fixtures. No request
// reaches the portal, an AI provider, a mailbox, or a Lodge record.
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks += 1; console.log('PASS ' + label); };
const definition = label => ({ name: 'Officer Report', fields: [{ id: 'summary', label, kind: 'long', req: true }] });
const fixture = label => ({ authenticated: true, identity: { name: 'Private Fixture Name', email: 'private-fixture@example.invalid' },
  officers: [{ name: 'Private Fixture Name', office: 'Private Fixture Office' }],
  types: { officer: definition(label) }, masterTypes: { officer: definition('Master ' + label) } });
const response = data => ({ ok: true, json: async () => data });
const safeFailure = async (label, fetchImpl) => {
  await assert.rejects(reportSchema({ assertion: 'synthetic-signed-assertion', fetchImpl }), error =>
    error.statusCode === 502 && /signed-in report fields could not load/.test(error.message)
      && !/private|secret|TOKEN|127\.0\.0\.1/i.test(error.message));
  check(label, true);
};

let requests = [];
const fetchImpl = async (url, options) => {
  requests.push({ url, options });
  return response(fixture('Current report summary'));
};
const schema = await reportSchema({ assertion: 'synthetic-officer-assertion', fetchImpl });
check('Authenticated schema uses the fixed HTTPS portal origin and schema route', requests.length === 1
  && requests[0].url === 'https://request.stonesquare22pha.org/api/report?schema=1');
check('The short-lived assertion travels only in Authorization and redirects are refused',
  requests[0].options.headers.Authorization === 'Bearer synthetic-officer-assertion'
  && requests[0].options.redirect === 'error'
  && !requests[0].url.includes('synthetic-officer-assertion')
  && !Object.hasOwn(requests[0].options, 'body')
  && requests[0].options.signal instanceof AbortSignal);
check('Only authenticated field groups leave schema loading, without the portal identity or officer roster',
  JSON.stringify(Object.keys(schema).sort()) === JSON.stringify(['masterTypes', 'types'])
  && schema.types.officer.fields[0].id === 'summary'
  && !JSON.stringify(schema).includes('Private Fixture'));

let absentCalls = 0;
for (const assertion of [undefined, null, '', 42, {}, []]) {
  await assert.rejects(reportSchema({ assertion, fetchImpl: async () => { absentCalls += 1; throw Error('Must not run'); } }),
    error => error.statusCode === 503 && /signed-in Dashboard/.test(error.message));
}
check('Missing or non-string assertions fail before any portal call', absentCalls === 0);

for (const [label, data] of [
  ['Public schema cannot be mistaken for officer fields', { ...fixture('Public'), authenticated: false }],
  ['Null JSON fails safely', null],
  ['Array JSON fails safely', []],
  ['Missing master fields fail safely', { ...fixture('Missing'), masterTypes: {} }],
  ['Object-shaped fields cannot reach the organizer', { ...fixture('Object'), types: { officer: { fields: {} } } }],
  ['String-shaped fields cannot reach the organizer', { ...fixture('String'), types: { officer: { fields: 'private schema' } } }],
  ['Empty officer definitions cannot reach paid generation', { ...fixture('Empty'), types: { officer: { fields: [] } } }],
  ['Null field entries fail safely', { ...fixture('Null field'), types: { officer: { fields: [null] } } }],
  ['Invalid field identifiers fail safely', { ...fixture('Invalid id'), types: { officer: { fields: [{ id: 'invalid_field', label: 'Invalid field', kind: 'long' }] } } }],
  ['Unexpected field kinds fail safely', { ...fixture('Invalid kind'), types: { officer: { fields: [{ id: 'summary', label: 'Summary', kind: 'script' }] } } }],
  ['More than sixty fields fail safely', { ...fixture('Too many'), types: { officer: { fields: Array.from({ length: 61 }, () => ({ id: 'summary', label: 'Summary', kind: 'long' })) } } }],
]) await safeFailure(label, async () => response(data));
await safeFailure('An HTTP authentication refusal becomes bounded schema guidance', async () => ({ ok: false, status: 401, json: async () => { throw Error('Must not parse a rejected response'); } }));
await safeFailure('A redirect/network rejection cannot leak its transport detail', async () => { throw Error('private TOKEN redirected to http://127.0.0.1'); });
await safeFailure('Malformed JSON cannot leak a provider parser message', async () => ({ ok: true, json: async () => { throw Error('private JSON payload TOKEN'); } }));
await safeFailure('A malformed fetch response fails safely', async () => null);

requests = [];
const freshFetch = async (url, options) => {
  requests.push(options.headers.Authorization);
  return response(fixture('Response ' + requests.length));
};
const first = await reportSchema({ assertion: 'synthetic-account-a', fetchImpl: freshFetch });
const second = await reportSchema({ assertion: 'synthetic-account-b', fetchImpl: freshFetch });
const third = await reportSchema({ assertion: 'synthetic-account-a', fetchImpl: freshFetch });
check('Each account and each repeat loads a fresh authenticated schema rather than a shared identity cache',
  requests.join('|') === 'Bearer synthetic-account-a|Bearer synthetic-account-b|Bearer synthetic-account-a'
  && first.types.officer.fields[0].label === 'Response 1'
  && second.types.officer.fields[0].label === 'Response 2'
  && third.types.officer.fields[0].label === 'Response 3');
first.types.officer.fields[0].label = 'Locally changed fixture';
check('Returned field groups do not alias another request or expose either account identity',
  second.types.officer.fields[0].label === 'Response 2' && !JSON.stringify([first, second, third]).includes('Private Fixture'));

const input = { source: 'Imported proposal table: food budget is $12,650. No approval was recorded.', type: 'officer', master: false, fields: { summary: 'Existing report content.' } };
const originalInput = structuredClone(input);
let generationCalls = 0;
const organized = await organizeReport(input, { schema: third, generateStructured: async request => {
  generationCalls += 1;
  assert.ok(request.input.includes('Imported proposal table: food budget is $12,650. No approval was recorded.'));
  assert.ok(!request.input.includes('Private Fixture'));
  return { suggestions: [{ field: 'summary', value: 'Imported proposal table: food budget is $12,650. No approval was recorded.', quote: 'Imported proposal table: food budget is $12,650. No approval was recorded.' }], warnings: ['Check the proposal figures.'] };
} });
check('Authenticated imported-source organization produces suggestions without changing inputs or asserting approval',
  generationCalls === 1 && organized.fields.summary.includes('$12,650')
  && JSON.stringify(input) === JSON.stringify(originalInput));

console.log(`${checks} isolated report schema and import-to-organization checks passed. No external requests or paid calls.`);
