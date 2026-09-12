import { minutesDateValue } from './public/minutes-dates.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';
import { CURRENT_OFFICERS } from './minutes-layout.js';
import { organizeMeetingSource } from './minutes-organizer.js';

const nullableText = { type: ['string', 'null'] };

export const MINUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'presiding',
    'quorum', 'nextMeeting', 'present', 'excused', 'visitors', 'officerAttendance',
    'income', 'expenses', 'sections', 'warnings', 'sensitiveReview', 'actionItems'],
  properties: {
    meetingDate: nullableText,
    meetingType: { type: 'string' },
    degree: nullableText,
    openingTime: nullableText,
    closingTime: nullableText,
    prayerRequested: { type: ['boolean', 'null'] },
    closingPrayerGiven: { type: ['boolean', 'null'] },
    presiding: nullableText,
    quorum: nullableText,
    nextMeeting: nullableText,
    present: { type: 'array', items: { type: 'string' } },
    excused: { type: 'array', items: { type: 'string' } },
    visitors: { type: 'array', items: { type: 'string' } },
    officerAttendance: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'title', 'status'],
        properties: {
          name: { type: 'string' }, title: { type: 'string' },
          status: { type: 'string', enum: ['present', 'absent', 'excused', 'not_recorded'] },
        },
      },
    },
    income: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['date', 'reference', 'party', 'description', 'amount'],
        properties: {
          date: nullableText, reference: nullableText, party: nullableText,
          description: nullableText, amount: nullableText,
        },
      },
    },
    expenses: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['date', 'reference', 'party', 'description', 'amount'],
        properties: {
          date: nullableText, reference: nullableText, party: nullableText,
          description: nullableText, amount: nullableText,
        },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    sensitiveReview: { type: 'array', items: { type: 'string' } },
    actionItems: { type: 'array', items: { type: 'string' } },
  },
};

const canonicalDegree = (value) => {
  const degree = String(value || '').trim();
  if (/^(?:first degree|entered apprentice(?: degree)?)$/i.test(degree)) return 'First Degree';
  if (/^(?:second degree|fellow ?craft(?: degree)?)$/i.test(degree)) return 'Second Degree';
  if (/^(?:third degree(?: of masonry)?|master mason(?: degree)?)$/i.test(degree)) return 'Third Degree';
  if (/^round[ -]?table$/i.test(degree)) return 'Round Table';
  return null;
};

const canonicalQuorum = (value) => {
  const quorum = String(value || '').trim();
  if (/^(?:yes|present|established|quorum present|quorum established)$/i.test(quorum)) return 'Yes';
  if (/^(?:no|no quorum|not present|not established)$/i.test(quorum)) return 'No';
  return null;
};

const cleanSavedSectionBody = (value) => String(value || '').split(/\n+/).filter((line) => (
  /\b(?:grand lodge visitation|official visitation)\b/i.test(line)
  || !/\b(?:grand secretary|grand treasurer|grand lodge officer|district deputy|grand master)\b.*\bpresent as (?:a )?member\b/i.test(line)
)).join('\n').trim();

