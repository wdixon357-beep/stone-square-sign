import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import { normalizeMinutesDraft } from '../minutes.js';
import { documentSections, closingReviewIssues, prayerRequestText, closingPrayerText } from '../minutes-format.js';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { buildMinutesDocx } from '../minutes-document.js';
import { MINUTES_REPORT_RULES, REPORT_RULES_VERSION } from '../report-rules.js';
import { workingMinutesEditorialDraft } from '../minutes-editorial.js';

const oldPrompt = 'Confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing; the cited source does not establish it.';
const source = {
  organizerVersion: 5, meetingDate:'2026-10-15', closingTime:'10:30 PM', closingPrayerGiven:true,
  warnings:[oldPrompt, 'Confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed; the cited source does not establish it.', 'Confirm the mover.'],
  sections:[
    {heading:'Sickness and Distress',body:`- Prayers were requested for Brother Example.\n- ${prayerRequestText}`},
    {heading:'Other Meeting Business',body:`- ${prayerRequestText}\n- The Chaplain will visit Brother Example.\n- Prayer request: confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing.`},
    {heading:'Prayer and Closing',body:`- ${prayerRequestText}\n- ${closingPrayerText}\n- The Lodge closed at 10:30 PM.`},
  ],
};
const snapshot = JSON.stringify(source);
for (const prayerRequested of [true, false, null]) {
  const draft = normalizeMinutesDraft({...source, prayerRequested, closingFormatVersion:2});
  assert.equal(draft.prayerRequested, prayerRequested, 'Editing preserves legacy recorded metadata');
  assert.deepEqual(closingReviewIssues(draft), [], 'A retired prayer request is never a submission requirement');
  const sections = documentSections(draft);
  const text = sections.map(section=>section.body).join('\n');
  assert.doesNotMatch(text, /asked the Chaplain|Prayer request: confirm/i);
  assert.match(text, /Prayers were requested for Brother Example/);
  assert.match(text, /Chaplain will visit Brother Example/);
  assert.equal(text.split(closingPrayerText).length - 1, 1);
  assert.ok(sections.at(-1).body.endsWith('The Lodge was closed at 10:30 PM.'));
  assert.ok(!draft.warnings.includes(oldPrompt));
  assert.equal(draft.warnings.length, 2, 'Actual closing-prayer and motion reminders remain');
  const parsed = new PDFParse({data:await buildMinutesPdf({draft,status:'draft'})});
  try {
    const rendered = (await parsed.getText()).text;
    assert.doesNotMatch(rendered, /asked the Chaplain|Prayer request: confirm/i);
    assert.match(rendered, /Prayers were requested for Brother Example/);
    assert.match(rendered, /The Chaplain gave the closing prayer/);
    assert.match(rendered, /The Lodge was closed at\s+10:30 PM/);
  } finally {await parsed.destroy();}
  const archive = await JSZip.loadAsync(await buildMinutesDocx({draft,status:'draft'}));
  const xml = await archive.file('word/document.xml').async('string');
  assert.doesNotMatch(xml, /asked the Chaplain|Prayer request: confirm/i);
  assert.match(xml, /Prayers were requested for Brother Example/);
  assert.match(xml, /The Chaplain gave the closing prayer/);
  assert.match(xml, /The Lodge was closed at/);
}
assert.equal(JSON.stringify(source), snapshot, 'Presentation never rewrites original source');
const legacy = normalizeMinutesDraft({...source, prayerRequested:true});
assert.equal(legacy.closingFormatVersion,1);
assert.ok(legacy.warnings.includes(oldPrompt));
assert.ok(documentSections(legacy).some(section=>section.body.includes(prayerRequestText)), 'Untouched signed legacy minutes retain their request statement');
const noClosingFacts = {...source, closingTime:null, closingPrayerGiven:null, closingFormatVersion:2};
assert.equal(closingReviewIssues(noClosingFacts).length,2);
const unrelatedNote = 'WM Dixon-Saunders asked the Chaplain to pray for Brother Example before his procedure.';
assert.ok(documentSections({...noClosingFacts,sections:[{heading:'Sickness and Distress',body:unrelatedNote}]}).some(section=>section.body.includes(unrelatedNote)), 'Specific sickness prayers are not routine boilerplate');
const openDraft = {...noClosingFacts, openingTime:'7:30 PM', closingTime:'9:00 PM', sections:[{heading:'Closing',body:'The Lodge was closed at 9:00 PM.'}]};
const updated = workingMinutesEditorialDraft(normalizeMinutesDraft(openDraft));
assert.equal(openDraft.closingPrayerGiven, null, 'Opening a draft does not mutate its stored record');
assert.equal(updated.closingFormatVersion, 4);
assert.equal(updated.closingPrayerGiven, true);
assert.deepEqual(updated.warnings, ['Confirm the mover.']);
assert.deepEqual(closingReviewIssues(updated), []);
assert.deepEqual(closingReviewIssues({...updated, closingTime:null}), ['Enter the closing time in Eastern Time with AM or PM.']);
const prayer = 'The Chaplain gave the closing prayer.';
const closing = 'The Lodge was closed at 9:00 PM.';
assert.equal(documentSections(updated).at(-1).body, `- ${prayer}\n- ${closing}`);
assert.equal(documentSections({...updated, sections:[{heading:'Closing',body:`- ${prayer}` }]}).at(-1).body,
  `- ${prayer}\n- ${closing}`, 'Routine wording appears once when the source also records it');
