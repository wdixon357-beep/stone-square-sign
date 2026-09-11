import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, Packer, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';

const NAVY = '17365D';
const RED = 'C62828';
const GOLD = 'C79A42';
const LIGHT_BLUE = 'E8EEF5';
const GRAY = '777777';
const lineBorder = { style: BorderStyle.SINGLE, size: 3, color: NAVY };
const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 1, color: 'AAB2BD' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'AAB2BD' },
  left: { style: BorderStyle.SINGLE, size: 1, color: 'AAB2BD' },
  right: { style: BorderStyle.SINGLE, size: 1, color: 'AAB2BD' },
};

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
  hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
}).format(new Date(value)) : '';

const summaryRow = (label, value) => new TableRow({
  children: [
    new TableCell({
      borders: cellBorders,
      shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
      width: { size: 28, type: WidthType.PERCENTAGE },
      margins: { top: 90, bottom: 90, left: 110, right: 110 },
      children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 21 })] })],
    }),
    new TableCell({
      borders: cellBorders,
      width: { size: 72, type: WidthType.PERCENTAGE },
      margins: { top: 90, bottom: 90, left: 110, right: 110 },
      children: [new Paragraph({ children: [new TextRun({ text: value || 'Not confirmed', size: 21 })] })],
    }),
  ],
});

const bodyParagraph = (text) => {
  const match = String(text).match(/^(MOTION|DISPOSITION):\s*(.*)$/i);
  if (match) {
    return new Paragraph({
      spacing: { after: 120, line: 300 },
      indent: { left: 360 },
      children: [
        new TextRun({ text: `${match[1].toUpperCase()}: `, bold: true, color: NAVY, size: 22 }),
        new TextRun({ text: match[2], size: 22 }),
      ],
    });
  }
  const bullet = text.match(/^\s*[•*-]\s+(.*)$/);
  return new Paragraph({
    spacing: { after: 110, line: 300 },
    ...(bullet ? { bullet: { level: 0 } } : {}),
    children: [new TextRun({ text: bullet ? bullet[1] : text, size: 22 })],
  });
};

const sectionParagraphs = (section, index) => {
  const heading = String(section.heading || '').replace(/^\d+[.)]?\s*/, '');
  const lines = String(section.body || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 210, after: 90 },
      border: { bottom: lineBorder },
      children: [new TextRun({ text: `${index + 2}.  ${heading}`, bold: true, color: NAVY, size: 26 })],
    }),
    ...lines.map(bodyParagraph),
  ];
};

const signatureCell = ({ name, role, signature, when }) => new TableCell({
  borders: { top: lineBorder, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
  width: { size: 48, type: WidthType.PERCENTAGE },
  margins: { top: 100, bottom: 80, left: 80, right: 80 },
  children: [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: signature
        ? [new ImageRun({ data: signature, type: 'png', transformation: { width: 210, height: 52 } })]
        : [new TextRun({ text: 'Attestation pending', italics: true, color: GRAY, size: 19 })],
    }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: name || role, bold: true, size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: role, color: NAVY, size: 18 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: when ? `Attested ${attestedDate(when)}` : 'Not yet attested', color: GRAY, size: 16 })] }),
  ],
});

export const buildMinutesDocx = async ({
  draft, status, approvedByLodgeOn, preparedBy, preparerRole, preparedSignature,
  preparerAttestedAt, masterName, masterSignature, masterAttestedAt,
}) => {
  const isOfficial = status === 'approved_by_lodge';
  const meetingDetail = [fullDate(draft.meetingDate), draft.openingTime && `opened ${draft.openingTime}`]
    .filter(Boolean).join(', ');
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: 'STONE SQUARE LODGE No. 22, PHA', bold: true, color: NAVY, size: 32 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 70 },
      children: [new TextRun({ text: 'Most Worshipful Prince Hall Grand Lodge of Delaware, First District', italics: true, size: 22 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 },
      children: [new TextRun({ text: 'MINUTES OF THE STATED COMMUNICATION', bold: true, size: 27 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 220 },
      children: [new TextRun({
        text: isOfficial
          ? `APPROVED BY THE LODGE${approvedByLodgeOn ? ` ON ${fullDate(approvedByLodgeOn).toUpperCase()}` : ''}`
          : 'DRAFT FOR REVIEW. NOT YET APPROVED BY THE LODGE.',
        bold: true,
        italics: !isOfficial,
        color: isOfficial ? NAVY : RED,
        size: 22,
      })],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        summaryRow('Lodge', 'Stone Square Lodge No. 22, Free and Accepted Masons, Prince Hall Affiliation'),
        summaryRow('Meeting', draft.meetingType || 'Stated Communication'),
        summaryRow('Date and Time', meetingDetail),
        summaryRow('Location', '208 East Lake Street, Middletown, Delaware 19709'),
        summaryRow('Presiding', draft.presiding || 'Not confirmed'),
        summaryRow('Quorum', draft.quorum || 'Not confirmed'),
        summaryRow('Next Stated Communication', draft.nextMeeting || 'Not confirmed'),
      ],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 210, after: 90 },
      border: { bottom: lineBorder },
      children: [new TextRun({ text: '1.  Roll of Officers and Attendance', bold: true, color: NAVY, size: 26 })],
    }),
    bodyParagraph(`Present: ${draft.present.length ? draft.present.join(', ') : 'None recorded'}`),
    bodyParagraph(`Excused: ${draft.excused.length ? draft.excused.join(', ') : 'None recorded'}`),
    bodyParagraph(`Visitors: ${draft.visitors.length ? draft.visitors.join(', ') : 'None recorded'}`),
    ...draft.sections.flatMap(sectionParagraphs),
    new Paragraph({
      spacing: { before: 260 },
      border: { top: lineBorder },
      children: [new TextRun({
        text: isOfficial
          ? 'Approved by the Lodge and retained as the official record.'
          : 'Prepared from the meeting recording for officer review. This is not the official record and may not be distributed without the Worshipful Master\'s authorization.',
        italics: true,
        color: GRAY,
        size: 19,
      })],
    }),
    new Paragraph({
      spacing: { before: 260, after: 130 },
      alignment: AlignmentType.CENTER,
      keepNext: true,
      children: [new TextRun({ text: 'OFFICER ATTESTATIONS', bold: true, color: NAVY, size: 23 })],
    }),
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
            name: masterName || 'W. Aaron Dixon-Saunders',
            role: 'Worshipful Master',
            signature: masterSignature,
            when: masterAttestedAt,
          }),
        ],
      })],
    }),
  ];

  const document = new Document({
    creator: 'Stone Square Lodge No. 22',
    title: `Minutes, ${fullDate(draft.meetingDate)}`,
    description: isOfficial ? 'Official Lodge minutes' : 'Draft Lodge minutes for review',
    styles: {
      default: { document: { run: { font: 'Times New Roman', size: 22 } } },
      paragraphStyles: [{
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: 'Times New Roman', size: 26, bold: true, color: NAVY },
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 720, right: 900, bottom: 720, left: 900 },
        },
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Returning to the Fundamentals, 2026 to 2027', italics: true, color: NAVY, size: 18 }),
                new TextRun({ text: '   |   Page ', color: GRAY, size: 17 }),
                new TextRun({ children: [PageNumber.CURRENT], color: GRAY, size: 17 }),
              ],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: isOfficial ? 'OFFICIAL RECORD' : 'DRAFT. DO NOT DISTRIBUTE WITHOUT AUTHORIZATION.', color: isOfficial ? NAVY : RED, size: 15 })],
            }),
          ],
        }),
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
