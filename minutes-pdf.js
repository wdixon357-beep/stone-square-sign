import fs from 'node:fs/promises';
import path from 'node:path';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  additionalPresent, financeRows, nonOfficerExcused, officerAttendanceRows, statusLabel,
} from './minutes-layout.js';

const BLACK = rgb(0.06, 0.06, 0.06);
const GRAY = rgb(0.38, 0.38, 0.38);
const RED = rgb(0.72, 0.08, 0.08);
const LETTER = [612, 792];
const MARGIN = 54;

const fullDate = (value) => {
  if (!value) return 'Date not confirmed';
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
};

const attestedDate = (value) => value ? new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  timeZone: 'America/New_York',
}).format(new Date(value)) : '';

const cleanPdfText = (value) => String(value || '')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2013\u2014]/g, ',')
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');

const wrap = (text, font, size, width) => {
  const lines = [];
  for (const paragraph of cleanPdfText(text).split(/\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
};

export const buildMinutesPdf = async ({
  draft, status, approvedByLodgeOn, preparedBy, preparerRole, preparedSignature,
  preparerAttestedAt, masterName, masterSignature, masterAttestedAt,
}) => {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const emblemBytes = await fs.readFile(path.join(process.cwd(), 'assets', 'meeting-minutes-emblem.png'));
  const emblem = await pdf.embedPng(emblemBytes);
  const preparerInk = preparedSignature ? await pdf.embedPng(preparedSignature) : null;
  const masterInk = masterSignature ? await pdf.embedPng(masterSignature) : null;
  const isOfficial = status === 'approved_by_lodge';
  let page;
  let y;
  let pageNumber = 0;

  const addPage = (continued = false) => {
    page = pdf.addPage(LETTER);
    pageNumber += 1;
    y = 738;
    if (continued) {
      const heading = 'STONE SQUARE LODGE NO. 22  MEETING MINUTES CONTINUED';
      page.drawText(heading, { x: (612 - bold.widthOfTextAtSize(heading, 10)) / 2, y, size: 10, font: bold, color: BLACK });
      y -= 24;
    }
    page.drawText(isOfficial ? 'OFFICIAL RECORD' : 'DRAFT  DO NOT DISTRIBUTE WITHOUT AUTHORIZATION', {
      x: MARGIN, y: 24, size: 8, font: bold, color: isOfficial ? BLACK : RED,
    });
    page.drawText(`Page ${pageNumber}`, { x: 522, y: 24, size: 8, font: regular, color: GRAY });
  };

  const ensure = (height) => { if (y - height < 48) addPage(true); };
  const center = (text, size, font = bold, color = BLACK) => {
    const value = cleanPdfText(text);
    page.drawText(value, { x: (612 - font.widthOfTextAtSize(value, size)) / 2, y, size, font, color });
    y -= size + 5;
  };
  const heading = (text) => {
    ensure(36);
    y -= 6;
    center(String(text).toUpperCase(), 13, bold);
    page.drawLine({ start: { x: MARGIN, y: y + 1 }, end: { x: 612 - MARGIN, y: y + 1 }, thickness: 0.6, color: BLACK });
    y -= 8;
  };
  const paragraphs = (text, { size = 10.5, font = regular, indent = 0 } = {}) => {
    for (const line of cleanPdfText(text).split(/\n+/).filter(Boolean)) {
      const motion = /^(MOTION|DISPOSITION):\s*(.*)$/i.exec(line);
      const lineFont = motion ? bold : font;
      const lines = wrap(line, lineFont, size, 612 - (MARGIN * 2) - indent);
      ensure(lines.length * 14 + 7);
      lines.forEach((part) => {
        page.drawText(part, { x: MARGIN + indent, y, size, font: lineFont, color: BLACK });
        y -= 14;
      });
      y -= 4;
    }
  };
  const simpleTable = (headers, rows, widths, fontSize = 9) => {
    const rowHeight = 22;
    const total = widths.reduce((a, b) => a + b, 0);
    const drawRow = (cells, header = false) => {
      ensure(rowHeight);
      let x = MARGIN;
      cells.forEach((cell, index) => {
        page.drawRectangle({ x, y: y - rowHeight + 5, width: widths[index], height: rowHeight, borderWidth: 0.5, borderColor: BLACK });
        const label = cleanPdfText(cell);
        const cellFont = header ? bold : regular;
        const available = widths[index] - 8;
        const fitted = label.length > 45 ? `${label.slice(0, 42)}...` : label;
        const centered = index >= cells.length - 3 || header;
        const tx = centered ? x + Math.max(4, (widths[index] - cellFont.widthOfTextAtSize(fitted, fontSize)) / 2) : x + 4;
        page.drawText(fitted, { x: tx, y: y - 10, size: fontSize, font: cellFont, color: BLACK });
        x += widths[index];
      });
      y -= rowHeight;
    };
    if (Math.abs(total - (612 - MARGIN * 2)) > 1) throw new Error('Minutes table widths do not fit the page.');
    drawRow(headers, true);
    rows.forEach((row) => drawRow(row));
    y -= 12;
  };

  addPage();
  page.drawImage(emblem, { x: 54, y: 657, width: 72, height: 83 });
  page.drawImage(emblem, { x: 486, y: 657, width: 72, height: 83 });
  center('STONE SQUARE LODGE NO. 22', 19);
  center('208 EAST LAKE STREET', 12);
  center('MIDDLETOWN, DELAWARE 19709', 12);
  y -= 5;
  center('MINUTES OF THE STATED COMMUNICATION', 14);
  center(fullDate(draft.meetingDate), 11, regular);
  center(isOfficial
    ? `APPROVED BY THE LODGE${approvedByLodgeOn ? ` ON ${fullDate(approvedByLodgeOn).toUpperCase()}` : ''}`
    : 'DRAFT FOR OFFICER REVIEW  NOT YET APPROVED BY THE LODGE', 9.5, bold, isOfficial ? BLACK : RED);
  y -= 7;
  simpleTable(['Meeting', 'Degree', 'Opening', 'Closing'], [[
    draft.meetingType || 'Not recorded', draft.degree || 'Not recorded',
    draft.openingTime || 'Not recorded', draft.closingTime || 'Not recorded',
  ]], [190, 138, 88, 88], 8.5);
  simpleTable(['Presiding', 'Quorum', 'Next Stated Communication'], [[
    draft.presiding || 'Not recorded', draft.quorum || 'Not recorded', draft.nextMeeting || 'Not recorded',
  ]], [205, 100, 199], 8.3);

  heading('Roll Call of Officers');
  simpleTable(['Name', 'Title', 'P', 'A', 'E', 'NR'], officerAttendanceRows(draft).map((officer) => [
    officer.name, officer.title,
    officer.status === 'present' ? 'X' : '', officer.status === 'absent' ? 'X' : '',
    officer.status === 'excused' ? 'X' : '', officer.status === 'not_recorded' ? 'X' : '',
  ]), [176, 184, 36, 36, 36, 36], 8.2);

  const attendanceGroups = [
    ['Additional Brothers Present', additionalPresent(draft)],
    ['Visitors', draft.visitors || []],
    ['Non Officers Excused From Meeting', nonOfficerExcused(draft)],
  ];
  attendanceGroups.forEach(([label, names]) => {
    heading(label);
    paragraphs(names.length ? names.join(', ') : 'None recorded.');
  });

  (draft.sections || []).forEach((section) => {
    heading(section.heading || 'Meeting Notes');
    paragraphs(section.body || 'No details recorded.');
  });

  const finance = [['Lodge Income', financeRows(draft.income)], ['Lodge Expenses', financeRows(draft.expenses)]];
  finance.forEach(([label, rows]) => {
    if (!rows.length) return;
    heading(label);
    simpleTable(['Date', 'Check or Ref', 'Brother or Payee', 'Amount'], rows.map((row) => [
      row.date, row.reference, row.party, row.amount,
    ]), [86, 86, 246, 86], 8.5);
  });

  heading('Officer Attestations');
  ensure(130);
  const signatureY = y - 56;
  if (preparerInk) page.drawImage(preparerInk, { x: 82, y: signatureY + 10, width: 190, height: 48 });
  if (masterInk) page.drawImage(masterInk, { x: 340, y: signatureY + 10, width: 190, height: 48 });
  page.drawLine({ start: { x: 72, y: signatureY }, end: { x: 282, y: signatureY }, thickness: 0.7, color: BLACK });
  page.drawLine({ start: { x: 330, y: signatureY }, end: { x: 540, y: signatureY }, thickness: 0.7, color: BLACK });
  const preparerName = cleanPdfText(preparedBy || 'Preparer');
  const masterDisplay = cleanPdfText(masterName || 'W. Aaron Dixon-Saunders');
  page.drawText(preparerName, { x: 177 - regular.widthOfTextAtSize(preparerName, 10) / 2, y: signatureY - 15, size: 10, font: regular, color: BLACK });
  page.drawText(masterDisplay, { x: 435 - regular.widthOfTextAtSize(masterDisplay, 10) / 2, y: signatureY - 15, size: 10, font: regular, color: BLACK });
  const preparerTitle = preparerRole === 'assistant_secretary' ? 'Assistant Secretary' : 'Secretary';
  page.drawText(preparerTitle, { x: 177 - italic.widthOfTextAtSize(preparerTitle, 9) / 2, y: signatureY - 29, size: 9, font: italic, color: GRAY });
  page.drawText('Worshipful Master', { x: 435 - italic.widthOfTextAtSize('Worshipful Master', 9) / 2, y: signatureY - 29, size: 9, font: italic, color: GRAY });
  const leftDate = preparerAttestedAt ? `Attested ${attestedDate(preparerAttestedAt)}` : 'Attestation pending';
  const rightDate = masterAttestedAt ? `Attested ${attestedDate(masterAttestedAt)}` : 'Attestation pending';
  page.drawText(leftDate, { x: 177 - regular.widthOfTextAtSize(leftDate, 8) / 2, y: signatureY - 42, size: 8, font: regular, color: GRAY });
  page.drawText(rightDate, { x: 435 - regular.widthOfTextAtSize(rightDate, 8) / 2, y: signatureY - 42, size: 8, font: regular, color: GRAY });

  return Buffer.from(await pdf.save());
};
