import assert from 'node:assert/strict';
import {
  MINUTES_MEETING_DETAILS_FIELDS,
  hasExplicitMinutesTime,
  minutesMeetingDetailsIssues,
  normalizeMinutesMeetingDetails,
} from '../public/minutes-meeting-details.js';

const fields = ['meetingDate', 'meetingType', 'degree', 'openingTime', 'closingTime', 'presiding', 'quorum', 'nextMeeting'];
const complete = Object.freeze({
  meetingDate: '2026-10-15', meetingType: 'Stated Communication', degree: 'Third Degree',
  openingTime: '7:30 PM', closingTime: '9:45 PM', presiding: 'WM Example', quorum: 'Yes', nextMeeting: '2026-11-05',
});
let checks = 0;
const check = (name, run) => { run(); checks += 1; console.log(`PASS: ${name}`); };
const valid = value => assert.deepEqual(minutesMeetingDetailsIssues(value), []);
const invalidField = (field, value) => assert.equal(minutesMeetingDetailsIssues({...complete, [field]: value}).length, 1, `${field}=${JSON.stringify(value)} must remain invalid without affecting other fields`);

check('All eight explicitly provided facts pass, without changing their values', () => {
  assert.deepEqual(MINUTES_MEETING_DETAILS_FIELDS, fields);
  valid(complete);
  assert.deepEqual(normalizeMinutesMeetingDetails(complete), complete);
  assert.deepEqual(Object.keys(normalizeMinutesMeetingDetails(complete)), fields);
});

check('A missing fact cannot be replaced by a default, a source guess or another field', () => {
  for (const field of fields) {
    const missing = {...complete}; delete missing[field];
    assert.equal(minutesMeetingDetailsIssues(missing).length, 1, `${field} is independently required`);
    invalidField(field, null); invalidField(field, '   ');
  }
  const empty = normalizeMinutesMeetingDetails({});
  assert.deepEqual(empty, {
    meetingDate:null, meetingType:'', degree:'', openingTime:'', closingTime:'', presiding:'', quorum:'', nextMeeting:null,
  });
  assert.equal(minutesMeetingDetailsIssues(empty).length, 8);
  assert.equal(empty.meetingType, '', 'Stated Communication is never silently supplied by this intake contract');
});

check('Malformed top-level payloads and nonstring field values fail without coercion', () => {
  for (const value of [null, undefined, false, true, 0, 2026, '2026-10-15', [], [complete]]) {
    assert.equal(minutesMeetingDetailsIssues(value).length, 8);
  }
  const poison = {toString() { throw new Error('Do not coerce an object into an officer fact'); }};
  for (const field of fields) for (const value of [false, true, 0, 730, [], {}, poison]) invalidField(field, value);
});

