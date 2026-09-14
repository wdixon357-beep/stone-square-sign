import { validDate, emptyAccount } from './treasury.js';

const iso = date => date.toISOString().slice(0, 10);
const atNoon = value => new Date(`${value}T12:00:00Z`);
export const addDays = (value, days) => {
  const date = atNoon(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
};

export function statedMeetingDates(year) {
  const dates = [];
  for (const month of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) {
    const first = new Date(Date.UTC(year, month - 1, 1, 12));
    const firstThursday = 1 + ((4 - first.getUTCDay() + 7) % 7);
    for (const day of [firstThursday, firstThursday + 14]) dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return dates;
}

export function easternDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function treasuryMeetingCycle(reference = easternDate()) {
  if (!validDate(reference)) throw new TypeError('A valid reference date is required.');
  const year = Number(reference.slice(0, 4));
  const dates = [year - 1, year, year + 1].flatMap(statedMeetingDates).sort();
  const upcomingMeeting = dates.find(date => date >= reference);
  const previousMeeting = dates[dates.indexOf(upcomingMeeting) - 1];
  return { previousMeeting, periodStart: addDays(previousMeeting, 1), periodEnd: upcomingMeeting };
}

export function treasuryCycleEnding(periodEnd) {
  if (!validDate(periodEnd)) return null;
  const year = Number(periodEnd.slice(0, 4));
  const dates = [year - 1, year, year + 1].flatMap(statedMeetingDates).sort();
  const index = dates.indexOf(periodEnd);
  if (index < 1) return null;
  return { previousMeeting: dates[index - 1], periodStart: addDays(dates[index - 1], 1), periodEnd };
}

export function applyTreasuryMeetingCycle(input, cycle, { excludeUncertain = true } = {}) {
  const draft = structuredClone(input);
  const sourceWindowMismatch = Boolean(draft.periodStart && draft.periodEnd && (draft.periodStart !== cycle.periodStart || draft.periodEnd !== cycle.periodEnd));
  draft.previousMeetingDate = cycle.previousMeeting;
  draft.periodStart = cycle.periodStart;
  draft.periodEnd = cycle.periodEnd;
  draft.accounts = [...(draft.accounts || [])];
  if(!draft.accounts.some(account=>account.id==='checking'))draft.accounts.unshift(emptyAccount());
  if(!draft.accounts.some(account=>account.id==='savings'))draft.accounts.push(emptyAccount('savings','Savings'));
  const excluded = [];
  draft.transactions = (draft.transactions || []).filter(transaction => {
    const inWindow = transaction.date && transaction.date >= cycle.periodStart && transaction.date <= cycle.periodEnd;
    if (!inWindow && excludeUncertain) excluded.push(transaction.date || 'date unavailable');
    return inWindow || !excludeUncertain;
  });
  draft.extractionNotes = [...(draft.extractionNotes || [])].filter(note => !/^Reporting window fixed|^\d+ source entr(?:y|ies)/i.test(note));
  draft.extractionNotes.push(`Reporting window fixed by the Lodge schedule: posted activity after ${cycle.previousMeeting} through ${cycle.periodEnd}.`);
  if (excluded.length) draft.extractionNotes.push(`${excluded.length} source ${excluded.length === 1 ? 'entry was' : 'entries were'} kept in the original banking records but excluded from report activity because the posted date was outside the reporting window or unavailable.`);
  if (excluded.length || sourceWindowMismatch) {
    const boundaryFields = ['openingBalance','statementBalance','bookBalance','receipts','disbursements','transfersIn','transfersOut','depositsInTransit','outstandingChecks','bankHold'];
    draft.accounts = (draft.accounts || []).map(account => ({ ...account, activityComplete:false, ...Object.fromEntries(boundaryFields.map(field => [field,null])) }));
    draft.extractionNotes.push('Statement-period balances and totals were not used as meeting-cycle balances. Confirm each account at the reporting boundaries before signing.');
  }
  return draft;
}
