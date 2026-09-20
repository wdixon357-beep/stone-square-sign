import assert from 'node:assert/strict';
import { expectedProduction, checkProduction, waitForProduction } from '../scripts/check-production.mjs';

const expected = await expectedProduction();
const commit = 'a'.repeat(40);
const bodies = { ...expected.assets, '/api/version': JSON.stringify({ version: expected.version, commit }), '/api/ready': JSON.stringify({ ok: true, database: 'ready' }) };
const fetcher = async url => new Response(bodies[new URL(url).pathname], { status: 200 });
const run = (overrides = {}) => checkProduction({ expected, commit, fetcher, ...overrides });
assert.deepEqual(await run(), []);

for (const pathname of ['/treasury.js', '/activity.css', '/minutes-preview.js', '/']) {
  const original = bodies[pathname];
  bodies[pathname] += '\nold content';
  assert.ok((await run()).some(issue => issue.startsWith(pathname + ':')));
  bodies[pathname] = original;
}
bodies['/api/version'] = JSON.stringify({ version: expected.version, commit: 'b'.repeat(40) });
assert.ok((await run()).some(issue => issue.includes('Server commit')));
bodies['/api/version'] = JSON.stringify({ version: '0.0.0', commit });
assert.ok((await run()).some(issue => issue.includes('Server version')));
bodies['/api/version'] = JSON.stringify({ version: expected.version });
assert.ok((await run()).some(issue => issue.includes('not reported')));
bodies['/api/version'] = 'not json';
assert.ok((await run()).some(issue => issue.includes('invalid version response')));
bodies['/api/version'] = JSON.stringify({ version: expected.version, commit });
const ready = bodies['/api/ready'];
bodies['/api/ready'] = JSON.stringify({ ok: false, database: 'unavailable' });
assert.ok((await run()).some(issue => issue.includes('database is not ready')));
bodies['/api/ready'] = 'not json';
assert.ok((await run()).some(issue => issue.includes('invalid readiness response')));
bodies['/api/ready'] = ready;
assert.ok((await run({ fetcher: async () => new Response('Unavailable', { status: 503 }) })).some(issue => issue.includes('HTTP 503')));
assert.ok((await run({ fetcher: async () => { throw Error('network unavailable'); } })).some(issue => issue.includes('network unavailable')));
const broken = structuredClone(expected);
broken.assets['/app.js'] += "\n$('missingRequiredControl').click(); $('optionalAbsentControl')?.click();";
const issues = await run({ expected: broken });
assert.ok(issues.some(issue => issue.includes('#missingRequiredControl')));
assert.ok(!issues.some(issue => issue.includes('#optionalAbsentControl')));

let time = 0, attempts = 0, waits = 0;
const result = await waitForProduction({
  check: async () => ++attempts < 3 ? ['deployment still running'] : [],
  waitMs: 100, intervalMs: 30, now: () => time,
  sleep: async ms => { time += ms; waits++; },
});
assert.deepEqual(result, { superseded: false, issues: [] });
assert.equal(attempts, 3); assert.equal(waits, 2);
time = 0;
const failure = await waitForProduction({ check: async () => ['genuine drift'], waitMs: 100, intervalMs: 30, now: () => time, sleep: async ms => { time += ms; } });
assert.deepEqual(failure, { superseded: false, issues: ['genuine drift'] });
let current = true;
const superseded = await waitForProduction({ check: async () => { current = false; return ['old commit']; }, current: () => current });
assert.deepEqual(superseded, { superseded: true, issues: [] });
console.log('Production checks pass: matching release, stale modules, stale server, missing markup, network failures, deployment wait, timeout and superseded commits.');
