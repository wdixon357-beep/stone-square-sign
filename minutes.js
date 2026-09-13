import { MINUTES_REPORT_RULES } from './report-rules.js';
import { minutesDateParts, minutesDateValue } from './public/minutes-dates.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';
import { CURRENT_OFFICERS, namesMatch } from './minutes-layout.js';
import { organizeMeetingSource } from './minutes-organizer.js';
import { cleanMinutesSectionsForPresentation } from './minutes-format.js';

const nullableText = { type: ['string', 'null'] };

export const MINUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'prayerRequested', 'closingPrayerGiven', 'presiding',
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

export const MINUTES_GENERATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['draft', 'evidence'],
  properties: {
    draft: MINUTES_SCHEMA,
    evidence: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['field', 'quote'],
        properties: {field: {type: 'string'}, quote: {type: 'string'}},
      },
    },
  },
};

const generationInstructions = MINUTES_REPORT_RULES;

const generationError = message => Object.assign(new Error(message), {statusCode: 502});

function validateGeneratedShape(value, schema, path = 'response') {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!allowed.includes(type)) throw generationError(`Minutes generation returned an invalid ${path}. Please try again.`);
  if (schema.enum && !schema.enum.includes(value)) throw generationError(`Minutes generation returned an invalid ${path}. Please try again.`);
  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))
      || schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) {
      throw generationError(`Minutes generation returned an incomplete ${path}. Please try again.`);
    }
    for (const [key, child] of Object.entries(value)) validateGeneratedShape(child, schema.properties[key], `${path}.${key}`);
  } else if (type === 'array') value.forEach((item, index) => validateGeneratedShape(item, schema.items, `${path}[${index}]`));
}

