// Calendar dates have no time zone. Only explicit dates with a year are
// reformatted; scheduling notes and unconfirmed dates remain the officer's words.
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const datePattern = /\b(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun),?\s+)?(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+)\d{4})\b/gi;

export function minutesDateParts(value) {
  const text = String(value || '');
  const matches = [...text.matchAll(datePattern)];
  if (matches.length !== 1) return null; // Do not choose between competing dates.
  const match = matches[0];
  const dateText = match[0].replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun),?\s+/i, '');
  let year, month, day;
  if (/^\d{4}-/.test(dateText)) [year, month, day] = dateText.split('-').map(Number);
  else if (/^\d{1,2}\//.test(dateText)) [month, day, year] = dateText.split('/').map(Number);
  else {
    const parts = /^(\w+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(\d{4})$/i.exec(dateText);
    if (!parts) return null;
    year = Number(parts[3]); day = Number(parts[2]);
    month = months.findIndex(name => name.startsWith(parts[1].toLowerCase())) + 1;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || month < 1 || month > 12 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { date, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, prefix: text.slice(0, match.index), suffix: text.slice(match.index + match[0].length) };
}

export function formatMinutesDate(value, empty = '') {
  const text = String(value || '').trim();
  if (!text) return empty;
  const parts = minutesDateParts(text);
  if (!parts) return text;
  const label = new Intl.DateTimeFormat('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'UTC'}).format(parts.date);
  return `${parts.prefix}${label}${parts.suffix}`;
}

export function minutesDateValue(value) {
  const text = String(value || '').trim();
  const parts = minutesDateParts(text);
  return parts && !parts.prefix.trim() && !parts.suffix.trim() ? parts.iso : text;
}

export function replaceMinutesDate(value, iso) {
  const next = minutesDateParts(iso);
  if (!next || next.prefix || next.suffix) return String(value || '');
  const parts = minutesDateParts(value);
  return parts ? `${parts.prefix}${next.iso}${parts.suffix}` : [next.iso, String(value || '').trim()].filter(Boolean).join(' ');
}
