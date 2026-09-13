import upng from '@pdf-lib/upng';
import { formatMinutesDate } from './public/minutes-dates.js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { bulletItems, sectionBlocks, documentSections, preparerOffice } from './minutes-format.js';

import {
  additionalPresent, nonOfficerExcused, officerAttendanceRows,
} from './minutes-layout.js';

const LETTER = [612, 792];
const LEFT = 45;
const WIDTH = 522;
const NAVY = rgb(11 / 255, 37 / 255, 63 / 255);
const GOLD = rgb(201 / 255, 162 / 255, 59 / 255);
const INK = rgb(31 / 255, 41 / 255, 55 / 255);
const GRAY = rgb(107 / 255, 114 / 255, 128 / 255);
const LIGHT = rgb(247 / 255, 247 / 255, 246 / 255);
const LINE = rgb(218 / 255, 222 / 255, 226 / 255);
const WHITE = rgb(1, 1, 1);
const RED = rgb(0.72, 0.08, 0.08);

const clean = (value) => String(value || '')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2013\u2014]/g, ',')
  .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')
  .trim();

// Align the visible ink, not the padded image canvas. Stored signature bytes
// remain unchanged; both original attestations and handwriting are preserved.
const signatureBottomInset = bytes => {
  const decoder = upng.default || upng;
  const image = decoder.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rgba = new Uint8Array(decoder.toRGBA8(image)[0]);
  for (let row = image.height - 1; row >= 0; row--) {
    for (let col = 0; col < image.width; col++) {
      const offset = (row * image.width + col) * 4;
      if (rgba[offset + 3] > 20 && Math.min(rgba[offset], rgba[offset + 1], rgba[offset + 2]) < 230) {
        return (image.height - 1 - row) / image.height * 50;
      }
    }
  }
  return 0;
};

const fullDate = (value) => formatMinutesDate(value, 'Date needs review');

const attestedDate = (value) => value ? new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  timeZone: 'America/New_York',
}).format(new Date(value)) : '';