function checkedGeneratedDraft(response, source, localDraft) {
  validateGeneratedShape(response, MINUTES_GENERATION_SCHEMA);
  const {draft: generated, evidence} = response;
  if (generated.income.length || generated.expenses.length || generated.actionItems.length) {
    throw generationError('Minutes generation included unsupported transaction or action tables. Please try again.');
  }
  const requiredFields = new Set();
  for (const field of ['meetingDate', 'degree', 'openingTime', 'closingTime', 'prayerRequested', 'closingPrayerGiven', 'presiding', 'quorum', 'nextMeeting']) {
    if (generated[field] !== null && generated[field] !== '') requiredFields.add(field);
  }
  if (generated.meetingType !== 'Stated Communication') requiredFields.add('meetingType');
  for (const field of ['present', 'excused', 'visitors', 'sensitiveReview']) generated[field].forEach((_, index) => requiredFields.add(`${field}[${index}]`));
  generated.sections.forEach((section, index) => {if (section.body.trim()) requiredFields.add(`sections[${index}].body`);});
  generated.officerAttendance.forEach((entry, index) => {if (entry.status !== 'not_recorded') requiredFields.add(`officerAttendance[${index}].status`);});
  const references = new Map();
  const coverage = new Set();
  for (const item of evidence) {
    const warningReference = /^warnings\[(0|[1-9]\d*)\]$/.exec(item.field);
    const existingWarning = warningReference && Object.hasOwn(generated.warnings, warningReference[1]);
    if ((!requiredFields.has(item.field) && item.field !== 'meetingType' && !existingWarning) || !item.quote.trim() || !source.includes(item.quote)) {
      throw generationError('Minutes generation returned a source reference that could not be verified. Please try again.');
    }
    const entries = references.get(item.field) || [];
    const start = source.indexOf(item.quote);
    const firstLine = source.slice(0, start).split('\n').length;
    const lastLine = firstLine + item.quote.split('\n').length - 1;
    for (let line = firstLine; line <= lastLine; line++) coverage.add(line);
    entries.push({...item, firstLine, lastLine}); references.set(item.field, entries);
  }
  if ([...requiredFields].some(field => !references.has(field))) {
    throw generationError('Minutes generation did not supply source references for all extracted content. Please try again.');
  }
  const warnings = ['Organized with GPT-5.6 Terra; source verification is required.', ...generated.warnings];
  const quotesFor = field => (references.get(field) || []).map(entry => entry.quote).join('\n');
  // Exact quotes alone do not establish that a paraphrase is faithful. Reject
  // these recognizable violations rather than silently publishing bad prose.
  generated.sections.forEach((section, index) => {
    const body = section.body.replace(/<[^>]*>/g, '').replace(/[*_]/g, '');
    const quote = quotesFor(`sections[${index}].body`);
    if (/treasur/i.test(section.heading) && /(?:[$£€]\s*\d|\b\d[\d,.]*\s*(?:dollars?|cents?)\b|\b(?:balance|receipts|disbursements|income|expenses|total)\s*(?:was|were|of|is|:)?\s*\d)/i.test(body)) {
      throw generationError('The generated minutes included treasury figures. The minutes should record the report reading status without amounts. Please try again.');
    }
    const noVote = /\b(?:no vote was taken|no recorded (?:vote|decision)|motion (?:was )?(?:not approved|rejected|defeated))\b/i;
    const approved = /\b(?:(?:motion|proposal|resolution)\s+(?:was\s+)?(?:approved|adopted|passed|carried)|approved unanimously|unanimously approved)\b/i;
    if (noVote.test(quote) && approved.test(body) && !approved.test(quote)) {
      throw generationError('The generated decision conflicts with its source reference. Review the recorded motion outcome and try again.');
    }
  });
  const normalized = normalizeMinutesDraft({...generated, sourceType: localDraft.sourceType, organizerVersion: localDraft.organizerVersion});
  const comparable = value => String(value || '').toLowerCase().replace(/[.\s]/g, '');
  for (const field of ['meetingDate', 'degree', 'openingTime', 'closingTime', 'quorum']) {
    if (!generated[field]) continue;
    if (!normalized[field]) throw generationError(`Minutes generation returned an invalid ${field}. Please try again.`);
    const quoted = organizeMeetingSource(quotesFor(field));
    const known = localDraft[field] || quoted[field];
    if (known && comparable(known) !== comparable(normalized[field])) {
      throw generationError(`Minutes generation disagreed with the source for ${field}. Review the source and try again.`);
    }
    if (field === 'meetingDate' && minutesDateParts(quotesFor(field))?.iso !== normalized.meetingDate) {
      throw generationError('The generated meeting date does not match its source reference. Please try again.');
    }
    if (['openingTime', 'closingTime'].includes(field)
      && !comparable(quotesFor(field)).includes(comparable(normalized[field]))) {
      throw generationError(`The generated ${field} does not match its source reference. Please try again.`);
    }
    if (!known) warnings.push(`Confirm ${field}: the source was cited, but this value needs officer verification.`);
  }
  for (const field of ['prayerRequested', 'closingPrayerGiven']) {
    if (generated[field] === null) continue;
    const quoted = organizeMeetingSource(quotesFor(field));
    const explicitNegative = field === 'prayerRequested'
      ? /\b(?:WM|Worshipful Master)\b[^.!?]*\b(?:did not|never)\b[^.!?]*\b(?:ask|request|direct)\b[^.!?]*\bChaplain\b[^.!?]*\b(?:sick|distress)/i
      : /\bChaplain\b[^.!?]*\b(?:did not|never)\b[^.!?]*\b(?:give|offer|deliver|lead)\b[^.!?]*\bclosing prayer\b/i;
    const supported = generated[field] === true ? quoted[field] === true : explicitNegative.test(quotesFor(field));
    if (!supported) throw generationError(`The cited source does not establish ${field}. Review the source and try again.`);
  }
  const attendanceEstablished = (quote, name, field) => {
    const quoted = organizeMeetingSource(quote);
    if ((quoted[field] || []).some(stated => namesMatch(stated, name))) return true;
    if (!quote.toLowerCase().includes(name.toLowerCase()) || /\b(?:next|previous|last) (?:meeting|year)|\b(?:will|would|should)\b/i.test(quote)) return false;
    const label = {present: /\b(?:was present|were present|in attendance|attended)\b/i, excused: /\bexcused\b/i, absent: /\babsent\b/i, visitors: /\b(?:visitors?|guests?|visiting)\b/i}[field];
    if (field === 'present' && /\b(?:not present|not in attendance|did not attend|absent|excused)\b/i.test(quote)) return false;
    if (field === 'excused' && /\bnot excused\b/i.test(quote) || field === 'absent' && /\bnot absent\b/i.test(quote)) return false;
    return label.test(quote);
  };
  for (const field of ['present', 'excused', 'visitors']) {
    generated[field].forEach((name, index) => {
      const quote = quotesFor(`${field}[${index}]`);
      if (!attendanceEstablished(quote, name, field)) throw generationError(`An extracted ${field} entry is not established by its source reference. Please try again.`);
    });
  }
  for (const [index, entry] of generated.officerAttendance.entries()) {
    if (entry.status === 'not_recorded') continue;
    const quote = quotesFor(`officerAttendance[${index}].status`);
    if (!attendanceEstablished(quote, entry.name, entry.status)) {
      throw generationError('An officer attendance status is not established by its source reference. Please try again.');
    }
  }
  generated.sensitiveReview.forEach((detail, index) => {
    if (!source.includes(detail) || !quotesFor(`sensitiveReview[${index}]`).includes(detail)) {
      throw generationError('A private review detail does not match the source. Please try again.');
    }
  });
  const uncovered = source.split('\n').filter((line, index) => line.trim() && !coverage.has(index + 1)).length;
  if (uncovered) warnings.push(`Source coverage review: ${uncovered} nonempty source ${uncovered === 1 ? 'line is' : 'lines are'} not linked to extracted content. Compare the draft with the original before attestation.`);
  for (const [field, entries] of references) {
    const section = /^sections\[(\d+)\]\.body$/.exec(field);
    const label = section ? generated.sections[Number(section[1])].heading : field;
    const locations = [...new Set(entries.map(entry => entry.firstLine === entry.lastLine ? `line ${entry.firstLine}` : `lines ${entry.firstLine} to ${entry.lastLine}`))];
    warnings.push(`Source reference: ${label}, ${locations.join('; ')}.`);
  }
  normalized.warnings = [...new Set(warnings)];
  return normalized;
}

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

