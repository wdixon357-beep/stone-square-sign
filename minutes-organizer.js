import { CURRENT_OFFICERS, namesMatch } from './minutes-layout.js';
import { detectPrayerFacts } from './minutes-format.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';

// Preserve agenda blocks before interpreting their contents. In compiled notes the
// author has already supplied context; a speaker's name must never start a section.
const clean = value => String(value || '').replace(/\r/g, '')
  .replace(/^[\s#*•_]+|[\s*_]+$/g, '').replace(/[“”]/g, '"').replace(/[’]/g, "'")
  .replace(/[–—]/g, ',').trim();
const undecorated = value => clean(value).replace(/^\d+[.)]\s*/, '').trim();
const sentenceParts = text => text.split(/(?<=[.!?])\s+(?=[A-Z])/).reduce((parts, part) => {
  if (parts.length && /\b(?:Bro|St|No|Mr|Mrs|Dr|Jr|Sr|[A-Z])\.$/.test(parts.at(-1))) parts[parts.length - 1] += ` ${part}`;
  else parts.push(part);
  return parts;
}, []);

const headings = [
  ['Opening', /^(?:opening(?: of the lodge)?|open on|call to order)$/i],
  ['Roll Call and Quorum', /^(?:roll call(?: of officers| and quorum)?|quorum|attendance(?:\s+(?:and|&)\s+visitors|\s*\/\s*visitors)?)$/i],
  [SICKNESS_HEADING, isSicknessHeading],
  ['Reading of the Minutes', /^(?:(?:reading and approval|approval|reading) of (?:the )?(?:previous |current )?minutes|minutes of (?:the )?previous meeting|previous minutes)$/i],
  ["Treasurer's Report", /^(?:treasurer'?s? report|financial report)(?:\s*\(.*\))?$/i],
  ['Degree Work', /^degree work(?: and current class)?$/i],
  ['Communications', /^(?:communications?|correspondence|reading of communications|grand lodge officers?'? remarks)$/i],
  ['Demits', /^demits?$/i], ['Petitions', /^petitions?$/i], ['Balloting', /^balloting$/i],
  ['Unfinished Business', /^(?:unfinished|old) business$/i],
  ['New Business and Motions', /^(?:new business(?: and motions)?|motions)$/i],
  ['Committee Reports', /^committee reports?$/i],
  ['Elections', /^elections?$/i],
  ['Good of the Order', /^(?:good of the order|praise reports?|(?:brothers?|wardens?|past masters?)'? remarks)$/i],
  ['Upcoming Events and Reminders', /^(?:upcoming events(?: and reminders)?|announcements)$/i],
  ['Prayer and Closing', /^(?:prayer and closing|closing(?: of the lodge)?|adjournment)$/i],
];
const knownHeading = line => headings.find(([, matcher]) => typeof matcher === 'function'
  ? matcher(line) : matcher.test(undecorated(line).replace(/:$/, '')))?.[0];
const emptyAttendance = value => /^(?:none(?: recorded| reported| present)?|no (?:one|visitors?|visiting brothers?|guests?|absences|excused brothers?)(?: were present| present| recorded| reported)?|n\/?a|not applicable)[.!]?$/i.test(String(value || '').trim());
const names = text => [...new Set(clean(text)
  .replace(/,\s*(PM|HPM|Jr\.?|Sr\.?|II|III|IV)(?=\s*(?:[,;]|$))/gi, ' $1')
  .replace(/\s+(?:and|&)\s+/gi, ';').split(/\s*[;,|]\s*/).map(clean).filter(name => !emptyAttendance(name))
  .map(name => name.replace(/\b[a-z][a-z]+\b/g, word => word[0].toUpperCase() + word.slice(1))).filter(Boolean))];
const visitorNames = text => names(text).reduce((visitors, entry) => {
  const startsPerson = /^(?:(?:bro(?:ther)?|mr|mrs|ms|dr|rev)\.?\s|(?:PM|HPM|WM|SW|JW)\s|(?:Worshipful|Past) Master\s)/i.test(entry)
    || /\b(?:of|from)\s+.+\blodge\b/i.test(entry);
  if (visitors.length && !startsPerson && /\blodge\s+(?:no\.?\s*|#\s*)\d+\b/i.test(entry)) visitors[visitors.length - 1] += `, ${entry}`;
  else visitors.push(entry);
  return visitors;
}, []);
const obsoletePraiseHeading = value => /^praise reports?$/i.test(undecorated(value).replace(/:$/, ''));
const isLetterhead = line => /^stone square lodge(?:\s+(?:no\.?|#)\s*\d+)?(?:\s*[,•]\s*(?:f\.?\s*&\s*a\.?\s*m\.?|p\.?h\.?a\.?|prince hall affiliation))*\s*\.?$/i.test(line);

function unknownHeading(line, markedHeadings) {
  const label = undecorated(line).replace(/:$/, '').trim();
  if (knownHeading(line) || isLetterhead(label) || emptyAttendance(label) || label.length > 100 || label.split(/\s+/).length > 12
    || !/[A-Za-z]/.test(label) || /[.!?:;$\d]/.test(label)) return false;
  // Speaker names and terse motion outcomes remain part of their topic.
  if (/^(?:(?:WM|SW|JW|PM|HPM|Bro(?:ther)?|Worshipful Master|Past Master)\b|motion\b|no (?:vote|motion|decision|action|errors?|omissions?)\b)/i.test(label)) return false;
  if (/^(?:(?:not )?(?:approved|adopted|passed|failed|carried|withdrawn|tabled)(?: unanimously| without objection)?|all in favor|none opposed|no opposition)$/i.test(label)) return false;
  return markedHeadings.has(line) || label.length >= 4 && label === label.toUpperCase();
}

function possibleUppercaseAttendanceName(line, markedHeadings) {
  if (markedHeadings.has(line) || knownHeading(line) || line !== line.toUpperCase()) return false;
  // Within an explicit attendance list, capitalization alone does not distinguish
  // a name from a heading. Keep plausible names, but stop at familiar agenda terms.
  if (/^(?:officer installation|installation of officers|community (?:service|outreach|events)|masonic education|charity reports?|scholarship (?:reports?|committee)|building (?:maintenance|and grounds)|candidate (?:progress|tracker)|degree instruction|attendance review|lodge business|upcoming activities)$/i.test(line)) return false;
  const words = line.split(/\s+/);
  return words.length >= 2 && words.length <= 5 && words.every(word => /^[\p{L}\p{M}]+(?:['-][\p{L}\p{M}]+)*$/u.test(word));
}
const date = text => {
  const iso = /\b(20\d{2})-(\d\d?)-(\d\d?)\b/.exec(text);
  const num = /\b(\d\d?)\/(\d\d?)\/(20\d{2})\b/.exec(text);
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d\d?)(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(text);
  let y, m, d;
  if (iso) [, y, m, d] = iso;
  else if (num) [, m, d, y] = num;
  else if (named) { y = named[3]; d = named[2]; m = 'january february march april may june july august september october november december'.split(' ').indexOf(named[1].toLowerCase()) + 1; }
  else return null;
  const check = new Date(Date.UTC(+y, +m - 1, +d));
  return check.getUTCFullYear() === +y && check.getUTCMonth() === +m - 1 && check.getUTCDate() === +d
    ? `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null;
};
const meetingDate = lines => {
  const labeled = lines.find(line => /^(?:meeting date|date(?: of (?:the )?meeting)?)\s*:/i.test(line));
  if (labeled) return date(labeled);
  const title = lines.find(line => !/\b(?:next|previous|last|will|would|should)\b/i.test(line)
    && /^(?:(?:stated |regular )?(?:meeting |communication )?minutes (?:of|for)|(?:stated |regular )?(?:meeting|communication) (?:of|on)|(?:the )?lodge\b[^.!?]*\bheld\b[^.!?]*\bon\b)/i.test(line));
  if (title) return date(title);
  const headerDate = lines.slice(0, 5).find(line => /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\.?$/i.test(line));
  if (headerDate) return date(headerDate);
  const opening = lines.find(line => /^open on\s*:/i.test(line)
    || /^(?:on\s+)?[^.!?]*\b(?:the )?lodge (?:opened|was called to order)\b/i.test(line));
  return opening ? date(opening.split(/(?<=[.!?])\s/)[0]) : null;
};
const time = (text, words) => new RegExp(`(?:${words})[^.\\n]{0,65}?(\\d{1,2}:\\d{2}\\s*(?:AM|PM|a\\.m\\.|p\\.m\\.))`, 'i').exec(text)?.[1]?.replace(/\./g,'').toUpperCase() || null;
const containsRoutinePresence = line => /\b(?:grand secretary|grand treasurer|grand lodge officer|district deputy|grand master)\b.*\bpresent as (?:a )?member\b/i.test(line);

function narrativeHeading(sentence, active) {
  if (/\b(opened|called to order)\b/i.test(sentence)) return 'Opening';
  if (/\b(closed|adjourned|closing prayer)\b/i.test(sentence)) return 'Prayer and Closing';
  if (/\b(sick(?:ness)?|distress(?:ed)?|prayers? for|pray(?:ed|ing)? for|prayers? (?:(?:was|were) )?requested|requested prayers?|asked for prayers?|hospital|funeral|bereavement)\b/i.test(sentence)) return SICKNESS_HEADING;
  if (/\b(treasurer'?s? report|financial reports?)\b/i.test(sentence)) return "Treasurer's Report";
  if (/\b(previous minutes|minutes (?:were )?(?:read|approved))\b/i.test(sentence)) return 'Reading of the Minutes';
  if (/\b(committee reported|committee report)\b/i.test(sentence)) return 'Committee Reports';
  if (/\b(correspondence|letter|edict|summons)\b/i.test(sentence)) return 'Communications';
  if (/\b(?:new business|motion|moved that|seconded)\b/i.test(sentence)) return 'New Business and Motions';
  return active || 'Other Meeting Business';
}

function treasuryReading(lines) {
  const report = String.raw`(?:(?:the|this|a)\s+)?(?:(?:treasurer'?s?|financial)\s+)?report`;
  const positive = new RegExp(String.raw`(?:^|:\s+)${report}\s+(?:(?:was|has been|had been)\s+)?read\b|\bread\s+(?:aloud\s+)?${report}\b`, 'i');
  const negative = new RegExp(String.raw`(?:^|:\s+)${report}\s+(?:(?:was|has|had)\s+)?(?:not|never)\s+(?:been\s+)?read\b|(?:^|:\s+)${report}\s+wasn'?t\s+read\b|(?:^|:\s+)no\s+${report}\s+(?:was\s+)?read\b`, 'i');
  const evidence = lines.flatMap(sentenceParts).map(clean);
  const notRead = evidence.some(line => negative.test(line) || /^(?:not|never) read(?: aloud)?(?: by .+)?\.?$/i.test(line));
  const read = evidence.some(line => !/\b(?:will|would|should|could|can|may|must|not|never|please|to read|requested|asked|silently|privately|next meeting|last meeting|previous meeting)\b/i.test(line)
    && !/^read\s+(?:the|this|a)\b/i.test(line)
    && (positive.test(line) || /^read(?: aloud)?(?: by .+)?\.?$/i.test(line)));
  // "Presented" or another item being read does not establish an aloud reading.
  return notRead && read ? 'unconfirmed' : notRead ? 'not_read' : read ? 'read' : 'unconfirmed';
}

export function organizeMeetingSource(source, { sourceType = 'auto' } = {}) {
  const rawLines = source.split('\n');
  const lines = rawLines.map(clean).filter(Boolean);
  const markedHeadings = new Set(rawLines.filter(line => /^\s*#{1,6}\s+\S/.test(line)
    || /^\s*(?:\d+[.)]\s*)?(?:\*\*[^*]+\*\*|__[^_]+__)\s*:?\s*$/.test(line)).map(clean));
  const numbered = lines.filter(line => /^\d+[.)]\s/.test(line));
  const detectedType = numbered.length >= 2 || lines.filter(knownHeading).length >= 2 ? 'compiled_notes' : 'transcript';
  const type = ['compiled_notes', 'transcript'].includes(sourceType) ? sourceType : detectedType;
  const attendance = { present: [], excused: [], absent: [], visitors: [] };
  const content = [];
  const placementWarnings = [];
  let attendanceLabel = null;
  for (const line of lines) {
    const label = /^(?:(?:brothers?|members?|officers?)\s+)?(present|excused|absent|visitors?)(?:\s+(?:brothers?|members?|officers?))?\s*:\s*(.*)$/i.exec(undecorated(line));
    if (label) {
      attendanceLabel = label[1].toLowerCase().replace(/^visitor$/, 'visitors');
      attendance[attendanceLabel].push(...(attendanceLabel === 'visitors' ? visitorNames(label[2]) : names(label[2])));
      continue;
    }
    const onlyLabel = /^(present|excused|absent|visitors?)$/i.exec(line);
    if (onlyLabel) { attendanceLabel = onlyLabel[1].toLowerCase().replace(/^visitor$/, 'visitors'); continue; }
    const ambiguousAttendanceName = attendanceLabel && unknownHeading(line, markedHeadings) && possibleUppercaseAttendanceName(line, markedHeadings);
    if (attendanceLabel && !knownHeading(line) && (!unknownHeading(line, markedHeadings) || ambiguousAttendanceName) && !/^\d+[.)]/.test(line)
      && !/[.!?:]/.test(line.replace(/\b(?:Bro|Jr|Sr)\./g,'')) && line.split(' ').length <= 5) {
      if (ambiguousAttendanceName) placementWarnings.push(`Uppercase entries under ${attendanceLabel} were kept as names. Confirm that none is a section heading.`);
      attendance[attendanceLabel].push(...(attendanceLabel === 'visitors' ? visitorNames(line) : names(line))); continue;
    }
    attendanceLabel = null;
    if (/^(?:meeting date|date(?: of (?:the )?meeting)?|meeting type|degree|opening time|closing time|presiding|quorum|next meeting|next stated communication)\s*:/i.test(line)) continue;
    if (isLetterhead(line) || /^page\s+\d+\s+(?:of|\/)\s+\d+\s*$/i.test(line)) continue;
    content.push(line);
  }
  for (const key of Object.keys(attendance)) attendance[key] = [...new Set(attendance[key])];
  const blocks = [];
  let active = null;
  const begin = (heading, topic = '', preserveBlock = false, obsoletePraise = false) => { active = { heading, lines: topic ? [topic] : [], preserveBlock, obsoletePraise }; blocks.push(active); };
  const explicitPresence = /\b(?:include|record) (?:the )?grand lodge (?:officer|presence)\b/i.test(source);
  for (let line of content) {
    const heading = knownHeading(line);
    if (heading) { begin(heading, '', false, obsoletePraiseHeading(line)); continue; }
    const inline = /^([^:]+):\s+(.+)$/.exec(line);
    if (inline && knownHeading(inline[1])) { begin(knownHeading(inline[1]), '', false, obsoletePraiseHeading(inline[1])); line = inline[2]; }
    else if (unknownHeading(line, markedHeadings)) {
      begin('Other Meeting Business', line, true);
      placementWarnings.push(`Confirm the section for "${undecorated(line).replace(/:$/, '')}". Its full notes were kept in Other Meeting Business.`);
      continue;
    } else if (/^\d+[.)]\s/.test(line) && line.length < 120) {
      begin('New Business and Motions', undecorated(line));
      placementWarnings.push(`Confirm the section for numbered item "${undecorated(line)}". Its notes were kept in New Business and Motions.`);
      continue;
    }
    line = line.replace(/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(?:Speaker\s*\d+\s*:\s*)?/i, '');
    if (emptyAttendance(clean(undecorated(line).replace(/^[-•]\s*/, '')))) continue;
    const sentences = sentenceParts(line).filter(sentence => explicitPresence || !containsRoutinePresence(sentence)
      || /\b(?:official visitation|grand lodge visitation)\b/i.test(sentence));
    if (!sentences.length) continue;
    if (type === 'compiled_notes' || active?.preserveBlock || active && detectedType === 'compiled_notes') {
      if (!active) begin('Other Meeting Business');
      active.lines.push(sentences.join(' '));
    } else {
      for (const sentence of sentences) {
        const target = narrativeHeading(sentence, active?.heading);
        if (active?.heading !== target) begin(target);
        active.lines.push(sentence);
      }
    }
  }
  const sections = new Map();
  const sensitiveReview = [];
  const add = (heading, body) => {
    if (!body.trim()) return;
    const entries = sections.get(heading) || [];
    entries.push(body.trim()); sections.set(heading, entries);
  };
  const topicBlocks = blocks.flatMap(block => {
    if (!block.obsoletePraise) return [block];
    const groups = [];
    for (const sentence of block.lines.flatMap(sentenceParts)) {
      const inferred = narrativeHeading(sentence);
      const heading = inferred !== 'Other Meeting Business' ? inferred
        : /\b(?:thanked|thank you|thanks|congratulations|congratulated)\b/i.test(sentence) ? 'Good of the Order'
          : groups.at(-1)?.heading || 'Good of the Order';
      if (groups.at(-1)?.heading === heading) groups.at(-1).lines.push(sentence);
      else groups.push({heading, lines: [sentence]});
    }
    return groups;
  });
  for (const block of topicBlocks) {
    if (!block.lines.length) continue;
    if (block.heading === "Treasurer's Report") {
      const reading = treasuryReading(block.lines);
      add(block.heading, reading === 'not_read' ? "The Treasurer's report was not read aloud."
        : reading === 'read' ? "The Treasurer's report was read aloud." : "The Treasurer's report was referenced. Confirm whether it was read aloud.");
      // Report figures live in the circulated financial report, never in inferred transactions.
      continue;
    }
    const safeLines = block.lines.map(line => {
      if (/\b(diagnos|medical condition|medication|dues status|disciplin|allegation|family dispute)/i.test(line)) {
        sensitiveReview.push(line);
        return 'Sensitive detail withheld pending officer review.';
      }
      return line;
    });
    if (block.heading === 'Communications') {
      // A dated event, summons, edict, or letter establishes a subject. Keep its
      // motion and follow-up lines with it until the next subject begins.
      const groups = [];
      let group = [];
      for (const line of safeLines) {
        const startsTopic = /^(?:edict\s+\d|grand master'?s summons|grand lodge visitation)/i.test(line)
          || /^(?!MOTION|PM\b|WM\b|Bro\.|Read\b|Confirmed\b|Split\b|Outcome\b)[^:]{2,65},\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(line)
          || /\blodge\s+no\.?\s*\d+\s+letter\b/i.test(line);
        if (startsTopic && group.length) { groups.push(group); group = []; }
        group.push(line);
      }
      if (group.length) groups.push(group);
      for (const groupLines of groups) add(groupLines.some(line => /^MOTION(?: PASSED| FAILED)?:/i.test(line)) ? 'New Business and Motions' : 'Communications', groupLines.join('\n'));
    } else add(block.heading, safeLines.join('\n'));
  }
  const opening = sections.get('Opening')?.join(' ') || '';
  const degreeLine = lines.find(line => /^degree\s*:/i.test(line)) || opening || source.slice(0, 350);
  const degree = /round[ -]?table/i.test(degreeLine) ? 'Round Table'
    : /(?:third|master mason) degree/i.test(degreeLine) ? 'Third Degree'
    : /(?:second|fellow ?craft) degree/i.test(degreeLine) ? 'Second Degree'
    : /(?:first|entered apprentice) degree/i.test(degreeLine) ? 'First Degree' : null;
  const ordered = [...headings.map(([heading]) => heading), 'Other Meeting Business'];
  const finalSections = [...new Set(ordered)].filter(heading => sections.has(heading)).map(heading => ({heading, body: [...new Set(sections.get(heading))].join('\n\n')}));
  const day = meetingDate(lines);
  const completedActions = lines.flatMap(sentenceParts).filter(line => !/\b(?:will|would|should|not|never|next meeting|previous meeting|last meeting)\b/i.test(line)).join('\n');
  const openingTime = time(completedActions, 'opening time|opened|open on|called to order');
  const closingTime = time(completedActions, 'closing time|closed|adjourned');
  const warnings = [...new Set(placementWarnings)];
  if (sensitiveReview.length) warnings.push('Review the private source details before attestation. No referral or follow-up action has been inferred.');
  if (!day) warnings.push('Enter the meeting date. Event dates in the notes are not used as the meeting date.');
  if (!openingTime) warnings.push('Confirm the opening time.');
  if (!closingTime) warnings.push('Confirm the closing time.');
  if (!attendance.present.length) warnings.push('Confirm the attendance list. Speaking or being mentioned does not establish attendance.');
  if (type === 'transcript') warnings.push('Unstructured speech may need editing. The organizer preserves wording and does not infer missing decisions.');
  for (const person of attendance.present) if (attendance.excused.some(other => namesMatch(person, other))) warnings.push(`${person} appears as both present and excused. Confirm the roll.`);
  const officerAttendance = CURRENT_OFFICERS.map(officer => ({...officer,
    status: attendance.excused.some(name => namesMatch(name, officer.name)) ? 'excused'
      : attendance.present.some(name => namesMatch(name, officer.name)) ? 'present'
        : attendance.absent.some(name => namesMatch(name, officer.name)) ? 'absent' : 'not_recorded'}));
  const otherPresent = attendance.present.filter((name) => !CURRENT_OFFICERS.some((officer) => namesMatch(name, officer.name)));
  const otherExcused = attendance.excused.filter((name) => !CURRENT_OFFICERS.some((officer) => namesMatch(name, officer.name)));
  return {
    organizerVersion: 4, sourceType: type, meetingDate: day,
    ...detectPrayerFacts(source),
    meetingType: /\bmeeting type\s*:\s*([^\n.]+)/i.exec(source)?.[1]?.trim() || 'Stated Communication',
    degree, openingTime, closingTime,
    presiding: /\b(?:presiding|presided by)\s*:\s*([^\n]+)/i.exec(source)?.[1]?.trim() || null,
    quorum: /\b(?:no quorum|quorum\s*:\s*no|quorum (?:was |is )?not (?:present|established))\b/i.test(source) ? 'No'
      : /\bquorum(?:\s*:\s*yes| (?:was |is )?(?:present|established|declared))\b/i.test(source) ? 'Yes' : null,
    nextMeeting: /\bnext (?:meeting|stated communication)\s*:\s*([^\n]+)/i.exec(source)?.[1]?.trim() || null,
    present: otherPresent, excused: otherExcused, absent: attendance.absent, visitors: attendance.visitors,
    officerAttendance,
    attendanceReview: { officerRoll: false, otherPresent: false, otherExcused: false },
    income: [], expenses: [], sections: finalSections,
    warnings, sensitiveReview, actionItems: [],
  };
}
