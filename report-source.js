import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { PDFParse } from 'pdf-parse';
import { hasPermission } from './access-control.js';

export const REPORT_SOURCE_MAX_BYTES = 12 * 1024 * 1024;
export const REPORT_SOURCE_MAX_CHARACTERS = 60000;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const WORD_NAMESPACES = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const word = (node, name) => node?.nodeType === 1 && WORD_NAMESPACES.has(node.namespaceURI) && (!name || node.localName === name);
const childElements = node => Array.from(node.childNodes || []).filter(child => child.nodeType === 1);
const isZip = bytes => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function decodeText(bytes, xml = false) {
  try {
    if (xml && bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (xml && bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw error(422, 'The file text is not readable. Save it as a regular Word document or UTF-8 TXT file, then upload that copy.'); }
}
function parseXml(bytes) {
  const source = decodeText(bytes, true);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw error(415, 'This Word document contains unsupported XML instructions. Save a new standard DOCX copy before uploading.');
  // Bound allocation before constructing a DOM, including XML that lies about
  // its nesting or contains an excessive number of attributes on one element.
  let depth = 0, elements = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '<') continue;
    const marker = source.startsWith('<!--', index) ? '-->' : source.startsWith('<![CDATA[', index) ? ']]>' : source.startsWith('<?', index) ? '?>' : null;
    if (marker) { const end = source.indexOf(marker, index + 2); if (end < 0) throw error(422, 'This Word document has incomplete XML. Save a new DOCX copy.'); index = end + marker.length - 1; continue; }
    let end = index + 1, quote = '', attributes = 0;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === '=') { if (++attributes > 256) throw error(413, 'This Word document is too complex to import safely. Save a simpler DOCX or TXT copy.'); }
      else if (char === '>') break;
    }
    if (end === source.length) throw error(422, 'This Word document has incomplete XML. Save a new DOCX copy.');
    const closing = source[index + 1] === '/', selfClosing = source.slice(index, end).trimEnd().endsWith('/');
    if (closing) depth -= 1;
    else if (++elements > 50000 || (!selfClosing && ++depth > 100)) throw error(413, 'This Word document is too complex to import safely. Save a simpler DOCX or TXT copy.');
    if (depth < 0) throw error(422, 'This Word document has invalid XML. Save a new DOCX copy.');
    index = end;
  }
  let document;
  try { document = new DOMParser({ errorHandler: { warning() { throw Error('Invalid XML'); }, error() { throw Error('Invalid XML'); }, fatalError() { throw Error('Invalid XML'); } } }).parseFromString(source, 'application/xml'); }
  catch { throw error(422, 'This Word document is damaged. Open it in Word and save a new DOCX copy, then try again.'); }
  const pending = [{ node: document, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++nodes > 100000 || depth > 100) throw error(413, 'This Word document is too complex to import safely. Save a simpler DOCX or UTF-8 TXT copy.');
    for (const child of Array.from(node.childNodes || [])) pending.push({ node: child, depth: depth + 1 });
  }
  return document;
}
function validateZipDirectory(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw error(422, 'This Word document has a damaged ZIP directory. Save a new DOCX copy.');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > 256) throw error(413, 'This Word document contains too many internal files. Save a simpler DOCX copy.');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || start + size !== end) throw error(422, 'This Word document has an unsupported ZIP structure. Save a new DOCX copy.');
  let offset = start; const names = new Set();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw error(422, 'This Word document has a damaged ZIP directory. Save a new DOCX copy.');
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + length + extra + comment > end) throw error(422, 'This Word document has a damaged ZIP directory. Save a new DOCX copy.');
    const name = decodeText(bytes.subarray(offset + 46, offset + 46 + length));
    if (names.has(name)) throw error(415, 'This Word document contains conflicting internal files. Save a new DOCX copy.');
    names.add(name);
    if (bytes.readUInt16LE(offset + 8) & 1) throw error(415, 'Encrypted Word documents are not supported. Save an unencrypted DOCX copy.');
    offset += 46 + length + extra + comment;
  }
  if (offset !== end) throw error(422, 'This Word document has a damaged ZIP directory. Save a new DOCX copy.');
}
async function unzipDocument(bytes) {
  validateZipDirectory(bytes);
  let zip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw error(422, 'This is not a readable Word document. Save a new DOCX copy in Word and upload it again.'); }
  const entries = Object.values(zip.files);
  if (!entries.length || entries.length > 256) throw error(413, 'This Word document contains too many internal files. Save a simpler DOCX copy.');
  let expanded = 0;
  for (const entry of entries) {
    const original = entry.unsafeOriginalName || entry.name;
    if (/\\|(?:^|\/)\.\.(?:\/|$)|^\//.test(original)) throw error(415, 'This Word document has an unsafe internal structure. Save a new standard DOCX copy.');
    if (/vbaProject|\.bin$|\.docm$/i.test(original)) throw error(415, 'Macro-enabled or embedded-program documents are not supported. Save a macro-free DOCX copy.');
    if (entry.dir) continue;
    const size = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED_BYTES || (expanded += size) > MAX_EXPANDED_BYTES) throw error(413, 'This Word document expands beyond the safe import limit. Save a smaller DOCX or TXT copy.');
    if (size > 1024 * 1024 && size > Math.max(1, entry._data.compressedSize) * 1000) throw error(413, 'This Word document has an unsafe compression ratio. Save a new DOCX or TXT copy.');
  }
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw error(415, 'The selected file is not a standard DOCX report. Choose a Word DOCX, text-based PDF or UTF-8 TXT file.');
  let actualTotal = 0;
  const read = name => new Promise((resolve, reject) => {
    const entry = zip.file(name); if (!entry) return resolve(null);
    const chunks = []; let length = 0, failed = false;
    const stream = entry.internalStream('nodebuffer');
    stream.on('data', chunk => {
      if (failed) return;
      length += chunk.length; actualTotal += chunk.length;
      if (length > MAX_XML_BYTES || actualTotal > MAX_EXPANDED_BYTES) {
        failed = true; stream.pause(); reject(error(413, 'This Word document expands beyond the safe import limit. Save a smaller DOCX or TXT copy.')); return;
      }
      chunks.push(chunk);
    });
    stream.on('error', () => { if (!failed) { failed = true; reject(error(422, 'This Word document is damaged. Save a new DOCX copy and try again.')); } });
    stream.on('end', () => {
      if (failed) return;
      const result = Buffer.concat(chunks);
      if (result.length !== entry._data.uncompressedSize || crc32(result) !== (entry._data.crc32 >>> 0)) return reject(error(422, 'This Word document failed its integrity check. Save a new DOCX copy and try again.'));
      resolve(result);
    }); stream.resume();
  });
  const types = decodeText(await read('[Content_Types].xml'), true);
  // Parse all consumed XML with the same entity/structure guards, including
  // metadata, before reading report content. No relationship is ever fetched.
  parseXml(Buffer.from(types));
  if (!types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') || /macroEnabled|vbaProject/i.test(types)) throw error(415, 'The file is not a macro-free Word DOCX report. Save a regular DOCX copy.');
  return { zip, read };
}