const visitorPlaceholder = value => /^(?:(?:visitors?|guests?)\s*:\s*)?(?:none(?: (?:(?:was|were) )?(?:recorded|reported|present|noted))?|not (?:recorded|reported|applicable)|n[/.]?a|no (?:visitors?|guests?|visiting brothers?)(?: (?:(?:were|are) )?(?:present|recorded|reported|attended))?|no entr(?:y|ies)(?: (?:(?:was|were) )?(?:recorded|reported|noted))?)\.?$/i.test(value);
const normalizeVisitors = value => Array.isArray(value) ? value.map(visitor => String(visitor).trim()).filter(visitor => visitor && !visitorPlaceholder(visitor)) : [];

const cleanSavedSectionBody = (value) => String(value || '').split(/\n+/).filter((line) => (
  /\b(?:grand lodge visitation|official visitation)\b/i.test(line)
  || !/\b(?:grand secretary|grand treasurer|grand lodge officer|district deputy|grand master)\b.*\bpresent as (?:a )?member\b/i.test(line)
)).join('\n').trim();

// Keep the required editor section available without adding a statement about
// anyone's health or changing a signed source snapshot.
const normalizeSections = (value, draft = {}) => {
  const sections = cleanMinutesSectionsForPresentation((Array.isArray(value) ? value : []).map(section => ({
    heading: isSicknessHeading(section?.heading) ? SICKNESS_HEADING
      : String(section?.heading || '').trim().replace(/^Grand Lodge Officers?'? Remarks$/i, 'Communications'),
    body: cleanSavedSectionBody(section?.body),
  })).filter(section => section.heading || section.body), draft);
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
  visitors: normalizeVisitors(value.visitors),
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
  sections: normalizeSections(value.sections, {...value, visitors: normalizeVisitors(value.visitors)}),
  warnings: Array.isArray(value.warnings) ? value.warnings.map(String).filter(Boolean) : [],
  sensitiveReview: Array.isArray(value.sensitiveReview)
    ? value.sensitiveReview.map(String).filter(Boolean) : [],
  actionItems: Array.isArray(value.actionItems) ? value.actionItems.map(String).filter(Boolean) : [],
});

export const generateMinutesDraft = async (transcript, {
  testResponse = process.env.NODE_ENV === 'test' ? process.env.MINUTES_TEST_RESPONSE : '',
  sourceType = 'auto',
  generateStructured,
} = {}) => {
  const source = String(transcript || '').trim();
  if (source.length < 100) throw Object.assign(new Error('The transcript is too short to create reliable minutes.'), { statusCode: 400 });
  if (source.length > 500_000) throw Object.assign(new Error('The transcript is too long. Upload the Plaud text export for one meeting.'), { statusCode: 400 });

  if (testResponse) return normalizeMinutesDraft(JSON.parse(testResponse));
  const localDraft = organizeMeetingSource(source, { sourceType });
  if (typeof generateStructured === 'function') {
    const response = await generateStructured({
      purpose: 'minutes', schemaName: 'stone_square_meeting_minutes', schema: MINUTES_GENERATION_SCHEMA,
      instructions: generationInstructions,
      input: JSON.stringify({sourceType: localDraft.sourceType, officerRoster: CURRENT_OFFICERS, source}),
    });
    return checkedGeneratedDraft(response, source, localDraft);
  }
  return normalizeMinutesDraft(localDraft);
};
