import { currentMinutesEditorialDraft } from './minutes-editorial.js';
import { MINUTES_REPORT_RULES } from './report-rules.js';
import { minutesDateParts, minutesDateValue } from './public/minutes-dates.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';
import { CURRENT_OFFICERS, namesMatch } from './minutes-layout.js';
import { organizeMeetingSource, extractOfficerCoverage, officerNameMatches } from './minutes-organizer.js';
import { normalizeOfficerCoverage, sameAttendancePerson } from './public/minutes-attendance.js';
import { cleanMinutesSectionsForPresentation, detectPrayerFacts, UNCITED_PRESIDING_WARNING } from './minutes-format.js';
import {MINUTES_MEETING_DETAILS_FIELDS, minutesMeetingDetailsIssues, normalizeMinutesMeetingDetails} from './public/minutes-meeting-details.js';

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
        type: 'object', additionalProperties: false, required: ['name', 'title', 'status', 'stationCoverage', 'actingName', 'actingWholeMeeting'],
        properties: {
          name: { type: 'string', minLength: 1 }, title: { type: 'string' },
          status: { type: 'string', enum: ['present', 'absent', 'excused', 'arrived_late', 'not_recorded'] },
          stationCoverage: { type: ['string', 'null'], enum: ['filled', 'vacant', null] },
          actingName: nullableText, actingWholeMeeting: { type: ['boolean', 'null'] },
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
    // Evidence stays beside the section it supports. The saved/public draft
    // contract remains heading/body only; this is the provider wire contract.
    draft: {...MINUTES_SCHEMA, properties: {...MINUTES_SCHEMA.properties,
      // These tables are forbidden in new minutes. Constrain the provider
      // contract without altering saved drafts or discarding returned facts.
      // The changed schema also separates this request from legacy cached output.
      income: {...MINUTES_SCHEMA.properties.income, maxItems: 0},
      expenses: {...MINUTES_SCHEMA.properties.expenses, maxItems: 0},
      actionItems: {...MINUTES_SCHEMA.properties.actionItems, maxItems: 0},
      sections: {type:'array', items:{type:'object', additionalProperties:false,
        required:['heading','body','sourceLineIds'], properties:{
          ...MINUTES_SCHEMA.properties.sections.items.properties,
          sourceLineIds:{type:'array',items:{type:'integer',minimum:1}},
        }}},
    }},
    evidence: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['field', 'sourceLineIds'],
        properties: {field: {type: 'string'}, sourceLineIds: {type:'array',items:{type:'integer',minimum:1}}},
      },
    },
  },
};

const generationInstructions = MINUTES_REPORT_RULES;

const generationError = (message, code = 'MINUTES_SOURCE_VERIFICATION_FAILED') => Object.assign(new Error(message), {statusCode: 502, code});
const otherAttendanceNames = (list, officerAttendance, attendanceVersion) => list.filter((name) => (
  !officerAttendance.some((officer) => attendanceVersion < 2 ? namesMatch(name, officer.name)
    : officerNameMatches(name, officer) || officer.actingName && sameAttendancePerson(name, officer.actingName))
));


// The model selects immutable source positions; it never retypes evidence.
// Keep blank lines and original characters so IDs remain stable and repeated
// text at different positions cannot be credited to the wrong occurrence.
export const minutesSourceLines = source => {
  if (typeof source !== 'string') throw new TypeError('Minutes source must be text.');
  return source.split('\n').map((text, index) => ({line:index + 1, text}));
};

export const minutesGenerationSchemaForLineCount = lineCount => {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new RangeError('A positive source line count is required.');
  const schema = structuredClone(MINUTES_GENERATION_SCHEMA);
  schema.properties.draft.properties.sections.items.properties.sourceLineIds.items.maximum = lineCount;
  schema.properties.evidence.items.properties.sourceLineIds.items.maximum = lineCount;
  return schema;
};

const resolveSourceCatalogLineIds = (lines, ids) => {
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > lines.length)) {
    throw new RangeError('Source line references must identify existing lines.');
  }
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  const groups = [];
  for (const id of sorted) {
    const last = groups.at(-1);
    if (last && id === last.lastLine + 1) last.lastLine = id;
    else groups.push({firstLine:id,lastLine:id});
  }
  return groups.map(({firstLine,lastLine}) => {
    const quote = lines.slice(firstLine - 1,lastLine).map(line => line.text).join('\n');
    if (!quote.trim()) throw new RangeError('Source line references must include recorded source text.');
    return {quote,firstLine,lastLine};
  });
};

