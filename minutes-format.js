import { formatMinutesDate, minutesDateParts } from './public/minutes-dates.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';
import { CURRENT_OFFICERS, namesMatch } from './minutes-layout.js';

// One presentation model for the live PDF and Word record. Formatting never
// supplies a motion, an outcome, a name, or a time missing from the record.
export const prayerRequestText = 'WM Dixon-Saunders asked the Chaplain to offer a prayer for the sick and distressed at the close of the meeting.';
export const closingPrayerText = 'The Chaplain gave the closing prayer and prayed for the sick and distressed.';

const plainBullet = value => emphasisRuns(String(value || '').replace(/^\s*(?:[-*•▪]|\d+[.)])\s+/, '').trim()).map(run => run.text).join('').trim();
const omitWholeBullets = (body, predicate) => String(body || '').split('\n').filter(line => {
  const plain = plainBullet(line);
  return plain && !/^[-*•▪]$/.test(plain) && !predicate(plain);
}).join('\n').trim();
const isStandardPrayerRequest = text => /^(?:The )?(?:Worshipful Master|WM)(?: Dixon-Saunders)? (?:asked|requested|directed) (?:the )?Chaplain to (?:(?:give|offer|say) a prayer|pray) for (?:sickness and distress|the sick and distressed) at (?:the (?:close|end)(?: of (?:the )?meeting)?|closing)\.?$/i.test(text);
const isEmptyEntry = value => /^(?:none(?: (?:were )?(?:recorded|reported|noted))?|no entr(?:y|ies)(?: (?:was |were )?(?:recorded|reported|noted))?|not (?:recorded|reported|applicable)|n\/?a|nil)\.?$/i.test(plainBullet(value));
const praiseLabel = /^praise reports?\s*[:.]?\s*$/i;
const attendanceLabel = /^attendance (?:and|&) visitors\s*[:.]?\s*$/i;
const visitorPlaceholder = /^(?:(?:additional )?(?:brothers|brethren)(?: and visitors)?|visitors)(?: (?:were |are |have been ))?\s*recorded in (?:the )?sign[ -]?in book\.?$/i;

