import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf("const REPORT_GENERATOR_ORIGIN"), app.indexOf('const showWorkspaceSection'));
const messages = [];
const posts = [];
const listeners = {};
const frame = { dataset: {}, contentWindow: null };
const target = { postMessage: (payload, origin) => posts.push({ payload, origin }) };
frame.contentWindow = target;
const state = { reportHandoff: null, reportHandoffExpiresAt: 0 };
let apiCalls = 0;
let resolveRefresh;
let nextHandoff = () => new Promise(resolve => { resolveRefresh = resolve; });
const elements = { reportGeneratorFrame: frame, reportGeneratorMessage: {} };
const context = {
  state,
  URL,
  Date,
  apiFetch: (...args) => { apiCalls += 1; return nextHandoff(...args); },
  setMessage: (_element, text, error = false) => messages.push({ text, error }),
  $: id => elements[id] || (elements[id] = {}),
  window: {
    addEventListener: (name, listener) => { listeners[name] = listener; },
    open: () => null,
  },
};
vm.createContext(context);
vm.runInContext(source, context);

const ready = (overrides = {}) => listeners.message({
  origin: 'https://request.stonesquare22pha.org',
  source: target,
  data: { kind: 'stone-square-report-ready' },
  ...overrides,
});

state.reportHandoff = {
  target,
  stagedAssertion: 'initial-assertion',
  expiresAt: Date.now() + 300_000,
  refreshPromise: null,
  embedded: true,
};
ready();
assert.equal(posts.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), {
  payload: { kind: 'stone-square-report-assertion', assertion: 'initial-assertion' },
  origin: 'https://request.stonesquare22pha.org',
});
assert.equal(state.reportHandoff.stagedAssertion, '', 'the staged assertion must be discarded after delivery');
assert.equal(frame.dataset.connected, 'true');
assert.equal(state.reportHandoff.target, target, 'the exact trusted target must remain available for renewal');

ready({ origin: 'https://evil.example' });
ready({ source: { postMessage() {} } });
ready({ data: { kind: 'anything-else' } });
assert.equal(apiCalls, 0, 'untrusted and unrelated messages must not renew access');

ready();
ready();
assert.equal(apiCalls, 1, 'concurrent ready events must share one renewal request');
const refresh = state.reportHandoff.refreshPromise;
resolveRefresh({
  url: 'https://request.stonesquare22pha.org/report',
  assertion: 'renewed-assertion',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});
await refresh;
assert.equal(posts.length, 2);
assert.equal(posts[1].payload.assertion, 'renewed-assertion');
assert.equal(state.reportHandoff.refreshPromise, null);
assert.equal(state.reportHandoff.target, target);
assert.ok(state.reportHandoffExpiresAt > Date.now());

nextHandoff = async () => ({
  url: 'https://request.stonesquare22pha.org/report?assertion=leak',
  assertion: 'must-not-send',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});
ready();
await state.reportHandoff.refreshPromise;
assert.equal(posts.length, 2, 'an assertion-bearing URL must be rejected before posting');
assert.equal(messages.at(-1).error, true);

assert.doesNotMatch(source, /localStorage|sessionStorage|[?&]assertion=\$\{/);
console.log('PASS: Report Generator assertions use the exact trusted target, renew once for concurrent ready events, reject untrusted messages and never persist or place assertions in URLs.');
