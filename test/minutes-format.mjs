import assert from 'node:assert/strict';
import { bulletItems, closingReviewIssues, detectPrayerFacts, documentSections, emphasisRuns, preparerOffice, prayerRequestText, closingPrayerText } from '../minutes-format.js';
import { normalizeMinutesDraft } from '../minutes.js';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { buildMinutesDocx } from '../minutes-document.js';
import { PDFDocument, PDFName } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatMinutesDate, minutesDateParts, minutesDateValue, replaceMinutesDate } from '../public/minutes-dates.js';

for (const value of ['2026-09-03', '9/3/2026', 'September 3, 2026', 'Sept. 3rd, 2026', 'Thu, Sept. 3, 2026', 'Thursday, 2026-09-03']) {
  assert.equal(formatMinutesDate(value), 'Thursday, September 3, 2026');
  assert.equal(minutesDateValue(value), '2026-09-03');
}
assert.equal(formatMinutesDate('2026-10-01 at 7:30 PM, Lodge Hall'), 'Thursday, October 1, 2026 at 7:30 PM, Lodge Hall');
assert.equal(replaceMinutesDate('Next meeting: October 1, 2026 at 7:30 PM, Lodge Hall', '2026-10-15'), 'Next meeting: 2026-10-15 at 7:30 PM, Lodge Hall');
for (const value of ['', 'To be scheduled', 'September 3', '2026-02-30', '2026-00-03', '2026-13-03', 'October 1, 2026 or October 8, 2026']) {
  assert.equal(formatMinutesDate(value), value, 'no invented, rolled-over or selected dates');
  assert.equal(minutesDateParts(value), null);
}
assert.equal(normalizeMinutesDraft({meetingDate:'Thursday, September 3, 2026'}).meetingDate, '2026-09-03');
assert.equal(formatMinutesDate('2028-02-29'), 'Tuesday, February 29, 2028');

