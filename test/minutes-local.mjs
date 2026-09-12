import assert from 'node:assert/strict';
import { generateMinutesDraft, normalizeMinutesDraft } from '../minutes.js';
import { officerAttendanceRows, nonOfficerExcused } from '../minutes-layout.js';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { PDFDocument } from 'pdf-lib';

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Local minutes generation must not call an external service.'); };
try {
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
  assert.equal(draft.excused.length, 3);
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
  const pdf = await PDFDocument.load(await buildMinutesPdf({draft, status:'draft', preparedBy:'Test Officer', preparerRole:'owner'}));
  assert.ok(pdf.getPageCount() <= 5, 'compact minutes do not use empty worksheet pages');
  // The only images allowed in minutes are explicitly supplied signatures.
  for (const page of pdf.getPages()) assert.ok(!page.node.Resources()?.toString().includes('/Subtype /Image'));

  const transcript = await generateMinutesDraft('On 09/17/2026 the Lodge opened at 7:30 PM. A quorum was established. Correspondence from the district was read. The committee reported on the building. A motion was made and seconded. The motion carried. The Lodge closed at 9:05 PM.');
  assert.equal(transcript.sourceType, 'transcript');
  assert.equal(transcript.meetingDate, '2026-09-17');
  for (const heading of ['Communications', 'Committee Reports', 'New Business and Motions']) assert.ok(transcript.sections.some(s => s.heading === heading));
  const other = await generateMinutesDraft('Meeting date: 09/10/2026\nMeeting type: Officers Planning Session\nDegree: Round Table\nQuorum: No\nThe group discussed the building schedule and assigned follow up work before closing at 8:30 PM.');
  assert.equal(other.degree, 'Round Table'); assert.equal(other.quorum, 'No'); assert.equal(other.meetingType, 'Officers Planning Session');
  const invalid = await generateMinutesDraft('Meeting date: 2026-02-31\nOpening\nThe Lodge opened at 7:30 PM. Brothers discussed the meeting schedule and requested that it be reviewed before the next communication.');
  assert.equal(invalid.meetingDate, null);
  const old = normalizeMinutesDraft({sections:[{heading:'Opening',body:'The Lodge opened.\nGrand Secretary Mobley present as a member.'},{heading:"Grand Lodge Officers' Remarks",body:'An official visitation was announced.'}]});
  assert.equal(old.sections[0].body, 'The Lodge opened.'); assert.equal(old.sections[1].heading, 'Communications');
  const corrected = structuredClone(draft); corrected.officerAttendance.find(r=>r.title==='Treasurer').status='not_recorded';
  assert.equal(officerAttendanceRows(corrected).find(r=>r.title==='Treasurer').status,'excused');
  console.log('Minutes content, context, attendance, dates and compact PDF passed without a network call.');
} finally { globalThis.fetch = originalFetch; }
