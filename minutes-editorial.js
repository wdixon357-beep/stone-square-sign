import {omitClosingPrayerCommentary} from './minutes-closing-commentary.js';
import {detectPrayerFacts, isClosingSection} from './minutes-format.js';

// This is a current-draft edit, never a historical renderer. Remove only
// procedural/source-analysis boilerplate, not an actual negative meeting fact.
const sentences = [
  /\bThe source does not (?:identify|provide|record) the mover, seconder, vote method, (?:or|and) (?:vote )?tally\./gi,
  /\bThe mover, seconder, vote method, and (?:vote )?tally were not recorded\./gi,
  /\bWhether (?:it|the Treasurer's report) was read aloud needs confirmation\./gi,
];
const referenceDump = /^\s*(?:[-*•]\s*)?(?:\*\*)?Unidentified source references:(?:\*\*)?\s*Several assignments and statements are attributed only to Speaker \d+(?:,\s*Speaker \d+)*(?:,?\s*(?:or|and) Speaker \d+)?\. Their identities and, where applicable, their offices should be confirmed from the source record\.\s*$/i;

export function currentMinutesEditorialDraft(value) {
  const draft = omitClosingPrayerCommentary(value);
  if (!draft || typeof draft !== 'object') return draft;
  draft.closingFormatVersion = Number(draft.closingFormatVersion) >= 4 ? 4 : 3;
  if (Array.isArray(draft.sections)) draft.sections = draft.sections.map(section => {
    if (!section || typeof section.body !== 'string') return section;
    const body = section.body.split('\n').filter(line => !referenceDump.test(line)).map(line => {
      let cleaned = line;
      for (const sentence of sentences) cleaned = cleaned.replace(sentence, '');
      if (cleaned === line) return line;
      const meaningful = cleaned.replace(/<\/?(?:strong|em|u)>|[*_]/gi, '').replace(/^\s*[-•]\s*/, '').trim();
      return meaningful ? cleaned.replace(/[\t ]+$/, '') : '';
    }).filter(line => line.trim() && !/^\s*[-*•]\s*$/.test(line)).join('\n');
    return {...section, body};
  });
  return draft;
}

export function workingMinutesEditorialDraft(value) {
  const draft = currentMinutesEditorialDraft(value);
  draft.closingFormatVersion = 4;
  if (typeof draft.closingPrayerGiven !== 'boolean') {
    const closing = (draft.sections || []).filter(section => isClosingSection(section?.heading)).map(section => section.body).join('\n');
    draft.closingPrayerGiven = detectPrayerFacts(closing, {closingFormatVersion:4}).closingPrayerGiven !== false;
  }
  if (Array.isArray(draft.warnings)) {
    draft.warnings = draft.warnings.filter(warning => !/^Confirm whether the Chaplain gave the closing prayer(?: and prayed for the sick and distressed)?(?:; the cited source does not establish it)?\.?$/i.test(warning));
  }
  return draft;
}
