import { CURRENT_OFFICERS, namesMatch } from './minutes-layout.js';

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
  ['Opening', /^(?:opening(?: of the lodge)?|call to order)$/i],
  ['Roll Call and Quorum', /^(?:roll call(?: of officers)?|quorum)$/i],
  ['Sickness and Distress', /^(?:sick(?:ness)? and distress|sickness|distress)$/i],
  ['Reading of the Minutes', /^(?:(?:reading and approval|approval|reading) of (?:the )?(?:previous |current )?minutes|minutes of (?:the )?previous meeting|previous minutes)$/i],
  ["Treasurer's Report", /^(?:treasurer'?s? report|financial report)(?:\s*\(.*\))?$/i],
  ['Degree Work', /^degree work(?: and current class)?$/i],
  ['Communications', /^(?:communications?|correspondence|reading of communications|grand lodge officers?'? remarks)$/i],
  ['Demits', /^demits?$/i], ['Petitions', /^petitions?$/i], ['Balloting', /^balloting$/i],
  ['Unfinished Business', /^(?:unfinished|old) business$/i],
  ['New Business and Motions', /^(?:new business(?: and motions)?|motions)$/i],
  ['Committee Reports', /^committee reports?$/i],
  ['Elections', /^elections?$/i],
  ['Good of the Order', /^(?:good of the order|praise report|(?:brothers?|wardens?|past masters?)'? remarks)$/i],
  ['Upcoming Events and Reminders', /^(?:upcoming events(?: and reminders)?|announcements)$/i],
  ['Prayer and Closing', /^(?:prayer and closing|closing(?: of the lodge)?|adjournment)$/i],
];
const knownHeading = line => headings.find(([, re]) => re.test(undecorated(line).replace(/:$/, '')))?.[0];
const names = text => [...new Set(clean(text)
  .replace(/,\s*(PM|HPM|Jr\.?|Sr\.?|II|III|IV)(?=\s*(?:[,;]|$))/gi, ' $1')
  .replace(/\s+(?:and|&)\s+/gi, ';').split(/\s*[;,|]\s*/).map(clean).map(name => name.replace(/\b[a-z][a-z]+\b/g, word => word[0].toUpperCase() + word.slice(1))).filter(Boolean))];
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
  const labeled = lines.find(line => /^(?:meeting date|date)\s*:/i.test(line));
  if (labeled) return date(labeled);
  const title = lines.slice(0, 5).find(line => !/\bnext\b/i.test(line) && (
    /(?:minutes (?:of|for)|meeting (?:of|on)|communication (?:of|on)|lodge.*held.*on)/i.test(line)
    || /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i.test(line)));
  if (title) return date(title);
  const opening = lines.find(line => /^(?:on\s+)?[^.!?]*\b(?:the )?lodge (?:opened|was called to order)\b/i.test(line));
  return opening ? date(opening.split(/(?<=[.!?])\s/)[0]) : null;
};
const time = (text, words) => new RegExp(`(?:${words})[^.\\n]{0,65}?(\\d{1,2}:\\d{2}\\s*(?:AM|PM|a\\.m\\.|p\\.m\\.))`, 'i').exec(text)?.[1]?.replace(/\./g,'').toUpperCase() || null;
const containsRoutinePresence = line => /\b(?:grand secretary|grand treasurer|grand lodge officer|district deputy|grand master)\b.*\bpresent as (?:a )?member\b/i.test(line);

function narrativeHeading(sentence, active) {
  if (/\b(opened|called to order)\b/i.test(sentence)) return 'Opening';
  if (/\b(closed|adjourned|closing prayer)\b/i.test(sentence)) return 'Prayer and Closing';
  if (/\b(sickness|distress|prayers? for|hospital|funeral|bereavement)\b/i.test(sentence)) return 'Sickness and Distress';
  if (/\b(treasurer'?s? report|financial reports?)\b/i.test(sentence)) return "Treasurer's Report";
  if (/\b(previous minutes|minutes (?:were )?(?:read|approved))\b/i.test(sentence)) return 'Reading of the Minutes';
  if (/\b(committee reported|committee report)\b/i.test(sentence)) return 'Committee Reports';
  if (/\b(correspondence|letter|edict|summons)\b/i.test(sentence)) return 'Communications';
  if (/\b(?:new business|motion|moved that|seconded)\b/i.test(sentence)) return 'New Business and Motions';
  return active || 'Other Meeting Business';
}

export function organizeMeetingSource(source, { sourceType = 'auto' } = {}) {
  const lines = source.split('\n').map(clean).filter(Boolean);
  const numbered = lines.filter(line => /^\d+[.)]\s/.test(line));
  const detectedType = numbered.length >= 2 || lines.filter(knownHeading).length >= 2 ? 'compiled_notes' : 'transcript';
  const type = ['compiled_notes', 'transcript'].includes(sourceType) ? sourceType : detectedType;
  const attendance = { present: [], excused: [], absent: [], visitors: [] };
  const content = [];
  let attendanceLabel = null;
  for (const line of lines) {
    const label = /^(?:(?:brothers?|members?|officers?)\s+)?(present|excused|absent|visitors?)(?:\s+(?:brothers?|members?|officers?))?\s*:\s*(.*)$/i.exec(undecorated(line));
    if (label) {
      attendanceLabel = label[1].toLowerCase().replace(/^visitor$/, 'visitors');
      attendance[attendanceLabel].push(...names(label[2]));
      continue;
    }
    const onlyLabel = /^(present|excused|absent|visitors?)$/i.exec(line);
    if (onlyLabel) { attendanceLabel = onlyLabel[1].toLowerCase().replace(/^visitor$/, 'visitors'); continue; }
    if (attendanceLabel && !knownHeading(line) && !/^\d+[.)]/.test(line)
      && !/[.!?:]/.test(line.replace(/\b(?:Bro|Jr|Sr)\./g,'')) && line.split(' ').length <= 5) {
      attendance[attendanceLabel].push(...names(line)); continue;
    }
    attendanceLabel = null;
    if (/^(?:meeting date|date|meeting type|degree|opening time|closing time|presiding|quorum|next meeting|next stated communication)\s*:/i.test(line)) continue;
    if (/^stone square lodge\b/i.test(line) && !/\b(?:opened|held)\b/i.test(line)) continue;
    content.push(line);
  }
  for (const key of Object.keys(attendance)) attendance[key] = [...new Set(attendance[key])];
  const blocks = [];
  let active = null;
  const begin = (heading, topic = '') => { active = { heading, lines: topic ? [topic] : [] }; blocks.push(active); };
  const explicitPresence = /\b(?:include|record) (?:the )?grand lodge (?:officer|presence)\b/i.test(source);
  for (let line of content) {
    const heading = knownHeading(line);
    if (heading) { begin(heading); continue; }
    if (/^\d+[.)]\s/.test(line) && line.length < 120) {
      begin('New Business and Motions', undecorated(line)); continue;
    }
    const inline = /^([^:]+):\s+(.+)$/.exec(line);
    if (inline && knownHeading(inline[1])) { begin(knownHeading(inline[1])); line = inline[2]; }
    line = line.replace(/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(?:Speaker\s*\d+\s*:\s*)?/i, '');
    const sentences = sentenceParts(line).filter(sentence => explicitPresence || !containsRoutinePresence(sentence)
      || /\b(?:official visitation|grand lodge visitation)\b/i.test(sentence));
    if (!sentences.length) continue;
    if (type === 'compiled_notes' || active && detectedType === 'compiled_notes') {
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
  for (const block of blocks) {
    if (block.heading === "Treasurer's Report") {
      const report = block.lines.join(' ');
      const notRead = /\b(?:not|never)\s+(?:been\s+)?(?:read|presented)\b|\b(?:wasn't|wasnt)\s+(?:read|presented)\b|\bno\s+(?:treasurer'?s?\s+)?report\s+(?:was\s+)?(?:read|presented)\b/i.test(report);
      const futureRead = /\b(?:will|would|should|to)\s+(?:be\s+)?(?:read|presented)\b/i.test(report);
      const read = !notRead && !futureRead && /\b(?:read(?: aloud)?|presented)\b/i.test(report);
      add(block.heading, notRead ? "The Treasurer's report was not read aloud."
        : read ? "The Treasurer's report was read aloud." : "The Treasurer's report was referenced. Confirm whether it was read aloud.");
      // Report figures live in the circulated financial report, never in inferred transactions.
      continue;
    }
    const safeLines = block.lines.map(line => {
      if (/\b(diagnos|medical condition|medication|dues status|disciplin|allegation|family dispute)/i.test(line)) {
        sensitiveReview.push(line);
        return 'A private matter was referred for officer follow up.';
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
  const openingTime = time(source, 'opening time|opened|called to order');
  const closingTime = time(source, 'closing time|closed|adjourned|closing');
  const warnings = [];
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
  return {
    organizerVersion: 2, sourceType: type, meetingDate: day,
    meetingType: /\bmeeting type\s*:\s*([^\n.]+)/i.exec(source)?.[1]?.trim() || 'Stated Communication',
    degree, openingTime, closingTime,
    presiding: /\b(?:presiding|presided by)\s*:\s*([^\n]+)/i.exec(source)?.[1]?.trim() || null,
    quorum: /\b(?:no quorum|quorum\s*:\s*no|quorum (?:was |is )?not (?:present|established))\b/i.test(source) ? 'No'
      : /\bquorum(?:\s*:\s*yes| (?:was |is )?(?:present|established|declared))\b/i.test(source) ? 'Yes' : null,
    nextMeeting: /\bnext (?:meeting|stated communication)\s*:\s*([^\n]+)/i.exec(source)?.[1]?.trim() || null,
    ...attendance, officerAttendance, income: [], expenses: [], sections: finalSections,
    warnings, sensitiveReview, actionItems: [],
  };
}