// Use the same cleanup for editable drafts and documents made from historical
// snapshots. Return new objects; neither saved nor attested records are changed.
export function cleanMinutesSectionsForPresentation(sections, {visitors = [], present = [], excused = [], officerAttendance = [], quorum = ''} = {}) {
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

export function closingReviewIssues(draft) {
  return [
    !String(draft.closingTime || '').trim() && 'Enter the closing time.',
    typeof draft.prayerRequested !== 'boolean' && 'Confirm whether the Worshipful Master requested prayer for the sick and distressed.',
    typeof draft.closingPrayerGiven !== 'boolean' && 'Confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.',
  ].filter(Boolean);
}

export function attendanceReviewIssues(draft = {}) {
  const review = draft.attendanceReview || {};
  const rows = Array.isArray(draft.officerAttendance) ? draft.officerAttendance : [];
  const unresolved = CURRENT_OFFICERS.filter((officer) => {
    const row = rows.find((entry) => namesMatch(entry?.name, officer.name));
    return !row || !['present', 'excused', 'absent'].includes(row.status);
  });
  const unresolvedAdditional = rows.filter((entry) => entry?.name
    && !CURRENT_OFFICERS.some((officer) => namesMatch(entry.name, officer.name))
    && !['present', 'excused', 'absent'].includes(entry.status));
  return [
    !review.officerRoll && 'Confirm that you reviewed the complete officer roll.',
    unresolved.length && `Record Present, Excused, or Absent for every Lodge officer. Still incomplete: ${unresolved.map((officer) => officer.name).join(', ')}.`,
    unresolvedAdditional.length && `Record Present, Excused, or Absent for each added officer or pro tem entry. Still incomplete: ${unresolvedAdditional.map((entry) => entry.name).join(', ')}.`,
    !review.otherPresent && 'Confirm the Other Brothers Present list, including when no other Brothers were present.',
    !review.otherExcused && 'Confirm the Other Brothers Excused list, including when no other Brothers were excused.',
  ].filter(Boolean);
}

export function detectPrayerFacts(source) {
  // Require past-tense evidence about this meeting. Requests, future plans and
  // negated statements cannot establish that the closing prayer happened.
  const sentences = String(source || '').split(/\n|(?<=[.!?])\s+(?=[A-Z])/);
  const past = sentence => !/\b(?:not|never|didn't|did not|will|would|should|next meeting|previous meeting|last meeting)\b/i.test(sentence);
  return {
    prayerRequested: sentences.some(s => past(s) && /\b(?:Worshipful Master|WM)\b.*\b(?:asked|requested|directed)\b.*\bChaplain\b.*\b(?:sick|distress)\w*/i.test(s) && /\b(?:close|closing|end of (?:the )?meeting)\b/i.test(s)) ? true : null,
    closingPrayerGiven: sentences.some(s => past(s) && /\bChaplain\b.*\b(?:gave|offered|delivered|led)\b.*\bclosing prayer\b.*\b(?:sick|distress)\w*/i.test(s)) ? true : null,
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
  const closing = sections.filter(s => /^(?:prayer and closing|closing(?: of the lodge)?|adjournment)$/i.test(s.heading.trim()));
  const result = sections.filter(s => !closing.includes(s));
  let sick = result.find(s => isSicknessHeading(s.heading));
  if (!sick) { sick = {heading: SICKNESS_HEADING, body: ''}; result.push(sick); }
  // Remove only our exact standard wording when the officer changes a control.
  if (typeof draft.prayerRequested === 'boolean') sick.body = omitWholeBullets(sick.body, isStandardPrayerRequest);
  if (draft.prayerRequested === true) sick.body += `\n${prayerRequestText}`;
  else if (draft.prayerRequested !== false) sick.body += '\nPrayer request: confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing.';
  if (draft.nextMeeting) {
    for (const section of result) section.body = omitWholeBullets(section.body, text => repeatsNextMeeting(text, draft, section.heading));
    result.push({heading: 'Next Meeting', body: formatMinutesDate(draft.nextMeeting)});
  }
  let closingBody = closing.map(s => s.body).join('\n').trim();
  if (draft.nextMeeting) closingBody = omitWholeBullets(closingBody, text => repeatsNextMeeting(text, draft, 'Closing'));
  if (typeof draft.prayerRequested === 'boolean') closingBody = omitWholeBullets(closingBody, isStandardPrayerRequest);
  if (typeof draft.closingPrayerGiven === 'boolean') closingBody = omitWholeBullets(closingBody, text => /^(?:The )?Chaplain (?:gave|offered|led|delivered) the closing prayer and prayed for the sick and distressed\.?$/i.test(text));
  // Replace an isolated closing-time statement with the reviewed time. Retain
  // any additional ceremonial or business details in the source sentence.
  if (draft.closingTime) closingBody = omitWholeBullets(closingBody, text => /^(?:(?:the )?lodge (?:was )?)?(?:closed|adjourned)(?: at [\d: .APMapm]+)?\.?$/i.test(text));
  const formal = separateFormalClosure(closingBody);
  closingBody = formal.remaining;
  const closure = formal.statements.length ? formal.statements.join('\n') : draft.closingTime ? `The Lodge was closed at ${draft.closingTime}.` : 'Closing time: confirm and enter the time the Lodge was closed.';
  const prayer = draft.closingPrayerGiven === true ? closingPrayerText : draft.closingPrayerGiven === false ? '' : 'Closing prayer: confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.';
  result.push({heading: 'Closing of the Lodge', body: [closingBody, prayer, closure].filter(Boolean).join('\n')});
  return result.filter(s => s.body.trim() || isSicknessHeading(s.heading));
}

// One block model controls both PDF and Word. Narrative and motions remain
// intact paragraphs; list sections use one bullet per source-delimited item.
export function sectionBlocks(section) {
  const list = /^(?:sickness (?:and|&) distress|communications|correspondence|upcoming events(?: and reminders)?|reminders)$/i.test(String(section.heading || '').trim());
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
