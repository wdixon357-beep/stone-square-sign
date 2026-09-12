import fs from 'node:fs/promises';
import path from 'node:path';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  additionalPresent, financeRows, nonOfficerExcused, officerAttendanceRows,
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
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
  .trim();

const fullDate = (value) => {
  if (!value) return 'Date needs review';
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return clean(value);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
};

const attestedDate = (value) => value ? new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  timeZone: 'America/New_York',
}).format(new Date(value)) : '';

const sectionText = (draft, ...names) => (draft.sections || [])
  .filter((section) => names.some((name) => clean(section.heading).toLowerCase() === name.toLowerCase()))
  .map((section) => clean(section.body)).filter(Boolean).join('\n');

const withoutLabels = (value) => clean(value).replace(/^(?:MOTION|DISPOSITION):\s*/i, '');

const motionRows = (draft) => {
  const text = sectionText(draft, 'New Business and Motions', 'Motions');
  return text.split(/\n+/).map(clean)
    .filter((line) => /\b(motion|moved|seconded|carried|failed|adopted|defeated|tabled)\b/i.test(line))
    .map((line) => {
      const moved = /\bmoved by\s+(.+?)(?=,|;|\.|\s+and\s+|\s+seconded)/i.exec(line)?.[1] || '';
      const seconded = /\bseconded by\s+(.+?)(?=,|;|\.|\s+(?:carried|failed|adopted|defeated|tabled)\b)/i.exec(line)?.[1] || '';
      const result = /\b(carried|failed|adopted|defeated|tabled)\b/i.exec(line)?.[1] || '';
      return [withoutLabels(line), moved, seconded, result];
    });
};

const historicalRows = [
  ['Craig Wilson', '2024 to 2026', 'Fred Cooke', '2012 to 2014'],
  ['ZaMair Jones', '2023 to 2024', 'Howard Young', '2010 to 2012'],
  ['Fred Cooke', '2022 to 2023', 'Johnie Burton', '2009 to 2010'],
  ['James Thomas', '2020 to 2022', 'Kenny Davis', '2004 to 2006'],
  ['Maurice Mobley Sr.', '2018 to 2020', 'Demetrius Rodgers', '2002 to 2004'],
  ['Wm. Aubrey Saunders', '2016 to 2018', 'Luther Turner', ''],
  ['Ronald Vann', '2014 to 2016', 'William "Bill" Saunders', ''],
  ['John Brown III', '2013 to 2015', 'Ernest "Rock" Saunders', ''],
];

const templateSectionNames = new Set([
  'opening', 'roll call and quorum', 'sickness and distress', 'praise report', 'good of the order',
  'reading of the minutes', 'previous minutes', "treasurer's report", 'demits', 'petitions',
  'balloting', 'degree work', 'communications', 'unfinished business', 'new business and motions',
  'new business', 'committee reports', 'elections', 'visitors', "brothers' remarks", "wardens' remarks",
  "past masters' remarks", "grand lodge officers' remarks", 'prayer and closing',
  'upcoming events and reminders', 'motions',
]);

