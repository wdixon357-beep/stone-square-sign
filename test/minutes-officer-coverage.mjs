import assert from 'node:assert/strict';
import {extractOfficerCoverage, organizeMeetingSource} from '../minutes-organizer.js';
import {generateMinutesDraft, normalizeMinutesDraft, MINUTES_SCHEMA} from '../minutes.js';

const senior = rows => rows.find(row => row.title === 'Senior Warden');
const partialSource = 'PM Mobley sat in as Senior Warden until SW White arrived.';
const fullSource = 'SW White was excused. PM Mobley served as Senior Warden for the entire meeting.';
const vacantSource = 'SW White was absent. The Senior Warden station was left vacant.';
const expectedPartial = {name:'Xavier M. White',title:'Senior Warden',status:'arrived_late',stationCoverage:'filled',actingName:'PM Mobley',actingWholeMeeting:false};
assert.deepEqual(senior(extractOfficerCoverage(partialSource)), expectedPartial);
assert.deepEqual(senior(extractOfficerCoverage("PM Mobley sat in as Senior Warden but didn't sit in the whole meeting because SW White did arrive.")),expectedPartial,'the stated partial coverage and causal arrival are recorded together');
assert.deepEqual(senior(extractOfficerCoverage(partialSource.replace('SW White', 'Xavier M. White'))), expectedPartial, 'middle initials do not cut off the arrival statement');
assert.deepEqual(senior(extractOfficerCoverage(fullSource)), {...expectedPartial,status:'excused',actingWholeMeeting:true});
assert.deepEqual(senior(extractOfficerCoverage(vacantSource)), {...expectedPartial,status:'absent',stationCoverage:'vacant',actingName:null,actingWholeMeeting:null});
assert.equal(senior(extractOfficerCoverage('PM Mobley served as Senior Warden.')).actingWholeMeeting, null, 'duration never defaults to the entire meeting');
assert.equal(senior(extractOfficerCoverage('PM Mobley served as Senior Warden. PM Jones stayed for the entire meeting.')).actingWholeMeeting, null, 'a different person staying cannot establish the covering officer duration');
assert.equal(senior(extractOfficerCoverage('PM Mobley served as Senior Warden, but not for the whole meeting.')).actingWholeMeeting, null, 'a partial assignment alone does not prove the regular officer arrived');
assert.equal(senior(extractOfficerCoverage('PM Mobley will serve as Senior Warden for the entire meeting.')).stationCoverage, null, 'plans do not establish service');
assert.equal(senior(extractOfficerCoverage('PM Mobley did not serve as Senior Warden for the entire meeting.')).stationCoverage, null, 'negated service never becomes a station assignment');
assert.equal(senior(extractOfficerCoverage('SW White served as Senior Warden for the entire meeting.')).stationCoverage, null, 'a regular officer does not substitute for himself');
assert.equal(senior(extractOfficerCoverage(`${partialSource}\nSW White never arrived.`)).actingWholeMeeting, null, 'contradictory arrival claims stay unconfirmed');
assert.equal(senior(extractOfficerCoverage('PM Mobley discussed the Senior Warden.')).stationCoverage, null, 'mere mention creates no assignment');
const local = normalizeMinutesDraft(organizeMeetingSource(`Meeting date: October 15, 2026\n${partialSource}\nThe Lodge closed at 10:00 PM.`));
assert.equal(local.officerAttendanceVersion,2);
assert.deepEqual(senior(local.officerAttendance),expectedPartial);
assert.equal(local.officerAttendance.filter(row=>row.name==='PM Mobley').length,0,'covering Brother stays linked to the regular officer');
const duplicateOther = normalizeMinutesDraft({...local,present:['PM Mobley','Brother Example Person']});
assert.deepEqual(duplicateOther.present,['Brother Example Person'],'a covering Brother is listed once with the covered station');
const legacy = normalizeMinutesDraft({officerAttendance:[{name:'Xavier M. White',title:'Senior Warden',status:'excused'}]});
assert.equal(legacy.officerAttendanceVersion,1);
assert.deepEqual(normalizeMinutesDraft({present:['WM Dixon-Saunders']}).present,['WM Dixon-Saunders'],'legacy other-Brother arrays retain the prior matching behavior');
const recordedLegacy = normalizeMinutesDraft({officerAttendance:[{name:'Xavier White',title:'Junior Warden',status:'present'}]});
assert.ok(recordedLegacy.officerAttendance.some(row=>row.name==='Xavier White' && row.title==='Junior Warden' && row.status==='present'),'legacy downloads preserve the recorded name and office without current-roster reinterpretation');
assert.equal(senior(legacy.officerAttendance).stationCoverage,null);
const wrongIdentity = normalizeMinutesDraft({officerAttendanceVersion:2,officerAttendance:[{name:'PM Mobley',title:'Senior Warden',status:'present'}]});
assert.equal(senior(wrongIdentity.officerAttendance).name,'Xavier M. White','office title alone never replaces regular officer identity');
assert.equal(senior(wrongIdentity.officerAttendance).status,'not_recorded');
assert.ok(wrongIdentity.officerAttendance.some(row=>row.name==='PM Mobley'),'an additional recorded officer is preserved rather than silently lost');
const aliases = normalizeMinutesDraft({officerAttendanceVersion:2,officerAttendance:[{name:'SW White',title:'Senior Warden',status:'present'}]});
assert.equal(senior(aliases.officerAttendance).status,'present','an office abbreviation and regular surname identify the rostered officer');
assert.equal(senior(aliases.officerAttendance).name,'Xavier M. White');
const fields = MINUTES_SCHEMA.properties.officerAttendance.items;
assert.deepEqual(fields.required,['name','title','status','stationCoverage','actingName','actingWholeMeeting']);
assert.ok(fields.properties.status.enum.includes('arrived_late'));

