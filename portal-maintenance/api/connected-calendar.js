// Read-only source retrieval. Never include the private feed URL in a response or log.
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const EASTERN = 'America/New_York';
const DAY_MS = 86400000;
const personalEntry = title => /^(check|follow up|follow-up|reminder|pick up|drop[- ]?off|call |quick call|renew|pay |refund|vehicle)\b/.test(String(title || '').toLowerCase());
const dayKey = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const addDays = (day, count) => new Date(Date.parse(day + 'T12:00:00Z') + count * DAY_MS).toISOString().slice(0, 10);
const localDate = date => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: EASTERN, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const localTime = date => new Intl.DateTimeFormat('en-GB', { timeZone: EASTERN, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

// Keep every occupied day. Date-only values are calendar dates, not UTC instants.
// node-ical's expander handles recurrence exclusions, overrides and date-only normalization.
export function connectedCalendarBlocks(data, { from, to, expandEvent }) {
  const events = [], seen = new Set();
  let complete = true;
  const push = (date, start, end, allDay, label) => {
    if (date < from || date > to) return;
    const key = JSON.stringify([date, start, end, allDay, label]);
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ date, start, end, allDay, label, source: 'gcal', status: 'approved' });
  };
  const range = { from: new Date(Date.parse(from + 'T00:00:00Z') - 2 * DAY_MS), to: new Date(Date.parse(to + 'T23:59:59Z') + 2 * DAY_MS), expandOngoing: true, includeOverrides: true, excludeExdates: true };
  for (const event of Object.values(data)) {
    if (!event || event.type !== 'VEVENT' || personalEntry(event.summary) || String(event.status).toUpperCase() === 'CANCELLED' || String(event.transparency).toUpperCase() === 'TRANSPARENT') continue;
    // A minute/second recurrence can expand to millions of entries in a year.
    // Retain an incomplete-source warning instead of timing out or losing the whole calendar.
    if (event.rrule?.options?.freq >= 5) { complete = false; continue; }
    let instances;
    try { instances = expandEvent(event, range); }
    catch { complete = false; continue; }
    if (!Array.isArray(instances) || instances.length > 10000) { complete = false; continue; }
    for (const instance of instances) {
      const current = instance.event || event;
      const label = String(instance.summary || event.summary || 'Reserved').slice(0, 80);
      if (personalEntry(label) || String(current.status).toUpperCase() === 'CANCELLED' || String(current.transparency).toUpperCase() === 'TRANSPARENT') continue;
      const start = instance.start, end = instance.end;
      if (!(start instanceof Date) || !Number.isFinite(start.getTime())) { complete = false; continue; }
      if (instance.isFullDay) {
        const durationSource = current.end ? current : event;
        const duration = durationSource.start && durationSource.end
          ? (Date.parse(dayKey(durationSource.end) + 'T12:00:00Z') - Date.parse(dayKey(durationSource.start) + 'T12:00:00Z')) / DAY_MS : 1;
        if (!Number.isInteger(duration) || duration < 1) { complete = false; continue; }
        const first = dayKey(start), last = addDays(first, duration - 1);
        for (let day = first < from ? from : first; day <= last && day <= to; day = addDays(day, 1)) push(day, '', '', true, label);
        continue;
      }
      const first = localDate(start);
      if (!(end instanceof Date) || !Number.isFinite(end.getTime()) || end <= start) {
        push(first, localTime(start), '', false, label);
        complete = false;
        continue;
      }
      const last = localDate(end), lastTime = localTime(end);
      for (let day = first < from ? from : first; day <= last && day <= to; day = addDays(day, 1)) {
        // DTEND is exclusive: midnight belongs to the preceding occupied day.
        if (day === last && day !== first && lastTime === '00:00') continue;
        push(day, day === first ? localTime(start) : '00:00', day === last ? lastTime : '24:00', false, label);
      }
    }
  }
  return { events, complete };
}

export async function readConnectedCalendar({ url, fetcher = fetch, parseICS, timeoutMs = 6000, maxBytes = MAX_FEED_BYTES }) {
  const unavailable = reason => ({ connected: false, reason, data: null });
  if (!url) return unavailable('not_configured');
  let response;
  try {
    response = await fetcher(url, {
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'text/calendar, text/plain;q=0.9' },
    });
    if (!response.ok) return unavailable([401, 403, 404, 410, 429].includes(response.status) ? `http_${response.status}` : 'source_error');
    if (Number(response.headers.get('content-length')) > maxBytes) return unavailable('too_large');
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); return unavailable('too_large'); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    } else {
      text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) return unavailable('too_large');
    }
    text = text.replace(/^\uFEFF/, '').trim();
    if (!/^BEGIN:VCALENDAR\r?\n/i.test(text) || !/\r?\nEND:VCALENDAR$/i.test(text)) return unavailable('invalid_feed');
    let data;
    try { data = parseICS(text); } catch { return unavailable('parse_error'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable('parse_error');
    return { connected: true, reason: 'connected', data };
  } catch (error) {
    return unavailable(['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error');
  }
}

export function connectedCalendarWarning(reason) {
  const lead = {
    not_configured: 'The connected calendar feed is not configured.',
    http_401: 'The connected calendar feed requires renewed access.',
    http_403: 'The connected calendar feed no longer allows access.',
    http_404: 'The connected calendar feed address was not found.',
    http_410: 'The connected calendar feed has been removed.',
    http_429: 'The connected calendar feed is temporarily limiting requests.',
    timeout: 'The connected calendar feed did not respond in time.',
    invalid_feed: 'The connected calendar returned an invalid feed.',
    parse_error: 'The connected calendar feed could not be read.',
    too_large: 'The connected calendar feed exceeded the supported size.',
    partial_data: 'Some connected calendar entries could not be fully read.',
  }[reason] || 'The connected calendar feed is unavailable.';
  return `${lead} Standing meetings and saved building requests are shown; extra calendar events could not be checked.`;
}
