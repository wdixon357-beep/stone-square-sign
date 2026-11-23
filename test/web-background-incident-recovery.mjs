import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const select = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const result = new Promise(done => { resolve = done; });
  return { result, resolve };
};
const response = (status, body = {}, retryAfter = null) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: key => key === 'content-type' ? 'application/json' : retryAfter },
  json: async () => body,
});

function apiHarness() {
  const state = { user: { id: 9 }, authEpoch: 1, activeSection: 'minutes' };
  const navigator = { onLine: true };
  const notices = [], sent = [], requests = [], delays = [];
  const nodes = new Map(), storage = new Map();
  let handle = () => response(200), deliver = () => response(201);
  let now = Date.parse('2026-11-22T15:00:00Z');
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', classList: { toggle() {} }, addEventListener() {} });
    return nodes.get(id);
  };
  class Clock extends Date { static now() { return now; } }
  const context = {
    state, navigator, Date: Clock, $: node, crypto: webcrypto, FormData,
    location: { pathname: '/', origin: 'https://dashboard.example.invalid' },
    window: { clearTimeout() {}, setTimeout() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    webUpdateRequests: 0,
    show: () => notices.push(node('reliabilityNoticeTitle').textContent),
    hide() {},
    delay: async milliseconds => delays.push(milliseconds),
    fetch: async (path, options) => {
      if (path === '/api/activity/incidents') {
        sent.push(JSON.parse(options.body));
        return deliver();
      }
      requests.push({ path, options });
      return handle(path, options);
    },
  };
  vm.createContext(context);
  const declarations = select('const newIncidentReference =', "window.addEventListener('online'");
  vm.runInContext(`${declarations}\nthis.request = apiFetch; this.pending = queuedIncidents; this.flush = flushQueuedIncidents; this.queue = queueIncident;`, context);
  return {
    ...context, notices, sent, requests, delays,
    reply: fn => { handle = fn; },
    incidentReply: fn => { deliver = fn; },
    advance: milliseconds => { now += milliseconds; },
    now: () => now,
  };
}

const paths = [
  ['/api/minutes/review-alerts', {}, 'minutes', 2],
  ['/api/minutes/completion-alerts', {}, 'minutes', 2],
  ['/api/correspondence/alerts', {}, 'correspondence', 2],
  ['/api/treasury/alerts', {}, 'treasury', 2],
  ['/api/auth/me', { background: true }, 'settings', 2],
  ['/api/activity/heartbeat', { method: 'POST' }, 'activity', 1],
  ['/api/activity/interaction', { method: 'POST' }, 'activity', 1],
];

for (const [path, options, area, attempts] of paths) {
  const h = apiHarness();
  h.reply(() => { throw new TypeError('Simulated connection interruption'); });
  let reference;
  await assert.rejects(h.request(path, options), error => !!(reference = error.incidentReference));
  await settle();
  await assert.rejects(h.request(path, options), error => error.incidentReference === reference);
  await settle();
  assert.equal(h.requests.length, attempts * 2, 'Passive writes stay single-attempt');
  assert.equal(h.notices.length, 0, 'Recurring poll failure does not interrupt another task');
  assert.equal(h.pending().length, 1, 'Repeated failures leave a single pending record');
  await h.flush();
  assert.equal(h.sent.length, 1, 'Repeated failures use one reference');
  assert.equal(h.sent[0].area, area);
  assert.equal(h.sent[0].category, 'network_error');
  h.reply(() => response(200));
  await h.request('/api/archives/minutes');
  await settle();
  assert.equal(h.sent.length, 1, 'Unrelated success does not resolve this route');
  await h.request(path, options);
  await settle();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].reference, reference);
  assert.equal(h.sent[1].state, 'recovered');
  h.reply(() => response(503, { incidentReference: 'SS22-NEW-REFERENCE' }));
  await assert.rejects(h.request(path, options), error => error.incidentReference !== reference);
  await settle();
  assert.equal(h.sent[2].state, 'open', 'A later outage is tracked separately');
}