const padded = text => `Meeting date: October 15, 2026\n${text}\nThe Lodge opened at 7:30 PM and the business was recorded for officer review.`;
const response = row => ({draft:{meetingDate:null,meetingType:'Stated Communication',degree:null,openingTime:null,closingTime:null,
  prayerRequested:null,closingPrayerGiven:null,presiding:null,quorum:null,nextMeeting:null,present:[],excused:[],visitors:[],
  officerAttendance:[row],income:[],expenses:[],sections:[],warnings:[],sensitiveReview:[],actionItems:[]},evidence:[]});
const cited = row => {
  const output=response(row);
  for(const field of ['status','stationCoverage','actingName','actingWholeMeeting']) if(row[field] !== null && row[field] !== 'not_recorded') output.evidence.push({field:`officerAttendance[0].${field}`,sourceLineIds:[2]});
  return output;
};
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw new Error('Officer coverage tests must not access a network or a live Lodge record.');};
try {
  const partial = await generateMinutesDraft(padded(partialSource),{generateStructured:async()=>cited(expectedPartial)});
  assert.deepEqual(senior(partial.officerAttendance),expectedPartial);
  assert.equal(partial.officerAttendanceVersion,2);
  const fullRow={...expectedPartial,status:'excused',actingWholeMeeting:true};
  const full=await generateMinutesDraft(padded(fullSource),{generateStructured:async()=>cited(fullRow)});
  assert.deepEqual(senior(full.officerAttendance),fullRow);
  const vacantRow={...expectedPartial,status:'absent',stationCoverage:'vacant',actingName:null,actingWholeMeeting:null};
  const vacant=await generateMinutesDraft(padded(vacantSource),{generateStructured:async()=>cited(vacantRow)});
  assert.deepEqual(senior(vacant.officerAttendance),vacantRow);
  const unsupportedQuote='PM Mobley discussed the Senior Warden with SW White.';
  const unsupported=await generateMinutesDraft(padded(unsupportedQuote),{generateStructured:async()=>cited(expectedPartial)});
  assert.equal(senior(unsupported.officerAttendance).status,'not_recorded');
  assert.equal(senior(unsupported.officerAttendance).stationCoverage,null);
  assert.equal(senior(unsupported.officerAttendance).actingName,null);
  assert.equal(senior(unsupported.officerAttendance).actingWholeMeeting,null);
  assert.ok(unsupported.warnings.some(warning=>warning.includes('Confirm attendance')));
  const independentlyAttending='Brother Henry Example';
  for (const field of ['present','excused']) {
    const attendanceQuote=`${field === 'present' ? 'Present' : 'Excused'}: ${independentlyAttending}`;
    const independentlySourced=cited({...expectedPartial,actingName:independentlyAttending});
    independentlySourced.draft[field]=[independentlyAttending];
    independentlySourced.evidence.push({field:`${field}[0]`,sourceLineIds:[3]});
    const preserved=await generateMinutesDraft(padded(`${unsupportedQuote}\n${attendanceQuote}`),{generateStructured:async()=>independentlySourced});
    assert.deepEqual(preserved[field],[independentlyAttending],`rejecting an unsupported station assignment preserves independently sourced ${field} attendance`);
    assert.equal(senior(preserved.officerAttendance).actingName,null);
  }
  const absentPartial={...expectedPartial,status:'excused'};
  const incoherent=await generateMinutesDraft(padded(fullSource),{generateStructured:async()=>cited(absentPartial)});
  assert.equal(senior(incoherent.officerAttendance).actingWholeMeeting,null,'a generated partial assignment never claims an unrecorded arrival');
  const uncited=cited(expectedPartial);uncited.evidence=uncited.evidence.filter(item=>!item.field.endsWith('.actingName'));
  await assert.rejects(generateMinutesDraft(padded(partialSource),{generateStructured:async()=>uncited}),/all extracted content/,'each non-null coverage fact requires source evidence');
  const oldShape=response({name:'Xavier M. White',title:'Senior Warden',status:'present'});
  await assert.rejects(generateMinutesDraft(padded(partialSource),{generateStructured:async()=>oldShape}),/incomplete/,'new generation cannot bypass the strict coverage shape');
} finally {globalThis.fetch=originalFetch;}
console.log('Officer coverage: sourced full/partial/vacant service, canonical identity, uncertainty, legacy records and strict evidence passed without network access.');
