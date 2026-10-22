import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {PDFParse} from 'pdf-parse';
import {
  assistantCoverageRoleForStation,
  attendanceCoverageIssues,
  normalizeOfficerCoverage,
  stationCoverageText,
} from '../public/minutes-attendance.js';
import {minutesChanges, preparerAttendanceReviewForEdit} from '../minutes-changes.js';
import {MINUTES_SCHEMA} from '../minutes.js';
import {CURRENT_OFFICERS} from '../minutes-layout.js';
import {buildMinutesPdf} from '../minutes-pdf.js';
import {buildMinutesDocx} from '../minutes-document.js';

const assistants = [
  {name:'Taylor Example', title:'Assistant Treasurer', status:'present'},
  {name:'Morgan Example', title:'Assistant Secretary', status:'present'},
];
const station = (title, values = {}) => ({
  name:title === 'Treasurer' ? 'Jordan Regular' : 'Casey Regular', title, status:'excused',
  stationCoverage:'filled', actingName:title === 'Treasurer' ? assistants[0].name : assistants[1].name,
  actingWholeMeeting:true, ...values,
});
const draft = row => ({officerAttendanceVersion:2, officerAttendance:[row, ...structuredClone(assistants)]});
let checks = 0;
const check = (name, run) => { run(); checks += 1; console.log(`PASS: ${name}`); };

check('The assistant choice belongs only to the matching regular station', () => {
  assert.equal(assistantCoverageRoleForStation({title:'Treasurer'}), 'Assistant Treasurer');
  assert.equal(assistantCoverageRoleForStation({title:'Secretary'}), 'Assistant Secretary');
  for (const title of ['treasurer', ' Treasurer ', 'TREASURER']) assert.equal(assistantCoverageRoleForStation({title}), 'Assistant Treasurer', 'Shared validation matches the native editable-office contract');
  for (const title of ['secretary', ' Secretary ', 'SECRETARY']) assert.equal(assistantCoverageRoleForStation({title}), 'Assistant Secretary');
  for (const title of ['Assistant Treasurer', 'Assistant Secretary', 'Senior Warden', 'Tyler', '__proto__', 'constructor', 'toString', '', undefined]) {
    assert.equal(assistantCoverageRoleForStation({title}), null);
  }
});

check('Legacy coverage keeps exact pro tem wording and does not acquire an assistant role from a name', () => {
  for (const title of ['Treasurer', 'Secretary']) {
    const row = station(title);
    const snapshot = structuredClone(row);
    assert.equal('actingRole' in normalizeOfficerCoverage(row), false);
    assert.equal(stationCoverageText(row), `${row.actingName} served pro tem for the whole meeting.`);
    assert.deepEqual(attendanceCoverageIssues(draft(row)), []);
    assert.deepEqual(row, snapshot);
  }
});

check('An explicitly selected assistant retains his named identity and accurate whole-meeting phrasing', () => {
  for (const title of ['Treasurer', 'Secretary']) {
    const actingRole = assistantCoverageRoleForStation({title});
    const row = station(title, {actingRole});
    const before = structuredClone(row);
    assert.deepEqual(attendanceCoverageIssues(draft(row)), []);
    assert.equal(stationCoverageText(row), `${actingRole} ${row.actingName} covered the station for the whole meeting.`);
    assert.equal(normalizeOfficerCoverage({...row, actingRole:`  ${actingRole}  `}).actingRole, actingRole);
    assert.deepEqual(normalizeOfficerCoverage(JSON.parse(JSON.stringify(row))), normalizeOfficerCoverage(row));
    assert.deepEqual(row, before);
  }
});

check('A role from another station or an unsupported role is rejected', () => {
  for (const [title, actingRole] of [['Treasurer','Assistant Secretary'], ['Secretary','Assistant Treasurer'], ['Treasurer','Deputy Treasurer']]) {
    assert.ok(attendanceCoverageIssues(draft(station(title, {actingRole}))).some(issue => /assistant for this station/.test(issue)));
  }
  assert.ok(attendanceCoverageIssues(draft({...station('Secretary'), title:'Senior Warden', actingRole:'Assistant Secretary'})).some(issue => /assistant for this station/.test(issue)));
});

check('An assistant role cannot be attached to a different covering name or to a missing identity', () => {
  for (const title of ['Treasurer', 'Secretary']) {
    const actingRole = assistantCoverageRoleForStation({title});
    assert.ok(attendanceCoverageIssues(draft(station(title, {actingRole, actingName:'Another Brother'}))).some(issue => /name must match the selected assistant/.test(issue)));
    assert.ok(attendanceCoverageIssues(draft(station(title, {actingRole, actingName:null}))).some(issue => /enter the Brother/.test(issue)));
    const row = station(title, {actingRole});
    assert.deepEqual(attendanceCoverageIssues(draft({...row, actingName:`Bro. ${row.actingName}`})), [], 'An established honorific does not change the selected person');
  }
});

