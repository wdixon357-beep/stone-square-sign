import { formatMinutesDate } from './public/minutes-dates.js';
import { SICKNESS_HEADING, isSicknessHeading } from './minutes-sections.js';

// One presentation model for the live PDF and Word record. Formatting never
// supplies a motion, an outcome, a name, or a time missing from the record.
export const prayerRequestText = 'The Worshipful Master asked the Chaplain to offer a prayer for the sick and distressed at the close of the meeting.';
export const closingPrayerText = 'The Chaplain gave the closing prayer and prayed for the sick and distressed.';

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

export function documentSections(draft) {
  const sections = (draft.sections || []).filter(s => String(s.body || '').trim() || isSicknessHeading(s.heading)).map(s => ({...s, heading: isSicknessHeading(s.heading) ? SICKNESS_HEADING : s.heading}));
  const closing = sections.filter(s => /^(?:prayer and closing|closing(?: of the lodge)?|adjournment)$/i.test(s.heading.trim()));
  const result = sections.filter(s => !closing.includes(s));
  let sick = result.find(s => isSicknessHeading(s.heading));
  if (!sick) { sick = {heading: SICKNESS_HEADING, body: ''}; result.push(sick); }
  // Remove only our exact standard wording when the officer changes a control.
  if (typeof draft.prayerRequested === 'boolean') sick.body = sick.body.replaceAll(prayerRequestText, '').replace(/(?:The )?(?:Worshipful Master|WM) (?:asked|requested|directed) (?:the )?Chaplain to (?:(?:give|offer|say) a prayer|pray) for (?:sickness and distress|the sick and distressed) at (?:the close of the meeting|the end of the meeting|closing)\.?/gi, '').trim();
  if (draft.prayerRequested === true) sick.body += `\n${prayerRequestText}`;
  else if (draft.prayerRequested !== false) sick.body += '\nPrayer request: confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing.';
  if (!sick.body.trim()) sick.body = 'No entry recorded.';
  if (draft.nextMeeting) result.push({heading: 'Next Meeting', body: formatMinutesDate(draft.nextMeeting)});
  let closingBody = closing.map(s => s.body).join('\n').trim();
  if (typeof draft.closingPrayerGiven === 'boolean') closingBody = closingBody.replaceAll(closingPrayerText, '')
    .replace(/(?:The )?Chaplain (?:gave|offered|led|delivered) the closing prayer and prayed for the sick and distressed\.?/gi, '').trim();
  // Replace an isolated closing-time statement with the reviewed time. Retain
  // any additional ceremonial or business details in the source sentence.
  if (draft.closingTime) closingBody = closingBody.split('\n').filter(line => !/^\s*(?:(?:the )?lodge (?:was )?)?(?:closed|adjourned)(?: at [\d: .APMapm]+)?\.?\s*$/i.test(line)).join('\n').trim();
  const closure = draft.closingTime ? `The Lodge was closed at ${draft.closingTime}.` : 'Closing time: confirm and enter the time the Lodge was closed.';
  const prayer = draft.closingPrayerGiven === true ? closingPrayerText : draft.closingPrayerGiven === false ? '' : 'Closing prayer: confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.';
  result.push({heading: 'Closing of the Lodge', body: [closingBody, closure, prayer].filter(Boolean).join('\n')});
  return result.filter(s => s.body.trim());
}

export function bulletItems(value) {
  const lines = String(value || '').replace(/\r/g, '').split(/\n+|\s+[•▪]\s*/).map(line => line.replace(/^\s*(?:[-*•▪]|\d+[.)])\s+/, '').trim()).filter(Boolean);
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
