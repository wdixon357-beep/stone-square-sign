import { formatMinutesDate, minutesDateParts } from './public/minutes-dates.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';
import { CURRENT_OFFICERS, namesMatch } from './minutes-layout.js';
import { attendanceCoverageIssues } from './public/minutes-attendance.js';
import {hasExplicitMinutesTime} from './public/minutes-meeting-details.js';

// One presentation model for the live PDF and Word record. Formatting never
// supplies a motion, an outcome, a name, or a time missing from the record.
export const prayerRequestText = 'WM Dixon-Saunders asked the Chaplain to offer a prayer for the sick and distressed at the close of the meeting.';
export const closingPrayerText = 'The Chaplain gave the closing prayer and prayed for the sick and distressed.';
export const closingPrayerTextV3 = 'The Chaplain gave the closing prayer.';
export const UNCITED_PRESIDING_WARNING = 'Confirm the presiding officer before attestation: the generated name had no source reference and has been left unconfirmed.';

const plainBullet = value => emphasisRuns(String(value || '').replace(/^\s*(?:[-*•▪]|\d+[.)])\s+/, '').trim()).map(run => run.text).join('').trim();
const omitWholeBullets = (body, predicate) => String(body || '').split('\n').filter(line => {
  const plain = plainBullet(line);
  return plain && !/^[-*•▪]$/.test(plain) && !predicate(plain);
}).join('\n').trim();
const isStandardPrayerRequest = text => /^(?:The )?(?:Worshipful Master|WM)(?: Dixon-Saunders)? (?:asked|requested|directed|instructed) (?:the )?Chaplain to (?:(?:give|offer|say) a prayer|pray) for (?:sickness and distress|the sick and distressed) at (?:the (?:close|end)(?: of (?:the )?meeting)?|closing)\.?$/i.test(text);
const isObsoletePrayerPrompt = text => /^Prayer request: confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing\.?$/i.test(text);
// These whole-bullet prompts belong in the preparer's form, not the current
// document. Keep actual negative facts and explanations about missing records.
const isClosingReviewPlaceholder = text => /^(?:Closing time: confirm and enter the time the Lodge was closed|Closing prayer: confirm whether the Chaplain gave the closing prayer(?: and prayed for the sick and distressed)?|Closing record: Opening time, closing time, and a formal Lodge closure statement were not recorded)\.?$/i.test(text);
const isGenericClosingPrayer = text => /^(?:(?:Closing )?Prayer:\s*)?(?:The )?Chaplain (?:gave|offered|led|delivered) the closing prayer(?: at (?:the )?end of (?:the )?meeting)?\.?$/i.test(text);
const isRecordedClosingPrayer = text => /^(?:(?:Closing )?Prayer:\s*)?(?:The )?Chaplain (?:gave|offered|led|delivered) the closing prayer\b/i.test(text);
const isEmptyEntry = value => /^(?:none(?: (?:were )?(?:recorded|reported|noted))?|no entr(?:y|ies)(?: (?:was |were )?(?:recorded|reported|noted))?|not (?:recorded|reported|applicable)|n\/?a|nil)\.?$/i.test(plainBullet(value));
const praiseLabel = /^praise reports?\s*[:.]?\s*$/i;
const attendanceLabel = /^attendance (?:and|&) visitors\s*[:.]?\s*$/i;
const visitorPlaceholder = /^(?:(?:additional )?(?:brothers|brethren)(?: and visitors)?|visitors)(?: (?:were |are |have been ))?\s*recorded in (?:the )?sign[ -]?in book\.?$/i;

