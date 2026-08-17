/* Reads a Stone Square meeting packet (.docx) and works out what is fillable.
 *
 * The packets already carry their own placeholders, [Name], [Amount], [Reported by]
 * and so on, sitting inside table rows under named section headings. So the schema is
 * not something anybody has to write by hand and keep in step with the templates. It
 * is derived from the template itself, which means when William edits a packet the
 * tool follows him instead of drifting.
 *
 *   node schema.mjs "<path to .docx>"
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const PLACEHOLDER = /\[[^\]]{1,40}\]/g;

/* A .docx is a zip; word/document.xml holds the body. Reading it with unzip -p keeps
 * this dependency free, which matters because the app itself has to do this later. */
export const readDocumentXml = (docxPath) =>
  execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');

const textOf = (xml) =>
  [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');

/* Word splits one visible line across many <w:p> runs, and tables nest paragraphs
 * inside <w:tc> cells. Walk rows so a placeholder keeps the label sitting beside it. */
export const parseTemplate = (xml) => {
  const sections = [];
  let current = null;

  /* Section headings in these packets read "TITLE  |  Thursday, October 1, 2026",
   * and they live inside a single shaded table cell rather than a bare paragraph.
   * So every block is tested as a heading first, whatever kind it is. */
  const isHeading = (t) => t.match(/^([A-Z][A-Z'’,\s.&]{6,}?)\s*\|\s*\w{3,}day,/);

  const blocks = [...xml.matchAll(/<w:(p|tr)[ >][\s\S]*?<\/w:\1>/g)];
  for (const [block, kind] of blocks) {
    const cells = kind === 'tr'
      ? [...block.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((c) => textOf(c[0]).trim())
      : null;
    const t = (cells ? cells.join(' | ') : textOf(block)).trim();
    if (!t) continue;

    /* Heading bars are a table row whose leading cell is empty spacing, so join the
     * whole row and the text starts with a pipe. Test the first cell that has text. */
    const heading = isHeading(cells ? (cells.find(Boolean) || '') : t);
    if (heading) {
      current = { title: heading[1].trim(), rows: [], fixedRows: [], prose: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const holders = t.match(PLACEHOLDER) || [];
    if (cells) {
      if (holders.length) current.rows.push({ cells, placeholders: holders });
      else if (cells.length > 1) current.fixedRows.push(cells);
    } else if (holders.length) {
      current.prose.push({ text: t, placeholders: holders });
    }
  }
  return sections;
};

if (process.argv[1]?.endsWith('schema.mjs')) {
  const path = process.argv[2];
  if (!path || !fs.existsSync(path)) {
    console.error('Give a path to a .docx meeting packet.');
    process.exit(2);
  }
  const sections = parseTemplate(readDocumentXml(path));
  const fillable = sections.filter((s) => s.rows.length || s.prose.length);

  console.log(`sections found: ${sections.length}, of which ${fillable.length} have blanks\n`);
  const counts = {};
  for (const s of fillable) {
    const holders = [
      ...s.rows.flatMap((r) => r.placeholders),
      ...s.prose.flatMap((p) => p.placeholders),
    ];
    for (const h of holders) counts[h] = (counts[h] || 0) + 1;
    console.log(`  ${s.title}`);
    console.log(`     ${s.rows.length} fillable row(s), ${s.prose.length} prose blank(s), ${holders.length} placeholder(s)`);
    const sample = s.rows[0] || s.prose[0];
    if (sample) {
      const shown = sample.cells ? sample.cells.join(' | ') : sample.text;
      console.log(`     e.g. ${shown.slice(0, 96)}`);
    }
  }
  console.log('\nplaceholder types across the packet:');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  const sectionsWithNothing = sections.filter((s) => !s.rows.length && !s.prose.length);
  console.log(`\nstatic sections needing nothing: ${sectionsWithNothing.map((s) => s.title).join(', ')}`);
}
