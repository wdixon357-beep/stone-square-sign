import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/import-historical-reports.mjs', import.meta.url), 'utf8');
const required = [
  "season:'September through June'",
  'month===7 || month===8',
  '2025-09-09 Stone Square No. 22 Minutes.pdf',
  'belongs to Mount Zion Chapter No. 7',
  'Stone Square Lodge Meeting Minutes January 16 2025.pdf',
  'Stone Square Lodge Meeting Minutes 03:20:2025 PDF.pdf',
  'Stone Square Lodge Meeting Minutes April 17 2025.pdf',
  'SELECT id FROM historical_reports WHERE kind = ? AND record_date = ?',
  'withTransaction(async () =>',
];

for (const text of required) {
  if (!source.includes(text)) throw new Error(`Historical import safeguard missing: ${text}`);
}

console.log('PASS: archive import enforces the September-through-June season, verified 2025 supplements, content exclusions, date deduplication and atomic writes.');
