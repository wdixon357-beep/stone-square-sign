import {minutesDateParts} from './minutes-dates.js';

export const MINUTES_MEETING_DETAILS_FIELDS = ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'presiding', 'quorum', 'nextMeeting'];
const degrees = ['First Degree', 'Second Degree', 'Third Degree', 'Round Table'];
const clean = value => typeof value === 'string' ? value.trim() : '';
const exactDate = value => {
  const parts = minutesDateParts(clean(value));
  return parts && !parts.prefix.trim() && !parts.suffix.trim() ? parts.iso : null;
};
export const hasExplicitMinutesTime = value => /^(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)$/i.test(clean(value))
  || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clean(value));

// These are the preparing officer's explicitly entered meeting facts. They are
// not transcript citations and never establish attendance, motions or approval.
export function minutesMeetingDetailsIssues(value = {}) {
  const details = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return [
    !exactDate(details.meetingDate) && 'Enter the meeting date, including the year.',
    (!clean(details.meetingType) || clean(details.meetingType).length > 100) && 'Select the meeting type or enter its name.',
    !degrees.includes(clean(details.degree)) && 'Select the degree.',
    !hasExplicitMinutesTime(details.openingTime) && 'Enter the opening time with AM/PM or in 24-hour HH:mm format.',
    !hasExplicitMinutesTime(details.closingTime) && 'Enter the closing time with AM/PM or in 24-hour HH:mm format.',
    (!clean(details.presiding) || clean(details.presiding).length > 160) && 'Enter the presiding officer.',
    !['Yes', 'No'].includes(clean(details.quorum)) && 'Select Yes or No for quorum.',
    !exactDate(details.nextMeeting) && 'Enter the next meeting date, including the year.',
  ].filter(Boolean);
}

export function normalizeMinutesMeetingDetails(value = {}) {
  const details = Object.fromEntries(MINUTES_MEETING_DETAILS_FIELDS.map(field => [field, clean(value?.[field])]));
  return {...details, meetingDate: exactDate(details.meetingDate), nextMeeting: exactDate(details.nextMeeting)};
}
