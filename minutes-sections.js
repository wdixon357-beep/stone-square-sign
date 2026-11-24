export const SICKNESS_HEADING = 'Sickness and Distress';

const entryMarker = /^\s*(?:[-*•▪]|\d+[.)])[ \t]+(?=\S)/;
const unfinishedEntry = /(?:\b(?:a|an|the|and|or|of|for|with|to|from|by|at|as|on|in|until|before|after|was|were)\b|\b(?:Bro|Dr|Mr|Mrs|Ms)\.)$/i;
const markedContinuation = /^(?: {2,}|\t+)\S/;
const newMatter = /^(?:(?:HPM|PM|WM|SW|JW|Bro(?:ther)?|Sister)\.?\s+[A-Z]|[Mm]otion\s|[Pp]roposal\s|[Aa]ction\s*:)/;

// Join only clear continuations on the editable copy. A blank, marked item,
// heading, or standalone statement is a boundary even in a wrapped PDF import.
export function joinWrappedMinutesEntries(value, startsSection = () => false, {namedUpdates = false} = {}) {
  const lines = [];
  let markedEntry = false;
  let previousWasHeading = false;
  for (const raw of String(value || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const text = line.trimStart();
    const previous = lines.at(-1);
    const marked = entryMarker.test(line);
    const heading = startsSection(line) || /^(?:#{1,6}\s|[^.!?]{1,65}:\s*$)/.test(text);
    const previousText = previous?.replace(entryMarker, '').trimEnd();
    const incomplete = previousText && !/[:.!?…]["')\]]*$/.test(previousText);
    // In a marked list of family updates, a third-person follow-up can start
    // a new sentence inside the same item. A wrapped affiliation can also
    // start with a capital letter. Keep blanks, headings and new people apart.
    const sameUpdate = namedUpdates && markedEntry && previousText && (
      /^(?:He|She|They) (?:is|was|has|had|will|are|were|have)\b/.test(text)
      || incomplete && /\b(?:of|at|from) [A-Z][a-z]+$/.test(previousText)
        && /^[A-Z][\w'-]+ (?:Lodge|Chapter|Council|Court|Temple)\b/.test(text)
    );
    const continuation = previousText && text && !marked && !heading && !previousWasHeading && !newMatter.test(text)
      && (sameUpdate || unfinishedEntry.test(previousText) || incomplete && (markedEntry && markedContinuation.test(line)
        || (markedEntry || /[,;]$/.test(previousText)) && /^[a-z]/.test(text)));
    if (continuation) lines[lines.length - 1] = previous.trimEnd() + ' ' + text;
    else {
      lines.push(line);
      markedEntry = marked;
      previousWasHeading = heading;
    }
  }
  return lines.join('\n');
}

export function withMinutesEntryGrouping(draft) {
  if (!Array.isArray(draft?.sections)) return draft;
  return {...draft, entryFormatVersion: 1, sections: draft.sections.map(section =>
    section && typeof section.body === 'string' ? {...section, body: joinWrappedMinutesEntries(section.body, undefined, {
      namedUpdates: draft.sourceType === 'compiled_notes' && isSicknessHeading(section.heading)
        && section.body.split('\n').filter(line => entryMarker.test(line)).length >= 2,
    })} : section)};
}

// Match a complete agenda heading, never a sentence mentioning a Brother's
// health. Notes may decorate or number the same heading in several ways.
export function isSicknessHeading(value) {
  const stripMarkdown = text => text.replace(/^[\s#>*_`•-]+|[\s*_`]+$/g, '').trim();
  const unnumbered = stripMarkdown(String(value || '')).replace(/^(?:\d+[.)]|\(\d+\))\s*/, '');
  const label = stripMarkdown(stripMarkdown(unnumbered).replace(/:\s*$/, ''));
  return /^(?:sick(?:ness)?(?:\s+and\s+|\s*&\s*)distress(?:ed)?|sickness|distress)$/i.test(label);
}
