import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import JSZip from 'jszip';
import {PDFParse} from 'pdf-parse';
import {documentSections, sectionBlocks, closingReviewIssues, detectPrayerFacts, closingPrayerText, closingPrayerTextV3, prayerRequestText} from '../minutes-format.js';
import {organizeMeetingSource} from '../minutes-organizer.js';
import {buildMinutesPdf} from '../minutes-pdf.js';
import {buildMinutesDocx} from '../minutes-document.js';
import {normalizeMinutesDraft} from '../minutes.js';
import {withMinutesEntryGrouping} from '../minutes-sections.js';
import {currentMinutesEditorialDraft, workingMinutesEditorialDraft} from '../minutes-editorial.js';

const missingTime = 'Closing time: confirm and enter the time the Lodge was closed.';
const missingPrayer = 'Closing prayer: confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.';
const missingRecord = 'Closing record: Opening time, closing time, and a formal Lodge closure statement were not recorded.';
const sicknessPrayer = 'The Chaplain offered prayer for the listed sickness and distress concerns.';
const fixture = {
  organizerVersion:5, closingFormatVersion:3, meetingDate:'2099-01-15', meetingType:'Stated Communication',
  degree:'Third Degree', openingTime:'7:30 PM', closingTime:null, closingPrayerGiven:null,
  prayerRequested:null, nextMeeting:null, presiding:'Synthetic Presiding Officer', quorum:'Yes',
  officerAttendance:[], present:[], excused:[], visitors:[], sensitiveReview:[], warnings:[],
  sections:[
    {heading:'Sickness and Distress',body:`- ${sicknessPrayer}`},
    {heading:'Prayer and Closing',body:`- **Closing record:** Opening time, closing time, and a formal Lodge closure statement were not recorded.\n- ${missingPrayer}\n- ${missingTime}`},
  ],
};
const snapshot = JSON.stringify(fixture);
const renderedText = draft => documentSections(draft).map(section => section.body).join('\n');
const clean = renderedText(fixture);
assert.equal(clean,`- ${sicknessPrayer}`, 'New unknown closing details do not become narrative prompts or fabricated events');
assert.equal(JSON.stringify(fixture),snapshot,'Versioned presentation never mutates the working draft or source');
assert.equal(fixture.closingTime,null);
assert.equal(fixture.closingPrayerGiven,null);
const openingTimeIssue='Enter the opening time in Eastern Time with AM or PM.';
const closingTimeIssue='Enter the closing time in Eastern Time with AM or PM.';
assert.deepEqual(closingReviewIssues(fixture),[closingTimeIssue,'Confirm whether the Chaplain gave the closing prayer.'],'Structured unknowns still require the preparer form');
assert.deepEqual(closingReviewIssues({...fixture,closingTime:'9:00 PM',closingPrayerGiven:true}),[]);
const completeTimes={...fixture,openingTime:'7:30 PM',closingTime:'9:45 PM',closingPrayerGiven:true};
assert.deepEqual(closingReviewIssues(completeTimes),[],'Both explicitly confirmed meeting times are accepted');
for(const value of [null,undefined,'','945','0945','945 PM','9:45','7:30','0 PM','13 PM','12:60 PM','23:60','24:00','7:3 PM','9:45 PM tomorrow','2:00 PM to 4:00 PM']) {
  assert.deepEqual(closingReviewIssues({...completeTimes,openingTime:value}),[openingTimeIssue],'Missing or ambiguous opening clocks are not accepted');
  assert.deepEqual(closingReviewIssues({...completeTimes,closingTime:value}),[closingTimeIssue],'Missing or ambiguous closing clocks are not accepted');
}
for(const value of ['9 PM','9PM','9:45 PM','7:30 a.m.','12 AM','12:00 PM','07:30','09:45','12:30','21:45','00:00','23:59']) {
  assert.deepEqual(closingReviewIssues({...completeTimes,openingTime:value,closingTime:value}),[],'Explicit meridiem or complete 24-hour clocks are retained without conversion');
}
assert.deepEqual(closingReviewIssues({...completeTimes,openingTime:null,closingTime:'945'}),[openingTimeIssue,closingTimeIssue],'Both actual meeting times must be completed independently');
const futureEvent=organizeMeetingSource('Upcoming Events and Reminders\nArts & Crafts Day will take place from 2:00 PM to 4:00 PM.');
assert.equal(futureEvent.openingTime,null,'A future event start is not this meeting opening');
assert.equal(futureEvent.closingTime,null,'A future event end is not this meeting closure');
const actualMeeting=organizeMeetingSource('Opening\nThe Lodge opened at 7:30 PM.\nPrayer and Closing\nThe Lodge closed at 9:45 PM.');
assert.equal(actualMeeting.openingTime,'7:30 PM');
assert.equal(actualMeeting.closingTime,'9:45 PM','Existing source extraction still retains explicit actual clocks');