async function docxSource(bytes) {
  const { zip, read } = await unzipDocument(bytes);
  const document = parseXml(await read('word/document.xml'));
  if (!word(document.documentElement, 'document')) throw error(415, 'The selected file is not a standard Word report. Save it as DOCX again.');
  const warnings = new Set(); let tableNumber = 0;
  const all = Array.from(document.getElementsByTagName('*'));
  if (all.some(node => word(node, 'del') || word(node, 'moveFrom'))) warnings.add('Tracked deletions were excluded and visible insertions were kept. Check the imported text against the visible Word document.');
  if (all.some(node => word(node, 'drawing') || word(node, 'pict') || word(node, 'object'))) warnings.add('Images and embedded objects were not read. Copy any important text from them into the source before organizing.');
  if (all.some(node => word(node, 'altChunk') || word(node, 'subDoc'))) throw error(422, 'This Word document includes linked or embedded text that cannot be imported completely. Save it as a text-based PDF or UTF-8 TXT file.');
  if (all.some(node => word(node, 'gridSpan') || word(node, 'vMerge'))) warnings.add('Merged table cells are represented as text rows. Verify their headings and amounts against the original report.');
  function inline(node) {
    if (word(node, 'del') || word(node, 'moveFrom') || word(node, 'instrText') || word(node, 'delText')) return '';
    if (word(node, 't')) return node.textContent;
    if (word(node, 'tab')) return '\t';
    if (word(node, 'br') || word(node, 'cr')) return '\n';
    if (word(node, 'noBreakHyphen')) return '\u2011';
    if (word(node, 'tbl')) return '\n' + table(node) + '\n';
    if (word(node, 'txbxContent')) return blocks(node).join('\n\n');
    return childElements(node).map(inline).join('');
  }
  function table(node) {
    if (++tableNumber > 1000) throw error(413, 'This report contains too many tables. Save a smaller report copy.');
    const label = `[Table ${tableNumber}]`;
    const rows = [];
    const visit = parent => {
      for (const child of childElements(parent)) {
        if (word(child, 'del') || word(child, 'moveFrom')) continue;
        if (word(child, 'tr')) {
          const cells = [];
          const collect = row => { for (const part of childElements(row)) { if (word(part, 'tc')) cells.push(blocks(part).join(' / ')); else if (!word(part, 'tbl')) collect(part); } };
          collect(child); rows.push(cells.join(' | '));
        } else if (!word(child, 'tbl')) visit(child);
      }
    };
    visit(node); return [label, ...rows].join('\n');
  }
  function blocks(node) {
    const values = [];
    for (const child of childElements(node)) {
      if (word(child, 'del') || word(child, 'moveFrom')) continue;
      if (word(child, 'p')) { const value = inline(child); if (value.trim()) values.push(value); }
      else if (word(child, 'tbl')) values.push(table(child));
      else values.push(...blocks(child));
    }
    return values;
  }
  const source = blocks(document.documentElement).join('\n\n');
  // Headers, footers and notes are retained once as supplementary source text.
  const supplementary = [];
  for (const name of Object.keys(zip.files).filter(name => /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name)).sort()) {
    const part = parseXml(await read(name));
    const values = blocks(part.documentElement);
    if (values.length) supplementary.push(`[${path.basename(name, '.xml')}]\n${values.join('\n\n')}`);
  }
  if (zip.file('word/comments.xml')) warnings.add('Editorial comments were not included in the report text.');
  for (const name of Object.keys(zip.files).filter(name => /\.rels$/.test(name))) {
    const relations = parseXml(await read(name));
    if (Array.from(relations.getElementsByTagName('*')).some(node => node.getAttribute('TargetMode') === 'External')) warnings.add('External links were not opened. Their visible report text was retained.');
  }
  return { source: [source, ...supplementary].filter(Boolean).join('\n\n'), warnings: [...warnings] };
}

