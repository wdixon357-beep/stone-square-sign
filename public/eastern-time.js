const timeZone = 'America/New_York';
const timestamp = new Intl.DateTimeFormat('en-US', {
  timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
});
const easternDate = new Intl.DateTimeFormat('en-US', {
  timeZone, month: 'long', day: 'numeric', year: 'numeric',
});
const dateKey = new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});

function formatInstant(value, formatter, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatter.format(date) : fallback;
}

export const formatEasternTimestamp = (value, fallback = 'Not recorded') => formatInstant(value, timestamp, fallback);
export const formatEasternDate = (value, fallback = 'Date unavailable') => formatInstant(value, easternDate, fallback);
export function easternDateKey(value = new Date()) {
  const { year, month, day } = Object.fromEntries(dateKey.formatToParts(value).map(({ type, value }) => [type, value]));
  return `${year}-${month}-${day}`;
}

// A Lodge clock value is already Eastern. Convert its notation without shifting it.
const displayClock = /^(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*([ap])\.?m\.?$/i;
const storedClock = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

export function formatEasternClock(value) {
  const text = String(value ?? '').trim();
  if (/^24:00(?::00)?$/.test(text)) return '12:00 AM (next day)';
  const display = displayClock.exec(text);
  if (display) return `${Number(display[1])}:${display[2] || '00'} ${display[3].toUpperCase()}M`;
  const stored = storedClock.exec(text);
  if (!stored) return '';
  const hour = Number(stored[1]);
  return `${hour % 12 || 12}:${stored[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export function easternClockForStorage(value) {
  const match = displayClock.exec(String(value ?? '').trim());
  if (!match) return '';
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === 'p' ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${match[2] || '00'}`;
}

// Free-form times may borrow the trailing meridiem. Format only explicit clocks
// or ranges written consistently in 24-hour notation.
const explicitFreeClock = value => displayClock.test(value) || /^(?:0[0-9]|1[3-9]|2[0-4]):/.test(value);
export function formatEasternClockRange(value) {
  const text = String(value ?? '').trim();
  if (explicitFreeClock(text)) {
    const single = formatEasternClock(text);
    if (single) return single;
  }
  const parts = text.split(/\s*(?:\bto\b|[-–—])\s*/i);
  if (parts.length !== 2) return text;
  const legacyRange = parts.every(part => /^\d{2}:/.test(part) && storedClock.test(part)) &&
    parts.some(explicitFreeClock);
  if (!legacyRange && !parts.every(explicitFreeClock)) return text;
  const [start, end] = parts.map(formatEasternClock);
  return start && end ? `${start} to ${end}` : text;
}