const text = 'Grown Folks Friday, September 25. The chapter will assist.\nMOTION PASSED: Fish and two sides. Moved Bro. Stone, seconded PM Reed.\nRevenue split discussed; no decision.';
const bullets = bulletItems(text);
assert.equal(bullets.length, 3);
assert.equal(bullets.map(b => b.runs.map(r => r.text).join('')).join('\n'), text, 'emphasis preserves every word and space');
assert.equal(bullets[0].runs.filter(r => r.bold).map(r => r.text).join(''), 'Grown Folks Friday');
assert.ok(bullets[0].runs.some(r => r.underline && /September 25/.test(r.text)));
assert.ok(bullets[1].runs.some(r => r.bold && /MOTION PASSED:/.test(r.text)));
assert.ok(bullets[2].runs.some(r => r.italic && /no decision/.test(r.text)));
assert.equal(bulletItems('• One point\n- Another point\n1. A third point').length, 3);
assert.equal(emphasisRuns('**Bold** *italic* <u>underlined</u>').map(r => r.text).join(''), 'Bold italic underlined');
assert.equal(emphasisRuns('Brother René: Review at 9:30 PM.').map(r => r.text).join(''), 'Brother René: Review at 9:30 PM.');
const dense = 'Bro. Stone reported that the building work had been completed with all details retained for the Lodge record. '.repeat(6);
assert.ok(bulletItems(dense).length > 1);
assert.ok(bulletItems(dense).every(b => !b.text.endsWith('Bro.')));
for (const source of ['The Chaplain will give the closing prayer for the sick and distressed.', 'The Chaplain did not give the closing prayer for the sick and distressed.', 'At the previous meeting the Chaplain gave the closing prayer for the sick and distressed.']) {
  assert.equal(detectPrayerFacts(source).closingPrayerGiven, null);
}
assert.deepEqual(detectPrayerFacts('The Worshipful Master asked the Chaplain to pray for the sick and distressed at closing. The Chaplain gave the closing prayer and prayed for the sick and distressed.'), {prayerRequested: true, closingPrayerGiven: true});
const draft = normalizeMinutesDraft({meetingDate: '2026-09-17', closingTime: '9:30 PM', prayerRequested: true, closingPrayerGiven: true, sections: [{heading:'Sickness and Distress', body:'Prayers were requested for Brother Stone.'}, {heading:'Prayer and Closing', body:'The Lodge closed at 9:30 PM.'}, {heading:'New Business', body:text}], nextMeeting:'10/1/2026 at 7:30 PM, Lodge Hall'});
const original = JSON.stringify(draft);
const sections = documentSections(draft);
assert.equal(JSON.stringify(draft), original, 'formatting must not mutate a saved or signed draft');
assert.equal(sections.at(-1).heading, 'Closing of the Lodge');
assert.equal(sections.at(-1).body, `The Lodge was closed at 9:30 PM.\n${closingPrayerText}`);
assert.ok(sections.find(s => s.heading === 'Sickness and Distress').body.endsWith(prayerRequestText));
assert.equal(sections.filter(s => /Closing/.test(s.heading)).length, 1);
assert.equal(sections.find(s => s.heading === 'Next Meeting').body, 'Thursday, October 1, 2026 at 7:30 PM, Lodge Hall');
const repeated = documentSections({...draft, sections:[{heading:'Sickness and Distress', body:'The WM asked the Chaplain to give a prayer for sickness and distress at the close of the meeting.\nPrayers for Brother Stone.'}, {heading:'Closing', body:'Closed at 9:30 PM.\nThe Chaplain offered the closing prayer and prayed for the sick and distressed.'}]});
assert.equal(repeated.find(s=>s.heading==='Sickness and Distress').body, `Prayers for Brother Stone.\n${prayerRequestText}`);
assert.equal(repeated.at(-1).body, `The Lodge was closed at 9:30 PM.\n${closingPrayerText}`);
assert.equal(detectPrayerFacts('The Worshipful Master asked the Chaplain to pray for the sick and distressed during the discussion.').prayerRequested, null);
assert.deepEqual(closingReviewIssues(draft), []);
assert.equal(closingReviewIssues({}).length, 3);
const missing = documentSections(normalizeMinutesDraft({})).map(s => s.body).join('\n');
assert.doesNotMatch(missing, /The Chaplain gave|The Worshipful Master asked|Lodge was closed at/);
const declined = documentSections({...draft, prayerRequested:false, closingPrayerGiven:false}).map(s=>s.body).join('\n');
assert.ok(!declined.includes(prayerRequestText) && !declined.includes(closingPrayerText));
assert.equal(normalizeMinutesDraft({prayerRequested:'false'}).prayerRequested, null);
assert.equal(preparerOffice('', 'secretary'), '');
assert.equal(preparerOffice('Adrian Reese', 'assistant_secretary'), 'Assistant Secretary');
assert.equal(preparerOffice('William M. McDuffie', 'secretary'), 'Secretary');
assert.equal(preparerOffice('W. Aaron Dixon-Saunders', 'owner'), 'Worshipful Master');
assert.equal(preparerOffice('Test Officer', 'unknown'), '');
for (const prayerRequested of [true, false, null]) {
  const input = {prayerRequested, sections: [{heading:'Roll Call and Quorum', body:'A quorum was confirmed.'}, {heading:'Reading of the Minutes', body:'Minutes were read.'}]};
  const saved = JSON.stringify(input);
  const normalized = normalizeMinutesDraft(input);
  assert.equal(normalized.sections[1].heading, 'Sickness and Distress');
  assert.equal(normalized.sections[1].body, '', 'required editor section adds no health statement');
  assert.equal(JSON.stringify(input), saved, 'normalization preserves the supplied snapshot');
  const section = documentSections(normalized).find(section => section.heading === 'Sickness and Distress');
  assert.ok(section, 'all prayer choices retain the document section');
  assert.doesNotMatch(section.body, /None (?:reported|present)|No (?:sickness|distress)/i);
  if (prayerRequested === false) assert.equal(section.body, 'No entry recorded.');
}
const emptySickness = normalizeMinutesDraft({prayerRequested:false, closingPrayerGiven:false, closingTime:'9:30 PM', sections:[{heading:'Opening',body:'The Lodge opened.'}]});
const emptyPdf = new PDFParse({data:await buildMinutesPdf({draft:emptySickness,status:'draft'})});
try {
  const renderedText = (await emptyPdf.getText()).text;
  assert.match(renderedText, /SICKNESS AND DISTRESS/i);
  assert.match(renderedText, /No entry recorded\./);
} finally {await emptyPdf.destroy();}
const ctx = {draft, status:'draft', preparedBy:'Adrian Reese', preparerRole:'assistant_secretary'};
const pdfBytes = await buildMinutesPdf(ctx);
const datePdf = new PDFParse({data:pdfBytes});
try {
  const text = (await datePdf.getText()).text;
  assert.match(text, /Thursday, September 17, 2026/);
  assert.match(text, /Thursday, October 1, 2026 at 7:30 PM, Lodge Hall/);
} finally { await datePdf.destroy(); }
const pdf = await PDFDocument.load(pdfBytes);
const images = pdf.getPages().flatMap(p => p.node.Resources()?.lookup(PDFName.of('XObject'))?.entries() || []);
assert.equal(images.length, 1, 'one official seal; no repeated generic emblems');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'minutes-format-'));
try {
  const docx = path.join(tmp, 'minutes.docx');
  await fs.writeFile(docx, await buildMinutesDocx(ctx));
  const xml = execFileSync('/usr/bin/unzip', ['-p', docx, 'word/document.xml'], {encoding:'utf8'});
  assert.match(xml, /<w:numPr>/, 'Word has real bullet paragraphs');
  assert.match(xml, /<w:u[^>]*>/, 'Word retains underlining');
  assert.match(xml, /<w:i\/>/, 'Word retains italics');
  assert.match(xml, /Assistant Secretary/);
  assert.match(xml, /Closing of the Lodge/i);
  assert.match(xml, /Thursday, September 17, 2026/);
  assert.match(xml, /Thursday, October 1, 2026/);
  assert.equal((xml.match(/<w:drawing>/g) || []).length, 1);
  await fs.writeFile(docx, await buildMinutesDocx({draft:emptySickness,status:'draft'}));
  const emptyXml = execFileSync('/usr/bin/unzip', ['-p', docx, 'word/document.xml'], {encoding:'utf8'});
  assert.match(emptyXml, /SICKNESS AND DISTRESS/);
  assert.match(emptyXml, /No entry recorded\./);
} finally { await fs.rm(tmp, {recursive:true, force:true}); }
console.log('Minutes bullets, emphasis, seal, closing facts, officer roles and Word parity passed.');
