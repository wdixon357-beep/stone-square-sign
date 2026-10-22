import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import { normalizeMinutesDraft } from '../minutes.js';
import { documentSections, closingReviewIssues, prayerRequestText, closingPrayerText } from '../minutes-format.js';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { buildMinutesDocx } from '../minutes-document.js';
import { MINUTES_REPORT_RULES, REPORT_RULES_VERSION } from '../report-rules.js';

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
assert.match(MINUTES_REPORT_RULES, /Set the legacy prayerRequested field to null/);
assert.equal(REPORT_RULES_VERSION,'2026-10-21.3');
const web = await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
assert.doesNotMatch(web,/id="minutesPrayerRequested"/);
assert.match(web,/id="minutesClosingPrayerGiven"/);
const app = await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
assert.doesNotMatch(app,/\$\('minutesPrayerRequested'\)/);
assert.match(app,/prayerRequested: currentMinutes\(\)\?\.draft.prayerRequested \?\? null/);
console.log('PASS: new closing format removes only the routine WM request in sections, PDF, Word and forms; closing facts and legacy records remain protected.');
