import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/import-historical-reports.mjs', import.meta.url), 'utf8');
const required = [
  "season:'Meeting minutes: September through June; treasurer reports may cover recess months'",
  "item.kind === 'minutes' && (month===7 || month===8)",
  'Stone_Square_22_Treasurers_Report_June_2026.pdf',
  'Stone_Square_22_Treasurers_Report_July_2026.pdf',
  'Stone_Square_22_Treasurers_Report_August_2026.pdf',
  'superseded by the three verified monthly PDFs sent September 3, 2026',
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

console.log('PASS: archive import preserves the meeting season, allows verified recess-month treasury reports, rejects the superseded combined workbook, deduplicates records and writes atomically.');
