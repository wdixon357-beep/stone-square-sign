import assert from 'node:assert/strict';
import ical from 'node-ical';
import { readConnectedCalendar, connectedCalendarWarning, connectedCalendarBlocks } from '../portal-maintenance/api/connected-calendar.js';
import { formatCalendarTime } from '../public/building-calendar.js';

let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
const source = 'https://calendar.example.test/private/synthetic-secret/basic.ics';
const valid = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-calendar-event\r\nDTSTART:20261022T230000Z\r\nDTEND:20261023T000000Z\r\nSUMMARY:Synthetic evening event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const parseICS = text => ical.parseICS(text);
const load = async (fetcher, options = {}) => readConnectedCalendar({ url: source, fetcher, parseICS, ...options });
let result = await readConnectedCalendar({ url: '', parseICS, fetcher: () => { throw Error('Should not fetch'); } });
check('Unconfigured source is reported without a network request', !result.connected && result.reason === 'not_configured');
for (const status of [401, 403, 404, 410, 429, 500]) {
  result = await load(async () => new Response('Synthetic unavailable source', { status }));
  check('HTTP ' + status + ' cannot be reported as connected', !result.connected && result.reason === (status === 500 ? 'source_error' : `http_${status}`));
}
result = await load(async () => new Response('<html>Please sign in</html>'));
check('Successful sign-in HTML cannot masquerade as a calendar', !result.connected && result.reason === 'invalid_feed');
result = await load(async () => new Response(valid), { parseICS: () => { throw Error('private source detail'); } });
check('Parser failures are safely identified', !result.connected && result.reason === 'parse_error');
result = await load(async () => new Response(valid), { parseICS: () => null });
check('Malformed parser output cannot appear connected', !result.connected && result.reason === 'parse_error');
result = await load(async () => { throw new DOMException('Synthetic timeout', 'TimeoutError'); });
check('Fetch deadline is distinguished from source removal', !result.connected && result.reason === 'timeout');
result = await load(async () => { throw Error('Synthetic network failure at ' + source); });
check('Network details and private source URL are not returned', !result.connected && result.reason === 'network_error' && !JSON.stringify(result).includes(source));
result = await load(async () => new Response(valid, { headers: { 'content-length': '9999999' } }));
check('Advertised oversized bodies are rejected before parsing', !result.connected && result.reason === 'too_large');
result = await load(async () => new Response(valid), { maxBytes: 50 });
check('Chunked oversized bodies are also rejected', !result.connected && result.reason === 'too_large');
let requested;
result = await load(async (url, options) => { requested = { url, options }; return new Response(valid); });
check('A valid calendar is parsed using the existing node-ical parser', result.connected && result.reason === 'connected' && result.data['synthetic-calendar-event'].summary === 'Synthetic evening event');
check('Fetch preserves the source and has a bounded deadline', requested.url === source && requested.options.signal instanceof AbortSignal);
check('Feed redirects cannot change the source implicitly', requested.options.redirect === 'error');
check('A valid empty calendar is distinct from a broken feed', (await load(async () => new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'))).connected);
for (const reason of ['not_configured', 'http_401', 'http_403', 'http_404', 'http_410', 'http_429', 'source_error', 'timeout', 'invalid_feed', 'parse_error', 'too_large', 'network_error']) {
  const warning = connectedCalendarWarning(reason);
  assert.match(warning, /extra calendar events could not be checked/);
  assert.ok(!warning.includes('synthetic-secret') && !warning.includes(source));
}
check('Every unavailable status retains an honest incomplete-availability warning', true);
const blocks = (entries, from = '2026-10-01', to = '2026-11-30') => connectedCalendarBlocks(parseICS(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${entries}\r\nEND:VCALENDAR\r\n`), { from, to, expandEvent: ical.expandRecurringEvent });
const event = lines => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
let projected = blocks(event(['UID:date-only', 'DTSTART;VALUE=DATE:20261022', 'DTEND;VALUE=DATE:20261024', 'SUMMARY:Synthetic date-only event']));
check('All-day dates do not shift into the preceding Eastern day', projected.complete && projected.events.map(x => x.date).join(',') === '2026-10-22,2026-10-23' && projected.events.every(x => x.allDay && !x.start && !x.end));
projected = blocks(event(['UID:single-all-day', 'DTSTART;VALUE=DATE:20261022', 'SUMMARY:Synthetic single-day event']));
check('A date-only event without an end occupies one calendar day', projected.complete && projected.events.length === 1 && projected.events[0].date === '2026-10-22');
projected = blocks(event(['UID:overnight', 'DTSTART;TZID=America/New_York:20261022T220000', 'DTEND;TZID=America/New_York:20261023T020000', 'SUMMARY:Synthetic overnight event']));
check('An overnight event blocks both occupied days accurately', projected.complete && projected.events.map(x => [x.date, x.start, x.end].join('|')).join(',') === '2026-10-22|22:00|24:00,2026-10-23|00:00|02:00');
check('End-of-day boundary is readable on the website', formatCalendarTime('24:00') === '12:00 AM (next day)');
projected = blocks(event(['UID:midnight', 'DTSTART;TZID=America/New_York:20261022T220000', 'DTEND;TZID=America/New_York:20261023T000000', 'SUMMARY:Synthetic midnight finish']));
check('Exclusive midnight finish does not reserve the following day', projected.complete && projected.events.length === 1 && projected.events[0].end === '24:00');
projected = blocks(event(['UID:late-last-day', 'DTSTART;TZID=America/New_York:20261031T220000', 'DTEND;TZID=America/New_York:20261031T230000', 'SUMMARY:Synthetic late event']), '2026-10-01', '2026-10-31');
check('Late Eastern events on the final requested day are retained', projected.complete && projected.events.length === 1 && projected.events[0].date === '2026-10-31' && projected.events[0].start === '22:00');
projected = blocks(event(['UID:spanning', 'DTSTART;TZID=America/New_York:20260930T220000', 'DTEND;TZID=America/New_York:20261003T020000', 'SUMMARY:Synthetic spanning event']), '2026-10-01', '2026-10-02');
check('An event already underway fills each occupied visible day', projected.complete && projected.events.map(x => [x.date, x.start, x.end].join('|')).join(',') === '2026-10-01|00:00|24:00,2026-10-02|00:00|24:00');
projected = blocks([
  event(['UID:recurring', 'DTSTART;TZID=America/New_York:20261022T193000', 'DTEND;TZID=America/New_York:20261022T203000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=America/New_York:20261105T193000', 'SUMMARY:Synthetic recurring meeting']),
  event(['UID:recurring', 'RECURRENCE-ID;TZID=America/New_York:20261112T193000', 'DTSTART;TZID=America/New_York:20261112T200000', 'DTEND;TZID=America/New_York:20261112T210000', 'SUMMARY:Synthetic changed occurrence']),
].join('\r\n'));
check('Recurrence exclusions and changed occurrences remain effective', projected.complete && projected.events.map(x => [x.date, x.start].join('|')).join(',') === '2026-10-22|19:30,2026-10-29|19:30,2026-11-12|20:00');
projected = blocks(event(['UID:dst-recurring', 'DTSTART;TZID=America/New_York:20261022T193000', 'DTEND;TZID=America/New_York:20261022T203000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Synthetic DST meeting']));
check('A timed recurrence keeps Eastern wall time across daylight saving change', projected.complete && projected.events.map(x => [x.date, x.start].join('|')).join(',') === '2026-10-22|19:30,2026-10-29|19:30,2026-11-05|19:30');
projected = blocks(event(['UID:dst-full-day', 'DTSTART;VALUE=DATE:20261031', 'DTEND;VALUE=DATE:20261102', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Synthetic recurring date-only meeting']));
check('Recurring date-only spans remain on their calendar dates across daylight saving change', projected.complete && projected.events.map(x => x.date).join(',') === '2026-10-31,2026-11-01,2026-11-07,2026-11-08');
projected = blocks([
  event(['UID:cancelled', 'DTSTART;TZID=America/New_York:20261022T193000', 'DTEND;TZID=America/New_York:20261022T203000', 'STATUS:CANCELLED', 'SUMMARY:Synthetic cancelled event']),
  event(['UID:free', 'DTSTART;TZID=America/New_York:20261022T193000', 'DTEND;TZID=America/New_York:20261022T203000', 'TRANSP:TRANSPARENT', 'SUMMARY:Synthetic free event']),
  event(['UID:personal', 'DTSTART;TZID=America/New_York:20261022T193000', 'DTEND;TZID=America/New_York:20261022T203000', 'SUMMARY:Reminder synthetic private task']),
].join('\r\n'));
check('Cancelled, free and personal task entries do not become building reservations', projected.complete && projected.events.length === 0);
projected = blocks(event(['UID:no-end', 'DTSTART;TZID=America/New_York:20261022T193000', 'SUMMARY:Synthetic unknown finish']));
check('An unknown timed finish is kept visible and marked incomplete', !projected.complete && projected.events.length === 1 && projected.events[0].end === '');
console.log(`PASS ${checks} isolated connected-calendar checks; no live feed or database used.`);