// Use the same cleanup for editable drafts and documents made from historical
// snapshots. Return new objects; neither saved nor attested records are changed.
export function cleanMinutesSectionsForPresentation(sections, {visitors = [], present = [], excused = [], officerAttendance = [], quorum = '', closingFormatVersion = 1} = {}) {
  const input = Array.isArray(sections) ? sections : [];
  const meaningfulVisitor = value => {
    const text = plainBullet(value);
    return text && !isEmptyEntry(text) && !visitorPlaceholder.test(text) && !/^(?:no visitors(?: (?:were |are )?(?:present|recorded|reported))?|visitors?\s*:\s*(?:none|not recorded|no entry recorded))\.?$/i.test(text);
  };
  const hasVisitors = (Array.isArray(visitors) ? visitors : []).some(meaningfulVisitor) || input.some(section => String(section.body || '').split('\n').some((line, index, lines) => {
    const text = plainBullet(line);
    if (/^visitors?\s*:?$/i.test(plainBullet(section.heading)) && meaningfulVisitor(text) && !/^visitors?\s*:?$/i.test(text)) return true;
    if (/^visitors?\s*:?$/i.test(text)) {
      const next = plainBullet(lines.slice(index + 1).find(value => plainBullet(value)) || '');
      if (meaningfulVisitor(next) && /^(?:(?:Bro(?:ther)?|PM|HPM)\.?\s+|[A-Z][a-z]+\s+[A-Z][a-z]+(?:[,.]|$))/.test(next)) return true;
    }
    const named = /^(?:visitors?|visiting brothers)\s*:\s*(.+)$/i.exec(plainBullet(line));
    return named && meaningfulVisitor(named[1]);
  }));
  const cleanBody = value => String(value || '').replace(/\r/g, '').split('\n').flatMap(line => {
    const text = plainBullet(line);
    if (Number(closingFormatVersion) >= 2 && (isStandardPrayerRequest(text) || isObsoletePrayerPrompt(text))) return [];
    if (!text || /^[-*•▪]$/.test(text) || isEmptyEntry(text) || praiseLabel.test(text)) return [];
    if (!hasVisitors && (attendanceLabel.test(text) || /^visitors?\s*[:.]?$/i.test(text) || visitorPlaceholder.test(text))) return [];
    const visitor = /^visitors?\s*:\s*(.+)$/i.exec(text);
    if (visitor && !meaningfulVisitor(visitor[1])) return [];
    const praise = /^praise reports?\s*:\s*(.+)$/i.exec(text);
    if (praise) return isEmptyEntry(praise[1]) ? [] : [praise[1]];
    return [line];
  }).join('\n').trim();
  const normalizedName = value => plainBullet(value).toLowerCase().replace(/\b(?:brother|bro|pm|hpm)\.?\s*/g, '').replace(/[^a-z0-9]/g, '');
  const recordedNames = status => {
    const list = status === 'present' ? present : excused;
    return [...(Array.isArray(list) ? list : []), ...(Array.isArray(officerAttendance) ? officerAttendance : []).filter(officer => officer && officer.status === status).map(officer => officer.name)].map(normalizedName);
  };
  const redundantRollCall = value => {
    const text = plainBullet(value);
    if (attendanceLabel.test(text) || visitorPlaceholder.test(text)) return true;
    if (/^all officers (?:are |were )?present unless (?:otherwise )?noted\.?$/i.test(text)) return true;
    if (/^yes$/i.test(quorum) && /^(?:a )?quorum (?:was |is )?(?:present|confirmed|established)\.?$/i.test(text)) return true;
    if (/^no$/i.test(quorum) && /^(?:no quorum (?:was |is )?present|(?:a )?quorum (?:was |is )?not present)\.?$/i.test(text)) return true;
    const attendance = /^(present|excused)(?: brothers)?\s*:\s*(.+?)\.?$/i.exec(text);
    if (!attendance) return false;
    const names = attendance[2].split(/\s*[,;]\s*|\s+and\s+/i).filter(name => !/^(?:PM|HPM)$/i.test(name)).map(normalizedName).filter(Boolean);
    const known = recordedNames(attendance[1].toLowerCase());
    return names.length > 0 && names.every(name => known.includes(name));
  };
  return input.map(section => {
    let heading = plainBullet(section.heading).replace(/^#{1,6}\s*/, '').replace(/:\s*$/, '');
    const rollCall = /^(?:roll call(?: (?:and|&) (?:quorum|attendance))?|attendance (?:and|&) quorum|quorum)$/i.test(heading);
    if (isSicknessHeading(heading)) heading = SICKNESS_HEADING;
    else if (praiseLabel.test(heading)) heading = 'Good of the Order';
    else if (!hasVisitors && attendanceLabel.test(heading)) heading = 'Attendance';
    let body = cleanBody(section.body);
    if (rollCall) { body = omitWholeBullets(body, redundantRollCall); heading = 'Other Meeting Business'; }
    return {...section, heading, body};
  }).filter(section => section.body || isSicknessHeading(section.heading));
}

function repeatsNextMeeting(text, draft, heading) {
  const known = minutesDateParts(plainBullet(draft.nextMeeting));
  const stated = minutesDateParts(text);
  if (!known || !stated || known.iso !== stated.iso) return false;
  const prefix = stated.prefix.trim();
  if (!/^(?:the )?next meeting(?:(?:\s+(?:is|was)(?:\s+scheduled)?(?:\s+(?:for|on))?)|(?:\s+scheduled(?:\s+(?:for|on))?)|\s*:)?$/i.test(prefix)
      && !(heading.trim().toLowerCase() === 'next meeting' && !prefix)) return false;
  const remainder = value => value.trim().replace(/\.$/, '').trim().toLowerCase();
  // A date-only bullet is covered by the dedicated section. Additional time,
  // location or event details stay unless that section also contains them.
  return !remainder(stated.suffix) || remainder(stated.suffix) === remainder(known.suffix);
}

export function preparerOffice(name, role) {
  if (!String(name || '').trim()) return '';
  return { assistant_secretary: 'Assistant Secretary', secretary: 'Secretary', owner: 'Worshipful Master' }[role] || '';
}

const hasExplicitClockTime = hasExplicitMinutesTime;

export function closingReviewIssues(draft) {
  if (Number(draft.closingFormatVersion) >= 3) return [
    !hasExplicitClockTime(draft.openingTime) && 'Enter the opening time with AM/PM or in 24-hour HH:mm format.',
    !hasExplicitClockTime(draft.closingTime) && 'Enter the closing time with AM/PM or in 24-hour HH:mm format.',
    typeof draft.closingPrayerGiven !== 'boolean' && 'Confirm whether the Chaplain gave the closing prayer.',
  ].filter(Boolean);
  return [
    !String(draft.closingTime || '').trim() && 'Enter the closing time.',
    typeof draft.closingPrayerGiven !== 'boolean' && 'Confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.',
  ].filter(Boolean);
}

export function attendanceReviewIssues(draft = {}, {requireConfirmation = true} = {}) {
  const review = draft.attendanceReview || {};
  const rows = Array.isArray(draft.officerAttendance) ? draft.officerAttendance : [];
  const unresolved = CURRENT_OFFICERS.filter((officer) => {
    const row = rows.find((entry) => namesMatch(entry?.name, officer.name));
    return !row || !['present', 'arrived_late', 'excused', 'absent'].includes(row.status);
  });
  const unresolvedAdditional = rows.filter((entry) => entry?.name
    && !CURRENT_OFFICERS.some((officer) => namesMatch(entry.name, officer.name))
    && !['present', 'arrived_late', 'excused', 'absent'].includes(entry.status));
  return [
    draft.warnings?.includes(UNCITED_PRESIDING_WARNING) && !String(draft.presiding || '').trim()
      && 'Enter and verify the presiding officer from the meeting record before attesting.',
    requireConfirmation && !review.officerRoll && 'Confirm that you reviewed the complete officer roll.',
    unresolved.length && `Record Present, Arrived later, Excused, or Absent for every Lodge officer. Still incomplete: ${unresolved.map((officer) => officer.name).join(', ')}.`,
    unresolvedAdditional.length && `Record attendance for each added officer or pro tem entry. Still incomplete: ${unresolvedAdditional.map((entry) => entry.name).join(', ')}.`,
    ...attendanceCoverageIssues(draft),
    requireConfirmation && !review.otherPresent && 'Confirm the Other Brothers Present list, including when no other Brothers were present.',
    requireConfirmation && !review.otherExcused && 'Confirm the Other Brothers Excused list, including when no other Brothers were excused.',
  ].filter(Boolean);
}

// The preparer confirms the roll. Master review validates recorded facts without
// asking the Master to repeat the preparer's checklist.
export const attendanceRecordIssues = draft => attendanceReviewIssues(draft, {requireConfirmation:false});

export function detectPrayerFacts(source, {closingFormatVersion = 2} = {}) {
  // Require past-tense evidence about this meeting. Requests, future plans and
  // negated statements cannot establish that the closing prayer happened.
  const sentences = String(source || '').split(/\n|(?<=[.!?])\s+(?=[A-Z])/);
  const past = sentence => !/\b(?:not|never|didn't|did not|will|would|should|next meeting|previous meeting|last meeting)\b/i.test(sentence);
  const affirmativePrayerPrefix = value => {
    const prefix = value.trim().replace(/^[“"']+|[“"']+$/g, '').trim();
    if (!prefix || /^(?:Closing(?: prayer)?|Prayer(?: and Closing)?|Chaplain):$/i.test(prefix)) return true;
    if (/^There being no further business,?$/i.test(prefix)
      || /^(?:At|During) (?:the )?(?:close|closing|end)(?: of (?:the )?(?:meeting|communication|Lodge))?,?$/i.test(prefix)) return true;
    if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(?:,? \d{4})?\s*[:,]$/i.test(prefix)
      || hasExplicitClockTime(prefix.replace(/^At\s+/i, '').replace(/[:,]$/, ''))) return true;
    return /^(?:(?:The )?(?:Worshipful Master|Secretary|Assistant Secretary|Chaplain)|(?:The )?WM(?:\s+[\p{L}.'-]+){0,4}|(?:Bro\.?|Brother|PM|HPM)\s+[\p{L}.'-]+(?:\s+[\p{L}.'-]+){0,3}|I|We)\s+(?:confirmed|affirmed|verified|stated|reported|recorded)(?:\s+that)?$/iu.test(prefix);
  };
  const currentClosingPrayer = value => {
    const sentence = plainBullet(value);
    if (!past(sentence)
      || /\?|\b(?:if|unless|whether|unclear|unknown|unconfirmed|unverified|uncertain|reportedly|allegedly|could|might|asked|requested|instructed|directed|planned|proposed|scheduled|expected|denied|denies|doubted|doubts|false|disputed|refuted|disclaimed|contradicted|perhaps|possibly|or)\b|\bno (?:one|record|evidence|confirmation|indication|statement)\b|\bwithout (?:a )?(?:record|evidence|confirmation)\b|\bmay (?:have|be|not|say|indicate|show|mean|suggest)\b|\b(?:please|needs? to|requires? to) confirm\b|\b(?:needs?|requires?) (?:confirmation|verification)\b|^\s*confirm\b/i.test(sentence)) return false;
    const action = /\b(?:The\s+)?Chaplain\s+(?:(?:then|also|finally|subsequently)\s+)?(?:gave|offered|delivered|led)\s+(?:(?:the|a)\s+)?closing prayer\b/i.exec(sentence);
    // A quoted subordinate clause is not an affirmative fact merely because
    // it contains a past-tense verb. Accept a direct statement or an explicit
    // officer/person's affirmative report; other prefixes remain unconfirmed.
    return Boolean(action && affirmativePrayerPrefix(sentence.slice(0, action.index)));
  };
  const currentSentences = Number(closingFormatVersion) >= 3 ? sentences.reduce((items, sentence) => {
    if (items.length && /\b(?:Bro|Mr|Dr|Rev|Jr|Sr)\.$/i.test(items.at(-1))) items[items.length - 1] += ` ${sentence}`;
    else items.push(sentence);
    return items;
  }, []).filter(sentence => sentence.trim()) : [];
  const refutesCurrentPrayer = value => {
    const text = plainBullet(value).replace(/^Correction:\s*/i, '');
    if (/\b(?:next meeting|previous meeting|last meeting)\b/i.test(text)) return false;
    return /^(?:That|This|It)(?: (?:statement|claim|assertion))? (?:is|was|remains) (?:false|untrue|not true|denied|disputed|refuted|disclaimed|contradicted)\b/i.test(text)
      || /^(?:That|This|It) (?:(?:did not|didn't) happen|never happened)\b/i.test(text)
      || /^(?:The )?Chaplain (?:(?:did not|didn't|never) (?:give|offer|lead|deliver)|never (?:gave|offered|led|delivered)|(?:has|had) not (?:given|offered|led|delivered)) (?:the |a )?closing prayer\b/i.test(text)
      || /^No closing prayer (?:was|had been) (?:given|offered|led|delivered)\.?$/i.test(text);
  };
  const currentPrayerRefuted = currentSentences.some((sentence, index) => currentClosingPrayer(sentence)
    && refutesCurrentPrayer(currentSentences[index + 1] || ''));
  return {
    prayerRequested: sentences.some(s => past(s) && /\b(?:Worshipful Master|WM)\b.*\b(?:asked|requested|directed|instructed)\b.*\bChaplain\b.*\b(?:sick|distress)\w*/i.test(s) && /\b(?:close|closing|end of (?:the )?meeting)\b/i.test(s)) ? true : null,
    closingPrayerGiven: (Number(closingFormatVersion) >= 3
      ? !currentPrayerRefuted && currentSentences.some(currentClosingPrayer)
      : sentences.some(s => past(s) && /\bChaplain\b.*\b(?:gave|offered|delivered|led)\b.*\bclosing prayer\b.*\b(?:sick|distress)\w*/i.test(s))) ? true : null,
  };
}

export function separateFormalClosure(body) {
  const statements = [];
  const remaining = String(body || '').replace(/\bThere being no further business,[^\n]*?\b(?:closed|adjourned)\b[^\n]*?\bWorshipful Master\./gi, statement => {
    statements.push(statement);
    return '';
  }).trim();
  return {remaining, statements};
}

export function documentSections(draft) {
  const sections = cleanMinutesSectionsForPresentation(draft.sections, draft);
  const currentClosingFormat = Number(draft.closingFormatVersion) >= 3;
  // Signed snapshots retain the renderer they were prepared with. A stray
  // bullet in a legacy section must not reformat an already attested PDF.
  const usesBullets = Number(draft.organizerVersion) >= 5;
  const generatedLine = text => usesBullets ? `- ${text}` : text;
  const closing = sections.filter(s => /^(?:prayer and closing|closing(?: of the lodge)?|adjournment)$/i.test(s.heading.trim()));
  const result = sections.filter(s => !closing.includes(s));
  let sick = result.find(s => isSicknessHeading(s.heading));
  if (!sick) { sick = {heading: SICKNESS_HEADING, body: ''}; result.push(sick); }
  // Older records used a separate prayer-request control. Their renderer keeps
  // its original behavior; new minutes omit that routine request entirely.
  sick.body = omitWholeBullets(sick.body, isStandardPrayerRequest);
  // Keep the original presentation of already-attested records. Current drafts
  // no longer ask for, print or require a separate routine WM prayer request.
  if (Number(draft.closingFormatVersion) < 2 || !draft.closingFormatVersion) {
    if (draft.prayerRequested === true) sick.body += `\n${generatedLine(prayerRequestText)}`;
    else if (draft.prayerRequested !== false) sick.body += `\n${generatedLine('Prayer request: confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing.')}`;
  }
  if (draft.nextMeeting) {
    for (const section of result) section.body = omitWholeBullets(section.body, text => repeatsNextMeeting(text, draft, section.heading));
    result.push({heading: 'Next Meeting', body: generatedLine(formatMinutesDate(draft.nextMeeting))});
  }
  let closingBody = closing.map(s => s.body).join('\n').trim();
  if (draft.nextMeeting) closingBody = omitWholeBullets(closingBody, text => repeatsNextMeeting(text, draft, 'Closing'));
  closingBody = omitWholeBullets(closingBody, isStandardPrayerRequest);
  if (currentClosingFormat) {
    closingBody = omitWholeBullets(closingBody, isClosingReviewPlaceholder);
    // A confirmed generic prayer is printed once by the versioned control.
    // Retain a sourced closing prayer with additional detail in its own wording.
    if (draft.closingPrayerGiven === true) closingBody = omitWholeBullets(closingBody, isGenericClosingPrayer);
  } else {
    closingBody = omitWholeBullets(closingBody, text => /^(?:The )?Chaplain (?:gave|offered|led|delivered) the closing prayer and prayed for the sick and distressed\.?$/i.test(text));
  }
  // Replace an isolated closing-time statement with the reviewed time. Retain
  // any additional ceremonial or business details in the source sentence.
  if (draft.closingTime) closingBody = omitWholeBullets(closingBody, text => /^(?:(?:the )?lodge (?:was )?)?(?:closed|adjourned)(?: at [\d: .APMapm]+)?\.?$/i.test(text));
  const formal = separateFormalClosure(closingBody);
  closingBody = formal.remaining;
  if (currentClosingFormat && !draft.closingTime) {
    closingBody = omitWholeBullets(closingBody, text => {
      if (!/^(?:The )?Lodge (?:was )?(?:closed|adjourned)\.?$/i.test(text)) return false;
      if (!formal.statements.includes(text)) formal.statements.push(text);
      return true;
    });
  }
  const closureText = formal.statements.length ? formal.statements.join('\n')
    : draft.closingTime ? `The Lodge was closed at ${draft.closingTime}.`
      : currentClosingFormat ? '' : 'Closing time: confirm and enter the time the Lodge was closed.';
  const closure = closureText ? generatedLine(closureText) : '';
  const hasRecordedPrayer = currentClosingFormat && closingBody.split('\n').some(line => isRecordedClosingPrayer(plainBullet(line)));
  const prayer = draft.closingPrayerGiven === true
    ? hasRecordedPrayer ? '' : generatedLine(currentClosingFormat ? closingPrayerTextV3 : closingPrayerText)
    : draft.closingPrayerGiven === false || currentClosingFormat ? '' : generatedLine('Closing prayer: confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.');
  result.push({heading: 'Closing of the Lodge', body: [closingBody, prayer, closure].filter(Boolean).join('\n')});
  return result.filter(s => s.body.trim() || isSicknessHeading(s.heading))
    .map(section => usesBullets ? {...section, bulletStyle: true} : section);
}

// One block model controls both PDF and Word. The explicit draft version keeps
// older signed snapshots in their original mixed paragraph and list format.
export function sectionBlocks(section) {
  const list = section.bulletStyle === true || /^(?:sickness (?:and|&) distress|communications|correspondence|upcoming events(?: and reminders)?|reminders)$/i.test(String(section.heading || '').trim());
  return String(section.body || '').replace(/\r/g, '').split(/\n+|\s+[•▪]\s*/)
    .map(line => line.replace(/^\s*(?:[-*•▪]|\d+[.)])\s+/, '').trim())
    .filter(line => line && !isEmptyEntry(line) && !praiseLabel.test(plainBullet(line)))
    .map(text => ({text, runs: emphasisRuns(text), bullet: list}));
}

export function bulletItems(value) {
  const lines = String(value || '').replace(/\r/g, '').split(/\n+|\s+[•▪]\s*/).map(line => line.replace(/^\s*(?:[-*•▪]|\d+[.)])\s+/, '').trim()).filter(line => line && !isEmptyEntry(line) && !praiseLabel.test(plainBullet(line)));
  return lines.flatMap(line => {
    // Keep short, connected statements together. Split a dense paragraph at
    // sentence boundaries, respecting titles, initials, times and abbreviations.
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z])/).reduce((all, sentence) => {
      if (all.length && /\b(?:Bro|St|No|Mr|Mrs|Dr|Jr|Sr|[A-Z]|a\.m|p\.m)\.$/i.test(all.at(-1))) all[all.length - 1] += ` ${sentence}`;
      else all.push(sentence);
      return all;
    }, []);
    const groups = [];
    for (const sentence of sentences) {
      if (groups.length && groups.at(-1).length + sentence.length < 220) groups[groups.length - 1] += ` ${sentence}`;
      else groups.push(sentence);
    }
    return groups.map(text => ({ text, runs: emphasisRuns(text) }));
  });
}

export function emphasisRuns(value) {
  let plain = '', flags = [];
  const token = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|<u>(.*?)<\/u>)/gi;
  let cursor = 0;
  const append = (text, style = {}) => { plain += text; for (let i = 0; i < text.length; i++) flags.push({...style}); };
  for (const match of value.matchAll(token)) {
    append(value.slice(cursor, match.index));
    append(match[2] || match[3] || match[4] || match[5] || match[6], {bold: !!(match[2] || match[3]), italic: !!(match[4] || match[5]), underline: !!match[6]});
    cursor = match.index + match[0].length;
  }
  append(value.slice(cursor));
  // Use UTF-16 indexes consistently with RegExp for accented names and Unicode.
  flags = Array.from({length: plain.length}, (_, i) => flags[i] || {});
  const mark = (start, end, style) => { for (let i = start; i < end; i++) Object.assign(flags[i], style); };
  const label = /^([^:]{2,85}:)(?:\s|$)/.exec(plain);
  if (label) mark(0, label[1].length, {bold: true});
  else if (plain.length <= 85 && !/[.!?]$/.test(plain)) mark(0, plain.length, {bold: true});
  else {
    const event = /^(.{2,70}?)(?=,\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b)/i.exec(plain);
    if (event) mark(0, event[1].length, {bold: true});
  }
  const dates = /\b(?:(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+20\d{2})?|\d{1,2}:\d{2}\s*(?:AM|PM|a\.m\.|p\.m\.)|20\d{2}-\d{2}-\d{2})\b/gi;
  for (const match of plain.matchAll(dates)) mark(match.index, match.index + match[0].length, {underline: true});
  const outcomes = /\b(?:no (?:vote|decision|action|motion)[^.!?]*[.!?]?|(?:outcome|disposition):[^.!?]*[.!?]?|attestation pending|confirm whether[^.!?]*[.!?]?)/gi;
  for (const match of plain.matchAll(outcomes)) mark(match.index, match.index + match[0].length, {italic: true});
  const runs = [];
  for (let i = 0; i < plain.length; i++) {
    const style = {bold: !!flags[i].bold, italic: !!flags[i].italic, underline: !!flags[i].underline};
    if (runs.length && ['bold','italic','underline'].every(key => runs.at(-1)[key] === style[key])) runs.at(-1).text += plain[i];
    else runs.push({text: plain[i], ...style});
  }
  return runs;
}
