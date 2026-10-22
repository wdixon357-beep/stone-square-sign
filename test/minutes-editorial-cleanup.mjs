import assert from 'node:assert/strict';
import {currentMinutesEditorialDraft} from '../minutes-editorial.js';
const input={closingFormatVersion:2,closingTime:null,closingPrayerGiven:null,transcriptText:'Original source remains exact.',submittedDraft:{sections:[{heading:'Original',body:'The mover, seconder, vote method, and tally were not recorded.'}]},warnings:['The source does not identify the mover, seconder, vote method, or vote tally.'],sections:[
 {heading:'Reading of the Minutes',body:'- **Minutes:** Approved as submitted. The source does not identify the mover, seconder, vote method, or vote tally.'},
 {heading:"Treasurer's Report",body:"- Presented. Whether it was read aloud needs confirmation. The source does not provide the mover, seconder, vote method, or vote tally."},
 {heading:'New Business',body:'- A motion passed. The mover, seconder, vote method, and tally were not recorded.\n- No vote was taken. The motion was not seconded.'},
 {heading:'Other Meeting Business',body:'- **Unidentified source references:** Several assignments and statements are attributed only to Speaker 1, Speaker 2, Speaker 4, Speaker 5, Speaker 6, or Speaker 10. Their identities and, where applicable, their offices should be confirmed from the source record.\n- The property proposal was discussed.'},
 {heading:'Prayer and Closing',body:'- The Chaplain prayed after sickness and distress. The source does not establish that this was a closing prayer.'},
]};
const before=structuredClone(input),out=currentMinutesEditorialDraft(input);
assert.deepEqual(input,before,'no mutation of original/captured input');
assert.equal(out.closingFormatVersion,3);assert.equal(out.closingTime,null);assert.equal(out.closingPrayerGiven,null);
assert.deepEqual(out.submittedDraft,before.submittedDraft);assert.deepEqual(out.warnings,before.warnings);assert.equal(out.transcriptText,before.transcriptText);
assert.equal(out.sections[0].body,'- **Minutes:** Approved as submitted.');
assert.equal(out.sections[1].body,'- Presented.');
assert.equal(out.sections[2].body,'- A motion passed.\n- No vote was taken. The motion was not seconded.');
assert.equal(out.sections[3].body,'- The property proposal was discussed.');
assert.equal(out.sections[4].body,'- The Chaplain prayed after sickness and distress.');
assert.deepEqual(currentMinutesEditorialDraft(out),out,'idempotent');
const genuine=currentMinutesEditorialDraft({sections:[{heading:'Other Meeting Business',body:'- Unidentified source references: PM Cooke presented a property proposal.\n- The source does not identify the missing keys.\n- The Treasurer explicitly said the report was not read aloud.'}]});
assert.match(genuine.sections[0].body,/PM Cooke presented/);assert.match(genuine.sections[0].body,/missing keys/);assert.match(genuine.sections[0].body,/not read aloud/);
assert.equal(currentMinutesEditorialDraft({sections:[{heading:'Reading',body:'- **The source does not identify the mover, seconder, vote method, or vote tally.**'}]}).sections[0].body,'','Removed commentary cannot leave a fake substantive emphasis-only section');
console.log('Current minutes editorial cleanup passed; original source, snapshots, warnings and real negatives preserved.');