async function pdfSource(bytes) {
  const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false,
    useSystemFonts: false, disableFontFace: true, stopAtErrors: true });
  try {
    const info = await parser.getInfo();
    if (info.total > 100) throw error(413, 'Import no more than 100 PDF pages. Save the report section you need as a separate file.');
    const pages = []; let characters = 0;
    for (let number = 1; number <= info.total; number += 1) {
      const result = await parser.getText({ partial: [number], pageJoiner: '', cellSeparator: ' | ', parseHyperlinks: false });
      const value = result.pages[0]?.text || '';
      if (!value.trim()) throw error(422, `PDF page ${number} has no copyable text. Upload the Word version or a text-based PDF so no report content is missed.`);
      characters += value.length + 2;
      if (characters > REPORT_SOURCE_MAX_CHARACTERS) throw error(413, 'The report contains more than 60,000 characters. Choose a smaller report file; nothing was imported.');
      pages.push(value);
    }
    return { source: pages.join('\n\n'), warnings: ['PDF table columns are represented as text. Verify their headings and amounts against the original report.'] };
  } catch (cause) {
    if (cause.statusCode) throw cause;
    throw error(422, 'The PDF could not be read. Remove password protection or save a new text-based PDF, DOCX or UTF-8 TXT copy.');
  } finally { await parser.destroy().catch(() => {}); }
}

