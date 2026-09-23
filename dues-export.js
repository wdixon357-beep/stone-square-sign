import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const lodge = 'Stone Square Lodge No. 22';
const money = cents => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars = cents => (Number(cents || 0) / 100).toFixed(2);
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const xml = value => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const stamp = date => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
}).format(date);
const fileStamp = date => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '00';
  return `${part('year')}-${part('month')}-${part('day')}_${part('hour')}-${part('minute')}-ET`;
};

export const duesExportFileName = (ledger, date, extension) => {
  if (!['pdf', 'xlsx'].includes(extension)) throw new Error('Unsupported dues export format.');
  const year = clean(ledger.duesYear).replace(/[^a-zA-Z0-9-]/g, '') || 'current';
  return `Stone-Square-Dues-Ledger-${year}-${fileStamp(date)}.${extension}`;
};

export async function buildDuesPdf(ledger, date = new Date()) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.075, 0.16, 0.25);
  const gold = rgb(0.73, 0.53, 0.22);
  const grey = rgb(0.36, 0.4, 0.45);
  const pale = rgb(0.96, 0.97, 0.98);
  const pageWidth = 792;
  const margin = 36;
  const pageHeight = 612;
  const columns = [
    { label: 'Brother', x: 42 }, { label: 'Assessed', x: 306 },
    { label: 'Paid', x: 382 }, { label: 'Balance', x: 460 },
    { label: 'Credit', x: 544 }, { label: 'Status', x: 613 },
    { label: 'Last paid', x: 681 },
  ];
  let page;
  let y;
  const header = (first = false) => {
    page = document.addPage([pageWidth, pageHeight]);
    page.drawRectangle({ x: 0, y: 552, width: pageWidth, height: 60, color: navy });
    page.drawText(lodge.toUpperCase(), { x: margin, y: 583, size: 10, font: bold, color: rgb(1, 1, 1) });
    page.drawText('DUES LEDGER', { x: margin, y: 563, size: 17, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`Masonic year ${clean(ledger.duesYear)}  |  Snapshot: ${stamp(date)}`, { x: margin, y: 532, size: 9, font: regular, color: navy });
    if (first) {
      page.drawText(`Assessment ${money(ledger.rateCents)}   Collected ${money(ledger.totals.collectedCents)}   Outstanding ${money(ledger.totals.outstandingCents)}`, { x: margin, y: 508, size: 10, font: bold, color: navy });
      page.drawText(`Paid in full ${ledger.totals.paidCount}   Partial ${ledger.totals.partialCount}   Not yet paid ${ledger.totals.unpaidCount}`, { x: margin, y: 490, size: 9, font: regular, color: grey });
      page.drawText('Current Zeffy campaigns and recorded Lodge adjustments. Amounts in USD.', { x: margin, y: 472, size: 8.5, font: regular, color: grey });
      y = 447;
    } else y = 505;
    page.drawRectangle({ x: margin, y: y - 5, width: pageWidth - margin * 2, height: 21, color: navy });
    for (const column of columns) page.drawText(column.label, { x: column.x, y: y + 2, size: 8, font: bold, color: rgb(1, 1, 1) });
    y -= 17;
  };
  const row = (values, index, emphasize = false) => {
    if (y < 48) header(false);
    if (index % 2 === 0) page.drawRectangle({ x: margin, y: y - 5, width: pageWidth - margin * 2, height: 18, color: pale });
    values.forEach((value, cell) => {
      const text = clean(value);
      const maxWidth = cell === 0 ? 256 : cell === 6 ? 72 : 66;
      let size = emphasize ? 8.4 : 8;
      while (size > 6.8 && (emphasize ? bold : regular).widthOfTextAtSize(text, size) > maxWidth) size -= 0.2;
      page.drawText(text, { x: columns[cell].x, y: y, size, font: emphasize ? bold : regular, color: navy });
    });
    y -= 18;
  };
  header(true);
  for (const [index, member] of ledger.rows.entries()) {
    row([member.name, money(member.assessedCents), money(member.paidCents), money(member.remainingCents),
      money(member.creditCents), String(member.status).toUpperCase(), member.lastPaymentISO || '-'], index);
  }
  if (y < 72) header(false);
  row(['TOTAL', money(ledger.totals.assessedCents), money(ledger.totals.collectedCents), money(ledger.totals.outstandingCents), '-', '', ''], ledger.rows.length, true);
  if (ledger.unmatched?.length || ledger.staleCampaign) {
    if (y < 105) header(false);
    y -= 12;
    page.drawText('RECONCILIATION NOTES', { x: margin, y, size: 9, font: bold, color: gold });
    y -= 15;
    if (ledger.unmatched?.length) {
      const total = ledger.unmatched.reduce((sum, item) => sum + item.amountCents, 0);
      page.drawText(`${ledger.unmatched.length} Zeffy payment(s), ${money(total)}, could not be matched to a Brother and are excluded from member balances.`, { x: margin, y, size: 8, font: regular, color: navy });
      y -= 15;
    }
    if (ledger.staleCampaign) {
      page.drawText(`${ledger.staleCampaign.count} payment(s), ${money(ledger.staleCampaign.totalCents)}, from last year's custom campaign are excluded.`, { x: margin, y, size: 8, font: regular, color: navy });
    }
  }
  const pages = document.getPages();
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: margin, y: 40 }, end: { x: pageWidth - margin, y: 40 }, thickness: 0.7, color: gold });
    item.drawText('PRIVATE LODGE FINANCIAL RECORD', { x: margin, y: 27, size: 7, font: bold, color: grey });
    item.drawText(`Page ${index + 1} of ${pages.length}  |  Generated ${stamp(date)}`, { x: 504, y: 27, size: 7, font: regular, color: grey });
  });
  return Buffer.from(await document.save());
}

