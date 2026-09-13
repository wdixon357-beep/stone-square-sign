import assert from 'node:assert/strict';
import { bulletItems, cleanMinutesSectionsForPresentation, closingReviewIssues, detectPrayerFacts, documentSections, emphasisRuns, preparerOffice, prayerRequestText, closingPrayerText } from '../minutes-format.js';
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
const decoratedDraft = {...draft, closingTime:'10:30 PM', nextMeeting:'October 1, 2026', sections:[
  {heading:'Sickness and Distress', body:'- The Worshipful Master asked the Chaplain to offer a prayer for the sick and distressed at the close of the meeting.'},
  {heading:'Upcoming Events and Reminders', body:'- The next meeting is scheduled for <u>October 1, 2026</u>.'},
  {heading:'Prayer and Closing', body:'- WM Dixon-Saunders asked the Chaplain to pray for the sick and distressed at the close.\n- The Chaplain gave the closing prayer and prayed for the sick and distressed.\n- The Lodge closed at <u>10:30 PM</u>.'},
]};
const decoratedSnapshot = JSON.stringify(decoratedDraft);
const decoratedSections = documentSections(decoratedDraft);
assert.equal(JSON.stringify(decoratedDraft), decoratedSnapshot, 'deduplication never changes the saved draft');
assert.equal(decoratedSections.at(-1).body, `The Lodge was closed at 10:30 PM.\n${closingPrayerText}`, 'marked-up whole closing bullets appear once in canonical closing');
assert.equal(decoratedSections.filter(s=>s.heading === 'Next Meeting').length, 1);
assert.ok(!decoratedSections.some(s=>s.heading === 'Upcoming Events and Reminders'), 'empty duplicate-only events section is omitted');
assert.equal(decoratedSections.find(s=>s.heading === 'Sickness and Distress').body.trim(), prayerRequestText);
assert.match(prayerRequestText, /^WM Dixon-Saunders /, 'canonical prayer request uses the requested WM name');
assert.equal(decoratedSections.map(s=>s.body).join('\n').split(prayerRequestText).length - 1, 1, 'standard prayer request appears once across sections');
const extraEvents = [
  '- The next meeting is scheduled for <u>October 1, 2026</u> at 7:30 PM, Lodge Hall.',
  '- The next meeting is scheduled for October 15, 2026.',
  '- The next meeting is scheduled for October 1.',
  '- Community dinner: October 1, 2026.',
  '- The next meeting is scheduled for October 1, 2026. Bring the revised agenda.',
].join('\n');
const preservedEvents = documentSections({...decoratedDraft, sections:[{heading:'Upcoming Events and Reminders', body:extraEvents}]}).find(s=>s.heading === 'Upcoming Events and Reminders');
assert.equal(preservedEvents.body, extraEvents, 'event details, other dates, missing years and additional instructions survive');
const mixedEvents = documentSections({...decoratedDraft, sections:[{heading:'Upcoming Events and Reminders', body:`- The next meeting is scheduled for <u>October 1, 2026</u>.\n${extraEvents}`}]}).find(s=>s.heading === 'Upcoming Events and Reminders');
assert.equal(mixedEvents.body, extraEvents, 'only the duplicate whole bullet is removed from a mixed events section');
assert.ok(!documentSections({...decoratedDraft, sections:[{heading:'Adjournment',body:'- Next meeting: <u>October 1, 2026</u>.'}]}).at(-1).body.includes('October 1'), 'a duplicate whole next-meeting bullet is also removed from closing');
assert.equal(documentSections({...decoratedDraft, prayerRequested:false, sections:[{heading:'Sickness and Distress',body:'- Next meeting: October 1, 2026.'}]}).find(s=>s.heading === 'Sickness and Distress').body, '', 'required sickness heading remains without a filler bullet');
const closingDetails = '- The Lodge closed at <u>10:30 PM</u> after the final announcement.\n- A motion to adjourn was recorded.';
assert.ok(documentSections({...decoratedDraft, sections:[{heading:'Closing', body:closingDetails}]}).at(-1).body.startsWith(closingDetails), 'ceremony and motion details are retained');
const unconfirmedClosing = documentSections({...decoratedDraft, closingTime:'', prayerRequested:null, closingPrayerGiven:null});
assert.ok(unconfirmedClosing.at(-1).body.includes('The Lodge closed at <u>10:30 PM</u>.'), 'no reviewed closing time means no removal of source closing text');
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
  if (prayerRequested === false) assert.equal(section.body, '');
}
const legacySections = [{heading:'Roll Call and Quorum',body:'All officers are present unless noted.\nATTENDANCE AND VISITORS\nAdditional Brothers and visitors recorded in the sign in book.\nPRAISE REPORTS\nNone reported.'}];
const legacySnapshot = JSON.stringify(legacySections);
assert.deepEqual(cleanMinutesSectionsForPresentation(legacySections), [], 'exact legacy template boilerplate produces no redundant section');
assert.equal(JSON.stringify(legacySections), legacySnapshot, 'cleanup preserves the original saved/signed sections');
assert.deepEqual(bulletItems('None Recorded.\n- **None reported.**\nNo entry recorded.\nNot applicable.\nNo vote was recorded.').map(item=>item.text), ['No vote was recorded.'], 'empty filler disappears while substantive negative outcomes remain');
const meaningfulPraise = cleanMinutesSectionsForPresentation([{heading:'Praise Reports',body:'Brother Example thanked the building committee.\nNone recorded.'},{heading:'Announcements',body:'- **Praise Report:** The repair was completed.\nNo motion was made.'}]);
assert.equal(meaningfulPraise[0].heading, 'Good of the Order');
assert.equal(meaningfulPraise[0].body, 'Brother Example thanked the building committee.');
assert.equal(meaningfulPraise[1].body, 'The repair was completed.\nNo motion was made.');
assert.doesNotMatch(JSON.stringify(meaningfulPraise), /praise reports?/i);
assert.deepEqual(cleanMinutesSectionsForPresentation([{heading:'Visitors',body:'Not applicable.'},{heading:'Announcements',body:'Visitors\nNone recorded.\nThe committee will meet.'}]), [{heading:'Announcements',body:'The committee will meet.'}]);
const visitors = ['Bro. Victor Example, Example Lodge No. 1'];
const namedVisitorSections = [{heading:'Attendance and Visitors',body:'- **Attendance and Visitors**\n- Visitors: Bro. Victor Example, Example Lodge No. 1.'}];
assert.deepEqual(cleanMinutesSectionsForPresentation(namedVisitorSections,{visitors}), namedVisitorSections, 'actual named visitors and their recorded text remain');
assert.ok(cleanMinutesSectionsForPresentation([{heading:'Announcements',body:'Visitors\nBro. Victor Example'}])[0].body.includes('Visitors'), 'a visitor label followed by a named entry remains');
const uniqueBusiness = cleanMinutesSectionsForPresentation([{heading:'Roll Call and Quorum',body:'All officers are present unless noted.\nA quorum was confirmed.\nPresent: Alex Example.\nThe building committee requested three estimates.'}], {quorum:'Yes',present:['Alex Example']});
assert.deepEqual(uniqueBusiness, [{heading:'Other Meeting Business',body:'The building committee requested three estimates.'}], 'dedicated attendance and quorum controls replace duplicates while distinct business survives');
assert.equal(cleanMinutesSectionsForPresentation([{heading:'Roll Call and Quorum',body:'Present: Alex Example.'}])[0].body, 'Present: Alex Example.', 'attendance absent from the dedicated lists is not silently discarded');
assert.equal(cleanMinutesSectionsForPresentation([{heading:'Roll Call',body:'Present: Bro. Example'}],{present:null,excused:null,officerAttendance:[null]} )[0].body, 'Present: Bro. Example', 'nullable optional attendance arrays preserve unproven source entries');
const emptySickness = normalizeMinutesDraft({prayerRequested:false, closingPrayerGiven:false, closingTime:'9:30 PM', sections:[{heading:'Opening',body:'The Lodge opened.'}]});
const emptyPdf = new PDFParse({data:await buildMinutesPdf({draft:emptySickness,status:'draft'})});
try {
  const renderedText = (await emptyPdf.getText()).text;
  assert.match(renderedText, /SICKNESS AND DISTRESS/i);
  assert.doesNotMatch(renderedText, /No entry recorded\./);
} finally {await emptyPdf.destroy();}
const ctx = {draft, status:'draft', preparedBy:'Adrian Reese', preparerRole:'assistant_secretary'};
const legacyDraft = {...draft, present:['Alex Example'],visitors,sections:legacySections};
const legacyRecordSnapshot = JSON.stringify(legacyDraft);
const legacyPdf = new PDFParse({data:await buildMinutesPdf({...ctx,draft:legacyDraft,status:'awaiting_master_attestation'})});
try {
  const rendered = (await legacyPdf.getText()).text;
  assert.doesNotMatch(rendered, /PRAISE REPORTS?|None (?:recorded|reported)|No entry recorded|ROLL CALL AND QUORUM|ATTENDANCE AND VISITORS/i);
  assert.match(rendered, /Alex Example/); assert.match(rendered, /Victor Example/);
} finally {await legacyPdf.destroy();}
assert.equal(JSON.stringify(legacyDraft), legacyRecordSnapshot, 'rendering legacy submitted content never mutates the record');
const pdfBytes = await buildMinutesPdf(ctx);
const decoratedPdf = new PDFParse({data:await buildMinutesPdf({...ctx,draft:decoratedDraft})});
try {
  const rendered = (await decoratedPdf.getText()).text;
  assert.equal((rendered.match(/10:30 PM/g) || []).length, 2, 'PDF has the closing time in the summary and one closing bullet');
  assert.equal((rendered.match(/The Lodge was closed at\s+10:30 PM/g) || []).length, 1);
  assert.doesNotMatch(rendered, /The Lodge closed at/);
  assert.equal((rendered.match(/October 1, 2026/g) || []).length, 1, 'PDF renders the next meeting date once');
  assert.doesNotMatch(rendered, /UPCOMING EVENTS AND REMINDERS/i);
  assert.match(rendered, /WM Dixon-Saunders asked the Chaplain/);
} finally {await decoratedPdf.destroy();}
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
  assert.doesNotMatch(emptyXml, /No entry recorded\./);
  await fs.writeFile(docx, await buildMinutesDocx({...ctx,draft:decoratedDraft}));
  const decoratedXml = execFileSync('/usr/bin/unzip', ['-p', docx, 'word/document.xml'], {encoding:'utf8'});
  assert.equal((decoratedXml.match(/10:30 PM/g) || []).length, 2, 'Word has the closing time in the summary and one closing bullet');
  assert.equal((decoratedXml.replace(/<[^>]*>/g, '').match(/The Lodge was closed at 10:30 PM/g) || []).length, 1);
  assert.equal((decoratedXml.match(/October 1, 2026/g) || []).length, 1, 'Word renders the next meeting date once');
  assert.doesNotMatch(decoratedXml, /UPCOMING EVENTS AND REMINDERS/i);
  await fs.writeFile(docx, await buildMinutesDocx({...ctx,draft:legacyDraft,status:'awaiting_master_attestation'}));
  const legacyXml = execFileSync('/usr/bin/unzip', ['-p', docx, 'word/document.xml'], {encoding:'utf8'});
  assert.doesNotMatch(legacyXml, /PRAISE REPORTS?|None (?:recorded|reported)|No entry recorded|ROLL CALL AND QUORUM/i);
  assert.match(legacyXml, /Alex Example/); assert.match(legacyXml, /Victor Example/);
} finally { await fs.rm(tmp, {recursive:true, force:true}); }
console.log('Minutes bullets, emphasis, seal, closing facts, officer roles and Word parity passed.');