export const buildMinutesPdf = async ({
  draft, status, approvedByLodgeOn, preparedBy, preparerRole, preparedSignature,
  preparerAttestedAt, masterName, masterSignature, masterAttestedAt,
}) => {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const emblem = await pdf.embedPng(await fs.readFile(path.join(process.cwd(), 'assets', 'meeting-minutes-emblem.png')));
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
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
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
    page.drawImage(emblem, { x: 51, y: 721, width: 24, height: 28 });
    page.drawText(fitText(`${title.toUpperCase()}${continued ? ' CONTINUED' : ''}`, bold, 10, 330), {
      x: 84, y: 732, size: 10, font: bold, color: WHITE,
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
    ensure(32);
    page.drawText(clean(text), { x: LEFT, y, size: 10, font: bold, color: NAVY });
    y -= 9;
    page.drawLine({ start: { x: LEFT, y }, end: { x: LEFT + WIDTH, y }, thickness: 0.8, color: NAVY });
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

  const cover = pdf.addPage(LETTER);
  page = cover;
  page.drawRectangle({ x: LEFT, y: 510, width: WIDTH, height: 216, color: NAVY });
  page.drawImage(emblem, { x: 271, y: 640, width: 70, height: 81 });
  const centered = (text, py, size, font = bold, color = WHITE) => {
    const value = fitText(text, font, size, WIDTH - 30);
    page.drawText(value, { x: (612 - font.widthOfTextAtSize(value, size)) / 2, y: py, size, font, color });
  };
  centered('STONE SQUARE LODGE NO. 22', 600, 20);
  centered('Meeting Minutes', 573, 15, bold, GOLD);
  centered('Most Worshipful Prince Hall Grand Lodge | Free and Accepted Masons | Jurisdiction of Delaware', 547, 7.5, regular);
  centered('208 East Lake Street | Middletown, Delaware 19709', 532, 8, regular);
  page.drawRectangle({ x: LEFT, y: 410, width: WIDTH, height: 74, color: rgb(246 / 255, 241 / 255, 229 / 255), borderColor: NAVY, borderWidth: 0.7 });
  centered(dateLabel, 454, 17, bold, NAVY);
  centered(meetingType, 431, 11, bold, INK);
  centered(clean(draft.degree) || 'Degree needs review', 415, 9.5, italic, GOLD);
  centered(`Presiding Officer: ${clean(draft.presiding) || 'Needs review'}`, 347, 9, regular, INK);
  centered(`Next Meeting: ${clean(draft.nextMeeting) || 'Needs review'}`, 327, 9, regular, INK);
  centered(isOfficial
    ? `Approved by the Lodge${approvedByLodgeOn ? ` on ${fullDate(approvedByLodgeOn)}` : ''}`
    : "Draft for officer review. Distribution requires the Worshipful Master's authorization.", 277, 8.5, bold, isOfficial ? NAVY : RED);
  footer();

  startPage('Meeting Snapshot');
  table(['Meeting Detail', 'Information'], [
    ['Date', dateLabel], ['Opening Time', clean(draft.openingTime) || 'Needs review'],
    ['Meeting Type', meetingType], ['Location', 'Stone Square Lodge No. 22, 208 East Lake Street, Middletown, Delaware 19709'],
    ['Degree', clean(draft.degree) || 'Needs review'], ['Presiding Officer', clean(draft.presiding) || 'Needs review'],
    ['Quorum', clean(draft.quorum) || 'Needs review'], ['Minutes Prepared By', clean(preparedBy) || 'Needs review'],
    ['Next Meeting', clean(draft.nextMeeting) || 'Needs review'],
  ], [160, 362], { size: 8 });
  ruleHeading('Secretary and Assistant Secretary Check');
  paragraphs("Previous minutes reviewed\nTreasurer report recorded\nCommunications placed in the proper section\nMotions and action items captured\nDistribution held for the Worshipful Master's authorization");

  startPage('Lodge Elected and Appointed Officers');
  table(['Name', 'Title'], officerAttendanceRows(draft).map((officer) => [officer.name, officer.title]), [300, 222], { size: 8.3 });
  ruleHeading('Lodge Meeting Order of Business');
  table(['#', 'Business', '#', 'Business'], [
    ['1', 'Opening of the Lodge', '13', 'Committee Reports'], ['2', 'Calling the Roll of Officers', '14', 'Elections, if applicable'],
    ['3', 'Sickness and Distress', '15', 'Visitors'], ['4', 'Reading and Approval of Previous Minutes', '16', "Brothers' Remarks"],
    ['5', "Treasurer's Report", '17', "Wardens' Remarks"], ['6', 'Demits', '18', "Past Masters' Remarks"],
    ['7', 'Petitions', '19', 'Additional Remarks, if applicable'], ['8', 'Balloting', '20', 'Reading of Current Meeting Notes'],
    ['9', 'Degree Work', '21', 'Motions and Dispositions'], ['10', 'Reading of Communications', '22', 'Prayer'],
    ['11', 'Unfinished Business', '23', 'Closing of the Lodge'], ['12', 'New Business', '', ''],
  ], [30, 230, 30, 232], { size: 7.2 });

  startPage('Official Meeting Notes');
  const opening = sectionText(draft, 'Opening');
  paragraphs([opening, sectionText(draft, 'Roll Call and Quorum')].filter(Boolean).join('\n')
    || `Stone Square Lodge No. 22 opened in ritualistic form on the ${clean(draft.degree) || 'degree shown above'} at ${clean(draft.openingTime) || 'the time to be confirmed'}.`);
  ruleHeading('Roll Call of Officers');
  table(['Name', 'Title', 'Present', 'Absent', 'Excused'], officerAttendanceRows(draft).map((officer) => [
    officer.name, officer.title, officer.status === 'present' ? 'X' : '', officer.status === 'absent' ? 'X' : '', officer.status === 'excused' ? 'X' : '',
  ]), [210, 160, 50, 50, 52], { size: 7.2 });

  startPage('Attendance and Visitors');
  ruleHeading('Additional Brothers Present');
  paragraphs(additionalPresent(draft).join('\n'), { empty: 'No additional Brothers were recorded as present.' });
  ruleHeading('Visitors');
  paragraphs([...(draft.visitors || []), sectionText(draft, 'Visitors')].filter(Boolean).join('\n'), { empty: 'No visitors were recorded.' });
  ruleHeading('Non Officers Excused From Meeting');
  paragraphs(nonOfficerExcused(draft).join('\n'), { empty: 'No additional excused Brothers were recorded.' });

  startPage('Previous Minutes and Treasurer Report');
  ruleHeading('Reading and Approval of Previous Minutes');
  paragraphs(sectionText(draft, 'Reading of the Minutes', 'Previous Minutes'));
  ruleHeading("Treasurer's Report");
  paragraphs(sectionText(draft, "Treasurer's Report"));

  startPage('Sickness Distress and Communications');
  ruleHeading('Sickness and Distress');
  paragraphs(sectionText(draft, 'Sickness and Distress'));
  ruleHeading('Communications');
  paragraphs(sectionText(draft, 'Communications'));

  startPage('Demits Petitions Balloting and Degree Work');
  for (const label of ['Demits', 'Petitions', 'Balloting', 'Degree Work', 'Elections']) {
    ruleHeading(label);
    paragraphs(sectionText(draft, label), { empty: `No ${label.toLowerCase()} information was recorded.` });
  }

  startPage('Unfinished Business');
  paragraphs(sectionText(draft, 'Unfinished Business'));

  startPage('New Business');
  paragraphs(sectionText(draft, 'New Business and Motions', 'New Business'));

  startPage('Committee Reports');
  paragraphs(sectionText(draft, 'Committee Reports'));

  const additionalSections = (draft.sections || []).filter((section) => (
    clean(section.heading) && !templateSectionNames.has(clean(section.heading).toLowerCase())
  ));
  if (additionalSections.length) {
    startPage('Additional Meeting Sections');
    additionalSections.forEach((section) => {
      ruleHeading(section.heading);
      paragraphs(section.body);
    });
  }

  startPage('Motions and Action Items');
  ruleHeading('Motions');
  table(['Motion', 'Moved By', 'Seconded By', 'Result'], motionRows(draft), [262, 88, 88, 84], { size: 6.7, minRows: 1 });
  ruleHeading('Action Items');
  table(['Action Item', 'Responsible Brother', 'Due Date', 'Status'], (draft.actionItems || []).map((item) => [item, '', '', 'Open']), [292, 100, 70, 60], { size: 6.7, minRows: 1 });

  startPage('Upcoming Events and Reminders');
  if (draft.nextMeeting) table(['Date or Detail', 'Event'], [[draft.nextMeeting, 'Next Lodge meeting']], [190, 332], { size: 8 });
  paragraphs(sectionText(draft, 'Upcoming Events and Reminders'), { empty: 'No additional events were recorded.' });
  ruleHeading('Good of the Order');
  paragraphs(sectionText(draft, 'Praise Report', 'Good of the Order', "Brothers' Remarks", "Wardens' Remarks", "Past Masters' Remarks", "Grand Lodge Officers' Remarks"));
  ruleHeading('Closing of the Lodge');
  paragraphs(sectionText(draft, 'Prayer and Closing') || `The Lodge closed in due form at ${clean(draft.closingTime) || 'the time to be confirmed'}.`);

  startPage('Lodge Income and Expenses');
  ruleHeading('Lodge Income');
  table(['Date', 'Source or Brother', 'Description', 'Amount'], financeRows(draft.income).map((row) => [row.date, row.party, '', row.amount]), [82, 160, 190, 90], { size: 7, minRows: 1 });
  ruleHeading('Lodge Expenses');
  table(['Date', 'Method', 'Payee and Description', 'Amount'], financeRows(draft.expenses).map((row) => [row.date, row.reference, row.party, row.amount]), [82, 100, 250, 90], { size: 7, minRows: 1 });

  startPage('Historical Reference');
  paragraphs('Past Masters and Honorary Past Masters remain visible in the regular meeting record. Years are shown as recorded in the Lodge template.');
  ruleHeading('Stone Square Lodge Past Masters');
  table(['Name', 'Years Served', 'Name', 'Years Served'], historicalRows, [166, 95, 166, 95], { size: 7.1 });
  ruleHeading('Honorary Past Masters');
  table(['Name', 'Title'], [
    ['Bobby Collins', 'Honorary Past Master'], ['Samuel Lathem', 'Honorary Past Master'],
    ['Dewittfield Henry', 'Honorary Past Master'], ['Abram Watson', 'Honorary Past Master'],
  ], [270, 252], { size: 7.4 });
  ruleHeading('Source Transcript');
  paragraphs('The corrected source transcript is retained with the private Sign draft record. It is not reproduced in the distributable minutes.');

  startPage('Minutes Distribution and Signatures');
  paragraphs(`${clean(preparedBy) || 'The preparing officer'}, ${preparerRole === 'assistant_secretary' ? 'Assistant Secretary' : 'Secretary'}, prepared these minutes for review. Distribution remains subject to the Worshipful Master's authorization.`);
  y -= 30;
  ruleHeading('Respectfully Submitted');
  const signatureY = y - 76;
  if (preparerInk) page.drawImage(preparerInk, { x: 65, y: signatureY + 15, width: 195, height: 50 });
  if (masterInk) page.drawImage(masterInk, { x: 337, y: signatureY + 15, width: 195, height: 50 });
  page.drawLine({ start: { x: 55, y: signatureY }, end: { x: 277, y: signatureY }, thickness: 0.8, color: INK });
  page.drawLine({ start: { x: 327, y: signatureY }, end: { x: 549, y: signatureY }, thickness: 0.8, color: INK });
  const preparerName = clean(preparedBy) || 'Preparing Officer';
  const preparerTitle = preparerRole === 'assistant_secretary' ? 'Assistant Secretary' : 'Secretary';
  const masterDisplay = clean(masterName) || 'W. Aaron Dixon-Saunders';
  page.drawText(fitText(preparerName, bold, 9, 210), { x: 61, y: signatureY - 16, size: 9, font: bold, color: NAVY });
  page.drawText(preparerTitle, { x: 61, y: signatureY - 30, size: 8, font: italic, color: GRAY });
  page.drawText(preparerAttestedAt ? `Attested ${attestedDate(preparerAttestedAt)}` : 'Attestation pending', { x: 61, y: signatureY - 44, size: 7, font: regular, color: GRAY });
  page.drawText(fitText(masterDisplay, bold, 9, 210), { x: 333, y: signatureY - 16, size: 9, font: bold, color: NAVY });
  page.drawText('Worshipful Master', { x: 333, y: signatureY - 30, size: 8, font: italic, color: GRAY });
  page.drawText(masterAttestedAt ? `Attested ${attestedDate(masterAttestedAt)}` : 'Attestation pending', { x: 333, y: signatureY - 44, size: 7, font: regular, color: GRAY });

  return Buffer.from(await pdf.save());
};