check('An explicit assistant choice requires one unambiguous current office holder', () => {
  for (const title of ['Treasurer', 'Secretary']) {
    const actingRole = assistantCoverageRoleForStation({title});
    const row = station(title, {actingRole});
    const entered = draft(row);
    const assistant = entered.officerAttendance.find(officer => officer.title === actingRole);
    for (const officers of [
      [row],
      entered.officerAttendance.map(officer => officer.title === actingRole ? {...officer, title:'Edited office'} : officer),
      [...entered.officerAttendance, {...assistant}],
      [...entered.officerAttendance, {...assistant, name:'Different Assistant'}],
    ]) {
      const value = {...entered, officerAttendance:officers};
      const before = structuredClone(value);
      assert.ok(attendanceCoverageIssues(value).length, 'Missing or duplicated office holders cannot establish an explicit assistant assignment');
      assert.deepEqual(value, before, 'Rejected office ambiguity preserves all entered names and roles');
    }
    assert.deepEqual(attendanceCoverageIssues({...entered, officerAttendance:entered.officerAttendance.map(officer => officer.title === actingRole ? {...officer, title:` ${actingRole.toUpperCase()} `} : officer)}), [], 'Current assistant offices use the same trim and case rules in both clients');
  }
});

check('Selecting an assistant never supplies missing duration or invents the regular officer arrival', () => {
  for (const title of ['Treasurer', 'Secretary']) {
    const actingRole = assistantCoverageRoleForStation({title});
    const unknown = station(title, {actingRole, actingWholeMeeting:null});
    assert.ok(attendanceCoverageIssues(draft(unknown)).some(issue => /whole meeting/.test(issue)));
    assert.match(stationCoverageText(unknown), /Duration not yet confirmed/);
    const partial = station(title, {actingRole, actingWholeMeeting:false});
    assert.ok(attendanceCoverageIssues(draft(partial)).some(issue => /regular officer arrived/.test(issue)));
    assert.doesNotMatch(stationCoverageText(partial), /until.*arrived/);
    const arrived = {...partial, status:'arrived_late'};
    assert.deepEqual(attendanceCoverageIssues(draft(arrived)), []);
    assert.equal(stationCoverageText(arrived), `${actingRole} ${arrived.actingName} covered the station until ${arrived.name} arrived.`);
  }
});

check('An explicit role does not silently select filled coverage, a vacancy or attendance', () => {
  const actingRole = 'Assistant Secretary';
  const row = station('Secretary', {actingRole});
  assert.ok(attendanceCoverageIssues(draft({...row, stationCoverage:null})).some(issue => /record who covered/.test(issue)));
  assert.ok(attendanceCoverageIssues(draft({...row, stationCoverage:'vacant', actingName:null, actingWholeMeeting:null})).some(issue => /clear the covering Brother/.test(issue)));
  assert.ok(attendanceCoverageIssues(draft({...row, status:'present'})).some(issue => /clear the station coverage/.test(issue)));
  const entered = draft(row);
  entered.officerAttendance.find(entry => entry.title === actingRole).status = 'not_recorded';
  const before = structuredClone(entered);
  attendanceCoverageIssues(entered);
  assert.deepEqual(entered, before, 'Checking a selected role must not mark its assistant present or change any entered facts');
});

check('A Master role correction clears only the officer-roll preparer confirmation and is visible in history', () => {
  const before = {...draft(station('Secretary')), present:['Other Brother'], excused:[],
    attendanceReview:{officerRoll:true, otherPresent:true, otherExcused:true}, sections:[]};
  const original = structuredClone(before);
  const after = structuredClone(before);
  after.officerAttendance[0].actingRole = 'Assistant Secretary';
  after.attendanceReview = {officerRoll:true, otherPresent:true, otherExcused:true};
  assert.deepEqual(preparerAttendanceReviewForEdit(before, after), {officerRoll:false, otherPresent:true, otherExcused:true});
  assert.deepEqual(preparerAttendanceReviewForEdit(after, before), {officerRoll:false, otherPresent:true, otherExcused:true}, 'Removing the explicit role is also a correction');
  const change = minutesChanges(before, after).find(entry => entry.field === 'Officer attendance');
  assert.ok(change);
  assert.match(change.before, /served pro tem/);
  assert.match(change.after, /Assistant Secretary Morgan Example covered the station/);
  assert.deepEqual(before, original, 'The original submitted attendance is never mutated by comparison');
});

