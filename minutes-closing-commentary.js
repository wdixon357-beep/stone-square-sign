// Apply only to new/current editable minutes. Never pass captured attestation
// snapshots or historical records here: their original wording is retained.
const caveatText = /\b(?:the\s+)?(?:source|transcript|notes)\s+(?:does|do)\s+not\s+establish\s+(?:that|whether)\s+(?:this|it)\s+(?:was|is)\s+(?:a|the)\s+closing\s+prayer\b/giu;
const wrappers = [['***','***'],['___','___'],['**','**'],['__','__'],['*','*'],['_','_'],['<strong>','</strong>'],['<em>','</em>'],['<u>','</u>']];

export function omitClosingPrayerCommentaryText(value) {
  if (typeof value !== 'string') return value;
  const ranges = [];
  for (const match of value.matchAll(caveatText)) {
    let start = match.index, end = start + match[0].length;
    let punctuation = /[.!?]/.test(value[end] || '') && Boolean(value[end]);
    if (punctuation) end++;
    // Remove matching emphasis around this sentence only. Emphasis spanning a
    // larger paragraph is left in place, with every neighbouring fact intact.
    const wrapper = wrappers.find(([open, close]) => value.slice(0,start).endsWith(open) && value.startsWith(close,end));
    if (wrapper) {
      start -= wrapper[0].length; end += wrapper[1].length;
      if (!punctuation && /[.!?]/.test(value[end] || '') && value[end]) {end++;punctuation = true;}
    }
    // A matched prefix in a longer statement is not the requested sentence.
    // Without terminal punctuation, accept only an actual line/end boundary.
    if (!punctuation && !/^[\t ]*(?:\r\n?|\n|$)/.test(value.slice(end))) continue;
    ranges.push({start,end});
  }
  if (!ranges.length) return value;
  let marker = '\u0000closing-commentary\u0000';
  while (value.includes(marker)) marker += '\u0000';
  let replaced = value;
  for (const {start,end} of ranges.reverse()) replaced = replaced.slice(0,start) + marker + replaced.slice(end);
  let output = '';
  const lines = [...replaced.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(match => match[0]);
  for (const [,line,separator] of lines) {
    if (!line.includes(marker)) {output += line + separator;continue;}
    const remaining = line.split(marker).join('');
    if (/^\s*(?:(?:[-*•▪]|\d+[.)])\s*)?$/.test(remaining)) {
      if (!separator) output = output.replace(/(?:\r\n|\r|\n)$/, '');
      continue;
    }
    // Collapse only the whitespace bordering the removed sentence, not spacing
    // elsewhere in a surviving fact, quotation, date or time.
    const pieces = line.split(marker);
    let result = pieces.shift();
    for (let piece of pieces) {
      if (!result || /[\t ]$/.test(result) && /^[\t ]/.test(piece)) piece = piece.replace(/^[\t ]+/, '');
      result += piece;
    }
    output += result.replace(/[\t ]+$/, '') + separator;
  }
  return output;
}

export function omitClosingPrayerCommentary(draft = {}) {
  const cleaned = structuredClone(draft);
  if (!cleaned || typeof cleaned !== 'object') return cleaned;
  if (Array.isArray(cleaned.sections)) cleaned.sections = cleaned.sections.map(section => (
    section && typeof section === 'object' && typeof section.body === 'string'
      ? {...section, body:omitClosingPrayerCommentaryText(section.body)} : section
  ));
  if (Array.isArray(cleaned.warnings)) cleaned.warnings = cleaned.warnings.flatMap(warning => {
    const remaining = omitClosingPrayerCommentaryText(warning);
    return typeof warning === 'string' && remaining !== warning && !remaining.trim() ? [] : [remaining];
  });
  return cleaned;
}