{
  const h = apiHarness();
  const path = '/api/treasury/alerts';
  h.navigator.onLine = false;
  h.reply(() => { throw new TypeError('Simulated offline'); });
  await assert.rejects(h.request(path));
  await assert.rejects(h.request(path));
  await h.flush();
  assert.equal(h.requests.length, 2, 'No immediate retries while offline');
  assert.equal(h.sent.length, 0, 'Offline incidents stay in the local outbox');
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].category, 'offline');
  h.navigator.onLine = true;
  await h.flush();
  h.reply(() => response(200));
  await h.request(path);
  await settle();
  assert.deepEqual(h.sent.map(event => event.state), ['open', 'recovered']);
}

for (const dateHeader of [false, true]) {
  const h = apiHarness();
  const path = '/api/treasury/alerts';
  const otherPath = '/api/minutes/completion-alerts';
  const retry = dateHeader ? new Date(h.now() + 300000).toUTCString() : '300';
  h.reply(target => target === path ? response(429, {}, retry) : response(200));
  let reference;
  await assert.rejects(h.request(path), error => error.status === 429 && !!(reference = error.incidentReference));
  await assert.rejects(h.request(path), error => error.incidentReference === reference);
  await h.request(otherPath);
  assert.equal(h.requests.filter(request => request.path === path).length, 1, 'Retry-After governs the next interval too');
  assert.deepEqual(h.delays, [], 'A long Retry-After schedules no immediate retry');
  h.advance(300000);
  h.reply(() => response(200));
  await h.request(path);
  await settle();
  assert.deepEqual(h.sent.map(event => event.state), ['open', 'recovered']);
}

{
  const h = apiHarness();
  const path = '/api/correspondence/alerts';
  const old = deferred();
  h.reply(() => old.result);
  const staleSuccess = h.request(path);
  h.reply(() => response(503, { incidentReference: 'SS22-LATEST' }));
  await assert.rejects(h.request(path));
  old.resolve(response(200));
  await staleSuccess;
  await settle();
  assert.deepEqual(h.sent.map(event => event.state), ['open'], 'A late response from an earlier poll cannot resolve a newer failure');
  h.reply(() => response(200));
  await h.request(path);
  await settle();
  assert.deepEqual(h.sent.map(event => event.state), ['open', 'recovered']);
}

{
  const h = apiHarness();
  const path = '/api/minutes/review-alerts';
  h.reply(() => { throw new TypeError('Connection interrupted before the server responded'); });
  let localReference;
  await assert.rejects(h.request(path), error => !!(localReference = error.incidentReference));
  await h.flush();
  let nextReference = 101;
  h.reply(() => response(502, { incidentReference: `SS22-RUNTIME${nextReference++}` }));
  await assert.rejects(h.request(path), error => error.incidentReference === localReference
    && error.serviceIncidentReference === 'SS22-RUNTIME102');
  await assert.rejects(h.request(path), error => error.incidentReference === localReference
    && error.serviceIncidentReference === 'SS22-RUNTIME104');
  await settle();
  assert.ok(h.sent.every(event => event.reference === localReference),
    'The recorded route failure does not duplicate server-reported incidents');
  h.reply(() => response(200));
  await h.request('/api/treasury/alerts');
  await settle();
  assert.ok(h.sent.every(event => event.state === 'open'), 'Unrelated poll success does not resolve the route or server incident');
  await h.request(path);
  await settle();
  assert.deepEqual(h.sent.filter(event => event.state === 'recovered').map(event => event.reference).sort(),
    [localReference, 'SS22-RUNTIME101', 'SS22-RUNTIME102', 'SS22-RUNTIME103', 'SS22-RUNTIME104'].sort(),
    'A successful matching poll separately resolves both server attempts and the browser outage');
}

{
  const h = apiHarness();
  for (let i = 0; i < 25; i += 1) h.queue({ reference: `SS22-QUEUE${i}`, state: 'recovered' });
  h.incidentReply(() => response(429, {}, '60'));
  await h.flush();
  await h.flush();
  assert.equal(h.sent.length, 1, 'Delivery pauses during a Retry-After instead of retrying the entire outbox');
  assert.equal(h.pending().length, 25);
  h.advance(60000);
  h.incidentReply(() => response(201));
  await h.flush();
  assert.equal(h.sent.length, 17, 'Incident delivery sends a bounded batch after recovery');
  assert.equal(h.pending().length, 9);
  await h.flush();
  assert.equal(h.pending().length, 0);
}