const genericPrayer='The Chaplain gave the closing prayer.';
assert.equal(detectPrayerFacts(genericPrayer).closingPrayerGiven,null,'Default historical detector retains its composite meaning');
assert.equal(detectPrayerFacts(genericPrayer,{closingFormatVersion:3}).closingPrayerGiven,true,'New explicit closing prayer needs no invented subject');
for(const closingFormatVersion of [2,3]) assert.equal(detectPrayerFacts('The Chaplain gave the closing prayer and prayed for the sick and distressed.',{closingFormatVersion}).closingPrayerGiven,true);
for(const source of [
  'The Chaplain offered prayer for the sick and distressed.',
  'The Chaplain will give the closing prayer.',
  'The Chaplain did not give the closing prayer.',
  'The Chaplain never gave the closing prayer.',
  'At the previous meeting the Chaplain gave the closing prayer.',
  'If the Chaplain gave the closing prayer, note it.',
  'It is unclear whether the Chaplain gave the closing prayer.',
  'Unconfirmed: the Chaplain gave the closing prayer.',
  'The Chaplain gave the closing prayer, according to an unverified report.',
  'No evidence establishes that the Chaplain gave the closing prayer.',
  'Confirm that the Chaplain gave the closing prayer.',
  'The Worshipful Master requested that the Chaplain gave the closing prayer.',
  'Did the Chaplain gave the closing prayer?',
  'The Chaplain thanked the Brother who gave the closing prayer.',
  'It was denied that the Chaplain gave the closing prayer.',
  'The Secretary doubted that the Chaplain gave the closing prayer.',
  'It is false that the Chaplain gave the closing prayer.',
  'The claim that the Chaplain gave the closing prayer remains disputed.',
  'The Chaplain gave the closing prayer, or perhaps another Brother did.',
  'The Chaplain gave the closing prayer, or another Brother did.',
  'The Chaplain gave the closing prayer, perhaps.',
  'It was refuted that the Chaplain gave the closing prayer.',
  'The claim that the Chaplain gave the closing prayer was disclaimed.',
  'An unsupported assertion says the Chaplain gave the closing prayer.',
]) assert.equal(detectPrayerFacts(source,{closingFormatVersion:3}).closingPrayerGiven,null,'Requests, uncertainty, other actors and other meetings do not establish a completed closing prayer');
for(const source of ['There being no further business, the Chaplain gave the closing prayer.','May 1: the Chaplain gave the closing prayer.','WM Dixon-Saunders confirmed that the Chaplain gave the closing prayer.','The Secretary verified that the Chaplain gave the closing prayer.','Bro. Example confirmed that the Chaplain gave the closing prayer.','At the end of the meeting, the Chaplain gave the closing prayer.','9:45 PM: the Chaplain gave the closing prayer.']) assert.equal(detectPrayerFacts(source,{closingFormatVersion:3}).closingPrayerGiven,true,'A direct completed event or explicit affirmative actor report remains established');
for(const refutation of ['That is false.','This is not true.','It was denied.','That statement was disputed.','This claim was refuted.','The Chaplain did not give the closing prayer.','That did not happen.',"That didn't happen.",'Correction: no closing prayer was given.']) {
  for(const separator of [' ','\n','\n\n']) {
    const source=`${genericPrayer}${separator}${refutation}`;
    assert.equal(detectPrayerFacts(source,{closingFormatVersion:3}).closingPrayerGiven,null,'A same-line or adjacent explicit refutation prevents the positive claim from establishing a closing prayer');
  }
}
for(const unrelated of ['The Lodge did not take a collection.','The Secretary did not give the closing prayer.','The Chaplain did not give an opening prayer.','The Chaplain did not give the closing prayer at the previous meeting.','No opening prayer was given.']) assert.equal(detectPrayerFacts(`${genericPrayer}\n${unrelated}`,{closingFormatVersion:3}).closingPrayerGiven,true,'An unrelated negative fact does not refute the current completed closing prayer');
assert.equal(detectPrayerFacts(`There being no further business, the Chaplain gave the closing prayer.\nThe Lodge did not take a collection.`,{closingFormatVersion:3}).closingPrayerGiven,true);