export const resolveMinutesSourceLineIds = (source, ids) => resolveSourceCatalogLineIds(minutesSourceLines(source), ids);

function validateGeneratedShape(value, schema, path = 'response') {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  const integer = type === 'number' && allowed.includes('integer') && Number.isSafeInteger(value);
  if (!allowed.includes(type) && !integer) throw generationError(`Minutes generation returned an invalid ${path}. Please try again.`);
  if (type === 'number' && (!Number.isFinite(value) || schema.minimum != null && value < schema.minimum
    || schema.maximum != null && value > schema.maximum)) throw generationError(`Minutes generation returned an invalid ${path}. Please try again.`);
  if (schema.enum && !schema.enum.includes(value)) throw generationError(`Minutes generation returned an invalid ${path}. Please try again.`);
  if (type === 'string' && schema.minLength != null && [...value].length < schema.minLength) {
    throw generationError(`Minutes generation returned an invalid ${path}. Please try again.`);
  }
  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))
      || schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) {
      throw generationError(`Minutes generation returned an incomplete ${path}. Please try again.`);
    }
    for (const [key, child] of Object.entries(value)) validateGeneratedShape(child, schema.properties[key], `${path}.${key}`);
  } else if (type === 'array') value.forEach((item, index) => validateGeneratedShape(item, schema.items, `${path}[${index}]`));
}

