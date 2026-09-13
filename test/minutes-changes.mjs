import assert from 'node:assert/strict';
import { minutesChanges } from '../minutes-changes.js';
import { normalizeMinutesDraft } from '../minutes.js';
const submitted={quorum:'Yes',visitors:[],sections:[
 {heading:'Opening',body:'The Lodge opened at 7:36 PM.'},
 {heading:'Roll Call and Quorum',body:'All officers are present unless noted.\nATTENDANCE AND VISITORS\nAdditional Brothers and visitors recorded in the sign in book.\nPRAISE REPORTS\nNone reported.'},
 {heading:'Sickness and Distress',body:'Prayers were requested for Brother Example.'},
 {heading:'New Business and Motions',body:'A picnic was discussed; no vote was recorded.'},
]};
const copy=structuredClone(submitted);const reviewed=normalizeMinutesDraft(submitted);
const changes=minutesChanges(submitted,reviewed);
assert.deepEqual(submitted,copy);
assert.equal(reviewed.quorum,'Yes');
assert.ok(!reviewed.sections.some(s=>/roll call/i.test(s.heading)));
assert.equal(changes.length,1);
assert.equal(changes[0].field,'Roll Call and Quorum');
assert.match(changes[0].before,/PRAISE REPORTS/);
assert.equal(changes[0].after,'');
const duplicated={...submitted,sections:[{heading:'Communications',body:'First letter.'},{heading:'Communications',body:'Second letter.'}]};
const revised={...duplicated,sections:[{heading:'Communications',body:'First letter.'},{heading:'Communications',body:'Corrected second letter.'}]};
const edits=minutesChanges(duplicated,revised).filter(c=>c.field==='Communications');assert.equal(edits.length,1);assert.match(edits[0].before,/First letter\.\nSecond letter\./);assert.match(edits[0].after,/Corrected second letter/);
console.log('Review change history preserves submitted wording, isolates removals, retains duplicate headings, and never mutates the snapshot.');