check('Calendar validation handles leap years and rejects impossible or yearless dates', () => {
  for (const field of ['meetingDate', 'nextMeeting']) {
    for (const value of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-15', '2026-10-00', '2026-10-32', 'October 15', '10/15/26', '0001-01-01']) invalidField(field, value);
    valid({...complete, [field]:'2028-02-29'});
    valid({...complete, [field]:'2000-02-29'});
    invalidField(field, '1900-02-29');
  }
});

check('Dates normalize calendar-only values while rejecting surrounding prose and competing dates', () => {
  for (const value of ['2026-10-15', '10/15/2026', 'October 15, 2026', 'Thursday, October 15, 2026', '  Oct. 15, 2026  ']) {
    const entered = {...complete, meetingDate:value, nextMeeting:value};
    valid(entered);
    const normalized = normalizeMinutesMeetingDetails(entered);
    assert.equal(normalized.meetingDate, '2026-10-15');
    assert.equal(normalized.nextMeeting, '2026-10-15');
  }
  for (const field of ['meetingDate', 'nextMeeting']) for (const value of [
    'Next meeting: October 15, 2026', 'October 15, 2026 at the Lodge', '2026-10-15 or 2026-11-05',
    'The event will take place October 15, 2026.', '2026-10-15 7:30 PM',
  ]) invalidField(field, value);
});

check('Explicit meridiem and complete 24-hour clocks are accepted without guessing or conversion', () => {
  for (const value of ['7 AM', '7PM', '07:30 AM', '7:30 a.m.', '9:45 P.M.', '12 AM', '12:00 PM', '00:00', '07:30', '09:45', '12:30', '21:45', '23:59']) {
    assert.equal(hasExplicitMinutesTime(value), true, value);
    valid({...complete, openingTime:value, closingTime:value});
    const normalized = normalizeMinutesMeetingDetails({...complete, openingTime:`  ${value}  `, closingTime:value});
    assert.equal(normalized.openingTime, value);
    assert.equal(normalized.closingTime, value);
  }
  valid({...complete, openingTime:'11:30 PM', closingTime:'00:15'}); // A meeting may cross midnight.
});

check('Ambiguous compact clocks, invalid ranges and event schedules cannot become meeting times', () => {
  for (const value of ['', '730', '945', '0945', '945 PM', '9:45', '7:30', '0 PM', '13 AM', '12:60 PM',
    '23:60', '24:00', '7:3 PM', '9:45 PM tomorrow', '2:00 PM to 4:00 PM', '7:30 PM or 8:00 PM']) {
    assert.equal(hasExplicitMinutesTime(value), false, value);
    invalidField('openingTime', value); invalidField('closingTime', value);
  }
  assert.equal(hasExplicitMinutesTime(945), false);
  assert.equal(normalizeMinutesMeetingDetails({...complete, closingTime:'945'}).closingTime, '945', 'Validation rejects the value; normalization must not silently change the officer entry');
});

check('Degree and quorum require explicit choices rather than aliases or truthy values', () => {
  for (const degree of ['First Degree', 'Second Degree', 'Third Degree', 'Round Table']) valid({...complete, degree});
  for (const degree of ['Master Mason', 'third degree', 'Other', 'Unknown', 'Third Degree tomorrow']) invalidField('degree', degree);
  for (const quorum of ['Yes', 'No']) valid({...complete, quorum});
  for (const quorum of ['yes', 'no', 'Present', 'Established', 'Unknown']) invalidField('quorum', quorum);
});

check('Type and presiding names remain officer-entered text with bounded lengths', () => {
  valid({...complete, meetingType:'Officers Planning Session', presiding:"Bro. O'Example"});
  valid({...complete, meetingType:'x'.repeat(100), presiding:'x'.repeat(160)});
  invalidField('meetingType', 'x'.repeat(101)); invalidField('presiding', 'x'.repeat(161));
  const normalized = normalizeMinutesMeetingDetails({...complete, meetingType:'  Special  Communication  ', presiding:'  Bro.  Example  '});
  assert.equal(normalized.meetingType, 'Special  Communication');
  assert.equal(normalized.presiding, 'Bro.  Example');
});

check('Metadata projection cannot carry signatures, attendance, source or claimed provenance', () => {
  const entered = {...complete, transcriptText:'Retained original source', sections:[{heading:'Business', body:'A private draft'}],
    attendanceReview:{officerRoll:true}, masterSignature:'not-authorized', enteredByUserId:999, enteredAt:'2099-01-01T00:00:00Z'};
  const before = structuredClone(entered);
  const normalized = normalizeMinutesMeetingDetails(entered);
  assert.deepEqual(normalized, complete);
  assert.deepEqual(entered, before);
  assert.equal('enteredByUserId' in normalized, false, 'The authenticated actor must be assigned by the server, never trusted from this object');
});

check('Normalization is immutable, idempotent and never upgrades invalid facts into valid ones', () => {
  const entered = Object.freeze({...complete, meetingDate:'October 15, 2026', nextMeeting:'November 5, 2026', openingTime:'  7:30 PM  '});
  const normalized = normalizeMinutesMeetingDetails(entered);
  assert.notEqual(normalized, entered);
  assert.deepEqual(normalizeMinutesMeetingDetails(normalized), normalized);
  assert.equal(entered.meetingDate, 'October 15, 2026');
  const invalid = normalizeMinutesMeetingDetails({...complete, meetingDate:'2026-02-30', degree:'Unknown', quorum:'Maybe', closingTime:'945'});
  assert.equal(minutesMeetingDetailsIssues(invalid).length, 4);
});

console.log(`${checks} meeting-details contract cases passed with synthetic values and no network, database or live records.`);
