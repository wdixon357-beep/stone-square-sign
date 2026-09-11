import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AlignmentType, BorderStyle, Document, Footer, ImageRun, Packer, PageNumber,
  PageBreak, Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';

import {
  additionalPresent, financeRows, nonOfficerExcused, officerAttendanceRows,
} from './minutes-layout.js';

const BLACK = '000000';
const RED = 'B71C1C';
const GRAY = '666666';
const LIGHT_GRAY = 'E7E7E7';
const border = { style: BorderStyle.SINGLE, size: 4, color: BLACK };
const borders = { top: border, bottom: border, left: border, right: border };

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

const paragraph = (text) => new Paragraph({
  spacing: { after: 100, line: 276 },
  children: [new TextRun({ text: String(text || ''), size: 22 })],
});

const center = (text, size, options = {}) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: options.after ?? 40 },
  keepNext: options.keepNext ?? true,
  children: [new TextRun({ text, size, bold: options.bold ?? true, color: options.color || BLACK, italics: options.italics })],
});

const sectionHeading = (text) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 220, after: 160 },
  keepNext: true,
  children: [new TextRun({ text: String(text || '').toUpperCase(), size: 26, bold: true, color: BLACK })],
});

const bodyParagraphs = (text) => String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
  const match = /^(MOTION|DISPOSITION):\s*(.*)$/i.exec(line);
  return new Paragraph({
    spacing: { after: 110, line: 288 },
    children: match ? [
      new TextRun({ text: `${match[1].toUpperCase()}: `, bold: true, size: 22 }),
      new TextRun({ text: match[2], size: 22 }),
    ] : [new TextRun({ text: line, size: 22 })],
  });
});

const cell = (text, { bold = false, centerText = false, fill } = {}) => new TableCell({
  borders,
  verticalAlign: VerticalAlign.CENTER,
  shading: fill ? { fill } : undefined,
  margins: { top: 70, bottom: 70, left: 85, right: 85 },
  children: [new Paragraph({
    alignment: centerText ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [new TextRun({ text: String(text || ''), size: 19, bold })],
  })],
});

const detailsTable = (draft) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({ children: [cell('Meeting', { bold: true, fill: LIGHT_GRAY }), cell(draft.meetingType || 'Not recorded'), cell('Degree', { bold: true, fill: LIGHT_GRAY }), cell(draft.degree || 'Not recorded')] }),
    new TableRow({ children: [cell('Opening', { bold: true, fill: LIGHT_GRAY }), cell(draft.openingTime || 'Not recorded'), cell('Closing', { bold: true, fill: LIGHT_GRAY }), cell(draft.closingTime || 'Not recorded')] }),
    new TableRow({ children: [cell('Presiding', { bold: true, fill: LIGHT_GRAY }), cell(draft.presiding || 'Not recorded'), cell('Quorum', { bold: true, fill: LIGHT_GRAY }), cell(draft.quorum || 'Not recorded')] }),
    new TableRow({ children: [cell('Next Stated Communication', { bold: true, fill: LIGHT_GRAY }), cell(draft.nextMeeting || 'Not recorded'), cell('', { fill: LIGHT_GRAY }), cell('')] }),
  ],
});

const officerTable = (draft) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  columnWidths: [2800, 2500, 600, 600, 600, 700],
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell('Name', { bold: true, centerText: true, fill: LIGHT_GRAY }),
      cell('Title', { bold: true, centerText: true, fill: LIGHT_GRAY }),
      cell('P', { bold: true, centerText: true, fill: LIGHT_GRAY }),
      cell('A', { bold: true, centerText: true, fill: LIGHT_GRAY }),
      cell('E', { bold: true, centerText: true, fill: LIGHT_GRAY }),
      cell('NR', { bold: true, centerText: true, fill: LIGHT_GRAY }),
    ] }),
    ...officerAttendanceRows(draft).map((officer) => new TableRow({
      cantSplit: true,
      children: [
        cell(officer.name), cell(officer.title),
        cell(officer.status === 'present' ? 'X' : '', { centerText: true }),
        cell(officer.status === 'absent' ? 'X' : '', { centerText: true }),
        cell(officer.status === 'excused' ? 'X' : '', { centerText: true }),
        cell(officer.status === 'not_recorded' ? 'X' : '', { centerText: true }),
      ],
    })),
  ],
});

const nameGroup = (heading, names) => [
  sectionHeading(heading),
  paragraph(names.length ? names.join(', ') : 'None recorded.'),
];

const financeTable = (heading, entries) => {
  const rows = financeRows(entries);
  if (!rows.length) return [];
  return [
    sectionHeading(heading),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [1300, 1400, 3500, 1000],
      rows: [
        new TableRow({ tableHeader: true, children: [
          cell('Date', { bold: true, centerText: true, fill: LIGHT_GRAY }),
          cell('Check or Reference', { bold: true, centerText: true, fill: LIGHT_GRAY }),
          cell('Brother or Payee', { bold: true, centerText: true, fill: LIGHT_GRAY }),
          cell('Amount', { bold: true, centerText: true, fill: LIGHT_GRAY }),
        ] }),
        ...rows.map((row) => new TableRow({ cantSplit: true, children: [
          cell(row.date, { centerText: true }), cell(row.reference, { centerText: true }),
          cell(row.party), cell(row.amount, { centerText: true }),
        ] })),
      ],
    }),
  ];
};