export async function extractReportSource(file) {
  if (!file?.buffer?.length) throw error(400, 'Choose a Word DOCX, text-based PDF or UTF-8 TXT report.');
  const bytes = Buffer.from(file.buffer);
  if (bytes.length > REPORT_SOURCE_MAX_BYTES) throw error(413, 'The report must be 12 MB or smaller.');
  const filename = path.basename(String(file.originalname || '').replaceAll('\\', '/')).replace(/[\u0000-\u001f]/g, '').trim();
  const format = path.extname(filename).slice(1).toLowerCase();
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  const types = { docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'], pdf: ['application/pdf'], txt: ['text/plain'] };
  if (!types[format] || filename.length > 255 || (mime && mime !== 'application/octet-stream' && !types[format].includes(mime))) throw error(415, 'Choose a Word DOCX, text-based PDF or UTF-8 TXT file with its correct file extension.');
  let result;
  if (format === 'docx') {
    if (!isZip(bytes)) throw error(415, 'This file does not match its DOCX extension. Save a regular Word DOCX copy and try again.');
    result = await docxSource(bytes);
  } else if (format === 'pdf') {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw error(415, 'This file does not match its PDF extension. Choose the original PDF or save a new PDF copy.');
    result = await pdfSource(bytes);
  } else {
    if (isZip(bytes) || bytes.subarray(0, 5).toString() === '%PDF-' || bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') throw error(415, 'This file does not match its TXT extension. Upload the original DOCX, PDF or UTF-8 TXT file.');
    const source = decodeText(bytes);
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(source)) throw error(422, 'This TXT file contains unreadable data. Save it as UTF-8 plain text and try again.');
    result = { source, warnings: [] };
  }
  const source = result.source.replace(/\r\n?/g, '\n').trim();
  if (!source) throw error(422, 'No readable report text was found. Upload the Word version, a text-based PDF or a UTF-8 TXT file.');
  if (source.length > REPORT_SOURCE_MAX_CHARACTERS) throw error(413, 'The report contains more than 60,000 characters. Choose a smaller report file; nothing was imported.');
  return { source, filename, format, characters: source.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), warnings: result.warnings };
}

export function mountReportSource(app, { requireAuth, now = () => Date.now() }) {
  const buckets = new Map(); let active = 0;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: REPORT_SOURCE_MAX_BYTES, files: 1, fields: 0, parts: 2 } }).single('report');
  app.post('/api/reports/import-source', requireAuth, (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!hasPermission(req.user, 'reports.create')) return res.status(403).json({ error: 'Report Generator access is not enabled for your account.' });
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.reset <= time) buckets.delete(key);
    const key = String(req.user.id), bucket = buckets.get(key) || { count: 0, reset: time + 3600000 };
    if (bucket.count >= 12 || (!buckets.has(key) && buckets.size >= 1000) || active >= 2) {
      res.setHeader('Retry-After', active >= 2 ? '15' : String(Math.max(1, Math.ceil((bucket.reset - time) / 1000))));
      return res.status(429).json({ error: active >= 2 ? 'Other reports are being imported. Please try again in 15 seconds.' : 'Too many reports were imported from this account. Please try again later.' });
    }
    bucket.count += 1; buckets.set(key, bucket); active += 1;
    let released = false, bodyParsed = false;
    const release = () => { if (!released) { released = true; active -= 1; } };
    req.once('aborted', () => { if (!bodyParsed) release(); });
    upload(req, res, async cause => {
      bodyParsed = true;
      try {
        if (req.aborted || res.destroyed) return;
        if (cause) throw error(cause.code === 'LIMIT_FILE_SIZE' ? 413 : 400, cause.code === 'LIMIT_FILE_SIZE' ? 'The report must be 12 MB or smaller.' : 'Choose one report file only, using the upload control.');
        res.json(await extractReportSource(req.file));
      } catch (failure) {
        if (failure.statusCode) res.status(failure.statusCode).json({ error: failure.message });
        else next(failure);
      } finally { release(); }
    });
  });
}
