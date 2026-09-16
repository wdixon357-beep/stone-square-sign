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

export function treasuryMeetingCycle(reference = easternDate(), previousReportEnd = '') {
  if (!validDate(reference)) throw new TypeError('A valid reference date is required.');
  const year = Number(reference.slice(0, 4));
  const dates = [year - 1, year, year + 1].flatMap(statedMeetingDates).sort();
  const previousMeeting = dates.filter(date => date < reference).at(-1);
  const previousCutoff = validDate(previousReportEnd) && previousReportEnd < reference ? previousReportEnd : previousMeeting;
  return { previousMeeting: previousCutoff, periodStart: addDays(previousCutoff, 1), periodEnd: reference };
}

export function treasuryReportingWindow(reference = easternDate(), finalizedReportEnds = []) {
  if (!validDate(reference)) throw new TypeError('A valid reference date is required.');
  const previousReportEnd = finalizedReportEnds.filter(value => validDate(value) && value < reference).sort().at(-1) || '';
  return treasuryMeetingCycle(reference, previousReportEnd);
}

export function treasuryWindowForDraft(draft) {
  if (!validDate(draft?.periodStart) || !validDate(draft?.periodEnd)) return null;
  const previousCutoff = validDate(draft.previousMeetingDate) ? draft.previousMeetingDate : addDays(draft.periodStart, -1);
  return { previousMeeting: previousCutoff, periodStart: draft.periodStart, periodEnd: draft.periodEnd };
}

export function applyTreasuryMeetingCycle(input, cycle, { excludeUncertain = true, validatedWindowFields = [] } = {}) {
  const draft = structuredClone(input);
  const sourceWindowMatches = draft.periodStart === cycle.periodStart && draft.periodEnd === cycle.periodEnd;
  const validated = new Set(validatedWindowFields);
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
  draft.extractionNotes.push(`Reporting window fixed by the Lodge: posted activity from ${cycle.periodStart} through ${cycle.periodEnd}.`);
  if (excluded.length) draft.extractionNotes.push(`${excluded.length} source ${excluded.length === 1 ? 'entry was' : 'entries were'} kept in the original banking records but excluded from report activity because the posted date was outside the reporting window or unavailable.`);
  if (!sourceWindowMatches) {
    const boundaryFields = ['openingBalance','statementBalance','bookBalance','receipts','disbursements','transfersIn','transfersOut','depositsInTransit','outstandingChecks','bankHold'];
    draft.accounts = (draft.accounts || []).map((account, index) => ({
      ...account,
      activityComplete:false,
      ...Object.fromEntries(boundaryFields.map(field => [field, validated.has(`accounts.${index}.${field}`) ? account[field] : null])),
    }));
    draft.extractionNotes.push(validated.size
      ? 'Only balances and totals with source evidence at the fixed reporting boundaries were retained. Confirm unresolved account fields before signing.'
      : 'Full-statement balances and totals were not used as reporting-window balances. Confirm each account at the reporting boundaries before signing.');
  } else if (excluded.length) {
    draft.accounts = (draft.accounts || []).map(account => ({ ...account, activityComplete:false }));
    draft.extractionNotes.push('Figures retained in the report were individually matched to the fixed reporting window. Confirm that the included activity is complete before signing.');
  }
  return draft;
}
