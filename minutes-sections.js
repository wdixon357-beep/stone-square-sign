export const SICKNESS_HEADING = 'Sickness and Distress';

// Match a complete agenda heading, never a sentence mentioning a Brother's
// health. Notes may decorate or number the same heading in several ways.
export function isSicknessHeading(value) {
  const stripMarkdown = text => text.replace(/^[\s#>*_`•-]+|[\s*_`]+$/g, '').trim();
  const unnumbered = stripMarkdown(String(value || '')).replace(/^(?:\d+[.)]|\(\d+\))\s*/, '');
  const label = stripMarkdown(stripMarkdown(unnumbered).replace(/:\s*$/, ''));
  return /^(?:sick(?:ness)?(?:\s+and\s+|\s*&\s*)distress(?:ed)?|sickness|distress)$/i.test(label);
}