{
  const h = apiHarness();
  h.reply(() => response(503));
  await assert.rejects(h.request('/api/auth/me'));
  assert.equal(h.notices.length, 2, 'An explicit sign-in check still explains its failure and retry');
  assert.equal('background' in h.requests[0].options, false, 'Application-only option is never sent to fetch');
  assert.equal(h.requests[0].options.credentials, 'same-origin');
}

function liveHarness(replies, online = true) {
  const calls = [], display = [], timers = new Map(), listeners = new Map();
  const navigator = { onLine: online };
  const state = { user: { id: 8 }, authEpoch: 1, activeSection: 'home' };
  const status = { classList: { toggle: (name, connected) => display.push(connected) }, lastChild: {} };
  let timerId = 0;
  let permissionChecks = 0;
  const context = {
    state, navigator, AbortController, TextDecoder, $: () => status, checkOrdersWorkspace: null,
    refreshMinutesReviewAlerts: async () => {}, refreshBuildingAlerts: async () => {},
    refreshCorrespondenceAlerts: async () => {}, refreshTreasuryAlerts: async () => {},
    refreshSessionPermissions: () => { permissionChecks += 1; },
    window: {
      setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
      clearTimeout: id => timers.delete(id),
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    },
    fetch: async path => {
      calls.push(path);
      assert.ok(replies.length, 'Unexpected reconnect');
      return replies.shift();
    },
  };
  vm.createContext(context);
  vm.runInContext(`${select('const setLiveState =', 'const renderDocuments =')}\nthis.start = startRealtime;`, context);
  return { calls, timers, display, navigator, start: context.start,
    duration: () => [...timers.values()][0]?.ms,
    runTimer: () => [...timers.values()][0].fn(),
    online: () => { navigator.onLine = true; listeners.get('online')?.(); },
    abort: () => state.realtimeAbort.abort(),
    permissionChecks: () => permissionChecks,
  };
}

const endedStream = { status: 200, ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
{
  const h = liveHarness([endedStream, response(503), response(403)]);
  const task = h.start();
  await settle();
  assert.deepEqual(h.display, [true, false], 'Completed stream shows it has disconnected');
  assert.equal(h.duration(), 2500);
  h.runTimer();
  await settle();
  assert.equal(h.duration(), 5000, 'Repeated connection failures back off');
  h.runTimer();
  await task;
  assert.equal(h.permissionChecks(), 1, 'A rejected stream confirms session access once');
  assert.equal(h.timers.size, 0, 'Unauthorized stream requests do not loop');
}
{
  const h = liveHarness([endedStream], false);
  const task = h.start();
  await settle();
  assert.equal(h.calls.length, 0, 'No live requests while the browser is offline');
  h.online();
  await settle();
  assert.equal(h.calls.length, 1, 'The online event reconnects without waiting for the scheduled poll');
  h.abort();
  await task;
  assert.equal(h.timers.size, 0, 'Leaving the session cancels its reconnect timer');
}

{
  const state = { user: { id: 9, role: 'owner' }, authEpoch: 1 };
  const element = {};
  let calls = 0;
  const source = select('const refreshGenerationStatus =', 'const renderMinutes =')
    .replace("import('/generation-status.js')", 'loadGenerationStatus()');
  const context = vm.createContext({ state, loadGenerationStatus: async () => { throw Error('Module unavailable'); },
    apiFetch: async () => { calls += 1; } });
  vm.runInContext(`${source}\nthis.refresh = refreshGenerationStatus;`, context);
  await context.refresh(element);
  assert.match(element.textContent, /Generation status unavailable/);
  assert.equal(calls, 0);
  const stale = deferred();
  context.loadGenerationStatus = () => stale.result;
  const refresh = context.refresh(element);
  state.user = { id: 10, role: 'secretary' };
  state.authEpoch += 1;
  stale.resolve({ generationStatusText: () => 'Administrator allowance' });
  await refresh;
  assert.equal(calls, 0, 'A stale status request does not use the next login');
  assert.doesNotMatch(element.textContent, /Administrator allowance/);
}

console.log('PASS: quiet route-scoped recovery, offline delivery, Retry-After, stale polls, live queue reconnection and optional generation status.');
