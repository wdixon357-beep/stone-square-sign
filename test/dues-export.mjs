import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { buildDuesPdf, buildDuesXlsx, duesExportFileName } from '../dues-export.js';

const rows = Array.from({ length: 48 }, (_, index) => ({
  name: `Bro. Example Member ${index + 1}`,
  assessedCents: 17500,
  paidCents: index === 0 ? 5000 : 0,
  remainingCents: index === 0 ? 12500 : 17500,
  creditCents: 0,
  status: index === 0 ? 'partial' : 'unpaid',
  lastPaymentISO: index === 0 ? '2026-09-20' : null,
  payments: index === 0 ? [{ dateISO: '2026-09-20', amountCents: 5000, campaign: 'manual',
    transactionType: 'payment', paymentMethod: 'Check', sourceReference: 'TEST-1', enteredBy: 'Test Officer' }] : [],
}));
const ledger = {
  duesYear: '2026-2027', rateCents: 17500, rows,
  totals: { assessedCents: 840000, collectedCents: 5000, outstandingCents: 835000,
    paidCount: 0, partialCount: 1, unpaidCount: 47 },
  unmatched: [{ dateISO: '2026-09-21', amountCents: 2000, buyerName: 'Unknown Buyer', buyerEmail: 'test@example.invalid' }],
  staleCampaign: { count: 2, totalCents: 7500 },
};
const date = new Date('2026-09-23T14:42:00Z');
assert.equal(duesExportFileName(ledger, date, 'pdf'), 'Stone-Square-Dues-Ledger-2026-2027-2026-09-23_10-42-ET.pdf');
assert.throws(() => duesExportFileName(ledger, date, 'html'));

const pdfBytes = await buildDuesPdf(ledger, date);
assert.equal(pdfBytes.subarray(0, 4).toString(), '%PDF');
const pdf = await PDFDocument.load(pdfBytes);
assert.ok(pdf.getPages().length >= 2, 'all 48 Brothers need multiple legible pages');
assert.ok(pdf.getPages().every(page => page.getSize().width === 792 && page.getSize().height === 612));

const xlsxBytes = await buildDuesXlsx(ledger, date);
assert.equal(xlsxBytes.subarray(0, 2).toString(), 'PK');
const book = await JSZip.loadAsync(xlsxBytes);
const workbook = await book.file('xl/workbook.xml').async('string');
assert.match(workbook, /sheet name="Ledger"/);
assert.match(workbook, /sheet name="Payments"/);
assert.match(workbook, /sheet name="Unmatched"/);
assert.match(workbook, /Ledger!\$1:\$9/);
assert.match(workbook, /Payments!\$1:\$5/);
const sheet1 = await book.file('xl/worksheets/sheet1.xml').async('string');
const sheet2 = await book.file('xl/worksheets/sheet2.xml').async('string');
const sheet3 = await book.file('xl/worksheets/sheet3.xml').async('string');
assert.match(sheet1, /Snapshot generated September 23, 2026 at 10:42 AM EDT/);
assert.match(sheet1, /Bro\. Example Member 48/);
assert.match(sheet1, /<autoFilter ref="A9:G57"\/>/);
assert.match(sheet1, /<v>8350\.00<\/v>/);
assert.match(sheet2, /TEST-1/);
assert.match(sheet3, /Unknown Buyer/);
assert.match(sheet3, /test@example\.invalid/);
assert.doesNotMatch(sheet1, /#REF!|#VALUE!/);
if (process.env.DUES_EXPORT_SAMPLE_DIR) {
  await fs.mkdir(process.env.DUES_EXPORT_SAMPLE_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.DUES_EXPORT_SAMPLE_DIR, 'dues-sample.pdf'), pdfBytes);
  await fs.writeFile(path.join(process.env.DUES_EXPORT_SAMPLE_DIR, 'dues-sample.xlsx'), xlsxBytes);
}
console.log('Timestamped dues PDF and Excel export checks passed.');
