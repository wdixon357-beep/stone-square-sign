import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { attendanceCoverageIssues, stationCoverageText, attendanceLabel } from '../public/minutes-attendance.js';
import { CURRENT_OFFICERS, officerAttendanceRows, additionalPresent } from '../minutes-layout.js';
import { attendanceReviewIssues } from '../minutes-format.js';
import { normalizeMinutesDraft } from '../minutes.js';
import { minutesChanges } from '../minutes-changes.js';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { buildMinutesDocx } from '../minutes-document.js';
import { PDFParse } from 'pdf-parse';

const base = () => ({
  officerAttendanceVersion: 2, meetingDate: '2026-10-15', meetingType: 'Stated Communication',
  degree: 'Third Degree', openingTime: '7:30 PM', closingTime: '10:00 PM', quorum: 'Yes',
  presiding: 'WM Dixon-Saunders', present: ['PM Mobley', 'Alex Example'], excused: [], visitors: [],
  officerAttendance: CURRENT_OFFICERS.map(officer => ({...officer, status:'present', stationCoverage:null, actingName:null, actingWholeMeeting:null})),
  attendanceReview: {officerRoll:true, otherPresent:true, otherExcused:true},
  sections: [{heading:'Opening', body:'The Lodge opened.'}], warnings: [],
});
const draft = base();
const senior = draft.officerAttendance.find(row => row.title === 'Senior Warden');
Object.assign(senior, {status:'arrived_late', stationCoverage:'filled', actingName:'PM Mobley', actingWholeMeeting:false});
assert.deepEqual(attendanceReviewIssues(draft), []);
assert.equal(attendanceLabel(senior), 'Arrived later');
assert.match(stationCoverageText(senior), /PM Mobley served pro tem until Xavier M\. White arrived\./);
assert.deepEqual(additionalPresent(draft), ['Alex Example'], 'A linked covering Brother is not duplicated in Other Brothers Present');
assert.deepEqual(normalizeMinutesDraft({...draft,present:['Past Master Mobley','Alex Example']}).present, ['Alex Example'], 'Full honorifics also deduplicate in saved attendance');
assert.equal(officerAttendanceRows(draft).filter(row => row.title === 'Senior Warden').length, 1);
assert.equal(officerAttendanceRows(draft).find(row => row.title === 'Senior Warden').actingWholeMeeting, false);
const normalized = normalizeMinutesDraft(draft);
const spellingCorrection = normalizeMinutesDraft({...draft, officerAttendance:[{...senior,name:'Xavier White',title:'Acting Senior Warden'}]});
assert.ok(spellingCorrection.officerAttendance.some(row => row.name === 'Xavier White' && row.title === 'Acting Senior Warden'), 'Explicit compatible identity and office corrections survive save');
assert.equal(normalized.officerAttendanceVersion, 2);
assert.deepEqual(normalizeMinutesDraft(JSON.parse(JSON.stringify(normalized))), normalized, 'Coverage persists across save and reopen without changing the regular officer');
assert.deepEqual(attendanceReviewIssues(normalized), []);

const changed = (values, version = 2) => ({...base(), officerAttendanceVersion:version,
  officerAttendance:[{...senior, ...values}]});
assert.ok(attendanceCoverageIssues(changed({status:'absent'})).some(issue => /partial assignment/.test(issue)));
assert.ok(attendanceCoverageIssues(changed({actingName:null})).some(issue => /enter the Brother/.test(issue)));
assert.ok(attendanceCoverageIssues(changed({actingWholeMeeting:null})).some(issue => /whole meeting/.test(issue)));
assert.ok(attendanceCoverageIssues(changed({actingName:'Bro. Xavier M. White'})).some(issue => /other than/.test(issue)));
assert.ok(attendanceCoverageIssues(changed({actingName:'Xavier White'})).some(issue => /other than/.test(issue)), 'Missing middle initial cannot bypass identity review');
assert.ok(attendanceCoverageIssues(changed({actingName:'SW White'})).some(issue => /other than/.test(issue)), 'An office abbreviation cannot bypass identity review');
assert.equal(officerAttendanceRows({...draft, officerAttendance:[...draft.officerAttendance, {name:'PM Mobley',title:'Senior Warden pro tem',status:'present'}]}).filter(row => row.name === 'PM Mobley').length, 0, 'A linked covering Brother is not repeated as an additional pro tem row');
assert.equal(officerAttendanceRows({...draft, officerAttendance:[...draft.officerAttendance, {name:'Past Master Mobley',title:'Senior Warden (pro tem)',status:'present'}]}).length, CURRENT_OFFICERS.length, 'Honorifics and parentheses do not duplicate a linked covering Brother');
assert.ok(attendanceCoverageIssues(changed({stationCoverage:'vacant'})).some(issue => /clear the covering Brother/.test(issue)));
assert.ok(attendanceCoverageIssues(changed({status:'present'})).length);
assert.ok(attendanceCoverageIssues(changed({stationCoverage:null,actingName:null,actingWholeMeeting:null})).length);
assert.deepEqual(attendanceCoverageIssues(changed({status:'excused',actingWholeMeeting:true})), []);
assert.deepEqual(attendanceCoverageIssues(changed({status:'absent',stationCoverage:'vacant',actingName:null,actingWholeMeeting:null})), []);
assert.deepEqual(attendanceCoverageIssues(changed({status:'excused',stationCoverage:null,actingName:null,actingWholeMeeting:null}, 1)), [], 'Untouched legacy records keep their original review gate');
assert.doesNotMatch(stationCoverageText({...senior, status:'absent'}), /until.*arrived/, 'An invalid partial claim cannot print an unconfirmed arrival');
const original = JSON.parse(JSON.stringify(draft));
const reviewed = JSON.parse(JSON.stringify(draft));
reviewed.officerAttendance.find(row => row.title === 'Senior Warden').actingName = 'PM Example';
const changes = minutesChanges(original, reviewed);
assert.ok(changes.some(change => /PM Mobley/.test(change.before) && /PM Example/.test(change.after)), 'WM corrections describe changes to station assignments');

const options = {draft:normalized, status:'draft', preparedBy:'Synthetic Preparing Officer', preparerRole:'assistant_secretary'};
const pdf = await buildMinutesPdf(options);
const parser = new PDFParse({data:pdf});
const text = (await parser.getText()).text;
await parser.destroy();
assert.match(text, /Station coverage/);
assert.match(text.replace(/\s+/g, ' '), /PM Mobley served pro tem until Xavier M\. White arrived\./);
assert.match(text, /Arrived later/);
const word = await JSZip.loadAsync(await buildMinutesDocx(options));
const xml = await word.file('word/document.xml').async('string');
assert.match(xml, /Station coverage/);
assert.match(xml, /PM Mobley served pro tem until Xavier M\. White arrived\./);
assert.match(xml, /Arrived later/);
assert.deepEqual(draft, original, 'Rendering and comparison do not mutate original attendance or attestations');
const legacy = {...draft, officerAttendanceVersion:1};
const legacyWord = await JSZip.loadAsync(await buildMinutesDocx({...options,draft:legacy}));
assert.doesNotMatch(await legacyWord.file('word/document.xml').async('string'), /Station coverage/, 'Existing historical layout is retained');
console.log('PASS: required station coverage, late arrival, save round trip, change audit and PDF/Word parity');
