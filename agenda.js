import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const NAVY = rgb(19 / 255, 47 / 255, 88 / 255);
const GOLD = rgb(183 / 255, 139 / 255, 48 / 255);
const INK = rgb(24 / 255, 24 / 255, 24 / 255);
const GRAY = rgb(89 / 255, 89 / 255, 89 / 255);
const LETTER = [612, 792];

export const AGENDA_OFFICERS = [
  ['Worshipful Master', 'W. Aaron Dixon-Saunders'],
  ['Senior Warden', 'Xavier White'],
  ['Junior Warden', 'Jamal Sadler'],
  ['Secretary', 'William McDuffie'],
  ['Assistant Secretary', 'Adrian Reese'],
  ['Treasurer', 'John Brown, PM'],
  ['Assistant Treasurer', 'David Marable'],
  ['Senior Deacon', 'Cliff Skinner'],
  ['Junior Deacon', 'Corey Grubbs'],
  ['Chaplain', 'Kenny Davis, PM'],
  ['Senior Steward', 'Karim Fletcher'],
  ['Junior Steward', 'David Jackson'],
  ['Tyler', 'Bobby Collins, HPM'],
].map(([office, name]) => ({ office, name }));

const standardSections = [
  ['Opening', '7:30 PM', 'Opening on the Third Degree.'],
  ['Sickness and Distress', '7:40 PM', ''],
  ['Reading and Approval of the Minutes', '7:45 PM', ''],
  ["Treasurer's Report", '7:50 PM', 'Report of accounts.'],
  ['Demits and Petitions', '8:00 PM', ''],
  ['Degree Work and the Class', '8:05 PM', ''],
  ['Communications', '8:15 PM', ''],
  ['Unfinished Business', '8:25 PM', ''],
  ['New Business', '8:35 PM', ''],
  ['Committee Reports and Event Acknowledgments', '8:47 PM', ''],
  ['Remarks of the Brethren, Past Masters, and Grand Lodge Officers', '8:55 PM', ''],
  ['Closing of the Lodge', '8:58 PM', ''],
];

const clean = (value, maximum = 12_000) => String(value ?? '')
  .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .trim().slice(0, maximum);
const id = value => clean(value, 80).replace(/[^a-zA-Z0-9_-]/g, '') || crypto.randomUUID();

export const defaultAgendaDraft = () => ({
  meetingDate: '',
  meetingType: 'Stated Communication',
  startTime: '7:30 PM',
  dress: 'Masonic Dress',
  addressee: 'To the Brethren of Stone Square Lodge No. 22',
  subtitle: '',
  masonicYear: '2026 to 2027',
  officers: AGENDA_OFFICERS.map((officer) => ({ ...officer })),
  sections: standardSections.map(([heading, scheduledTime, body]) => ({
    id: crypto.randomUUID(), heading, scheduledTime, body,
  })),
});

export const normalizeAgendaDraft = (input = {}) => {
  const base = defaultAgendaDraft();
  const sections = Array.isArray(input.sections) ? input.sections.slice(0, 30).map((section) => ({
    id: id(section?.id),
    heading: clean(section?.heading, 180),
    scheduledTime: clean(section?.scheduledTime, 40),
    body: clean(section?.body),
  })).filter((section) => section.heading || section.body) : base.sections;
  const officers = Array.isArray(input.officers) ? input.officers.slice(0, 20).map((officer) => ({
    office: clean(officer?.office, 100), name: clean(officer?.name, 140),
  })).filter((officer) => officer.office || officer.name) : base.officers;
  return {
    meetingDate: clean(input.meetingDate, 10),
    meetingType: clean(input.meetingType, 120) || base.meetingType,
    startTime: clean(input.startTime, 40) || base.startTime,
    dress: clean(input.dress, 100) || base.dress,
    addressee: clean(input.addressee, 180) || base.addressee,
    subtitle: clean(input.subtitle, 500),
    masonicYear: clean(input.masonicYear, 40) || base.masonicYear,
    officers,
    sections: sections.length ? sections : base.sections,
  };
};

export const agendaIssues = draft => {
  const issues = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.meetingDate)) issues.push('Choose the meeting date.');
  if (!draft.meetingType) issues.push('Enter the meeting type.');
  if (!draft.startTime) issues.push('Enter the meeting start time.');
  if (!draft.sections.length) issues.push('Add at least one agenda section.');
  if (draft.sections.some(section => !section.heading)) issues.push('Every agenda section needs a heading.');
  return issues;
};

