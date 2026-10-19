import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('const REPORT_GENERATOR_ORIGIN'), app.indexOf('const showWorkspaceSection'));
const origin = 'https://request.stonesquare22pha.org';
const plain = value => JSON.parse(JSON.stringify(value));
function harness(query = '?section=reports&legacyReport=1') {
  const requests = [], posts = [], listeners = {};
  const opener = { postMessage: (payload, targetOrigin) => requests.push({ payload, targetOrigin }) };
  const frame = { dataset: {}, contentWindow: null };
  const target = { postMessage: (payload, targetOrigin) => posts.push({ payload, targetOrigin }) };
  frame.contentWindow = target;
  const elements = { reportGeneratorFrame: frame, reportGeneratorMessage: {} };
  const state = { user: null, authEpoch: 1, reportHandoff: null, reportHandoffExpiresAt: 0 };
  const context = vm.createContext({
    state, URL, Date, crypto: { randomUUID },
    can: permission => Boolean(state.user?.permissions?.includes(permission)),
    apiFetch: async () => { throw new Error('Unexpected API call'); },
    setMessage() {},
    $: id => elements[id] || (elements[id] = { addEventListener() {} }),
    window: { opener, location: { href: `https://stone-square-sign.onrender.com/${query}` },
      addEventListener: (name, listener) => { listeners[name] = listener; }, open: () => null },
  });
  vm.runInContext(source, context);
  return {
    state, requests, posts, opener, target, frame,
    request: () => vm.runInContext('legacyReportBridge.request()', context),
    clear: () => vm.runInContext('legacyReportBridge.clear()', context),
    message: overrides => listeners.message({ origin, source: opener, data: {
      kind: 'stone-square-legacy-report-draft', requestId: requests.at(-1)?.payload.requestId,
      draft: { type: 'formal', fields: { title: 'Nursing facility visit', findings: 'The Brothers visited.' }, phone: '302-555-0100' },
    }, ...overrides }),
    ready: () => listeners.message({ origin, source: target, data: { kind: 'stone-square-report-ready' } }),
    login(email = 'adrian@example.org', id = 2) { state.user = { id, email, permissions: ['reports.create'] }; },
    connect() { state.reportHandoff = { target, stagedAssertion: 'verified-account-assertion', expiresAt: Date.now() + 300000, embedded: true }; },
  };
}

const h = harness();
h.request();
assert.equal(h.requests.length, 0, 'no draft request before authentication');
h.login();
h.request(); h.request();
assert.equal(h.requests.length, 1, 'same-account refreshes do not repeatedly request or overwrite a draft');
assert.equal(h.requests[0].targetOrigin, origin);
assert.equal(h.requests[0].payload.email, 'adrian@example.org');
assert.ok(h.requests[0].payload.requestId);
h.message({ origin: 'https://evil.example' });
h.message({ source: {} });
h.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: 'wrong-request', draft: { type: 'formal', fields: { title: 'wrong' } } } });
assert.equal(h.posts.length, 0);
h.message();
assert.equal(h.posts.length, 0, 'candidate waits for a connected frame');
h.connect();
h.message();
assert.equal(h.posts.length, 0, 'candidate waits until authenticated assertion has been delivered');
h.ready();
assert.deepEqual(h.posts.map(post => post.payload.kind), ['stone-square-report-assertion', 'stone-square-report-recovery']);
assert.deepEqual(plain(h.posts[1]), { targetOrigin: origin, payload: {
  kind: 'stone-square-report-recovery', email: 'adrian@example.org',
  draft: { type: 'formal', fields: { title: 'Nursing facility visit', findings: 'The Brothers visited.' }, phone: '302-555-0100' },
} });
assert.equal(h.frame.dataset.connected, 'true');
h.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: h.requests[0].payload.requestId, draft: { type: 'formal', fields: { title: 'overwrite attempt' } } } });
assert.equal(h.posts.length, 2, 'duplicate messages cannot replace the first candidate');

// The reverse order is also valid: the legacy response can arrive after the frame.
const late = harness(); late.login(); late.request(); late.connect(); late.ready();
late.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: late.requests[0].payload.requestId,
  draft: { type: 'formal', fields: { title: '<script>window.secret=true</script>' }, phone: '', reviewed: true,
    name: 'Impersonator', office: 'Worshipful Master', signatureName: 'Forged', clientId: 'old-submission' } } });
