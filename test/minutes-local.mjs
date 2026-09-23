import assert from 'node:assert/strict';
import { generateMinutesDraft, normalizeMinutesDraft } from '../minutes.js';
import { officerAttendanceRows, nonOfficerExcused } from '../minutes-layout.js';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { PDFDocument } from 'pdf-lib';
import { SICKNESS_HEADING, isSicknessHeading } from '../minutes-sections.js';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Local minutes generation must not call an external service.'); };
try {
  const sicknessAliases = [
    'Sickness and Distress', 'SICKNESS & DISTRESS', '3. Sick and Distressed:',
    '### **SICKNESS & DISTRESS:**', '**SICKNESS & DISTRESS**:', '(3) __Sick & Distressed__',
    '2) SICKNESS AND DISTRESSED:', 'Sickness', 'Distress',
  ];
  for (const alias of sicknessAliases) assert.ok(isSicknessHeading(alias), `recognize ${alias}`);
  for (const sentence of ['Please pray for the sick and distressed.', 'Sickness and Distress follow up', 'Sick & Distress: prayers were requested']) {
    assert.equal(isSicknessHeading(sentence), false, 'only a complete heading is canonicalized');
  }
  for (const alias of sicknessAliases) {
    const agenda = await generateMinutesDraft(`ROLL CALL
Present: Brother Example One; Brother Example Two
A quorum was established.
${alias}
A Brother requested prayers for his family.
A visit was arranged for next week.
PRAISE REPORTS
The building team was thanked for completing the repairs.
READING OF THE MINUTES
The previous minutes were read and approved.`);
    assert.equal(agenda.sourceType, 'compiled_notes');
    assert.deepEqual(agenda.present, ['Brother Example One', 'Brother Example Two']);
    const sickness = agenda.sections.filter(section => section.heading === SICKNESS_HEADING);
    assert.equal(sickness.length, 1, `one dedicated section for ${alias}`);
    assert.match(sickness[0].body, /A Brother requested prayers for his family\.[^]*A visit was arranged for next week\./);
    assert.doesNotMatch(sickness[0].body, /building team|previous minutes|PRAISE REPORTS|READING OF THE MINUTES/);
    assert.ok(!agenda.sections.some(section => section.heading === 'Roll Call and Quorum'));
    assert.equal(agenda.quorum, 'Yes', 'quorum stays in metadata after the redundant section is removed');
    assert.match(agenda.sections.find(section => section.heading === 'Good of the Order').body, /building team/);
    assert.match(agenda.sections.find(section => section.heading === 'Reading of the Minutes').body, /read and approved/);
  }
  const healthNarrative = await generateMinutesDraft('A Brother was sick and requested prayers. Another Brother was distressed. The Chaplain prayed for the families. The Chaplain gave the closing prayer. The Lodge closed at 9:00 PM.');
  const healthBody = healthNarrative.sections.find(section => section.heading === SICKNESS_HEADING)?.body;
  assert.match(healthBody, /was sick and requested prayers[^]*was distressed[^]*prayed for the families/);
  assert.doesNotMatch(healthBody, /closing prayer|Lodge closed/);
  const closingBody = healthNarrative.sections.find(section => section.heading === 'Prayer and Closing')?.body;
  assert.match(closingBody, /closing prayer/);
  for (const request of ['Prayers were requested for Brother Example.', 'A prayer was requested for Brother Example.']) {
    const prayerNarrative = await generateMinutesDraft(`The Lodge opened at 7:30 PM. ${request} The Chaplain gave the closing prayer. The Lodge closed at 9:00 PM.`);
    const prayerBody = prayerNarrative.sections.find(section => section.heading === SICKNESS_HEADING)?.body;
    assert.equal(prayerBody, request, 'preserve a passive prayer request in its dedicated section');
    assert.doesNotMatch(prayerBody, /closing prayer|Lodge closed/);
  }
  const ordinaryClosing = await generateMinutesDraft('The next stated communication date was announced to the Brothers. The Chaplain gave the closing prayer. The Lodge closed at 9:00 PM.');
  assert.equal(ordinaryClosing.sections.find(section => section.heading === SICKNESS_HEADING)?.body || '', '', 'a general closing prayer does not establish a sickness report');

  for (const visitorValue of ['None', 'NONE', 'None recorded', 'None reported', 'N/A', 'No visitors', 'No visiting Brothers']) {
    const noVisitors = await generateMinutesDraft(`ROLL CALL AND QUORUM\nPresent: Brother Example One\nVisitors: ${visitorValue}\nA quorum was established.\nCLOSING\nThe Lodge closed at 9:00 PM.`);
    assert.deepEqual(noVisitors.visitors, [], 'a no-visitors marker is not a person');
    assert.deepEqual(noVisitors.present, ['Brother Example One']);
  }
  const visitorWithAffiliation = await generateMinutesDraft('ROLL CALL AND QUORUM\nPresent: Brother Sample Member\nVisitors: Bro. Alex Example, Example Lodge No. 99\nA quorum was established.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.deepEqual(visitorWithAffiliation.visitors, ['Bro. Alex Example, Example Lodge No. 99'], 'a visitor affiliation stays attached to its visitor');
  for (const secondVisitor of ['Bro. Ben Sample of Example Lodge No. 99', 'Ben Sample of Example Lodge No. 99']) {
    const separateVisitors = await generateMinutesDraft(`ROLL CALL AND QUORUM\nPresent: Brother Sample Member\nVisitors: Bro. Alex Example, ${secondVisitor}\nA quorum was established.\nCLOSING\nThe Lodge closed at 9:00 PM.`);
    assert.deepEqual(separateVisitors.visitors.map(visitor => visitor.toLowerCase()), ['bro. alex example', secondVisitor.toLowerCase()], 'a second person with a Lodge affiliation remains a separate visitor');
  }
  const legacySections = [{heading:'Roll Call and Quorum',body:'All officers are present unless noted.\nATTENDANCE AND VISITORS\nAdditional Brothers and visitors recorded in the sign in book.\nPRAISE REPORTS\nNone reported.'}];
  const legacyBefore = JSON.stringify(legacySections);
  const legacyClean = normalizeMinutesDraft({sections:legacySections,visitors:[]});
  assert.ok(!legacyClean.sections.some(section => section.heading === 'Roll Call and Quorum'));
  assert.doesNotMatch(JSON.stringify(legacyClean.sections), /praise reports|none reported|attendance and visitors|sign in book/i);
  assert.equal(JSON.stringify(legacySections), legacyBefore, 'display normalization does not mutate the source snapshot');
  const namedVisitorDraft = normalizeMinutesDraft({visitors:['Bro. Alex Example, Example Lodge No. 99'],sections:[{heading:'Roll Call and Quorum',body:'Visitors: Bro. Alex Example, Example Lodge No. 99'}]});
  assert.deepEqual(namedVisitorDraft.visitors, ['Bro. Alex Example, Example Lodge No. 99']);
  assert.ok(!namedVisitorDraft.sections.some(section => section.heading === 'Roll Call and Quorum'));
  const visitorMarkers = ['None', 'None recorded', 'None reported.', 'None were recorded.', 'Not recorded', 'Not applicable', 'N/A', 'NA', 'N.A.', 'No visitors', 'No visitors were present.', 'No visiting Brothers', 'Visitors: None reported.'];
  const placeholderVisitors = normalizeMinutesDraft({visitors:visitorMarkers,sections:legacySections});
  assert.deepEqual(placeholderVisitors.visitors, [], 'saved visitor placeholders cannot create a Visitors table');
  assert.doesNotMatch(JSON.stringify(placeholderVisitors.sections), /attendance and visitors|sign in book/i, 'section cleanup receives the filtered visitor list');
  const mixedVisitors = normalizeMinutesDraft({visitors:[...visitorMarkers,'Bro. Alex Example, Example Lodge No. 99','Bro. Ben Sample of Example Lodge No. 99']});
  assert.deepEqual(mixedVisitors.visitors, ['Bro. Alex Example, Example Lodge No. 99','Bro. Ben Sample of Example Lodge No. 99'], 'placeholder filtering preserves actual visitor names and affiliations exactly');
  for (const emptyPraise of ['PRAISE REPORTS\nNone reported.', '3. Praise Reports: None recorded.', '**Praise Reports**\n- **None recorded.**']) {
    const noPraise = await generateMinutesDraft(`OPENING\nThe Lodge opened at 7:30 PM.\n${emptyPraise}\nNEW BUSINESS\nA planning discussion was held. No vote was taken.\nCLOSING\nThe Lodge closed at 9:00 PM.`);
    assert.doesNotMatch(JSON.stringify(noPraise.sections), /praise reports|none recorded|none reported/i);
    assert.match(noPraise.sections.find(section => section.heading === 'New Business and Motions').body, /No vote was taken/);
  }
  const meaningfulPraise = await generateMinutesDraft('OPENING\nThe Lodge opened at 7:30 PM.\nPRAISE REPORTS\nPrayers were requested for the families.\nThe volunteers were thanked for arranging the supper.\nA motion to repair the steps was seconded.\nNo vote was taken. The team will obtain an estimate.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.match(meaningfulPraise.sections.find(section => section.heading === SICKNESS_HEADING).body, /Prayers were requested for the families/);
  assert.match(meaningfulPraise.sections.find(section => section.heading === 'Good of the Order').body, /volunteers were thanked/);
  assert.match(meaningfulPraise.sections.find(section => section.heading === 'New Business and Motions').body, /repair the steps was seconded[^]*No vote was taken[^]*obtain an estimate/);
  assert.doesNotMatch(JSON.stringify(meaningfulPraise.sections), /praise reports/i);
  const uppercaseAttendance = await generateMinutesDraft('ROLL CALL\nPresent:\nJOHN SAMPLE\nJAMES EXAMPLE\nExcused:\nDAVID TEST\nCOMMUNITY SERVICE\nA food collection was discussed.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.deepEqual(uppercaseAttendance.present, ['JOHN SAMPLE', 'JAMES EXAMPLE'], 'uppercase names remain in an explicitly labeled attendance list');
  assert.deepEqual(uppercaseAttendance.excused, ['DAVID TEST']);
  assert.ok(uppercaseAttendance.warnings.some(warning => /Uppercase entries under present were kept as names/.test(warning)));
  assert.match(uppercaseAttendance.sections.find(section => section.heading === 'Other Meeting Business').body, /COMMUNITY SERVICE[^]*food collection/);
  assert.doesNotMatch(JSON.stringify(uppercaseAttendance.sections), /JOHN SAMPLE|JAMES EXAMPLE|DAVID TEST/);
  const markedAttendanceBoundary = await generateMinutesDraft('ROLL CALL\nPresent:\nJOHN SAMPLE\n### Planning Topics\nThe schedule was discussed.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.deepEqual(markedAttendanceBoundary.present, ['JOHN SAMPLE']);
  assert.match(markedAttendanceBoundary.sections.find(section => section.heading === 'Other Meeting Business').body, /Planning Topics[^]*schedule was discussed/);
  for (const heading of ['OFFICER INSTALLATION', 'INSTALLATION', '### Officer Installation', '**Officer Installation**']) {
    const unplaced = await generateMinutesDraft(`ROLL CALL\nPresent: Brother Example One\n${heading}\nA ceremony was discussed.\nThe schedule remains to be confirmed.\nREADING OF THE MINUTES\nThe previous minutes were read.`);
    assert.deepEqual(unplaced.present, ['Brother Example One'], 'an unknown heading is not an attendee');
    const preserved = unplaced.sections.find(section => section.heading === 'Other Meeting Business')?.body;
    assert.match(preserved, /installation[^]*A ceremony was discussed\.[^]*schedule remains/i);
    assert.doesNotMatch(preserved, /previous minutes were read/);
    assert.ok(unplaced.warnings.some(warning => /Confirm the section.*Other Meeting Business/.test(warning)), 'uncertain placement requires visible review');
    assert.ok(!unplaced.sections.some(section => section.heading === 'Roll Call and Quorum' && /ceremony/.test(section.body)));
  }
  const treasuryBoundary = await generateMinutesDraft("TREASURER REPORT\nThe report was circulated. A letter was read aloud.\nCOMMUNITY SERVICE\nA food collection was planned for next month.\nVolunteers will prepare boxes.\nCLOSING\nThe Lodge closed at 9:00 PM.");
  assert.match(treasuryBoundary.sections.find(section => section.heading === 'Other Meeting Business').body, /COMMUNITY SERVICE[^]*food collection[^]*prepare boxes/);
  assert.match(treasuryBoundary.sections.find(section => section.heading === "Treasurer's Report").body, /Confirm whether it was read/);
  for (const note of ['A letter was read aloud.', 'A committee report was read aloud.', 'The report was presented.', 'The Secretary was asked to read the report.', 'The report will be read aloud.', 'The report was read silently.', 'Please read the report.', 'Read the report.', 'The report was not read. The report was read aloud.']) {
    const unconfirmed = await generateMinutesDraft(`OPENING\nThe Lodge opened at 7:30 PM.\nTREASURER REPORT\n${note}\nCLOSING\nThe Lodge closed at 9:00 PM.`);
    assert.match(unconfirmed.sections.find(section => section.heading === "Treasurer's Report").body, /Confirm whether it was read/, 'treasury reading requires evidence tied to this report');
  }
  for (const note of ['The report was read aloud.', 'The Secretary read the report.', 'Read by the Secretary.']) {
    const confirmed = await generateMinutesDraft(`OPENING\nThe Lodge opened at 7:30 PM.\nTREASURER REPORT\n${note}\nCLOSING\nThe Lodge closed at 9:00 PM.`);
    assert.equal(confirmed.sections.find(section => section.heading === "Treasurer's Report").body, "The Treasurer's report was read aloud.");
  }
  const inlineHeading = await generateMinutesDraft('1. Opening\nThe Lodge opened at 7:30 PM.\n2. Committee Reports: The team inspected the roof.\n3. Closing\nThe Lodge closed at 9:00 PM.');
  assert.match(inlineHeading.sections.find(section => section.heading === 'Committee Reports').body, /team inspected the roof/);
  assert.ok(!inlineHeading.sections.some(section => section.heading === 'New Business and Motions'));
  const motionOutcome = await generateMinutesDraft('NEW BUSINESS\nA motion to repair the steps was made and seconded.\nAPPROVED UNANIMOUSLY\nALL IN FAVOR\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.match(motionOutcome.sections.find(section => section.heading === 'New Business and Motions').body, /repair the steps[^]*APPROVED UNANIMOUSLY[^]*ALL IN FAVOR/);
  assert.ok(!motionOutcome.warnings.some(warning => /Confirm the section/.test(warning)), 'uppercase outcomes remain with their motion');
  const letterhead = await generateMinutesDraft('Stone Square Lodge No. 22\nOPENING\nThe Lodge opened at 7:30 PM.\nNEW BUSINESS\nStone Square Lodge will host a food collection next month.\nCLOSING\nThe Lodge closed at 9:00 PM.\nPage 1 of 1');
  assert.match(letterhead.sections.find(section => section.heading === 'New Business and Motions').body, /Stone Square Lodge will host a food collection next month/);
  assert.doesNotMatch(JSON.stringify(letterhead.sections), /Stone Square Lodge No\. 22|Page 1 of 1/);
  const privateNote = await generateMinutesDraft('OPENING\nThe Lodge opened at 7:30 PM.\nNEW BUSINESS\nA private dues status matter was noted.\nNo action was recorded.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.deepEqual(privateNote.sensitiveReview, ['A private dues status matter was noted.']);
  assert.doesNotMatch(JSON.stringify(privateNote.sections), /was referred|dues status/);
  assert.match(privateNote.sections.find(section => section.heading === 'New Business and Motions').body, /withheld pending officer review[^]*No action was recorded/);
  assert.ok(privateNote.warnings.some(warning => /private source details before attestation/.test(warning)));
  const lateHeaderDate = await generateMinutesDraft('Example header\nExample address\nExample city\nExample contact\nExample reference\nExample document label\nMinutes for Thursday, September 17, 2026\nOPENING\nThe Lodge opened at 7:30 PM.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.equal(lateHeaderDate.meetingDate, '2026-09-17', 'an explicit meeting title beyond five header lines still supplies the date');
  const eventDate = await generateMinutesDraft('September 25, 2026 community supper\nOPENING\nThe Lodge opened at 7:30 PM.\nNEW BUSINESS\nVolunteers will arrange the meal.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.equal(eventDate.meetingDate, null, 'a dated event near the top is not standalone meeting-date metadata');
  const openOn = await generateMinutesDraft('Open on: Third Degree at 7:30 PM.\nA quorum was established.\nNEW BUSINESS\nThe meeting schedule was discussed.\nCLOSING\nThe Lodge closed at 9:00 PM.');
  assert.equal(openOn.degree, 'Third Degree');
  assert.equal(openOn.openingTime, '7:30 PM');

  // Synthetic example mirrors notes, including Markdown, speaker labels, a future
  // event date, a financial report, a contextual motion, and a rejected proposal.
  const source = `****Excused: PM John Brown, david marable, Brother Marcus Green****
Present: Adrian Reese; William M. McDuffie
1. Opening
The Lodge opened on the Third Degree at 7:30 PM. A quorum was present.
Grand Secretary Mobley present as a member.
2. Sickness and Distress
PM Stone: Prayers for a family member.
WM: Prayers for Brother Green.
3. Minutes of the Previous Meeting
Distributed by email. No errors or omissions. Approved.
4. Treasurer's Report (information only, no vote)
Treasurer absent. Read by Secretary McDuffie.
Beginning balance $8,000; receipts $300; ending balance $8,300.
A deposit of $500 was proposed for a future event. No vote taken.
5. Degree Work and Current Class
Fellow Craft Degree planned for October. Two rehearsals remain to be scheduled.
6. Communications
Community Supper, September 25. The Lodge has the kitchen; the chapter is assisting.
MOTION PASSED: Fish and two sides. Moved PM Stone, seconded PM Reed.
Brothers will arrange the cleanup. Revenue split discussed; no decision.
Grand Lodge Visitation: Thursday, December 3, 2026.
7. Dues for Past Masters (discussion; no dues carried)
No dues carried. No motion was made.
8. Committee Reports
Building and Grounds
WM additions
The entry lighting will be repaired.
9. Past Masters' Remarks
Read the ritual as written.
10. Closing
The Lodge closed at 9:18 PM.`;
  const draft = await generateMinutesDraft(source);
  const section = heading => draft.sections.find(s => s.heading === heading)?.body || '';
  assert.equal(draft.sourceType, 'compiled_notes');
  assert.equal(draft.meetingDate, null, 'a future visitation date is not the meeting date');
  assert.equal(draft.degree, 'Third Degree', 'opening degree takes precedence over future degree work');
  assert.equal(draft.quorum, 'Yes');
  assert.equal(draft.openingTime, '7:30 PM');
  assert.equal(draft.closingTime, '9:18 PM');
  assert.deepEqual(draft.excused, ['Brother Marcus Green'], 'the Other Brothers Excused list excludes Lodge officers');
  assert.equal(draft.officerAttendance.find(r => r.title === 'Treasurer').status, 'excused');
  assert.equal(draft.officerAttendance.find(r => r.title === 'Assistant Treasurer').status, 'excused');
  assert.equal(draft.officerAttendance.find(r => r.name === 'Adrian Reese').status, 'present');
  assert.deepEqual(nonOfficerExcused(draft), ['Brother Marcus Green']);
  assert.equal(section("Treasurer's Report"), "The Treasurer's report was read aloud.");
  assert.doesNotMatch(JSON.stringify(draft.sections), /Treasurer absent|8,000|8,300/);
  assert.equal(draft.income.length, 0, 'reported figures and proposals are not transactions');
  assert.equal(draft.expenses.length, 0);
  assert.match(section('Sickness and Distress'), /PM Stone.*\nWM: Prayers/);
  assert.match(section('Reading of the Minutes'), /No errors or omissions/);
  assert.match(section('New Business and Motions'), /Community Supper[^]*MOTION PASSED: Fish and two sides[^]*Revenue split discussed; no decision/);
  assert.match(section('New Business and Motions'), /No dues carried. No motion was made/);
  assert.match(section('Communications'), /Grand Lodge Visitation/);
  assert.doesNotMatch(JSON.stringify(draft.sections), /Grand Secretary Mobley present/);
  assert.ok(!draft.sections.some(s => /Grand Lodge Officers|^WM|PM Stone|Building and Grounds/.test(s.heading)));
  assert.match(section('Committee Reports'), /WM additions/);
  assert.equal(draft.actionItems.length, 0, 'no duplicated or inferred action table');
  const notRead = await generateMinutesDraft('1. Opening\nThe Lodge opened at 7:30 PM.\n2. Treasurer Report\nThe report was not read. The circulated balance was $500.\n3. Closing\nThe Lodge closed at 9:00 PM.');
  assert.equal(notRead.sections.find(s=>s.heading==="Treasurer's Report").body, "The Treasurer's report was not read aloud.");
  const futureReport = await generateMinutesDraft('1. Opening\nThe Lodge opened at 7:30 PM.\n2. Treasurer Report\nThe report will be read at the next meeting.\n3. Closing\nThe Lodge closed at 9:00 PM.');
  assert.notEqual(futureReport.sections.find(s=>s.heading==="Treasurer's Report").body, "The Treasurer's report was read aloud.");
  const pdf = await PDFDocument.load(await buildMinutesPdf({draft, status:'draft', preparedBy:'Test Officer', preparerRole:'owner'}));
  assert.ok(pdf.getPageCount() <= 5, 'compact minutes do not use empty worksheet pages');
  // Official seal, narrative formatting and signature handling are tested in minutes-format.mjs.

  const transcript = await generateMinutesDraft('On 09/17/2026 the Lodge opened at 7:30 PM. A quorum was established. Correspondence from the district was read. The committee reported on the building. A motion was made and seconded. The motion carried. The Lodge closed at 9:05 PM.');
  const futureClosing = await generateMinutesDraft('The Lodge will be closed at 9:00 PM. The Chaplain will give the closing prayer for the sick and distressed.');
  assert.equal(futureClosing.closingTime, null, 'a planned closing time is not a completed closing');
  assert.equal(futureClosing.closingPrayerGiven, null);
  assert.equal(transcript.sourceType, 'transcript');
  assert.equal(transcript.meetingDate, '2026-09-17');
  for (const heading of ['Communications', 'Committee Reports', 'New Business and Motions']) assert.ok(transcript.sections.some(s => s.heading === heading));
  const other = await generateMinutesDraft('Meeting date: 09/10/2026\nMeeting type: Officers Planning Session\nDegree: Round Table\nQuorum: No\nThe group discussed the building schedule and assigned follow up work before closing at 8:30 PM.');
  assert.equal(other.degree, 'Round Table'); assert.equal(other.quorum, 'No'); assert.equal(other.meetingType, 'Officers Planning Session');
  const invalid = await generateMinutesDraft('Meeting date: 2026-02-31\nOpening\nThe Lodge opened at 7:30 PM. Brothers discussed the meeting schedule and requested that it be reviewed before the next communication.');
  assert.equal(invalid.meetingDate, null);
  const old = normalizeMinutesDraft({sections:[{heading:'Opening',body:'The Lodge opened.\nGrand Secretary Mobley present as a member.'},{heading:"Grand Lodge Officers' Remarks",body:'An official visitation was announced.'}]});
  assert.equal(old.sections.find(section => section.heading === 'Opening').body, 'The Lodge opened.');
  assert.equal(old.sections.find(section => section.body === 'An official visitation was announced.').heading, 'Communications');
  const corrected = structuredClone(draft); corrected.officerAttendance.find(r=>r.title==='Treasurer').status='not_recorded';
  assert.equal(officerAttendanceRows(corrected).find(r=>r.title==='Treasurer').status,'not_recorded', 'the officer roll stays incomplete instead of falling back to an Other Brothers list');
  console.log('Minutes content, context, attendance, dates and compact PDF passed without a network call.');
} finally { globalThis.fetch = originalFetch; }
