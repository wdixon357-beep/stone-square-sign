import assert from 'node:assert/strict';
import {generateMinutesDraft,MINUTES_SCHEMA,MINUTES_GENERATION_SCHEMA,minutesSourceLines,
  minutesGenerationSchemaForLineCount,resolveMinutesSourceLineIds} from '../minutes.js';

let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
const exact='  First line\r\n\r\nSecond line\r\n  First line';
check('Source catalog preserves spaces, CRLF characters, blank lines and repeated text',()=>assert.deepEqual(minutesSourceLines(exact),[
  {line:1,text:'  First line\r'},{line:2,text:'\r'},{line:3,text:'Second line\r'},{line:4,text:'  First line'},
]));
const ids=[4,3,1,3];
check('Reference IDs are sorted and deduplicated without mutating the supplied list',()=>{
  assert.deepEqual(resolveMinutesSourceLineIds(exact,ids),[
    {quote:'  First line\r',firstLine:1,lastLine:1},
    {quote:'Second line\r\n  First line',firstLine:3,lastLine:4},
  ]);assert.deepEqual(ids,[4,3,1,3]);
});
check('Consecutive selected positions reconstruct the exact original source span',()=>assert.deepEqual(resolveMinutesSourceLineIds(exact,[3,2,1]),[
  {quote:'  First line\r\n\r\nSecond line\r',firstLine:1,lastLine:3},
]));
check('Repeated text is credited to the selected occurrence, not the first matching string',()=>assert.deepEqual(resolveMinutesSourceLineIds('Repeat\nOther\nRepeat',[3]),[
  {quote:'Repeat',firstLine:3,lastLine:3},
]));
for(const invalid of [[0],[-1],[5],[1.5],['1'],[null],[NaN],[Infinity],[Number.MAX_SAFE_INTEGER+1],null,{}]) {
  check('Invalid or nonexistent line IDs fail closed: '+JSON.stringify(invalid),()=>assert.throws(()=>resolveMinutesSourceLineIds(exact,invalid),RangeError));
}
check('Blank-only citations cannot establish a recorded fact',()=>assert.throws(()=>resolveMinutesSourceLineIds(exact,[2]),RangeError));
check('An empty reference list remains empty',()=>assert.deepEqual(resolveMinutesSourceLineIds(exact,[]),[]));
const template=structuredClone(MINUTES_GENERATION_SCHEMA),saved=structuredClone(MINUTES_SCHEMA);
for(const count of [1,8,1000])check('Each request binds integer references to its own source catalog size '+count,()=>{
  const schema=minutesGenerationSchemaForLineCount(count);
  for(const item of [schema.properties.draft.properties.sections.items.properties.sourceLineIds.items,
    schema.properties.evidence.items.properties.sourceLineIds.items])assert.deepEqual(item,{type:'integer',minimum:1,maximum:count});
  schema.properties.draft.properties.sections.items.properties.sourceLineIds.items.maximum=9999;
  assert.deepEqual(MINUTES_GENERATION_SCHEMA,template);assert.deepEqual(MINUTES_SCHEMA,saved);
});
for(const invalid of [0,-1,1.5,'2',NaN,Number.MAX_SAFE_INTEGER+1])check('Invalid schema line counts are rejected: '+String(invalid),()=>assert.throws(()=>minutesGenerationSchemaForLineCount(invalid),RangeError));

const repeated='Community Supper: Fish and two sides were proposed. No vote was taken. Volunteers will confirm the menu.';
const source=['Meeting date: October 1, 2026','The Lodge opened on the Third Degree at 7:30 PM.',repeated,'',repeated,
  'The Chaplain gave the closing prayer and prayed for the sick and distressed.','The Lodge closed at 9:00 PM.','An additional scheduling note needs placement.'].join('\n');
