import assert from 'node:assert/strict';

process.env.BUILDING_STORE_BACKEND = 'sign-postgres';
process.env.BUILDING_STORE_BRIDGE_URL = 'https://dashboard.example.test/api/internal/building-store';
process.env.BUILDING_STORE_BRIDGE_SECRET = 'synthetic-test-secret-with-at-least-thirty-two-bytes';
process.env.GCAL_ICS_URL = 'https://calendar.example.test/private/synthetic-secret/basic.ics';
const originalFetch = global.fetch;
let mode = 'valid', calls = [], checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-event\r\nDTSTART;TZID=America/New_York:20261022T180000\r\nDTEND;TZID=America/New_York:20261022T190000\r\nSUMMARY:Synthetic source event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
global.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  if (url === process.env.BUILDING_STORE_BRIDGE_URL) {
    const operation = JSON.parse(options.body);
    assert.deepEqual(operation, { operation: 'get', key: 'resv:all' });
    if (mode === 'store-fail') return Response.json({ error: 'Synthetic storage unavailable' }, { status: 503 });
    return Response.json({ result: JSON.stringify([{ id: 'synthetic-reservation', org: 'Synthetic organization', date: '2026-10-23', start: '18:00', end: '20:00', status: 'approved' }]) });
  }
  assert.equal(url, process.env.GCAL_ICS_URL, 'Only the synthetic calendar source may be fetched');
  assert.equal(options.redirect, 'error');
  if (mode === '404') return new Response('', { status: 404 });
  if (mode === 'html') return new Response('<html>Not a calendar</html>');
  if (mode === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError');
  return new Response(ics);
};
try {
  const { default: handler } = await import('../portal-maintenance/api/calendar.js');
  const read = async (query = {}) => {
    let status = 200, body, headers = {};
    const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; }, send(value) { body = value; return this; }, setHeader(key, value) { headers[key] = value; } };
    await handler({ method: 'GET', query: { from: '2026-10-01', to: '2026-10-31', ...query } }, res);
    return { status, body, headers };
  };
  let result = await read();
  check('Valid feed and saved reservations remain available together', result.status === 200 && result.body.gcalConnected && result.body.calendarFeedStatus === 'connected' && result.body.warning === null);
  check('Saved reservation data is read without mutation', result.body.busy.some(x => x.source === 'reservation' && x.date === '2026-10-23') && calls.filter(x => x.url === process.env.BUILDING_STORE_BRIDGE_URL).every(x => JSON.parse(x.options.body).operation === 'get'));
  check('Connected source event retains its Eastern Time values', result.body.busy.some(x => x.label === 'Synthetic source event' && x.date === '2026-10-22' && x.start === '18:00' && x.end === '19:00'));
  for (const [scenario, reason] of [['404', 'http_404'], ['html', 'invalid_feed'], ['timeout', 'timeout']]) {
    mode = scenario; result = await read();
    check(scenario + ' retains standing and saved records with honest source status', result.status === 200 && !result.body.gcalConnected && result.body.calendarFeedStatus === reason && result.body.busy.some(x => x.source === 'reservation') && result.body.busy.some(x => x.label.includes('Stated Meeting')));
    check(scenario + ' never exposes the private source address', !JSON.stringify(result.body).includes('synthetic-secret') && !JSON.stringify(result.body).includes(process.env.GCAL_ICS_URL));
  }
  mode = 'store-fail'; result = await read();
  check('Database failure remains a failure, never an empty available calendar', result.status === 503 && /cannot confirm availability/.test(result.body.error));
  mode = 'valid'; calls = []; result = await read({ format: 'ics' });
  check('Existing subscription behavior is preserved', result.status === 200 && result.headers['Content-Type'].includes('text/calendar') && typeof result.body === 'string' && result.body.includes('BEGIN:VCALENDAR'));
  check('Subscription does not start fetching another calendar source', calls.every(x => x.url === process.env.BUILDING_STORE_BRIDGE_URL));
  console.log(`PASS ${checks} isolated portal calendar checks; no live feed, records or environment changes.`);
} finally { global.fetch = originalFetch; }