const confirmed = {...fixture, closingPrayerGiven:true};
assert.equal(renderedText(confirmed),`- ${sicknessPrayer}\n- ${closingPrayerTextV3}`,'Confirmed closing prayer is separate from the Sickness and Distress prayer');
assert.doesNotMatch(renderedText(confirmed),/gave the closing prayer and prayed for the sick/,'Generic confirmation never adds an unconfirmed prayer subject');
for (const prayer of [closingPrayerTextV3,'The Chaplain offered the closing prayer.','**Prayer:** The Chaplain gave the closing prayer at the end of the meeting.']) {
  const sections=[fixture.sections[0],{heading:'Prayer and Closing',body:`- ${prayer}\n- ${prayer}`}];
  const text=renderedText({...confirmed,sections});
  assert.equal((text.match(/closing prayer/g)||[]).length,1,'An existing generic closing prayer is rendered exactly once');
  assert.equal(text.split(sicknessPrayer).length-1,1,'The distinct Sickness and Distress occurrence remains once');
}
const detailedPrayer = 'The Chaplain gave the closing prayer and prayed for the sick and distressed.';
assert.equal(documentSections({...confirmed,sections:[{heading:'Prayer and Closing',body:`- ${detailedPrayer}`}]}).at(-1).body,`- ${detailedPrayer}`,'Additional actual closing-prayer details retain their wording, without a generic duplicate');
const sourcePrayer = {...fixture,sections:[{heading:'Prayer and Closing',body:`- ${closingPrayerTextV3}`}]};
assert.equal(documentSections(sourcePrayer).at(-1).body,`- ${closingPrayerTextV3}`,'An actual prayer sentence is not silently dropped when metadata remains unknown');

const realNegative = 'No closing prayer was given.';
const realExplanation = 'The closing time was not recorded because the clock had stopped.';
const realRecord = 'Closing record: No formal Lodge closure occurred while the fire alarm was active.';
const substantive = {...fixture,closingPrayerGiven:false,sections:[{heading:'Prayer and Closing',body:`- ${realNegative}\n- ${realExplanation}\n- ${realRecord}`} ]};
for(const fact of [realNegative,realExplanation,realRecord]) assert.ok(renderedText(substantive).includes(fact),'Actual negative facts and explanations survive narrow placeholder removal');
assert.ok(!renderedText(substantive).includes(closingPrayerTextV3),'False does not become a prayer assertion');

const closedWithoutTime = {...confirmed,sections:[{heading:'Prayer and Closing',body:'- The Lodge was closed.\n- A synthetic final announcement was recorded.'}]};
assert.equal(documentSections(closedWithoutTime).at(-1).body,`- A synthetic final announcement was recorded.\n- ${closingPrayerTextV3}\n- The Lodge was closed.`,'A recorded closure without a time remains last, with no invented time');
const formalClosure = 'There being no further business, the Lodge was closed in due form by the Worshipful Master.';
assert.ok(documentSections({...confirmed,sections:[{heading:'Prayer and Closing',body:`- ${formalClosure}\n- A synthetic final announcement was recorded.`}]}).at(-1).body.endsWith(formalClosure),'Formal actual closure remains the final narrative item');
const timed = {...confirmed,closingTime:'9:00 PM',sections:[{heading:'Prayer and Closing',body:'- The Lodge closed at 9:00 PM.'}]};
assert.equal(documentSections(timed).at(-1).body,`- ${closingPrayerTextV3}\n- The Lodge was closed at 9:00 PM.`,'Reviewed actual closing time appears once after prayer');