const letters = index => {
  let value = index + 1;
  let result = '';
  while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
};
const sheetXml = ({ rows, widths, freeze, filter, merges = [] }) => {
  const renderedRows = rows.map((cells, rowIndex) => {
    const renderedCells = cells.map((item, columnIndex) => {
      if (item == null || item.value == null || item.value === '') return '';
      const ref = `${letters(columnIndex)}${rowIndex + 1}`;
      const style = item.style == null ? '' : ` s="${item.style}"`;
      return item.number
        ? `<c r="${ref}"${style}><v>${Number(item.value).toFixed(item.style === 5 ? 0 : 2)}</v></c>`
        : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(item.value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="30" customHeight="1"' : ''}>${renderedCells}</row>`;
  }).join('');
  const maxCol = letters(widths.length - 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${maxCol}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${renderedRows}</sheetData>${filter ? `<autoFilter ref="${filter}"/>` : ''}${merges.length ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : ''}<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="1" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
};
const s = (value, style) => ({ value, style });
const n = (value, style = 3) => ({ value, style, number: true });

export async function buildDuesXlsx(ledger, date = new Date()) {
  const book = new JSZip();
  const asOf = stamp(date);
  const detail = [
    [s(`${lodge} | Dues Ledger`, 1)], [s(`Snapshot generated ${asOf}`, 4)],
    [s('Masonic year', 2), s(ledger.duesYear)],
    [s('Assessment per Brother', 2), n(ledger.rateCents / 100)],
    [s('Collected', 2), n(ledger.totals.collectedCents / 100), s('Outstanding', 2), n(ledger.totals.outstandingCents / 100)],
    [s('Paid in full', 2), n(ledger.totals.paidCount, 5), s('Partial', 2), n(ledger.totals.partialCount, 5), s('Not yet paid', 2), n(ledger.totals.unpaidCount, 5)],
    [s('Current Zeffy campaigns plus Lodge adjustments. Snapshot only; update records in the Dashboard.', 4)],
    [],
    ['Brother', 'Assessed', 'Paid', 'Balance', 'Credit', 'Status', 'Last paid'].map(value => s(value, 2)),
    ...ledger.rows.map(row => [s(row.name), n(row.assessedCents / 100), n(row.paidCents / 100), n(row.remainingCents / 100), n(row.creditCents / 100), s(row.status), s(row.lastPaymentISO || '')]),
    [s('TOTAL', 2), n(ledger.totals.assessedCents / 100), n(ledger.totals.collectedCents / 100), n(ledger.totals.outstandingCents / 100)],
  ];
  const payments = [
    [s(`${lodge} | Payment detail`, 1)], [s(`Snapshot generated ${asOf}`, 4)],
    [s('Amounts shown here are already included in the member totals on the Ledger tab.', 4)], [],
    ['Brother', 'Date', 'Amount', 'Source', 'Method', 'Reference', 'Entered by'].map(value => s(value, 2)),
    ...ledger.rows.flatMap(row => row.payments.map(payment => [
      s(row.name), s(payment.dateISO || ''), n(payment.amountCents / 100),
      s(payment.campaign === 'manual' ? `Lodge ${payment.transactionType || 'payment'}` : `Zeffy ${payment.campaign}`),
      s(payment.paymentMethod || ''), s(payment.sourceReference || ''), s(payment.enteredBy || ''),
    ])),
  ];
  const unmatched = [
    [s(`${lodge} | Unmatched and excluded`, 1)], [s(`Snapshot generated ${asOf}`, 4)],
    [s('These amounts are not assigned to a Brother or counted in the member ledger.', 4)], [],
    ['Date', 'Amount', 'Buyer name', 'Buyer email'].map(value => s(value, 2)),
    ...(ledger.unmatched || []).map(item => [s(item.dateISO || ''), n(item.amountCents / 100), s(item.buyerName || ''), s(item.buyerEmail || '')]),
    [],
    [s('Prior-year custom campaign payments excluded from this dues year', 2), n(ledger.staleCampaign?.totalCents / 100 || 0), s(`${ledger.staleCampaign?.count || 0} payment(s)`) ],
  ];
  book.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  book.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  book.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/><sheet name="Payments" sheetId="2" r:id="rId2"/><sheet name="Unmatched" sheetId="3" r:id="rId3"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">Ledger!$1:$9</definedName><definedName name="_xlnm.Print_Titles" localSheetId="1">Payments!$1:$5</definedName><definedName name="_xlnm.Print_Titles" localSheetId="2">Unmatched!$1:$5</definedName></definedNames></workbook>');
  book.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  book.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;[Red](&quot;$&quot;#,##0.00)"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Aptos"/><color rgb="FF152B40"/></font><font><b/><sz val="16"/><name val="Aptos Display"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="10"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF152B40"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  book.file('xl/worksheets/sheet1.xml', sheetXml({ rows: detail, widths: [38, 17, 17, 17, 17, 18, 17], freeze: 9, filter: `A9:G${9 + ledger.rows.length}`, merges: ['A1:G1', 'A2:G2', 'A7:G7'] }));
  book.file('xl/worksheets/sheet2.xml', sheetXml({ rows: payments, widths: [38, 17, 17, 22, 18, 24, 28], freeze: 5, filter: `A5:G${Math.max(5, payments.length)}`, merges: ['A1:G1', 'A2:G2', 'A3:G3'] }));
  book.file('xl/worksheets/sheet3.xml', sheetXml({ rows: unmatched, widths: [18, 17, 32, 38], freeze: 5, filter: `A5:D${Math.max(5, 4 + (ledger.unmatched?.length || 0))}`, merges: ['A1:D1', 'A2:D2', 'A3:D3'] }));
  return book.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