const signatureCell = ({ name, role, signature, when }) => new TableCell({
  borders: { top: border, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
  width: { size: 48, type: WidthType.PERCENTAGE },
  verticalAlign: VerticalAlign.CENTER,
  margins: { top: 100, bottom: 80, left: 80, right: 80 },
  children: [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: signature
        ? [new ImageRun({ data: signature, type: 'png', transformation: { width: 210, height: 52 } })]
        : [new TextRun({ text: 'Attestation pending', italics: true, color: GRAY, size: 19 })],
    }),
    center(name || role, 20, { after: 20 }),
    center(role, 18, { after: 20, color: GRAY, bold: false }),
    center(when ? `Attested ${attestedDate(when)}` : 'Not yet attested', 16, { after: 0, color: GRAY, bold: false }),
  ],
});

export const buildMinutesDocx = async ({
  draft, status, approvedByLodgeOn, preparedBy, preparerRole, preparedSignature,
  preparerAttestedAt, masterName, masterSignature, masterAttestedAt,
}) => {
  const isOfficial = status === 'approved_by_lodge';
  const emblem = await fs.readFile(path.join(process.cwd(), 'assets', 'meeting-minutes-emblem.png'));
  const noBorders = {
    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  };
  const masthead = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...noBorders, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
    columnWidths: [1400, 5800, 1400],
    rows: [new TableRow({
      cantSplit: true,
      children: [
        new TableCell({ borders: noBorders, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: emblem, type: 'png', transformation: { width: 74, height: 86 } })] })] }),
        new TableCell({ borders: noBorders, verticalAlign: VerticalAlign.CENTER, children: [
          center('STONE SQUARE LODGE NO. 22', 32),
          center('208 EAST LAKE STREET', 22),
          center('MIDDLETOWN, DELAWARE 19709', 22),
        ] }),
        new TableCell({ borders: noBorders, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: emblem, type: 'png', transformation: { width: 74, height: 86 } })] })] }),
      ],
    })],
  });
  const opening = (draft.sections || []).find((item) => /opening/i.test(item.heading));
  const children = [
    masthead,
    center('MINUTES OF THE STATED COMMUNICATION', 28, { after: 55 }),
    center(fullDate(draft.meetingDate), 22, { after: 70, bold: false }),
    center(isOfficial
      ? `APPROVED BY THE LODGE${approvedByLodgeOn ? ` ON ${fullDate(approvedByLodgeOn).toUpperCase()}` : ''}`
      : 'DRAFT FOR OFFICER REVIEW. NOT YET APPROVED BY THE LODGE.', 20,
    { after: 170, color: isOfficial ? BLACK : RED, italics: !isOfficial }),
    detailsTable(draft),
    sectionHeading('Opening'),
    ...bodyParagraphs(opening?.body || 'No opening details recorded.'),
    sectionHeading('Roll Call of Officers Present'),
    officerTable(draft),
    ...nameGroup('Additional Brothers Present', additionalPresent(draft)),
    ...nameGroup('Visitors', draft.visitors || []),
    ...nameGroup('Non Officers Excused From Meeting', nonOfficerExcused(draft)),
    ...(draft.sections || []).filter((item) => item !== opening).flatMap((item) => [
      sectionHeading(item.heading || 'Meeting Notes'),
      ...bodyParagraphs(item.body || 'No details recorded.'),
    ]),
    ...((draft.income || []).length || (draft.expenses || []).length
      ? [new Paragraph({ children: [new PageBreak()] })] : []),
    ...financeTable('Lodge Income', draft.income),
    ...financeTable('Lodge Expenses', draft.expenses),
    sectionHeading('Officer Attestations'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [4750, 4750],
      rows: [new TableRow({
        cantSplit: true,
        children: [
          signatureCell({
            name: preparedBy,
            role: preparerRole === 'assistant_secretary' ? 'Assistant Secretary' : 'Secretary',
            signature: preparedSignature,
            when: preparerAttestedAt,
          }),
          signatureCell({
            name: masterName || 'W. Aaron Dixon-Saunders', role: 'Worshipful Master',
            signature: masterSignature, when: masterAttestedAt,
          }),
        ],
      })],
    }),
  ];

  const document = new Document({
    creator: 'Stone Square Lodge No. 22',
    title: `Meeting Minutes ${fullDate(draft.meetingDate)}`,
    description: isOfficial ? 'Official Lodge minutes' : 'Draft Lodge minutes for officer review',
    styles: { default: { document: { run: { font: 'Times New Roman', size: 22, color: BLACK } } } },
    sections: [{
      properties: {
        page: { size: { width: 12240, height: 15840 }, margin: { top: 720, right: 900, bottom: 720, left: 900 } },
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: isOfficial ? 'OFFICIAL RECORD' : 'DRAFT. DO NOT DISTRIBUTE WITHOUT AUTHORIZATION.', bold: true, color: isOfficial ? BLACK : RED, size: 15 }),
            new TextRun({ text: '   Page ', color: GRAY, size: 15 }),
            new TextRun({ children: [PageNumber.CURRENT], color: GRAY, size: 15 }),
          ],
        })] }),
      },
      children,
    }],
  });
  return Buffer.from(await Packer.toBuffer(document));
};

export const minutesFileName = (draft, status) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(draft.meetingDate || '')) ? draft.meetingDate : 'undated';
  const prefix = status === 'approved_by_lodge' ? 'APPROVED' : 'DRAFT';
  return `${prefix}_Stone_Square_22_Minutes_${date}.docx`;
};
