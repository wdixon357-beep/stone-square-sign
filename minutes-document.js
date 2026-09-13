import { formatMinutesDate } from './public/minutes-dates.js';
import {
  AlignmentType, BorderStyle, Document, Footer, ImageRun, Packer, PageNumber,
  Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';
import { readFile } from 'node:fs/promises';
import { bulletItems, sectionBlocks, documentSections, preparerOffice } from './minutes-format.js';

import {
  additionalPresent, nonOfficerExcused, officerAttendanceRows,
} from './minutes-layout.js';

const BLACK = '000000';
const RED = 'B71C1C';
const GRAY = '666666';
const LIGHT_GRAY = 'EAF0F5';
const border = { style: BorderStyle.SINGLE, size: 4, color: BLACK };
const borders = { top: border, bottom: border, left: border, right: border };

const fullDate = (value) => formatMinutesDate(value, 'Date not confirmed');

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
  alignment: AlignmentType.LEFT,
  spacing: { before: 220, after: 100 },
  keepNext: true,
  border: {bottom: {style: BorderStyle.SINGLE, size: 8, color: 'C9A23B', space: 5}},
  children: [new TextRun({ text: String(text || '').toUpperCase(), size: 23, bold: true, color: '10263D' })],
});

const bodyParagraphs = (section, keepNext = false) => (typeof section === 'string' ? bulletItems(section).map(item => ({...item, bullet:true})) : sectionBlocks(section)).map(item => new Paragraph({
  keepNext,
  ...(item.bullet ? {bullet: {level: 0}, indent: {left: 260, hanging: 200}} : {}),
  spacing: {after: 130, line: 288},
  children: item.runs.map(run => new TextRun({text: run.text, size: 22, bold: run.bold, italics: run.italic, underline: run.underline ? {} : undefined})),
}));

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

const nameGroup = (heading, names) => names.length ? [
  sectionHeading(heading),
  ...bodyParagraphs(names.join('\n')),
] : [];

const signatureCell = ({ name, role, signature, when, label }) => new TableCell({
  borders: { top: border, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
  width: { size: 48, type: WidthType.PERCENTAGE },
  verticalAlign: VerticalAlign.CENTER,
  margins: { top: 100, bottom: 80, left: 80, right: 80 },
  children: [
    center(label, 18, {color: '10263D', after: 100}),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: signature
        ? [new ImageRun({ data: signature, type: 'png', transformation: { width: 210, height: 52 } })]
        : [new TextRun({ text: 'Attestation pending', italics: true, color: GRAY, size: 19 })],
    }),
    center(name || 'Preparing Officer', 20, { after: 20 }),
    ...(role ? [center(role, 18, { after: 20, color: GRAY, bold: false })] : []),
    center(when ? `Attested ${attestedDate(when)}` : 'Not yet attested', 16, { after: 0, color: GRAY, bold: false }),
  ],
});

export const buildMinutesDocx = async ({
  draft, status, approvedByLodgeOn, preparedBy, preparerRole, preparedSignature,
  preparerAttestedAt, masterName, masterSignature, masterAttestedAt, masterChanges = [],
}) => {
  const isOfficial = status === 'approved_by_lodge';
  const masthead = center('STONE SQUARE LODGE NO. 22', 28, { color: '10263D', after: 150 });
  const children = [
    new Paragraph({alignment: AlignmentType.CENTER, keepNext: true, spacing: {after: 100}, children: [new ImageRun({data: await readFile(new URL('./assets/lodge-seal.png', import.meta.url)), type: 'png', transformation: {width: 66, height: 66}})]}),
    masthead,
    center(`MINUTES OF THE ${String(draft.meetingType || 'STATED COMMUNICATION').toUpperCase()}`, 28, { after: 55 }),
    center(fullDate(draft.meetingDate), 22, { after: 70, bold: false }),
    center(isOfficial
      ? `APPROVED BY THE LODGE${approvedByLodgeOn ? ` ON ${fullDate(approvedByLodgeOn).toUpperCase()}` : ''}`
      : 'DRAFT FOR OFFICER REVIEW. NOT YET APPROVED BY THE LODGE.', 20,
    { after: 170, color: isOfficial ? BLACK : RED, italics: !isOfficial }),
    detailsTable(draft),
    sectionHeading('Officer Attendance'),
    officerTable(draft),
    ...nameGroup('Additional Brothers Present', additionalPresent(draft)),
    ...nameGroup('Visitors', draft.visitors || []),
    ...nameGroup('Non Officers Excused From Meeting', nonOfficerExcused(draft)),
    ...documentSections(draft).flatMap((item) => [
      sectionHeading(item.heading || 'Meeting Notes'),
      ...bodyParagraphs(item, item.heading === 'Closing of the Lodge'),
    ]),
    sectionHeading('Officer Attestations'),
    ...(masterChanges.length ? [paragraph("The preparing officer attested to the submitted version. The Worshipful Master's corrections and the original signed submission are retained in the record.")] : []),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [4750, 4750],
      rows: [new TableRow({
        cantSplit: true,
        children: [
          signatureCell({
            name: preparedBy,
            label: 'PREPARING OFFICER',
            role: preparerOffice(preparedBy, preparerRole),
            signature: preparedSignature,
            when: preparerAttestedAt,
          }),
          signatureCell({
            label: 'WORSHIPFUL MASTER REVIEW',
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
    styles: { default: { document: { run: { font: 'Calibri', size: 22, color: BLACK } } } },
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