const prefixedPrayer = 'At closing, the Chaplain gave the closing prayer.';
assert.equal(documentSections({...updated, sections:[{heading:'Closing',body:`- ${prefixedPrayer}`}]}).at(-1).body,
  `- ${prefixedPrayer}\n- ${closing}`, 'A sourced prayer with a time reference appears once');
const exception = 'No closing prayer was given.';
const recorded = workingMinutesEditorialDraft({...openDraft, sections:[{heading:'Closing',body:`- ${exception}`}]});
assert.equal(recorded.closingPrayerGiven, false);
assert.equal(documentSections(recorded).at(-1).body, `- ${exception}\n- ${closing}`);
for (const body of [
  'At closing, the Chaplain did not give the closing prayer.',
  'The Secretary confirmed that the Chaplain did not give the closing prayer.',
  'The closing prayer was led by the Senior Warden.',
  'The Senior Warden led the closing prayer.',
  'The Senior Deacon gave the closing prayer.',
  'Bro. Example offered the closing prayer.',
]) {
  const draft = workingMinutesEditorialDraft({...openDraft, sections:[{heading:'Closing',body:`- ${body}`}]});
  assert.equal(draft.closingPrayerGiven, false);
  assert.equal(documentSections(draft).at(-1).body, `- ${body}\n- ${closing}`);
  assert.equal(documentSections({...draft, closingPrayerGiven:true}).at(-1).body, `- ${prayer}\n- ${closing}`);
}
for (const body of [
  `${prayer} That claim was disputed.`,
  `${prayer} The Chaplain did not give the closing prayer, if the transcript is correct.`,
]) {
  const draft = workingMinutesEditorialDraft({...openDraft, sections:[{heading:'Closing', body}]});
  assert.equal(draft.closingPrayerGiven, true, 'Uncertainty does not establish an exception');
}
assert.equal(documentSections({...updated, closingPrayerGiven:false}).at(-1).body,
  `- The Chaplain did not give the closing prayer.\n- ${closing}`);
const unrelatedClosingNote = 'The custodian locked the west door.';
assert.equal(documentSections({...updated, closingPrayerGiven:false,
  sections:[{heading:'Closing',body:`- ${prayer} ${unrelatedClosingNote}`}] }).at(-1).body,
  `- ${unrelatedClosingNote}\n- The Chaplain did not give the closing prayer.\n- ${closing}`,
  'An officer-recorded exception leaves other closing facts intact');
assert.doesNotMatch(documentSections(openDraft).at(-1).body, /The Chaplain gave the closing prayer/, 'The historic format retains a missing prayer value');
assert.match(MINUTES_REPORT_RULES, /Set the legacy prayerRequested field to null/);
assert.equal(REPORT_RULES_VERSION,'2026-11-18.1');
const web = await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
assert.doesNotMatch(web,/id="minutesPrayerRequested"/);
assert.match(web,/<option value="true" selected>Given by the Chaplain<\/option>/);
const app = await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
assert.doesNotMatch(app,/\$\('minutesPrayerRequested'\)/);
assert.match(app,/prayerRequested: currentMinutes\(\)\?\.draft.prayerRequested \?\? null/);
console.log('PASS: new closing format removes only the routine WM request in sections, PDF, Word and forms; closing facts and legacy records remain protected.');