const response=()=>({draft:{meetingDate:'2026-10-01',meetingType:'Stated Communication',degree:'Third Degree',openingTime:'7:30 PM',closingTime:'9:00 PM',prayerRequested:null,closingPrayerGiven:true,presiding:null,quorum:null,nextMeeting:null,
  present:[],excused:[],visitors:[],officerAttendance:[],income:[],expenses:[],actionItems:[],warnings:[],sensitiveReview:[],sections:[
    {heading:'Opening',body:'- The Lodge opened on the Third Degree at 7:30 PM.',sourceLineIds:[2]},
    {heading:'Sickness and Distress',body:'',sourceLineIds:[]},
    {heading:'New Business and Motions',body:'- '+repeated,sourceLineIds:[5,5]},
    {heading:'Prayer and Closing',body:'- The Chaplain gave the closing prayer and prayed for the sick and distressed.\n- The Lodge closed at 9:00 PM.',sourceLineIds:[7,6]},
  ]},evidence:[{field:'meetingDate',sourceLineIds:[1]},{field:'degree',sourceLineIds:[2]},{field:'openingTime',sourceLineIds:[2]},
    {field:'closingTime',sourceLineIds:[7]},{field:'closingPrayerGiven',sourceLineIds:[6]}]});
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Source-line fixtures must never contact a provider.');};
try{
  let calls=0;const result=response(),snapshot=structuredClone(result);
  const draft=await generateMinutesDraft(source,{sourceType:'compiled_notes',generateStructured:async request=>{
    calls++;const input=JSON.parse(request.input);
    assert.deepEqual(Object.keys(input).sort(),['officerRoster','sourceLines','sourceType']);
    assert.equal(input.sourceLines.map(line=>line.text).join('\n'),source);
    assert.deepEqual(input.sourceLines,minutesSourceLines(source));
    assert.deepEqual(request.schema,minutesGenerationSchemaForLineCount(8));return result;
  }});
  check('Generation receives the source exactly once as a bounded line catalog',()=>assert.equal(calls,1));
  check('Successful verification preserves the model result and source text',()=>{assert.deepEqual(result,snapshot);assert.equal(source.split('\n')[4],repeated);});
  check('Repeated-text references retain the exact selected line position in the saved review notes',()=>{
    assert.ok(draft.warnings.includes('Source reference: New Business and Motions, line 5.'));
    assert.ok(draft.warnings.some(warning=>/Motion source review: line 3 /.test(warning)));
    assert.ok(!draft.warnings.some(warning=>/Motion source review: line 5 /.test(warning)));
  });
  const reject=async(mutator,code)=>{const bad=response();mutator(bad);let attempts=0;await assert.rejects(generateMinutesDraft(source,{generateStructured:async()=>{attempts++;return bad;}}),error=>error.statusCode===502&&(!code||error.code===code));assert.equal(attempts,1);checks++;};
  await reject(bad=>{bad.draft.sections[2].sourceQuotes=[repeated];delete bad.draft.sections[2].sourceLineIds;},'MINUTES_SOURCE_LINE_CONTRACT_REQUIRED');
  await reject(bad=>{bad.evidence[0]={field:'meetingDate',quote:'Meeting date: October 1, 2026'};},'MINUTES_SOURCE_LINE_CONTRACT_REQUIRED');
  await reject(bad=>{bad.draft.sections[2].sourceLineIds=[];},'MINUTES_SECTION_EVIDENCE_INVALID');
  await reject(bad=>{bad.draft.sections[1].sourceLineIds=[1];},'MINUTES_SECTION_EVIDENCE_INVALID');
  await reject(bad=>{bad.draft.sections[2].sourceLineIds=[4];},'MINUTES_SECTION_EVIDENCE_INVALID');
  for(const ids of [[0],[9],[1.5],['5'],[Number.MAX_SAFE_INTEGER+1]])await reject(bad=>{bad.draft.sections[2].sourceLineIds=ids;});
  await reject(bad=>{bad.draft.sections[2].body='- The Community Supper motion was approved unanimously.';},'MINUTES_UNSUPPORTED_APPROVAL');
  console.log('PASS Legacy contracts, empty-section coupling, invalid IDs and unsupported factual claims remain rejected without automatic retry.');
  console.log(checks+' source-line catalog, runtime binding and strict verification checks passed.');
}finally{globalThis.fetch=originalFetch;}