// A statement that a procedural detail is missing is not a claim that the
// procedure occurred. Mask only bounded omission grammar, never an entire
// section, so a nearby affirmative assertion still needs its own evidence.
function proceduralClaims(value) {
  const field = String.raw`(?:(?:named|recorded)\s+)?(?:mover|seconder|second|vote(?:\s+(?:method|tally|count|result|outcome))?|tally|count|result|outcome|approval|rejection|tabling|withdrawal|unanimity|unanimous(?:\s+vote)?)`;
  const item = String.raw`(?:(?:the|a|an|any|its)\s+)?${field}`;
  const fields = String.raw`${item}(?:\s*(?:,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)${item})*`;
  const unknown = String.raw`(?:not\s+(?:recorded|identified|named|specified|provided|stated|known|confirmed|established|clear)|unrecorded|unidentified|unknown|unconfirmed|unclear)`;
  const omission = String.raw`\b(?:(?:the|this)\s+)?(?:source|record|transcript|notes|minutes|excerpt|summary|it)\s+(?:(?:does|do|did)\s+not|doesn't|don't|didn't)\s+(?:identify|name|record|specify|state|include|provide|establish|confirm|indicate)`;
  const subject = String.raw`(?:(?:the|a)\s+)?(?:(?!(?:but|and|or|however)\b)[a-z][a-z'-]*\s+){0,6}?(?:motion|proposal|resolution|vote)`;
  const verb = String.raw`(?:unanimously\s+(?:approved|adopted|passed|carried)|(?:seconded|approved|adopted|passed|carried|rejected|defeated|failed|tabled|withdrawn)(?:\s+unanimously)?|unanimous)\b`;
  const verbs = String.raw`${verb}(?:\s*(?:,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)${verb})*`;
  const action = String.raw`${subject}\s+(?:(?:was|were|is|had been|has been)\s+)?(?:properly\s+)?${verbs}`;
  return String(value || '').replace(/[’]/g, "'")
    .replace(new RegExp(String.raw`\bneither\s+${item}(?:\s*,\s*${item})*\s+nor\s+${item}\s+(?:was|were|is|are)\s+(?:recorded|identified|named|specified|provided|stated|confirmed|established)\b`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\b(?:(?:it|this)\s+(?:is|was|remains?)\s+)?(?:unknown|unclear|unconfirmed|not clear)\s+(?:whether|if)\s+${action}`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\b(?:whether|if)\s+${action}\s+(?:(?:was|were|is|are|remains?)\s+)?${unknown}\b`, 'gi'), ' ')
    .replace(new RegExp(String.raw`${omission}\s+(?:(?:whether|if)\s+${action}|who\s+(?:moved|seconded)|${fields})`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\b${fields}\s+(?:(?:was|were|is|are|remains?|has been|have been)\s+)?${unknown}\b`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\bno\s+${field}\s+(?:(?:was|were|is|are|has been|have been)\s+)?(?:recorded|identified|named|specified|provided|stated|confirmed|established)\b`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\b(?:${field}|seconded(?:\s+by)?)\s*:\s*${unknown}\b`, 'gi'), ' ')
    // Neither/nor describes explicit non-occurrence, not a missing detail.
    // Expand only procedural verbs so each negative claim still needs evidence.
    .replace(new RegExp(String.raw`\bneither\s+${verb}(?:\s*(?:,\s*(?:nor\s+)?|\s+nor\s+)${verb})+`, 'gi'),
      clause => (clause.match(new RegExp(verb, 'gi')) || []).map(action => `not ${action}`).join(' '));
}
const withoutNegatedFact = (text, pattern) => pattern ? text.replace(new RegExp(pattern.source, 'gi'), ' ') : text;
const negatedProcedure = (verbs, extra = '') => new RegExp(String.raw`\b(?:(?:not|never|wasn't|isn't|weren't)\s+(?:yet\s+)?(?:been\s+)?(?:properly\s+)?(?:unanimously\s+)?(?:${verbs})|(?:no one|nobody|no brother|no member|no person)\s+(?:${verbs})${extra ? `|${extra}` : ''})\b`, 'i');


function checkedGeneratedDraft(response, source, localDraft, schema, sourceLines) {
  const sectionEvidenceError = () => generationError('The meeting section source references are incomplete or invalid. Your source has not been changed.', 'MINUTES_SECTION_EVIDENCE_INVALID');
  // Never guess positions for an older free-quotation or parallel-index
  // contract. Its audited cache remains intact; an explicit new request uses
  // the changed schema/input hash and selects source lines directly.
  if (Array.isArray(response?.draft?.sections) && response.draft.sections.some(section => section && Object.hasOwn(section,'sourceQuotes'))
    || Array.isArray(response?.evidence) && response.evidence.some(item => item && Object.hasOwn(item,'quote'))) {
    throw generationError('Minutes generation returned an older source-reference format. Your source has not been changed. Request a new organization of these minutes.',
      'MINUTES_SOURCE_LINE_CONTRACT_REQUIRED');
  }
  if (Array.isArray(response?.draft?.sections) && response.draft.sections.some(section =>
    section && typeof section === 'object' && !Array.isArray(section.sourceLineIds))) throw sectionEvidenceError();
  validateGeneratedShape(response, schema);
  if (response.evidence.some(item => /^sections(?:\[|\.|$)/.test(item.field))) throw sectionEvidenceError();
  const evidence = structuredClone(response.evidence);
  const generated = structuredClone(response.draft);
  generated.sections = generated.sections.map((section, index) => {
    const {heading, body, sourceLineIds} = section;
    if (body.trim() ? !sourceLineIds.length : sourceLineIds.length) throw sectionEvidenceError();
    if (sourceLineIds.length) evidence.push({field:`sections[${index}].body`,sourceLineIds});
    return {heading,body};
  });
  // Retain this nullable wire field for older provider schemas only. It is no
  // longer a recorded fact or a preparer confirmation in new minutes.
  generated.prayerRequested = null;
  const warnings = ['Organized with GPT-5.6 Luna; source verification is required.', ...generated.warnings];
  if (generated.officerAttendance.some(entry => !entry.name.trim())) {
    throw generationError('Minutes generation returned an invalid officer attendance name. Please try again.');
  }
  if (generated.income.length || generated.expenses.length || generated.actionItems.length) {
    throw generationError('Minutes generation included unsupported transaction or action tables. Please try again.');
  }
  // Missing evidence must not leave an invented presiding officer in an
  // otherwise sourced draft or force an identical cached response to fail.
  // Retain a persistent reminder that blocks attestation until it is entered.
  // A supplied but invalid citation still fails the strict checks below.
  if (generated.presiding?.trim() && !evidence.some(item => item.field === 'presiding')) {
    generated.presiding = null;
    warnings.push(UNCITED_PRESIDING_WARNING);
  }
  const requiredFields = new Set();
  for (const field of ['meetingDate', 'degree', 'openingTime', 'closingTime', 'closingPrayerGiven', 'presiding', 'quorum', 'nextMeeting']) {
    if (generated[field] !== null && generated[field] !== '') requiredFields.add(field);
  }
  if (generated.meetingType !== 'Stated Communication') requiredFields.add('meetingType');
  for (const field of ['present', 'excused', 'visitors', 'sensitiveReview']) generated[field].forEach((_, index) => requiredFields.add(`${field}[${index}]`));
  generated.sections.forEach((section, index) => {if (section.body.trim()) requiredFields.add(`sections[${index}].body`);});
  generated.officerAttendance.forEach((entry, index) => {
    if (entry.status !== 'not_recorded') requiredFields.add(`officerAttendance[${index}].status`);
    for (const field of ['stationCoverage', 'actingName', 'actingWholeMeeting']) {
      if (entry[field] !== null && entry[field] !== '') requiredFields.add(`officerAttendance[${index}].${field}`);
    }
  });
  const references = new Map();
  for (const item of evidence) {
    // An obsolete field supports no displayed fact and must not count toward
    // source coverage or block a draft. All recorded facts still need evidence.
    if (item.field === 'prayerRequested') continue;
    // The unchanged default is allowed without a source fact. Provider input
    // metadata is not a citation and must never count as source coverage.
    if (item.field === 'meetingType' && generated.meetingType === 'Stated Communication'
      && localDraft.meetingType === 'Stated Communication') continue;
    const unrecordedOfficer = /^officerAttendance\[(0|[1-9]\d*)\]\.status$/.exec(item.field);
    if (unrecordedOfficer && generated.officerAttendance[Number(unrecordedOfficer[1])]?.status === 'not_recorded') {
      // The model sometimes cites an officer whose attendance it explicitly left
      // unknown. That citation supports no recorded fact and must not count as
      // verified source coverage or make an otherwise usable draft fail.
      continue;
    }
    const warningReference = /^warnings\[(0|[1-9]\d*)\]$/.exec(item.field);
    const existingWarning = warningReference && Object.hasOwn(generated.warnings, warningReference[1]);
    const allowedField = requiredFields.has(item.field) || item.field === 'meetingType' || existingWarning;
    let spans = [];
    if (allowedField) {
      try { spans = resolveSourceCatalogLineIds(sourceLines,item.sourceLineIds); } catch { /* Fail closed below without logging source text. */ }
    }
    if (!allowedField || !spans.length) {
      console.warn('Minutes source reference rejected:', !allowedField ? 'invalid_field' : 'invalid_source_lines', allowedField ? item.field : 'unsupported');
      throw generationError('Minutes generation returned a source reference that could not be verified. Please try again.',
        /^sections\[/.test(item.field) ? 'MINUTES_SECTION_EVIDENCE_INVALID' : 'MINUTES_SOURCE_VERIFICATION_FAILED');
    }
    const entries = references.get(item.field) || [];
    entries.push(...spans.map(span => ({field:item.field,...span}))); references.set(item.field, entries);
  }
  if ([...requiredFields].some(field => !references.has(field))) {
    throw generationError('Minutes generation did not supply source references for all extracted content. Please try again.');
  }
  const quotesFor = field => (references.get(field) || []).map(entry => entry.quote).join('\n');
  // Exact quotes alone do not establish that a paraphrase is faithful. Reject
  // these recognizable violations rather than silently publishing bad prose.
  generated.sections.forEach((section, index) => {
    const body = section.body.replace(/<[^>]*>/g, '').replace(/[*_]/g, '');
    const quote = quotesFor(`sections[${index}].body`);
    if (/treasur/i.test(section.heading) && /(?:[$£€]\s*\d|\b\d[\d,.]*\s*(?:dollars?|cents?)\b|\b(?:balance|receipts|disbursements|income|expenses|total)\s*(?:was|were|of|is|:)?\s*\d)/i.test(body)) {
      throw generationError('The generated minutes included treasury figures. The minutes should record the report reading status without amounts. Please try again.');
    }
    const statedClaims = proceduralClaims(body), citedClaims = proceduralClaims(quote);
    const noVote = /\b(?:no vote was taken|no recorded (?:vote|decision)|motion (?:was )?(?:not approved|rejected|defeated))\b/i;
    const approved = /\b(?:(?:motion|proposal|resolution)\s+(?:was\s+)?(?:approved|adopted|passed|carried)|approved unanimously|unanimously approved)\b/i;
    if (noVote.test(quote) && approved.test(statedClaims) && !approved.test(citedClaims)) {
      throw generationError('The generated decision conflicts with its source reference. Review the recorded motion outcome and try again.', 'MINUTES_UNSUPPORTED_APPROVAL');
    }
    const proceduralFacts = [
      {label: 'second', stated: /\b(?:seconded|seconder|seconding|second by|a second was (?:made|offered))\b/i, supported: /\b(?:seconded|seconder|seconding|second by|a second was (?:made|offered))\b/i,
        negated: negatedProcedure('seconded', String.raw`did not second|no second(?:er)?\s+(?:(?:was|were)\s+)?(?:made|offered|given|received)|received no second`)},
      {label: 'unanimous vote', stated: /\bunanimous(?:ly)?\b/i, supported: /\bunanimous(?:ly)?\b|\ball (?:in favor|ayes?)\b[^.!?]*\b(?:none|no one|zero) opposed\b/i,
        negated: negatedProcedure('unanimous(?:ly)?')},
      {label: 'approval', stated: /\b(?:approved|adopted|passed|carried)\b/i, supported: /\b(?:approved|adopted|passed|carried|all in favor)\b/i,
        negated: negatedProcedure('approved|adopted|passed|carried')},
      {label: 'rejection', stated: /\b(?:rejected|defeated|failed)\b/i, supported: /\b(?:rejected|defeated|failed)\b/i,
        negated: negatedProcedure('rejected|defeated|failed')},
      {label: 'tabling', stated: /\btabled\b/i, supported: /\btabled\b/i,
        negated: negatedProcedure('tabled')},
      {label: 'withdrawal', stated: /\bwithdrawn|withdrew\b/i, supported: /\bwithdrawn|withdrew\b/i,
        negated: negatedProcedure('withdrawn|withdrew', 'did not withdraw')},
    ];
    const states = fact => fact.stated.test(withoutNegatedFact(statedClaims, fact.negated));
    const supports = fact => fact.supported.test(withoutNegatedFact(citedClaims, fact.negated));
    if (/\b(?:motion|moved|seconded|seconder|vote)\b/i.test(`${body}\n${quote}`)) {
      for (const fact of proceduralFacts) {
        if (states(fact) && !supports(fact)
          || fact.negated.test(statedClaims) && !fact.negated.test(citedClaims)) {
          throw generationError(`The generated motion claims an unsupported ${fact.label}. Review the cited transcript and try again.`, `MINUTES_UNSUPPORTED_${fact.label.toUpperCase().replace(/ /g, '_')}`);
        }
      }
      if (supports(proceduralFacts[0]) && !states(proceduralFacts[0])) {
        warnings.push(`Confirm ${section.heading}: a second appears in the cited source but is absent from the draft motion.`);
      }
      if (proceduralFacts.slice(1).some(supports)
        && !proceduralFacts.slice(1).some(states)) {
        warnings.push(`Confirm ${section.heading}: the cited source records a motion outcome that is absent from the draft.`);
      }
      if (noVote.test(quote) && !noVote.test(body)) {
        warnings.push(`Confirm ${section.heading}: the cited source says no vote or decision was recorded, but the draft omits that distinction.`);
      }
    }
  });
  const motionLine = /\b(?:motion|moved|seconded|vote(?:d)?|carried|adopted|unanimous(?:ly)?)\b/i;
  const sectionCoverage = new Set([...references].filter(([field]) => /^sections\[\d+\]\.body$/.test(field))
    .flatMap(([, entries]) => entries.flatMap(entry => Array.from({length: entry.lastLine - entry.firstLine + 1}, (_, offset) => entry.firstLine + offset))));
  source.split('\n').forEach((line, index) => {
    if (motionLine.test(line) && !sectionCoverage.has(index + 1)) {
      warnings.push(`Motion source review: line ${index + 1} mentions a motion or vote but is not linked to a minutes section.`);
    }
  });
  const normalized = normalizeMinutesDraft({...generated, officerAttendanceVersion: 2, closingFormatVersion: 3, sourceType: localDraft.sourceType, organizerVersion: localDraft.organizerVersion});
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
  for (const field of ['closingPrayerGiven']) {
    if (generated[field] === null) continue;
    const quoted = organizeMeetingSource(quotesFor(field));
    const explicitNegative = /\bChaplain\b[^.!?]*\b(?:did not|never)\b[^.!?]*\b(?:give|offer|deliver|lead)\b[^.!?]*\bclosing prayer\b/i;
    const supported = generated[field] === true ? localDraft[field] === true && detectPrayerFacts(quotesFor(field), {closingFormatVersion:3})[field] === true : explicitNegative.test(quotesFor(field));
    if (!supported) {
      // An unsupported prayer flag must not become a statement in the PDF.
      // Keep the rest of the sourced draft and require the preparer to confirm
      // this one fact, just as we do for an unsupported officer status.
      generated[field] = null;
      normalized[field] = null;
      references.delete(field);
      warnings.push('Confirm whether the Chaplain gave the closing prayer; the cited source does not establish it.');
    }
  }
  for (const field of ['closingPrayerGiven']) {
    if (normalized[field] !== null) continue;
    if (generated.sections.some(section => detectPrayerFacts(section.body.replace(/<[^>]*>/g, '').replace(/[*_]/g, ''), {closingFormatVersion:3})[field] === true)) {
      throw generationError(`The generated minutes claim ${field} without a verified source reference. Review the source and try again.`);
    }
  }
  const attendanceEstablished = (quote, name, field) => {
    const quoted = organizeMeetingSource(quote);
    if ((quoted[field] || []).some(stated => namesMatch(stated, name))) return true;
    if (!quote.toLowerCase().includes(name.toLowerCase()) || /\b(?:next|previous|last) (?:meeting|year)|\b(?:will|would|should)\b/i.test(quote)) return false;
    if (field === 'arrived_late') return extractOfficerCoverage(quote).some(officer => officerNameMatches(name, officer) && officer.status === 'arrived_late');
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
  const sameOfficer = (left, right) => officerNameMatches(left.name, right);
  for (const [index, entry] of generated.officerAttendance.entries()) {
    const field = key => `officerAttendance[${index}].${key}`;
    const rosterOfficer = CURRENT_OFFICERS.find(officer => officerNameMatches(entry.name, officer));
    const referenceOfficer = rosterOfficer || entry;
    if (entry.status !== 'not_recorded') {
      const quote = quotesFor(field('status'));
      const explicit = extractOfficerCoverage(quote, [referenceOfficer])[0];
      if (!(explicit.status === entry.status || attendanceEstablished(quote, entry.name, entry.status))) {
        entry.status = 'not_recorded';
        references.delete(field('status'));
        warnings.push(`Confirm attendance for ${entry.name}: the source mentions the officer but does not establish an attendance status.`);
      }
    }
    for (const key of ['stationCoverage', 'actingName', 'actingWholeMeeting']) {
      if (entry[key] === null || entry[key] === '') continue;
      const explicit = extractOfficerCoverage(quotesFor(field(key)), [referenceOfficer])[0];
      const supported = key === 'actingName'
        ? explicit.actingName?.toLowerCase() === entry.actingName.trim().toLowerCase()
        : explicit[key] === entry[key];
      if (!supported || key === 'actingName' && officerNameMatches(entry.actingName, referenceOfficer)
        || key === 'actingWholeMeeting' && entry.actingWholeMeeting === false && entry.status !== 'arrived_late') {
        entry[key] = null;
        references.delete(field(key));
        warnings.push(`Confirm ${referenceOfficer.title || entry.name} station coverage: the source does not establish ${key}.`);
      }
    }
    // A covering Brother cannot be treated as a sourced assignment without a
    // sourced link to this officer's station, even when his name occurs nearby.
    if (entry.stationCoverage !== 'filled') {
      entry.actingName = null;
      entry.actingWholeMeeting = null;
      references.delete(field('actingName'));
      references.delete(field('actingWholeMeeting'));
    }
  }
  for (const normalizedEntry of normalized.officerAttendance) {
    const generatedEntries = generated.officerAttendance.filter(entry => sameOfficer(entry, normalizedEntry));
    if (!generatedEntries.length) continue;
    const chosen = generatedEntries.find(entry => entry.status !== 'not_recorded') || generatedEntries[0];
    normalizedEntry.status = chosen.status;
    Object.assign(normalizedEntry, normalizeOfficerCoverage(chosen));
  }
  // Reconcile the other-Brother lists after unsupported assignments are
  // cleared. An invented assignment must not erase independently sourced
  // presence or excusal that was removed during the initial normalization.
  normalized.present = otherAttendanceNames(generated.present.map(name => name.trim()).filter(Boolean), normalized.officerAttendance, 2);
  normalized.excused = otherAttendanceNames(generated.excused.map(name => name.trim()).filter(Boolean), normalized.officerAttendance, 2);
  generated.sensitiveReview.forEach((detail, index) => {
    if (!source.includes(detail) || !quotesFor(`sensitiveReview[${index}]`).includes(detail)) {
      throw generationError('A private review detail does not match the source. Please try again.');
    }
  });
  const coverage = new Set([...references.values()].flatMap(entries => entries.flatMap(entry =>
    Array.from({length: entry.lastLine - entry.firstLine + 1}, (_, offset) => entry.firstLine + offset))));
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

export const normalizeMinutesDraft = (value = {}) => {
  const attendanceVersion = Number(value.officerAttendanceVersion) >= 2 ? 2 : 1;
  const rawPresent = Array.isArray(value.present) ? value.present.map(item => String(item).trim()).filter(Boolean) : [];
  const rawExcused = Array.isArray(value.excused) ? value.excused.map(item => String(item).trim()).filter(Boolean) : [];
  const statedRows = Array.isArray(value.officerAttendance) ? value.officerAttendance.map((entry) => ({
    name: String(entry?.name || '').trim(),
    title: String(entry?.title || '').trim(),
    ...normalizeOfficerCoverage(entry),
    status: ['present', 'absent', 'excused', 'arrived_late', 'not_recorded'].includes(entry?.status)
      ? entry.status : 'not_recorded',
  })).filter((entry) => entry.name) : [];
  const sameOfficer = (entry, officer) => attendanceVersion >= 2 ? officerNameMatches(entry.name, officer)
    : namesMatch(entry.name, officer.name)
      || entry.title && officer.title && entry.title.toLowerCase() === officer.title.toLowerCase();
  const officerAttendance = CURRENT_OFFICERS.map((officer) => {
    const stated = statedRows.find((entry) => sameOfficer(entry, officer));
    const inferred = rawPresent.some((name) => namesMatch(name, officer.name)) ? 'present'
      : rawExcused.some((name) => namesMatch(name, officer.name)) ? 'excused' : 'not_recorded';
    return {
      // Expand office/surname aliases, while retaining an officer's explicit
      // full-name spelling and office corrections made in the editor.
      name: attendanceVersion >= 2 && stated && !namesMatch(stated.name, officer.name)
        ? officer.name : stated?.name || officer.name,
      title: stated?.title || officer.title,
      ...normalizeOfficerCoverage(stated),
      status: stated?.status && stated.status !== 'not_recorded' ? stated.status : inferred,
    };
  });
  officerAttendance.push(...statedRows.filter((entry) => (
    !CURRENT_OFFICERS.some((officer) => sameOfficer(entry, officer))
  )));
  const otherNames = list => otherAttendanceNames(list, officerAttendance, attendanceVersion);
  return {
  organizerVersion: value.organizerVersion || 1,
  officerAttendanceVersion: attendanceVersion,
  closingFormatVersion: Number(value.closingFormatVersion) >= 3 ? 3 : Number(value.closingFormatVersion) >= 2 ? 2 : 1,
  ...(Number(value.meetingDetailsVersion) >= 1 ? {meetingDetailsVersion:1} : {}),
  sourceType: value.sourceType === 'compiled_notes' ? 'compiled_notes' : 'transcript',
  meetingDate: minutesDateValue(value.meetingDate) || null,
  meetingType: /^(?:regular )?stated communication$/i.test(String(value.meetingType || ''))
    ? 'Stated Communication' : String(value.meetingType || (Number(value.meetingDetailsVersion) >= 1 ? '' : 'Stated Communication')).trim(),
  degree: canonicalDegree(value.degree),
  openingTime: value.openingTime ? String(value.openingTime).trim() : null,
  closingTime: value.closingTime ? String(value.closingTime).trim() : null,
  prayerRequested: typeof value.prayerRequested === 'boolean' ? value.prayerRequested : null,
  closingPrayerGiven: typeof value.closingPrayerGiven === 'boolean' ? value.closingPrayerGiven : null,
  presiding: value.presiding ? String(value.presiding).trim() : null,
  quorum: canonicalQuorum(value.quorum),
  nextMeeting: value.nextMeeting ? String(value.nextMeeting).trim() : null,
  present: otherNames(rawPresent),
  excused: otherNames(rawExcused),
  visitors: normalizeVisitors(value.visitors),
  officerAttendance,
  attendanceReview: {
    officerRoll: value.attendanceReview?.officerRoll === true,
    otherPresent: value.attendanceReview?.otherPresent === true,
    otherExcused: value.attendanceReview?.otherExcused === true,
  },
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
  warnings: Array.isArray(value.warnings) ? value.warnings.map(String).filter(warning => warning
    && !(Number(value.closingFormatVersion) >= 2
      && /^Confirm whether the Worshipful Master asked the Chaplain to (?:pray for the sick and distressed|offer a prayer for sickness and distress) at (?:closing|the close of the meeting)(?:[.;].*)?$/i.test(warning))) : [],
  sensitiveReview: Array.isArray(value.sensitiveReview)
    ? value.sensitiveReview.map(String).filter(Boolean) : [],
  actionItems: Array.isArray(value.actionItems) ? value.actionItems.map(String).filter(Boolean) : [],
  };
};

export const generateMinutesDraft = async (transcript, {
  testResponse = process.env.NODE_ENV === 'test' ? process.env.MINUTES_TEST_RESPONSE : '',
  sourceType = 'auto',
  generateStructured,
  meetingDetails,
} = {}) => {
  if (meetingDetails !== undefined) {
    const issues = minutesMeetingDetailsIssues(meetingDetails);
    if (issues.length) throw Object.assign(new Error(issues.join(' ')), {statusCode:400, code:'MINUTES_MEETING_DETAILS_REQUIRED'});
  }
  const finish = draft => applyMinutesMeetingDetails(currentMinutesEditorialDraft(draft), meetingDetails);
  const source = String(transcript || '').trim();
  if (source.length < 100) throw Object.assign(new Error('The transcript is too short to create reliable minutes.'), { statusCode: 400 });
  if (source.length > 500_000) throw Object.assign(new Error('The transcript is too long. Upload the Plaud text export for one meeting.'), { statusCode: 400 });

  if (testResponse) return finish(normalizeMinutesDraft({...JSON.parse(testResponse), officerAttendanceVersion: 2, closingFormatVersion: 2}));
  const localDraft = organizeMeetingSource(source, { sourceType });
  localDraft.closingPrayerGiven = detectPrayerFacts(source, {closingFormatVersion:3}).closingPrayerGiven;
  if (typeof generateStructured === 'function') {
    const sourceLines = minutesSourceLines(source);
    const schema = minutesGenerationSchemaForLineCount(sourceLines.length);
    const response = await generateStructured({
      purpose: 'minutes', schemaName: 'stone_square_meeting_minutes', schema,
      instructions: generationInstructions,
      input: JSON.stringify({sourceType: localDraft.sourceType, officerRoster: CURRENT_OFFICERS, sourceLines}),
    });
    return finish(checkedGeneratedDraft(response, source, localDraft, schema, sourceLines));
  }
  return finish(normalizeMinutesDraft(localDraft));
};

export function applyMinutesMeetingDetails(draft, supplied) {
  if (supplied === undefined) return draft;
  const issues = minutesMeetingDetailsIssues(supplied);
  if (issues.length) throw Object.assign(new Error(issues.join(' ')), {statusCode:400, code:'MINUTES_MEETING_DETAILS_REQUIRED'});
  const details = normalizeMinutesMeetingDetails(supplied);
  const labels = {meetingDate:'meeting date',meetingType:'meeting type',degree:'degree',openingTime:'opening time',closingTime:'closing time',presiding:'presiding officer',quorum:'quorum',nextMeeting:'next meeting date'};
  const compare = (field, value) => {
    if (field === 'meetingDate' || field === 'nextMeeting') return minutesDateParts(value)?.iso || value;
    if (field === 'openingTime' || field === 'closingTime') {
      const time = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(String(value || '').trim());
      if (time) return `${String(Number(time[1]) % 12 + (time[3].toLowerCase() === 'p' ? 12 : 0)).padStart(2,'0')}:${time[2] || '00'}`;
    }
    return String(value || '').trim();
  };
  const warnings = (draft.warnings || []).filter(warning => ![
    'Enter the meeting date. Event dates in the notes are not used as the meeting date.',
    'Confirm the opening time.', 'Confirm the closing time.', UNCITED_PRESIDING_WARNING,
  ].includes(warning));
  for (const field of MINUTES_MEETING_DETAILS_FIELDS) {
    if (draft[field] && compare(field,draft[field]) !== compare(field,details[field])) {
      warnings.push(`The entered ${labels[field]} differs from the organized source value. Review the source and the entered detail before submission.`);
    }
  }
  // Keep original source and provider citations untouched. These values are
  // authenticated officer entries, not model-verified transcript assertions.
  return normalizeMinutesDraft({...draft, ...details, meetingDetailsVersion:1, warnings:[...new Set(warnings)]});
}
