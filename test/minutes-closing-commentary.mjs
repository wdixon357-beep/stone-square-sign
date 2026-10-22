import assert from 'node:assert/strict';
import {omitClosingPrayerCommentary,omitClosingPrayerCommentaryText} from '../minutes-closing-commentary.js';
const caveat='The source does not establish that this was a closing prayer';
const factual=['Prayers were requested for Brother Example.','The Chaplain did not give the closing prayer.','No closing prayer was offered.','The Lodge closed at 9:12 PM.'];
let checks=0;
const check=(label,run)=>{run();checks++;console.log('PASS '+label);};
for(const text of [caveat,caveat+'.','- '+caveat+'.','• '+caveat,'1. '+caveat+'.','**'+caveat+'.**','- *'+caveat+'*.','- ***'+caveat+'.***','<em>'+caveat+'.</em>']) {
  check('Remove only the standalone requested caveat: '+text,()=>assert.equal(omitClosingPrayerCommentaryText(text),''));
}
for(const text of ['The transcript does not establish whether this was a closing prayer.','The notes do not establish that it was the closing prayer.']) {
  check('Remove narrow equivalent source-analysis sentence: '+text,()=>assert.equal(omitClosingPrayerCommentaryText(text),''));
}
check('A caveat in a mixed bullet never drops adjacent facts or explicit negatives',()=>{
 const text='- '+factual[0]+' '+caveat+'. '+factual[1]+' '+factual[3];
 assert.equal(omitClosingPrayerCommentaryText(text),'- '+[factual[0],factual[1],factual[3]].join(' '));
});
check('Markdown caveat between real facts removes its wrapper without changing neighbouring emphasis',()=>assert.equal(
 omitClosingPrayerCommentaryText('- **Prayer:** '+factual[0]+' **'+caveat+'.** '+factual[3]),'- **Prayer:** '+factual[0]+' '+factual[3]));
check('A wrapped caveat can be removed while separate prayer and closing bullets remain',()=>assert.equal(
 omitClosingPrayerCommentaryText('- '+factual[0]+'\r\n- The source does not establish\r\nthat this was a closing prayer.\r\n- '+factual[3]),'- '+factual[0]+'\r\n- '+factual[3]));
for(const text of [...factual,'The source does not establish the mover or seconder.','The source does not establish that this was a closing prayer for Brother Example.','Confirm whether the Chaplain gave the closing prayer.','The prayer was not identified as a closing prayer.']) {
 check('Preserve real facts and unrelated or broader statements: '+text,()=>assert.equal(omitClosingPrayerCommentaryText(text),text));
}
check('Multiple caveats are removed without joining or dropping separate factual bullets',()=>assert.equal(
 omitClosingPrayerCommentaryText('- '+caveat+'.\n- '+factual[0]+'\n- '+caveat+'.\n- '+factual[3]),'- '+factual[0]+'\n- '+factual[3]));
const draft={closingPrayerGiven:null,prayerRequested:null,closingTime:'9:12 PM',attendanceReview:{officerRoll:false},
 transcript_text:caveat,sourceText:caveat,sourceName:'Original notes',submittedDraft:{sections:[{heading:'Prayer and Closing',body:caveat+'.'}]},
 sections:[{heading:'Sickness and Distress',body:'- '+factual[0]},{heading:'Prayer and Closing',body:'- '+caveat+'.\n- '+factual[2]+'\n- '+factual[3]}],warnings:[caveat+'.','Confirm the mover.',factual[1]]};
const before=structuredClone(draft),cleaned=omitClosingPrayerCommentary(draft);
check('Cleanup returns independent objects and leaves every input/source/snapshot byte unchanged',()=>{
 assert.deepEqual(draft,before);assert.notEqual(cleaned,draft);assert.notEqual(cleaned.sections,draft.sections);assert.notEqual(cleaned.attendanceReview,draft.attendanceReview);
 assert.equal(cleaned.sourceText,caveat);assert.equal(cleaned.transcript_text,caveat);assert.deepEqual(cleaned.submittedDraft,before.submittedDraft);
});
check('Cleanup preserves structured prayer uncertainty, confirmations and real section content',()=>{
 assert.equal(cleaned.closingPrayerGiven,null);assert.equal(cleaned.prayerRequested,null);assert.equal(cleaned.closingTime,'9:12 PM');assert.deepEqual(cleaned.attendanceReview,{officerRoll:false});
 assert.deepEqual(cleaned.sections,[{heading:'Sickness and Distress',body:'- '+factual[0]},{heading:'Prayer and Closing',body:'- '+factual[2]+'\n- '+factual[3]}]);
 assert.deepEqual(cleaned.warnings,['Confirm the mover.',factual[1]]);
});
check('Unchanged drafts retain exactly the same values',()=>{const input={closingPrayerGiven:false,sections:[{heading:'Prayer and Closing',body:'  '+factual[2]+'  '}],warnings:['Confirm the mover.']};assert.deepEqual(omitClosingPrayerCommentary(input),input);});
check('Unrelated empty/nonstring warnings and incomplete section shapes remain unchanged',()=>{const input={sections:[{heading:'Prayer and Closing'},null],warnings:['',null,17,'Confirm the mover.']};assert.deepEqual(omitClosingPrayerCommentary(input),input);});
check('Unrelated mixed line endings and indentation are preserved',()=>assert.equal(omitClosingPrayerCommentaryText('  '+factual[0]+' '+caveat+'.\r\n'+factual[2]+'\n'+factual[3]),'  '+factual[0]+'\r\n'+factual[2]+'\n'+factual[3]));
check('Cleanup is idempotent',()=>assert.deepEqual(omitClosingPrayerCommentary(cleaned),cleaned));
console.log(checks+' closing-commentary cleanup checks passed without network or live records.');