const dateLabel = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return 'Meeting date needs review';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T12:00:00Z`));
};

export const agendaFileName = draft => `Stone_Square_22_Agenda_${draft.meetingDate || 'Draft'}.pdf`;

export async function buildAgendaPdf(input) {
  const draft = normalizeAgendaDraft(input);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  const meetingDate = dateLabel(draft.meetingDate);
  const bodyLeft = 120, bodyRight = 566, bodyWidth = bodyRight - bodyLeft;
  let page, y, sectionNumber = 0;

  const safe = value => clean(value).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, ',').replace(/[^\x20-\x7e\xa0-\xff\n]/g, '');
  const wrap = (value, font = regular, size = 9.5, width = bodyWidth) => {
    const lines = [];
    for (const paragraph of safe(value).split('\n')) {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const original of words) {
        let word = original;
        while (font.widthOfTextAtSize(word, size) > width) {
          let cut = 1;
          while (cut < word.length && font.widthOfTextAtSize(word.slice(0, cut + 1), size) <= width) cut++;
          const piece = word.slice(0, cut); if (line) { lines.push(line); line = ''; } lines.push(piece); word = word.slice(cut);
        }
        const candidate = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(candidate, size) > width) { lines.push(line); line = word; }
        else line = candidate;
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  const centered = (text, atY, font, size, color = INK, left = 36, width = 540) => {
    const value = safe(text); page.drawText(value, { x: left + (width - font.widthOfTextAtSize(value, size)) / 2, y: atY, size, font, color });
  };
  const rail = () => {
    page.drawText('OFFICERS', { x: 32, y: 608, size: 8.3, font: bold, color: NAVY });
    page.drawText(draft.masonicYear.replace(' to ', '     '), { x: 32, y: 598, size: 6.5, font: regular, color: GOLD });
    let ry = 584;
    for (const officer of draft.officers) {
      if (ry < 70) break;
      page.drawText(safe(officer.office), { x: 32, y: ry, size: 5.5, font: bold, color: GOLD }); ry -= 8;
      for (const line of wrap(officer.name, bold, 6.6, 78)) { page.drawText(line, { x: 32, y: ry, size: 6.6, font: bold, color: NAVY }); ry -= 7.3; }
      page.drawText('208 East Lake Street', { x: 32, y: ry, size: 4.8, font: regular, color: GRAY }); ry -= 6;
      page.drawText('Middletown, DE 19709', { x: 32, y: ry, size: 4.8, font: regular, color: GRAY }); ry -= 10;
    }
    page.drawLine({ start: { x: 108, y: 614 }, end: { x: 108, y: 58 }, thickness: .45, color: GOLD });
  };
  const footer = () => {
    centered('◆', 31, regular, 6, GOLD, bodyLeft, bodyWidth);
    centered(`Returning to the Fundamentals, ${draft.masonicYear}`, 18, italic, 6.6, GRAY, bodyLeft, bodyWidth);
  };
  const newPage = () => {
    page = pdf.addPage(LETTER);
    page.drawImage(seal, { x: 35, y: 705, width: 43, height: 43 });
    page.drawImage(seal, { x: 534, y: 705, width: 43, height: 43 });
    centered('Stone Square Lodge No. 22', 729, bold, 19, NAVY);
    centered('Free and Accepted Masons, Prince Hall Affiliation', 715, regular, 9.2, NAVY);
    centered('208 East Lake Street', 703, regular, 7.5);
    centered('Middletown, DE 19709', 693, regular, 7.5);
    centered('Telephone (302) 304-6123', 683, regular, 7.5);
    centered('Stated Meetings: 1st & 3rd Thursdays, 7:30 PM', 672, regular, 7.5);
    page.drawLine({ start: { x: 32, y: 662 }, end: { x: 580, y: 662 }, thickness: 1.6, color: NAVY });
    centered('O F F I C E   O F   T H E   W O R S H I P F U L   M A S T E R', 646, bold, 9.2, NAVY);
    centered('W. Aaron Dixon-Saunders, Worshipful Master', 635, italic, 7.6);
    page.drawLine({ start: { x: 32, y: 626 }, end: { x: 580, y: 626 }, thickness: 1.6, color: NAVY });
    rail(); footer(); y = 608;
  };
  const ensure = height => { if (y - height < 54) newPage(); };
  const drawParagraph = (value, { indent = 0, font = regular, size = 9.4, after = 7 } = {}) => {
    const width = bodyWidth - indent;
    for (const line of wrap(value, font, size, width)) {
      ensure(size + 6);
      if (line) page.drawText(line, { x: bodyLeft + indent, y, size, font, color: INK });
      y -= size + 3;
    }
    y -= after;
  };
  const drawSection = section => {
    sectionNumber += 1;
    const title = `${sectionNumber}. ${section.heading}${section.scheduledTime ? `  ${section.scheduledTime}` : ''}`;
    ensure(34);
    drawParagraph(title, { font: bold, size: 9.8, after: 5 });
    const paragraphs = safe(section.body).split('\n').map(line => line.trim()).filter(Boolean);
    let letter = 0;
    for (const paragraph of paragraphs) {
      const explicit = /^([a-z])[.)]\s+/i.exec(paragraph);
      const bullet = /^[-•*]\s+/.test(paragraph);
      if (explicit) drawParagraph(paragraph, { indent: 12, after: 3 });
      else if (bullet) drawParagraph(`• ${paragraph.replace(/^[-•*]\s+/, '')}`, { indent: 12, after: 3 });
      else if (paragraphs.length > 1 && ['Communications','Unfinished Business','New Business'].includes(section.heading)) {
        drawParagraph(`${String.fromCharCode(97 + letter)}. ${paragraph}`, { indent: 12, after: 3 }); letter += 1;
      } else drawParagraph(paragraph, { after: 4 });
    }
    y -= 3;
  };

  newPage();
  drawParagraph(meetingDate, { size: 9.3, after: 13 });
  drawParagraph(draft.addressee, { size: 9.3, after: 12 });
  centered(`AGENDA, ${draft.meetingType.toUpperCase()}`, y, bold, 11.5, INK, bodyLeft, bodyWidth); y -= 17;
  centered(`${meetingDate}  ·  ${draft.startTime}  ·  ${draft.dress}`, y, regular, 9.1, INK, bodyLeft, bodyWidth); y -= 17;
  if (draft.subtitle) { for (const line of wrap(draft.subtitle, italic, 8.3, bodyWidth)) { centered(line, y, italic, 8.3, INK, bodyLeft, bodyWidth); y -= 11; } y -= 4; }
  for (const section of draft.sections) drawSection(section);
  return Buffer.from(await pdf.save());
}