// Keep the required editor section available without adding a statement about
// anyone's health or changing a signed source snapshot.
const normalizeSections = (value) => {
  const sections = (Array.isArray(value) ? value : []).map(section => ({
    heading: isSicknessHeading(section?.heading) ? SICKNESS_HEADING
      : String(section?.heading || '').trim().replace(/^Grand Lodge Officers?'? Remarks$/i, 'Communications'),
    body: cleanSavedSectionBody(section?.body),
  })).filter(section => section.heading || section.body);
  const sickness = sections.filter(section => section.heading === SICKNESS_HEADING);
  if (sickness.length) {
    sickness[0].body = sickness.map(section => section.body).filter(Boolean).join('\n');
    return sections.filter(section => section.heading !== SICKNESS_HEADING || section === sickness[0]);
  }
  const rollCall = sections.findIndex(section => /^roll call(?: and quorum)?$/i.test(section.heading));
  const minutes = sections.findIndex(section => /^(?:reading|approval) of (?:the )?minutes$/i.test(section.heading));
  const opening = sections.findIndex(section => /^opening$/i.test(section.heading));
  const insertAt = rollCall >= 0 ? rollCall + 1 : minutes >= 0 ? minutes : opening >= 0 ? opening + 1 : 0;
  sections.splice(insertAt, 0, {heading: SICKNESS_HEADING, body: ''});
  return sections;
};

export const normalizeMinutesDraft = (value = {}) => ({
  organizerVersion: value.organizerVersion || 1,
  sourceType: value.sourceType === 'compiled_notes' ? 'compiled_notes' : 'transcript',
  meetingDate: minutesDateValue(value.meetingDate) || null,
  meetingType: /^(?:regular )?stated communication$/i.test(String(value.meetingType || ''))
    ? 'Stated Communication' : String(value.meetingType || 'Stated Communication').trim(),
  degree: canonicalDegree(value.degree),
  openingTime: value.openingTime ? String(value.openingTime).trim() : null,
  closingTime: value.closingTime ? String(value.closingTime).trim() : null,
  prayerRequested: typeof value.prayerRequested === 'boolean' ? value.prayerRequested : null,
  closingPrayerGiven: typeof value.closingPrayerGiven === 'boolean' ? value.closingPrayerGiven : null,
  presiding: value.presiding ? String(value.presiding).trim() : null,
  quorum: canonicalQuorum(value.quorum),
  nextMeeting: value.nextMeeting ? String(value.nextMeeting).trim() : null,
  present: Array.isArray(value.present) ? value.present.map(String).filter(Boolean) : [],
  excused: Array.isArray(value.excused) ? value.excused.map(String).filter(Boolean) : [],
  visitors: Array.isArray(value.visitors) ? value.visitors.map(String).filter(Boolean) : [],
  officerAttendance: Array.isArray(value.officerAttendance) && value.officerAttendance.length
    ? value.officerAttendance.map((entry) => ({
    name: String(entry?.name || '').trim(),
    title: String(entry?.title || '').trim(),
    status: ['present', 'absent', 'excused', 'not_recorded'].includes(entry?.status)
      ? entry.status : 'not_recorded',
    })).filter((entry) => entry.name)
    : CURRENT_OFFICERS.map((officer) => ({ ...officer, status: 'not_recorded' })),
  income: Array.isArray(value.income) ? value.income.map((entry) => ({
    date: entry?.date ? String(entry.date).trim() : null,
    reference: entry?.reference ? String(entry.reference).trim() : null,
    party: entry?.party ? String(entry.party).trim() : null,
    description: entry?.description ? String(entry.description).trim() : null,
    amount: entry?.amount ? String(entry.amount).trim() : null,
  })) : [],
  expenses: Array.isArray(value.expenses) ? value.expenses.map((entry) => ({
    date: entry?.date ? String(entry.date).trim() : null,
    reference: entry?.reference ? String(entry.reference).trim() : null,
    party: entry?.party ? String(entry.party).trim() : null,
    description: entry?.description ? String(entry.description).trim() : null,
    amount: entry?.amount ? String(entry.amount).trim() : null,
  })) : [],
  sections: normalizeSections(value.sections),
  warnings: Array.isArray(value.warnings) ? value.warnings.map(String).filter(Boolean) : [],
  sensitiveReview: Array.isArray(value.sensitiveReview)
    ? value.sensitiveReview.map(String).filter(Boolean) : [],
  actionItems: Array.isArray(value.actionItems) ? value.actionItems.map(String).filter(Boolean) : [],
});

export const generateMinutesDraft = async (transcript, {
  testResponse = process.env.NODE_ENV === 'test' ? process.env.MINUTES_TEST_RESPONSE : '',
  sourceType = 'auto',
} = {}) => {
  const source = String(transcript || '').trim();
  if (source.length < 100) throw Object.assign(new Error('The transcript is too short to create reliable minutes.'), { statusCode: 400 });
  if (source.length > 500_000) throw Object.assign(new Error('The transcript is too long. Upload the Plaud text export for one meeting.'), { statusCode: 400 });

  if (testResponse) return normalizeMinutesDraft(JSON.parse(testResponse));
  return normalizeMinutesDraft(organizeMeetingSource(source, { sourceType }));
};