const legacySource = {...fixture,sections:[fixture.sections[0],{heading:'Prayer and Closing',body:'- A synthetic final announcement was recorded.'}]};
for(const closingFormatVersion of [1,2]) {
  const draft={...legacySource,closingFormatVersion};
  const sections=documentSections(draft);
  assert.equal(sections.at(-1).body,`- A synthetic final announcement was recorded.\n- ${missingPrayer}\n- ${missingTime}`,'Legacy unknown prayer/time rendering is unchanged');
  assert.equal(sections.find(section=>section.heading==='Sickness and Distress').body,closingFormatVersion===1 ? `- ${sicknessPrayer}\n- Prayer request: confirm whether the Worshipful Master asked the Chaplain to pray for the sick and distressed at closing.` : `- ${sicknessPrayer}`);
  assert.equal(documentSections({...draft,closingPrayerGiven:true,prayerRequested:true}).at(-1).body,`- A synthetic final announcement was recorded.\n- ${closingPrayerText}\n- ${missingTime}`,'Captured older confirmation keeps its original composite wording');
  assert.equal(closingReviewIssues(draft)[1],'Confirm whether the Chaplain gave the closing prayer and prayed for the sick and distressed.');
  if(closingFormatVersion===1) assert.ok(renderedText({...draft,prayerRequested:true}).includes(prayerRequestText));
}

async function texts(draft, status = 'draft') {
  const parser=new PDFParse({data:await buildMinutesPdf({draft,status})});
  let pdf;
  try {pdf=(await parser.getText()).text;} finally {await parser.destroy();}
  const archive=await JSZip.loadAsync(await buildMinutesDocx({draft,status}));
  const xml=await archive.file('word/document.xml').async('string');
  return [pdf,xml.replace(/<[^>]+>/g,'')];
}
for(const text of await texts(confirmed)) {
  assert.doesNotMatch(text,/Closing record:|Closing time: confirm|Closing prayer: confirm/,'Both new document formats omit uncertainty filler');
  assert.match(text,/The Chaplain gave the closing prayer\./);
  assert.doesNotMatch(text,/gave the closing prayer and prayed for the sick/);
  assert.match(text,/Chaplain offered prayer for the listed sickness and distress concerns/);
  assert.doesNotMatch(text,/The Lodge was closed at/,'Missing closing time does not create an event');
}
for(const closingFormatVersion of [1,2]) for(const text of await texts({...legacySource,closingFormatVersion})) {
  assert.match(text,/Closing time: confirm/,'Captured PDF and Word retain legacy time prompt');
  assert.match(text,/Closing prayer: confirm/,'Captured PDF and Word retain legacy prayer prompt');
}

const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const workingCopySource = server.slice(server.indexOf('const workingMinutesDraft ='), server.indexOf('const minutesForResponse ='));
const workingCopy = vm.runInNewContext(`${workingCopySource}\nworkingMinutesDraft`, {
  normalizeMinutesDraft, withMinutesEntryGrouping, currentMinutesEditorialDraft, workingMinutesEditorialDraft,
});
const submitted = {
  ...completeTimes, closingFormatVersion: 4,
  sections: [{
    heading: 'Sickness and Distress',
    body: '- A family asked for\ncontinued prayers during recovery.\n- A separate prayer request was received.',
  }],
};
const signedPreparerJson = JSON.stringify(submitted);
const pending = Object.freeze({
  status: 'awaiting_master_attestation',
  draft_json: signedPreparerJson,
  submitted_draft_json: signedPreparerJson,
});
const sicknessBlocks = draft => sectionBlocks(documentSections(draft).find(section => section.heading === 'Sickness and Distress'))
  .map(item => item.text);
