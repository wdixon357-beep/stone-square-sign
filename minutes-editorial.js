import {omitClosingPrayerCommentary} from './minutes-closing-commentary.js';

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
  draft.closingFormatVersion = 3;
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