check('A legacy review retains its prior gate and provider output gains no unevidenced assistant role', () => {
  const row = station('Secretary', {actingRole:'Assistant Treasurer'});
  assert.deepEqual(attendanceCoverageIssues({...draft(row), officerAttendanceVersion:1}), []);
  assert.equal('actingRole' in MINUTES_SCHEMA.properties.officerAttendance.items.properties, false);
  assert.deepEqual(MINUTES_SCHEMA.properties.officerAttendance.items.required,
    ['name', 'title', 'status', 'stationCoverage', 'actingName', 'actingWholeMeeting']);
});

const renderedCoverage = async value => {
  const options = {draft:value, status:'draft', preparedBy:'Synthetic Preparing Officer', preparerRole:'assistant_secretary'};
  const parser = new PDFParse({data:await buildMinutesPdf(options)});
  let pdf;
  try { pdf = (await parser.getText()).text; } finally { await parser.destroy(); }
  const archive = await JSZip.loadAsync(await buildMinutesDocx(options));
  const xml = await archive.file('word/document.xml').async('string');
  return [pdf, xml.replace(/<[^>]+>/g, '')].map(text => text.replace(/\s+/g, ' '));
};

const renderedDraft = {
  organizerVersion:5, closingFormatVersion:3, officerAttendanceVersion:2,
  meetingDate:'2099-01-15', meetingType:'Stated Communication', degree:'Third Degree',
  openingTime:'7:30 PM', closingTime:'9:45 PM', presiding:'Synthetic Presiding Officer', quorum:'Yes',
  nextMeeting:'2099-02-05', closingPrayerGiven:false, prayerRequested:null,
  present:[], excused:[], visitors:[], income:[], expenses:[], sensitiveReview:[], actionItems:[], warnings:[],
  attendanceReview:{officerRoll:true, otherPresent:true, otherExcused:true},
  officerAttendance:CURRENT_OFFICERS.map(officer => ({...officer, status:'present', stationCoverage:null, actingName:null, actingWholeMeeting:null})),
  sections:[{heading:'Opening', body:'- A synthetic meeting was recorded for interface testing.'}, {heading:'Sickness and Distress', body:''}],
};
const expected = [];
for (const title of ['Treasurer', 'Secretary']) {
  const actingRole = assistantCoverageRoleForStation({title});
  const assistant = renderedDraft.officerAttendance.find(row => row.title === actingRole);
  const row = renderedDraft.officerAttendance.find(row => row.title === title);
  Object.assign(row, {status:'excused', stationCoverage:'filled', actingName:assistant.name, actingRole, actingWholeMeeting:true});
  expected.push({explicit:`${actingRole} ${assistant.name} covered the station for the whole meeting.`, legacy:`${assistant.name} served pro tem for the whole meeting.`});
}
const beforeRendered = structuredClone(renderedDraft);
for (const text of await renderedCoverage(renderedDraft)) {
  for (const phrase of expected) {
    assert.ok(text.includes(phrase.explicit), `Both actual document formats must contain ${phrase.explicit}`);
    assert.ok(!text.includes(phrase.legacy), 'An explicit assistant choice must not be rendered as a generic pro tem assignment');
  }
}
assert.deepEqual(renderedDraft, beforeRendered, 'Actual PDF/Word rendering must not mutate any input attendance or draft field');
checks += 1;
console.log('PASS: actual PDF and Word print each explicitly selected assistant identity and role without mutating the draft');

const legacyRendered = structuredClone(renderedDraft);
legacyRendered.officerAttendance.forEach(row => { delete row.actingRole; });
const beforeLegacyRendered = structuredClone(legacyRendered);
for (const text of await renderedCoverage(legacyRendered)) {
  for (const phrase of expected) {
    assert.ok(text.includes(phrase.legacy), 'Both actual legacy document formats retain exact pro tem wording');
    assert.ok(!text.includes(phrase.explicit), 'A named legacy assistant never acquires a new role assertion during rendering');
  }
}
assert.deepEqual(legacyRendered, beforeLegacyRendered, 'Legacy PDF/Word input and recorded role absence remain exact');
checks += 1;
console.log('PASS: actual legacy PDF and Word retain recorded generic coverage wording with no inferred assistant roles');

console.log(`${checks} assistant-coverage contract cases passed with synthetic attendance and no network, database or live records.`);
