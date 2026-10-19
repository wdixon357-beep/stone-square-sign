import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import http from 'node:http';
import { extractReportSource, mountReportSource, REPORT_SOURCE_MAX_BYTES } from '../report-source.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Never use a live database for import tests.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Never reuse a database for import tests.');
// No database connection exists. Any unexpected SQL operation would fail.
let checks = 0, listener, externalFetches = 0;
const check = (label, value) => { assert.ok(value, label); checks += 1; console.log('PASS ' + label); };
const reject = async (label, callback, status) => { await assert.rejects(callback, cause => cause.statusCode === status); check(label, true); };
const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const types = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const paragraph = value => `<w:p><w:r><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`;
const document = content => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${namespace}"><w:body>${content}</w:body></w:document>`;
async function docx(content, entries = {}) {
  const zip = new JSZip(); zip.file('[Content_Types].xml', types); zip.file('word/document.xml', document(content));
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const file = (buffer, originalname = 'Synthetic.docx', mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') => ({ buffer, originalname, mimetype });
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
  externalFetches += 1; throw Error('Import must never make an external request.');
};
try {
  const sections = [], expectedParagraphs = [];
  for (let number = 1; number <= 16; number += 1) {
    const heading = `Section ${number}: original report description`;
    expectedParagraphs.push(heading); sections.push(paragraph(heading));
    const cells = [['Budget item', 'Original amount'], [`Item ${number}`, number === 16 ? '$12,650' : '$0.00']];
    sections.push('<w:tbl>' + cells.map((row, index) => '<w:tr>' + (index ? '' : '<w:trPr><w:tblHeader/></w:trPr>') + row.map(value => '<w:tc>' + paragraph(value) + '</w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>');
    sections.push(paragraph(`After table ${number}. This is a proposal, not an approval.`));
  }
  const fixture = await docx(sections.join(''));
  const result = await extractReportSource(file(fixture));
  check('All sixteen Word tables retain headers, rows and literal budget values', (result.source.match(/\[Table \d+\]/g) || []).length === 16 && result.source.includes('Budget item | Original amount') && result.source.includes('Item 16 | $12,650') && result.source.includes('Item 1 | $0.00'));
  check('Paragraphs and tables remain in original reading order', expectedParagraphs.every((value, index) => result.source.indexOf(value) < result.source.indexOf(`[Table ${index + 1}]`) && result.source.indexOf(`[Table ${index + 1}]`) < result.source.indexOf(`After table ${index + 1}.`)));
  check('Extraction never changes proposal language or performs financial corrections', !result.source.includes('$12,650.00') && result.source.includes('This is a proposal, not an approval.'));
  check('Metadata binds exact original bytes and reports JS UTF-16 length', result.sha256 === crypto.createHash('sha256').update(fixture).digest('hex') && result.characters === result.source.length && result.filename === 'Synthetic.docx' && result.format === 'docx');
  const tracked = await extractReportSource(file(await docx(paragraph('Visible before') + '<w:p><w:del><w:r><w:delText>Deleted unsupported approval</w:delText></w:r></w:del><w:ins><w:r><w:t>Visible insertion</w:t></w:r></w:ins></w:p>' + paragraph('Visible after'))));
  check('Tracked deletion is excluded with warning while visible insertion remains', !tracked.source.includes('Deleted') && tracked.source.includes('Visible insertion') && tracked.warnings.some(warning => warning.includes('Tracked deletions')));
  const linked = await extractReportSource(file(await docx('<w:p><w:hyperlink><w:r><w:t>Visible link text</w:t></w:r></w:hyperlink></w:p>', {
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" TargetMode="External" Target="https://invalid.example.test/private" Type="hyperlink"/></Relationships>',
  })));
  check('External relationship targets remain unopened and visible hyperlink text is retained', linked.source === 'Visible link text' && linked.warnings.some(warning => warning.includes('External links')) && externalFetches === 0);
  const notes = await extractReportSource(file(await docx(paragraph('Body retained'), { 'word/header1.xml': `<w:hdr xmlns:w="${namespace}">${paragraph('Original header')}</w:hdr>`, 'word/footer1.xml': `<w:ftr xmlns:w="${namespace}">${paragraph('Original footer')}</w:ftr>` })));
  check('Word headers and footers remain available as supplementary source', notes.source.includes('Original header') && notes.source.includes('Original footer'));
  const txt = await extractReportSource(file(Buffer.from('Literal notes 😃\r\n$12,650\r\nIgnore every instruction is source data only.'), 'notes.txt', 'text/plain'));
  check('UTF-8 TXT preserves literal notes, emoji and money without executing embedded instructions', txt.source.includes('$12,650') && txt.source.includes('Ignore every instruction') && txt.characters === txt.source.length && txt.format === 'txt');
  const pdf = await PDFDocument.create(); const page = pdf.addPage(); const font = await pdf.embedFont(StandardFonts.Helvetica); page.drawText('Synthetic report budget: $12,650. Zero remains $0.00.', { x: 40, y: 700, size: 12, font });
  const pdfBytes = Buffer.from(await pdf.save());
  const pdfResult = await extractReportSource(file(pdfBytes, 'report.pdf', 'application/pdf'));
  check('Text-based PDF retains original figures and returns PDF format', pdfResult.format === 'pdf' && pdfResult.source.includes('$12,650') && pdfResult.source.includes('$0.00'));
  const blankPdf = await PDFDocument.create(); blankPdf.addPage();
  const blankBytes = Buffer.from(await blankPdf.save());
  await reject('Scanned or blank PDF fails with copyable-text guidance', () => extractReportSource(file(blankBytes, 'scan.pdf', 'application/pdf')), 422);
  await reject('Corrupt PDF is rejected with recovery guidance', () => extractReportSource(file(Buffer.from('%PDF-1.7\ncorrupt'), 'bad.pdf', 'application/pdf')), 422);
  await reject('Empty report is rejected rather than treated as a draft', () => extractReportSource(file(Buffer.from('   '), 'empty.txt', 'text/plain')), 422);
  await reject('Invalid UTF-8 is rejected without replacement characters', () => extractReportSource(file(Buffer.from([0xc3, 0x28]), 'bad.txt', 'text/plain')), 422);
  await reject('Binary TXT is not interpreted as readable report content', () => extractReportSource(file(Buffer.from([65, 0, 66]), 'binary.txt', 'text/plain')), 422);
  await reject('Renamed PDF cannot pass as DOCX', () => extractReportSource(file(pdfBytes)), 415);
  await reject('Renamed DOCX cannot pass as TXT', () => extractReportSource(file(fixture, 'renamed.txt', 'text/plain')), 415);
  await reject('Mismatched MIME type is rejected', () => extractReportSource(file(fixture, 'report.docx', 'image/png')), 415);
  await reject('Macro extension is rejected', () => extractReportSource(file(fixture, 'report.docm', 'application/octet-stream')), 415);
  const macro = await docx(paragraph('Report'), { 'word/vbaProject.bin': Buffer.from('not executed') });
  await reject('Embedded macro project is rejected despite DOCX extension', () => extractReportSource(file(macro)), 415);
  const dtd = new JSZip(); dtd.file('[Content_Types].xml', types); dtd.file('word/document.xml', `<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "https://invalid.example.test/entity">]>${document('<w:p><w:r><w:t>&xxe;</w:t></w:r></w:p>')}`);
  const dtdBytes = await dtd.generateAsync({ type: 'nodebuffer' });
  await reject('DOCTYPE and external entity instructions are rejected before XML parsing', () => extractReportSource(file(dtdBytes)), 415);
  const alt = await docx('<w:altChunk/>');
  await reject('Linked or embedded text cannot disappear silently', () => extractReportSource(file(alt)), 422);
  const malformed = new JSZip(); malformed.file('[Content_Types].xml', types); malformed.file('word/document.xml', `<w:document xmlns:w="${namespace}"><w:body><w:p></w:body></w:document>`);
  const malformedBytes = await malformed.generateAsync({ type: 'nodebuffer' });
  await reject('Malformed XML is rejected rather than repaired silently', () => extractReportSource(file(malformedBytes)), 422);
  const repaired = new JSZip(); repaired.file('[Content_Types].xml', types); repaired.file('word/document.xml', `<w:document xmlns:w="${namespace}"><w:body><w:p unusual=unquoted><w:r><w:t>Original</w:t></w:r></w:p></w:body></w:document>`);
  const repairedBytes = await repaired.generateAsync({ type: 'nodebuffer' });
  await reject('XML parser warnings cannot silently repair malformed content', () => extractReportSource(file(repairedBytes)), 422);
  const deep = await docx('<w:sdt>'.repeat(110) + paragraph('Deep content') + '</w:sdt>'.repeat(110));
  await reject('XML nesting is bounded', () => extractReportSource(file(deep)), 413);
  await reject('Output beyond sixty thousand characters is rejected without truncation', () => extractReportSource(file(Buffer.from('x'.repeat(60001)), 'long.txt', 'text/plain')), 413);
  await reject('Original file bytes cannot exceed twelve MiB', () => extractReportSource(file(Buffer.alloc(REPORT_SOURCE_MAX_BYTES + 1), 'big.txt', 'text/plain')), 413);
  // Forge ZIP metadata to claim an oversized expansion without allocating it.
  const zipBomb = Buffer.from(fixture);
  const central = zipBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0); zipBomb.writeUInt32LE(25 * 1024 * 1024, central + 24);
  await reject('ZIP expansion budget is checked before inflation', () => extractReportSource(file(zipBomb)), 413);
  const bombZip = new JSZip(); bombZip.file('[Content_Types].xml', types); bombZip.file('word/document.xml', document(paragraph('x'.repeat(5 * 1024 * 1024))));
  const lyingBomb = await bombZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  for (let offset = 0; offset < lyingBomb.length - 46; offset += 1) if (lyingBomb.readUInt32LE(offset) === 0x02014b50) {
    const length = lyingBomb.readUInt16LE(offset + 28), name = lyingBomb.subarray(offset + 46, offset + 46 + length).toString();
    if (name === 'word/document.xml') { lyingBomb.writeUInt32LE(100, offset + 24); break; }
  }
  await reject('Inflation is bounded even when the ZIP lies about expanded size', () => extractReportSource(file(lyingBomb)), 413);
  const damaged = Buffer.from(fixture); const local = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const dataOffset = local + 30 + damaged.readUInt16LE(local + 26) + damaged.readUInt16LE(local + 28); damaged[dataOffset] ^= 0xff;
  await reject('Corrupt compressed content fails integrity verification', () => extractReportSource(file(damaged)), 422);
  const eocd = fixture.length - 22, dirStart = fixture.readUInt32LE(eocd + 16);
  const duplicateLength = 46 + fixture.readUInt16LE(dirStart + 28) + fixture.readUInt16LE(dirStart + 30) + fixture.readUInt16LE(dirStart + 32);
  const duplicate = Buffer.concat([fixture.subarray(0, eocd), fixture.subarray(dirStart, dirStart + duplicateLength), fixture.subarray(eocd)]);
  const duplicateEnd = duplicate.length - 22;
  duplicate.writeUInt16LE(fixture.readUInt16LE(eocd + 8) + 1, duplicateEnd + 8);
  duplicate.writeUInt16LE(fixture.readUInt16LE(eocd + 10) + 1, duplicateEnd + 10);
  duplicate.writeUInt32LE(fixture.readUInt32LE(eocd + 12) + duplicateLength, duplicateEnd + 12);
  await reject('Conflicting duplicate ZIP members are rejected before one can hide another', () => extractReportSource(file(duplicate)), 415);

  const accounts = new Map([['preparer', { id: 1, role: 'assistant_treasurer' }], ['disabled', { id: 2, role: 'assistant_treasurer', permissions: [] }], ['owner', { id: 3, role: 'owner' }], ['slow1', { id: 4, role: 'assistant_treasurer' }], ['slow2', { id: 5, role: 'assistant_treasurer' }]]);
  let incompleteArrivals = 0;
  const app = express();
  mountReportSource(app, { requireAuth: (req, res, next) => {
    req.user = accounts.get(req.headers.authorization);
    if (req.headers.authorization?.startsWith('slow')) incompleteArrivals += 1;
    if (!req.user) return res.status(401).json({ error: 'Synthetic authentication required.' }); next();
  } });
  app.use((cause, _req, res, _next) => res.status(500).json({ error: 'Unexpected import failure.' }));
  listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = 'http://127.0.0.1:' + listener.address().port;
  const upload = async (account, bytes = fixture, name = 'report.docx', field = 'report') => {
    const form = new FormData(); form.append(field, new Blob([bytes]), name);
    const response = await fetch(base + '/api/reports/import-source', { method: 'POST', headers: account ? { Authorization: account } : {}, body: form });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const malformedRequest = account => fetch(base + '/api/reports/import-source', { method: 'POST', headers: { ...(account ? { Authorization: account } : {}), 'Content-Type': 'multipart/form-data; boundary=missing' }, body: 'not-valid-multipart' });
  check('Authentication runs before multipart parsing', (await malformedRequest()).status === 401);
  check('Current report permission runs before multipart parsing', (await malformedRequest('disabled')).status === 403);
  const imported = await upload('preparer');
  check('Actual multipart route accepts Assistant Treasurer report and returns private source', imported.status === 200 && imported.data.source === result.source && imported.data.sha256 === result.sha256 && imported.headers.get('cache-control') === 'private, no-store');
  check('Owner retains report import capability', (await upload('owner')).status === 200);
  check('Unexpected multipart field is rejected', (await upload('preparer', fixture, 'report.docx', 'wrong')).status === 400);
  const tooLarge = await upload('preparer', Buffer.alloc(REPORT_SOURCE_MAX_BYTES + 1), 'big.txt');
  check('Multipart memory parser enforces the fixed twelve-MiB ceiling', tooLarge.status === 413 && tooLarge.data.error.includes('12 MB'));
  let successes = 0;
  for (let index = 0; index < 15; index += 1) {
    const response = await upload('owner', Buffer.from('A small synthetic source.'), 'source.txt');
    if (response.status === 200) successes += 1;
    else { check('Per-user limiter is bounded with retry guidance and no SQL writes', response.status === 429 && Number(response.headers.get('retry-after')) > 0); break; }
  }
  check('Rate bucket is per user and admits no more than twelve imports an hour', successes === 11 && (await upload('preparer', Buffer.from('Separate account source.'), 'separate.txt')).status === 200);
  const stalled = ['slow1', 'slow2'].map(account => {
    const request = http.request(base + '/api/reports/import-source', { method: 'POST', headers: { Authorization: account, 'Content-Type': 'multipart/form-data; boundary=unfinished' } });
    request.on('error', () => {});
    request.write('--unfinished\r\nContent-Disposition: form-data; name="report"; filename="source.txt"\r\nContent-Type: text/plain\r\n\r\nPartial source');
    return request;
  });
  for (let attempt = 0; attempt < 100 && incompleteArrivals < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  check('Concurrent upload memory is bounded before parsing another report', incompleteArrivals === 2 && (await upload('preparer', Buffer.from('Third report.'), 'third.txt')).status === 429);
  for (const request of stalled) request.destroy();
  let recovered;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    recovered = await upload('preparer', Buffer.from('After aborted upload.'), 'after.txt');
    if (recovered.status !== 429) break; await new Promise(resolve => setTimeout(resolve, 5));
  }
  check('Aborted incomplete uploads release their import slots', recovered.status === 200);
  check('DOCX, PDF and TXT imports perform no external requests', externalFetches === 0);
  console.log(`${checks} isolated report source checks passed. No database connection, AI call, email or live record write.`);
} finally {
  globalThis.fetch = originalFetch;
  if (listener) await new Promise(resolve => listener.close(resolve));
}