assert.equal(late.posts.length, 2);
assert.deepEqual(Object.keys(late.posts[1].payload.draft).sort(), ['clientId', 'fields', 'phone', 'type']);
assert.equal(late.posts[1].payload.draft.clientId, 'old-submission');
assert.equal(late.posts[1].payload.draft.fields.title, '<script>window.secret=true</script>', 'content is relayed as data, never executed or inserted into the dashboard DOM');

const durable = harness(); durable.login(); durable.request(); durable.connect(); durable.ready();
const deliveryIntent = randomUUID();
durable.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: durable.requests[0].payload.requestId,
  draft: { type: 'formal', fields: { title: 'Retained final draft' }, clientId: 'retained-client-id', deliveryIntent, externalId: 'Never-trust-client-archive' } } });
assert.equal(durable.posts[1].payload.draft.clientId, 'retained-client-id');
assert.equal(durable.posts[1].payload.draft.deliveryIntent, deliveryIntent);
assert.equal(durable.posts[1].payload.draft.externalId, undefined);
const malformedIntent = harness(); malformedIntent.login(); malformedIntent.request(); malformedIntent.connect(); malformedIntent.ready();
malformedIntent.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: malformedIntent.requests[0].payload.requestId,
  draft: { type: 'formal', fields: { title: 'Preserved notes' }, clientId: '<invalid>', deliveryIntent: 'not-a-uuid' } } });
assert.equal(malformedIntent.posts[1].payload.draft.deliveryIntent, undefined);
assert.equal(malformedIntent.posts[1].payload.draft.clientId, undefined);

for (const badDraft of [
  { type: 'unknown', fields: { title: 'Bad type' } },
  { type: 'formal', fields: { title: 42 } },
  { type: 'formal', fields: { title: 'x'.repeat(20001) } },
  { type: 'formal', fields: { title: 'valid' }, phone: '1'.repeat(41) },
  { type: 'formal', fields: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`field${i}`, 'x'])) },
  { type: 'formal', fields: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`field${i}`, 'x'.repeat(20000)])) },
  { type: 'formal', fields: JSON.parse('{"__proto__":"pollution","title":"Bad key"}') },
  { type: 'formal', fields: { title: '   ' } },
]) {
  const invalid = harness(); invalid.login(); invalid.request(); invalid.connect(); invalid.ready();
  invalid.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: invalid.requests[0].payload.requestId, draft: badDraft } });
  assert.equal(invalid.posts.length, 1, 'malformed or oversized content must never reach the report frame');
}

const changed = harness(); changed.login(); changed.request();
const oldRequest = changed.requests[0].payload.requestId;
changed.message();
changed.state.authEpoch += 1;
changed.login('mcduffie@example.org', 3); changed.request(); changed.connect(); changed.ready();
assert.equal(changed.posts.length, 1, 'account switch clears the previous account candidate');
changed.message({ data: { kind: 'stone-square-legacy-report-draft', requestId: oldRequest, draft: { type: 'formal', fields: { title: 'Delayed private draft' } } } });
assert.equal(changed.posts.length, 1, 'a delayed response from the former account cannot enter the new account');
changed.clear(); changed.message();
assert.equal(changed.posts.length, 1, 'logout discards pending requests and candidates');

const forbidden = harness(); forbidden.login(); forbidden.request(); forbidden.state.user.permissions = []; forbidden.message();
forbidden.connect(); forbidden.ready();
assert.equal(forbidden.posts.length, 1, 'revoked report access prevents draft delivery');
forbidden.request(); assert.equal(forbidden.requests.length, 1);
const direct = harness('?section=reports'); direct.login(); direct.request(); direct.message();
assert.equal(direct.requests.length, 0, 'normal dashboard visits do not inspect opener drafts');
assert.equal(direct.posts.length, 0);

assert.match(app, /state\.user = user;\s+legacyReportBridge\.request\(\)/);
assert.match(app, /state\.user = null;\s+legacyReportBridge\.clear\(\)/);
assert.match(app, /\$\('logoutBtn'\)\.addEventListener\('click', async \(\) => \{\s+legacyReportBridge\.clear\(\)/);
const bridgeSource = source.slice(source.indexOf('const legacyReportBridge'), source.indexOf('const secureReportUrl'));
assert.doesNotMatch(bridgeSource, /localStorage|sessionStorage|innerHTML\s*=|location\s*=|location\.(?:assign|replace)/);
console.log('PASS: Legacy report recovery requires the exact opener, verified report access, account and request binding; works in both readiness orders; strips identity/signature/submission claims; rejects malformed content; and clears on logout or account changes without persisting or overwriting report fields.');