export const buildMinutesPdf = async ({
  draft, status, approvedByLodgeOn, preparedBy, preparerRole, preparedSignature,
  preparerAttestedAt, masterName, masterSignature, masterAttestedAt, masterChanges = [],
}) => {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  const preparerInk = preparedSignature ? await pdf.embedPng(preparedSignature) : null;
  const masterInk = masterSignature ? await pdf.embedPng(masterSignature) : null;
  const dateLabel = fullDate(draft.meetingDate);
  const meetingType = clean(draft.meetingType) || 'Stated Communication';
  const isOfficial = status === 'approved_by_lodge';
  let page;
  let y;
  let currentTitle = '';

  const fitText = (text, font, size, maxWidth) => {
    let value = clean(text);
    if (!value) return '';
    while (font.widthOfTextAtSize(value, size) > maxWidth && value.length > 3) value = `${value.slice(0, -4).trim()}...`;
    return value;
  };

  const wrap = (text, font, size, maxWidth) => {
    const output = [];
    for (const paragraph of clean(text).split(/\n/)) {
      // Split long URLs and unbroken identifiers so pasted text stays inside the margins.
      const words = paragraph.trim().split(/\s+/).filter(Boolean).flatMap(word => {
        const pieces = [];
        let part = '';
        for (const character of word) {
          if (part && font.widthOfTextAtSize(part + character, size) > maxWidth) { pieces.push(part); part = ''; }
          part += character;
        }
        if (part) pieces.push(part);
        return pieces;
      });
      if (!words.length) { output.push(''); continue; }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
        else { output.push(line); line = word; }
      }
      if (line) output.push(line);
    }
    return output;
  };

  const footer = () => {
    const label = `Stone Square Lodge No. 22 | ${meetingType} | ${dateLabel} | Page ${pdf.getPageCount()}`;
    page.drawText(fitText(label, regular, 6.5, WIDTH), { x: LEFT, y: 24, size: 6.5, font: regular, color: GRAY });
    page.drawText(isOfficial ? 'OFFICIAL RECORD' : 'DRAFT  DO NOT DISTRIBUTE WITHOUT AUTHORIZATION', {
      x: LEFT, y: 36, size: 6.5, font: bold, color: isOfficial ? NAVY : RED,
    });
  };

  const startPage = (title, continued = false) => {
    currentTitle = title;
    page = pdf.addPage(LETTER);
    page.drawRectangle({ x: LEFT, y: 716, width: WIDTH, height: 38, color: NAVY });
    page.drawText(fitText(`${title.toUpperCase()}${continued ? ' CONTINUED' : ''}`, bold, 10, 330), {
      x: 57, y: 732, size: 10, font: bold, color: WHITE,
    });
    page.drawText(fitText(`|  ${dateLabel}`, regular, 7, 138), {
      x: 421, y: 733, size: 7, font: regular, color: GOLD,
    });
    y = 690;
    footer();
  };

  const ensure = (height) => {
    if (y - height >= 55) return;
    startPage(currentTitle, true);
  };

  const ruleHeading = (text) => {
    const lines = wrap(text, bold, 10, WIDTH);
    ensure(lines.length * 14 + 32);
    for (const [index, line] of lines.entries()) {
      if (index) y -= 14;
      page.drawText(line, { x: LEFT, y, size: 10, font: bold, color: NAVY });
    }
    y -= 9;
    page.drawLine({ start: { x: LEFT, y }, end: { x: LEFT + WIDTH, y }, thickness: 0.6, color: LINE });
    page.drawLine({ start: { x: LEFT, y }, end: { x: LEFT + 58, y }, thickness: 2, color: GOLD });
    y -= 17;
  };

  const paragraphs = (text, { size = 9, color = INK, empty = 'No information was recorded.' } = {}) => {
    const value = clean(text) || empty;
    const lines = wrap(value, regular, size, WIDTH - 8);
    for (const line of lines) {
      ensure(size + 7);
      if (line) page.drawText(line, { x: LEFT + 4, y, size, font: regular, color });
      y -= size + 4;
    }
    y -= 8;
  };

  const table = (headers, rows, widths, { size = 7.5, minRows = 0 } = {}) => {
    const sourceRows = [...rows];
    while (sourceRows.length < minRows) sourceRows.push(headers.map(() => ''));
    const drawHeader = () => {
      const height = 18;
      let x = LEFT;
      headers.forEach((header, index) => {
        page.drawRectangle({ x, y: y - height, width: widths[index], height, color: NAVY });
        const value = fitText(header, bold, size, widths[index] - 7);
        page.drawText(value, { x: x + (widths[index] - bold.widthOfTextAtSize(value, size)) / 2, y: y - 12, size, font: bold, color: WHITE });
        x += widths[index];
      });
      y -= height;
    };
    ensure(38);
    drawHeader();
    sourceRows.forEach((row, rowIndex) => {
      const wrapped = row.map((cell, index) => wrap(cell, regular, size, widths[index] - 8));
      const height = Math.max(19, Math.max(...wrapped.map((lines) => lines.length || 1)) * (size + 3) + 6);
      if (y - height < 55) { startPage(currentTitle, true); drawHeader(); }
      let x = LEFT;
      row.forEach((cell, index) => {
        page.drawRectangle({ x, y: y - height, width: widths[index], height, color: rowIndex % 2 ? LIGHT : WHITE, borderWidth: 0.35, borderColor: LINE });
        wrapped[index].forEach((line, lineIndex) => {
          page.drawText(line, { x: x + 4, y: y - 12 - lineIndex * (size + 3), size, font: regular, color: INK });
        });
        x += widths[index];
      });
      y -= height;
    });
    y -= 14;
  };

  const layoutBullet = (item) => {
    const size = 10, available = WIDTH - (item.bullet === false ? 0 : 20);
    const tokens = []; let token = [];
    for (const run of item.runs) {
      const font = run.bold ? (run.italic ? boldItalic : bold) : (run.italic ? italic : regular);
      // Join punctuation to its word even when the underline or font changes.
      for (const char of clean(`|${run.text}|`).slice(1, -1)) {
        const space = /\s/.test(char);
        if (token.length && space !== /\s/.test(token[0].text)) { tokens.push(token); token = []; }
        token.push({text: char, font, underline: run.underline, width: font.widthOfTextAtSize(char, size)});
      }
    }
    if (token.length) tokens.push(token);
    const lines = []; let line = [], width = 0;
    for (const token of tokens) {
      const tokenWidth = token.reduce((sum, part) => sum + part.width, 0);
      const chunks = tokenWidth > available ? token.map(part => [part]) : [token];
      for (const parts of chunks) {
        const partWidth = parts.reduce((sum, part) => sum + part.width, 0);
        if (width && width + partWidth > available) { lines.push(line); line = []; width = 0; }
        if (!width && parts.every(part => /\s/.test(part.text))) continue;
        line.push(...parts); width += partWidth;
      }
    }
    if (line.length) lines.push(line);
    // Coalesce adjacent characters to retain text extraction and compact PDFs.
    return lines.map(line => line.reduce((parts, char) => {
      const last = parts.at(-1);
      if (last && last.font === char.font && last.underline === char.underline) { last.text += char.text; last.width += char.width; }
      else parts.push({...char});
      return parts;
    }, []));
  };

  const renderBlocks = (items) => {
    const size = 10, lineHeight = 14;
    for (const item of items) {
      const indent = item.bullet === false ? LEFT : LEFT + 15;
      const lines = layoutBullet(item);
      ensure(Math.min(lines.length, 3) * lineHeight + 8);
      lines.forEach((parts, index) => {
        ensure(lineHeight + 3);
        if (index === 0 && item.bullet !== false) page.drawCircle({x: LEFT + 4, y: y + 3, size: 1.8, color: GOLD});
        let x = indent;
        for (const part of parts) {
          page.drawText(part.text, {x, y, size, font: part.font, color: INK});
          if (part.underline && part.text.trim()) page.drawLine({start: {x, y: y - 1.5}, end: {x: x + part.width, y: y - 1.5}, thickness: 0.45, color: INK});
          x += part.width;
        }
        y -= lineHeight;
      });
      y -= 8;
    }
  };

  const bullets = text => renderBlocks(bulletItems(text));

  startPage('Stone Square Lodge No. 22');
  page.drawImage(seal, {x: LEFT + WIDTH - 60, y: y - 33, width: 60, height: 60});
  page.drawText('Meeting Minutes', { x: LEFT, y, size: 24, font: bold, color: NAVY });
  y -= 24;
  for (const line of wrap(`${meetingType} | ${dateLabel}`, regular, 10, WIDTH - 76)) {
    page.drawText(line, {x: LEFT, y, size: 10, font: regular, color: GRAY}); y -= 14;
  }
  y -= 14;
  table(['Meeting Detail', 'Information'], [
    ['Degree', clean(draft.degree) || 'Needs review'],
    ['Opening / Closing', `${clean(draft.openingTime) || 'Needs review'} / ${clean(draft.closingTime) || 'Needs review'}`],
    ['Presiding Officer', clean(draft.presiding) || 'Needs review'],
    ['Quorum', clean(draft.quorum) || 'Needs review'],
  ], [155, 367], { size: 9 });
  ruleHeading('Attendance');
  table(['Officer', 'Office', 'Attendance'], officerAttendanceRows(draft).map(officer => [
    officer.name, officer.title, ({present: 'Present', absent: 'Absent', excused: 'Excused'})[officer.status] || 'Not recorded',
  ]), [220, 200, 102], { size: 8 });
  const additional = additionalPresent(draft);
  if (additional.length) { ruleHeading('Additional Brothers Present'); bullets(additional.join('\n')); }
  const excused = nonOfficerExcused(draft);
  if (excused.length) { ruleHeading('Other Brothers Excused'); bullets(excused.join('\n')); }
  if (draft.visitors?.length) { ruleHeading('Visitors'); bullets(draft.visitors.join('\n')); }

  // Render the editor's sections in order. No separate inferred financial ledger,
  // speculative motion results, empty worksheets, or repeated remarks pages.
  for (const section of documentSections(draft)) {
    if (!clean(section.body) && section.heading !== 'Sickness and Distress') continue;
    const closingHeight = section.heading === 'Closing of the Lodge'
      ? sectionBlocks(section).reduce((sum, item) => sum + layoutBullet(item).length * 14 + 8, 32) + (masterChanges.length ? 260 : 220) : 65;
    ensure(closingHeight);
    const title = clean(section.heading).replace(/^Grand Lodge Officers?'? Remarks$/i, 'Communications');
    ruleHeading(title || 'Meeting Business');
    renderBlocks(sectionBlocks(section));
  }
  ensure(masterChanges.length ? 260 : 220);
  ruleHeading('Attestation and Distribution');
  const preparerTitle = preparerOffice(preparedBy, preparerRole);
  paragraphs(isOfficial
    ? `Approved by the Lodge${approvedByLodgeOn ? ` on ${fullDate(approvedByLodgeOn)}` : ''}.`
    : masterAttestedAt ? "The Worshipful Master has authorized distribution of this draft. Formal Lodge approval remains pending."
      : "Working draft for officer review. Distribution requires the Worshipful Master's authorization.", { size: 9 });
  if (masterChanges.length) paragraphs("The preparing officer attested to the submitted version. The Worshipful Master's corrections and the original signed submission are retained in the record.", { size: 8 });
  const signatureY = y - 94;
  page.drawText('PREPARING OFFICER', {x: 61, y: y - 12, size: 8, font: bold, color: NAVY});
  page.drawText('WORSHIPFUL MASTER REVIEW', {x: 333, y: y - 12, size: 8, font: bold, color: NAVY});
  if (preparerInk) page.drawImage(preparerInk, { x: 65, y: signatureY + 2 - signatureBottomInset(preparedSignature), width: 195, height: 50 });
  if (masterInk) page.drawImage(masterInk, { x: 337, y: signatureY + 2 - signatureBottomInset(masterSignature), width: 195, height: 50 });
  page.drawLine({ start: { x: 55, y: signatureY }, end: { x: 277, y: signatureY }, thickness: 0.8, color: INK });
  page.drawLine({ start: { x: 327, y: signatureY }, end: { x: 549, y: signatureY }, thickness: 0.8, color: INK });
  const preparerName = clean(preparedBy) || 'Preparing Officer';
  const masterDisplay = clean(masterName) || 'W. Aaron Dixon-Saunders';
  page.drawText(fitText(preparerName, bold, 9, 210), { x: 61, y: signatureY - 16, size: 9, font: bold, color: NAVY });
  page.drawText(preparerTitle, { x: 61, y: signatureY - 30, size: 8, font: italic, color: GRAY });
  page.drawText(preparerAttestedAt ? `Attested ${attestedDate(preparerAttestedAt)}` : 'Attestation pending', { x: 61, y: signatureY - 44, size: 7, font: regular, color: GRAY });
  page.drawText(fitText(masterDisplay, bold, 9, 210), { x: 333, y: signatureY - 16, size: 9, font: bold, color: NAVY });
  page.drawText('Worshipful Master', { x: 333, y: signatureY - 30, size: 8, font: italic, color: GRAY });
  page.drawText(masterAttestedAt ? `Attested ${attestedDate(masterAttestedAt)}` : 'Attestation pending', { x: 333, y: signatureY - 44, size: 7, font: regular, color: GRAY });

  return Buffer.from(await pdf.save());
};