const reviewDraft = workingCopy(pending);
assert.equal(reviewDraft.entryFormatVersion, 1);
assert.deepEqual(sicknessBlocks(reviewDraft), [
  'A family asked for continued prayers during recovery.',
  'A separate prayer request was received.',
]);
const {entryFormatVersion: formatMarker, ...postedDraft} = reviewDraft;
assert.equal(formatMarker, 1);
assert.deepEqual(workingCopy(pending, postedDraft), reviewDraft, 'Previewing browser or Mac draft data preserves the working-copy layout');
const earlierPending = { ...pending, draft_json: JSON.stringify({ ...submitted, closingFormatVersion: 2, closingPrayerGiven: null }) };
assert.equal(workingCopy(earlierPending).closingPrayerGiven, null, 'Entry grouping does not attest an older unknown closing prayer');
for (const text of await texts(reviewDraft, pending.status)) {
  assert.match(text, /A family asked for continued prayers during recovery\./, 'Both previews keep the continuation on the same item');
  assert.match(text, /A separate prayer request was received\./, 'Both previews retain the next separate matter');
}
assert.equal(pending.submitted_draft_json, signedPreparerJson);
assert.equal(pending.draft_json, signedPreparerJson, 'Opening legacy minutes does not rewrite the submitted or working record');

const olderGrouping = { ...pending, draft_json: JSON.stringify({ ...submitted, entryFormatVersion: 1 }) };
for (const status of ['draft', 'awaiting_master_attestation']) {
  const row = { ...olderGrouping, status };
  const current = workingCopy(row);
  assert.deepEqual(sicknessBlocks(current), sicknessBlocks(reviewDraft), 'An existing format marker does not skip working-copy line corrections');
  assert.deepEqual(workingCopy(row, current), current, 'Read, edited preview, and save use the same formatted copy');
  assert.deepEqual(workingCopy({ ...row, draft_json: JSON.stringify(current) }), current, 'Reading an already repaired copy is idempotent');
}

for (const status of ['ready_for_distribution', 'distributed', 'approved_by_lodge']) {
  for (const [row, marker] of [[pending, undefined], [olderGrouping, 1]]) {
    const finalized = workingCopy({ ...row, status });
    assert.equal(finalized.entryFormatVersion, marker);
    assert.deepEqual(sicknessBlocks(finalized), [
      'A family asked for',
      'continued prayers during recovery.',
      'A separate prayer request was received.',
    ], 'Previously finalized minutes retain their original item boundaries with or without a format marker');
  }
}
for (const text of await texts(normalizeMinutesDraft(JSON.parse(signedPreparerJson)), 'approved_by_lodge')) {
  assert.doesNotMatch(text, /A family asked for continued prayers during recovery\./, 'Captured historical PDF and Word retain their original layout');
}

const preparerApply = server.slice(server.indexOf('const applyMinutesPreparerSignature ='), server.indexOf('const finishMinutesPreparerSignature ='));
const masterApply = server.slice(server.indexOf('const applyMinutesMasterSignature ='), server.indexOf('const finishMinutesMasterSignature ='));
const signatureReview = server.slice(server.indexOf("for (const phase of ['preparer','master'])"), server.indexOf("registerSignatureOperation('documents.sign'"));
assert.match(preparerApply, /const draft = workingMinutesDraft\(row\);/, 'Direct preparer signing captures the exact working-copy draft');
assert.match(masterApply, /const draft = workingMinutesDraft\(row\);/, 'Direct Master signing captures the exact working-copy draft');
assert.match(signatureReview, /const draft = workingMinutesDraft\(row\);/, 'Confirmation binds the same working-copy draft in either phase');
assert.equal(JSON.stringify(fixture),snapshot);
console.log('PASS: reviewed PDF and Word text, legacy pending entry grouping, shared Master signature input, and captured archive protection.');
