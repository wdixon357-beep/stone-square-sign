import { formatEasternClock } from './eastern-time.js';
import {formatMinutesDate, minutesDateParts} from './minutes-dates.js';

export const MINUTES_MEETING_DETAILS_FIELDS = ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'presiding', 'quorum', 'nextMeeting'];
const degrees = ['First Degree', 'Second Degree', 'Third Degree', 'Round Table'];
const clean = value => typeof value === 'string' ? value.trim() : '';
const exactDate = value => {
  const parts = minutesDateParts(clean(value));
  return parts && !parts.prefix.trim() && !parts.suffix.trim() ? parts.iso : null;
};
export const hasExplicitMinutesTime = value => /^(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)$/i.test(clean(value))
  || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clean(value));

export const formatMinutesClock = value => hasExplicitMinutesTime(value) ? formatEasternClock(value) : clean(value);

// These are the preparing officer's explicitly entered meeting facts. They are
// not transcript citations and never establish attendance, motions or approval.
export function minutesMeetingDetailsIssues(value = {}) {
  const details = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return [
    !exactDate(details.meetingDate) && 'Enter the meeting date, including the year.',
    (!clean(details.meetingType) || clean(details.meetingType).length > 100) && 'Select the meeting type or enter its name.',
    !degrees.includes(clean(details.degree)) && 'Select the degree.',
    !hasExplicitMinutesTime(details.openingTime) && 'Enter the opening time in Eastern Time with AM or PM.',
    !hasExplicitMinutesTime(details.closingTime) && 'Enter the closing time in Eastern Time with AM or PM.',
    (!clean(details.presiding) || clean(details.presiding).length > 160) && 'Enter the presiding officer.',
    !['Yes', 'No'].includes(clean(details.quorum)) && 'Select Yes or No for quorum.',
    !exactDate(details.nextMeeting) && 'Enter the next meeting date, including the year.',
  ].filter(Boolean);
}

export function normalizeMinutesMeetingDetails(value = {}) {
  const details = Object.fromEntries(MINUTES_MEETING_DETAILS_FIELDS.map(field => [field, clean(value?.[field])]));
  return {...details, meetingDate: exactDate(details.meetingDate), nextMeeting: exactDate(details.nextMeeting)};
}

// Recognize explicit field labels only. These are suggestions from the supplied
// notes and carry no independent verification or attestation.
export function suggestMinutesDetailsFromNotes(notes) {
  const fields = new Map([
    ['meeting date', ['meetingDate', exactDate]],
    ['meeting type', ['meetingType', value => value.length <= 100 ? value : null]],
    ['degree', ['degree', value => degrees.find(degree => degree.toLowerCase() === value.toLowerCase())]],
    ['opening time', ['openingTime', value => hasExplicitMinutesTime(value) ? formatMinutesClock(value) : null]],
    ['closing time', ['closingTime', value => hasExplicitMinutesTime(value) ? formatMinutesClock(value) : null]],
    ['presiding officer', ['presiding', value => value.length <= 160 ? value : null]],
    ['quorum', ['quorum', value => ['Yes', 'No'].find(answer => answer.toLowerCase() === value.toLowerCase())]],
    ['next meeting date', ['nextMeeting', exactDate]],
  ]);
  const candidates = new Map();
  for (const line of String(notes || '').split(/\r?\n/)) {
    const pair = /^\s*([a-z ]+)\s*:\s*(.*?)\s*$/i.exec(line);
    const field = pair && fields.get(pair[1].trim().toLowerCase());
    if (!field) continue;
    const [key, validate] = field;
    const value = pair[2];
    const uncertain = !value || /[?\[\]]|\b(?:tbd|unknown|unconfirmed|unclear|pending|verify|confirm|not recorded|not stated)\b/i.test(value);
    let candidate = uncertain ? null : validate(value) || null;
    if (candidate && (key === 'meetingDate' || key === 'nextMeeting')) {
      const weekday = /^([a-z]{3,9}),?\s/i.exec(value)?.[1];
      if (weekday && !formatMinutesDate(candidate).toLowerCase().startsWith(weekday.toLowerCase())) {
        // Month names can occur at the beginning of a date without a weekday.
        if (/^(?:mon|tue|wed|thu|fri|sat|sun)/i.test(weekday)) candidate = null;
      }
    }
    if (!candidates.has(key)) candidates.set(key, candidate);
    else if (candidates.get(key) !== candidate) candidates.set(key, null);
  }
  return Object.fromEntries([...candidates].filter(([, value]) => value !== null));
}
