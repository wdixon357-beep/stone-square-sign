import assert from 'node:assert/strict';
import {organizeReport,REPORT_GENERATOR_RULES} from '../report-ai.js';
const schema={types:{event:{name:'Event Proposal',fields:[{id:'title',label:'Event name',kind:'text',req:true},{id:'budget',label:'Budget',kind:'budget'},{id:'price',label:'Price',kind:'money'},{id:'approved',label:'Approved funds',kind:'money'},{id:'time',label:'Time',kind:'time'},{id:'date',label:'Date',kind:'date'},{id:'notes',label:'Notes',kind:'long'}]}},masterTypes:{}};
const input={source:'Community dinner on October 1, 2026. Plates cost $20.00. Food, 300, Stone Square. No vote was taken.',type:'event',master:false,fields:{notes:'Existing note must remain.'}};
const suggestion={suggestions:[{field:'title',value:'Community dinner',quote:'Community dinner'},{field:'price',value:'20.00',quote:'Plates cost $20.00.'},{field:'date',value:'2026-10-01',quote:'October 1, 2026'},{field:'budget',value:'Food, 300, Stone Square',quote:'Food, 300, Stone Square.'}],warnings:['No vote was taken.']};
let calls=0;
const run=(value=suggestion,data=input)=>organizeReport(data,{schema,generateStructured:async request=>{calls++;assert.equal(request.purpose,'report');assert.equal(request.instructions,REPORT_GENERATOR_RULES);assert.match(request.input,/Existing note must remain/);return structuredClone(value);}});
const result=await run();assert.equal(result.fields.price,'20.00');assert.equal(result.fields.date,'2026-10-01');assert.equal(result.fields.notes,undefined);assert.equal(input.fields.notes,'Existing note must remain.');
for(const bad of [{field:'signatureName',value:'Signed',quote:'Community dinner'},{field:'price',value:'999',quote:'Plates cost $20.00.'},{field:'date',value:'2026-10-02',quote:'October 1, 2026'},{field:'title',value:'Invented',quote:'Not in the source'}])await assert.rejects(run({suggestions:[bad],warnings:[]}));
await assert.rejects(run({...suggestion,suggestions:[suggestion.suggestions[0],suggestion.suggestions[0]]}));
const before=calls;await assert.rejects(run(suggestion,{...input,source:''}));await assert.rejects(run(suggestion,{...input,fields:{signatureName:'x'}}));assert.equal(calls,before);
await assert.rejects(organizeReport(input,{schema}),e=>e.statusCode===503);
await assert.rejects(run({suggestions:[{field:'budget',value:'Food, 9000, Jephthah',quote:'Food, 300, Stone Square.'}],warnings:[]}),/budget changed/);
await assert.rejects(run({suggestions:[{field:'approved',value:'500',quote:'The request for $500 was denied. No money was approved.'}],warnings:[]},{...input,source:'The request for $500 was denied. No money was approved.'}),/approved funds/);
await assert.rejects(run({suggestions:[{field:'time',value:'21:00',quote:'Dinner starts at 6:00 PM.'}],warnings:[]},{...input,source:'Dinner starts at 6:00 PM.'}),/time does not match/);
const timed=await run({suggestions:[{field:'time',value:'18:00',quote:'Dinner starts at 6:00 PM.'}],warnings:[]},{...input,source:'Dinner starts at 6:00 PM.'});assert.equal(timed.fields.time,'18:00');
await assert.rejects(run({suggestions:[{field:'budget',value:'Food, 300',quote:'Food, 300, Stone Square.'}],warnings:[]}),/budget changed/);
const approved=await run({suggestions:[{field:'approved',value:'500',quote:'The Lodge approved the $500 request.'}],warnings:[]},{...input,source:'The Lodge approved the $500 request.'});assert.equal(approved.fields.approved,'500');
await assert.rejects(run({suggestions:[{field:'budget',value:'Food, 300',quote:'Food, 300'}],warnings:[]}),/omitted part of a row/);
console.log('Report field organization, evidence, amounts, dates, identity boundaries and input retention passed without paid calls.');

const tierQuote='General Admission | $5.00 per person | $10.00 per family';
const rangeQuote='TOTAL PROJECTED GROSS REVENUE | $10,700–$12,650';
const noteQuote='Organizers will review the schedule before approval.';
const moneySchema=structuredClone(schema);
moneySchema.types.event.fields.push({id:'revenue',label:'Expected event income',kind:'money'});
const moneyInput={source:[tierQuote,rangeQuote,noteQuote].join('\n'),type:'event',master:false,fields:{notes:'Keep the original note exactly.'}};
const moneyResult={suggestions:[
  {field:'price',value:'5.00 per person; 10.00 per family',quote:tierQuote},
  {field:'revenue',value:'10700.00 - 12650.00',quote:rangeQuote},
  {field:'notes',value:noteQuote,quote:noteQuote},
],warnings:[]};
let moneyCalls=0;
const organizeMoney=(result=moneyResult,data=moneyInput,definitions=moneySchema)=>organizeReport(data,{
  schema:definitions,generateStructured:async()=>{moneyCalls+=1;return structuredClone(result);}
});
const beforeMoney=structuredClone(moneyInput);
const tiers=await organizeMoney();
assert.equal(tiers.fields.price,undefined,'tiered prices must not be forced into a single numeric field');
assert.equal(tiers.fields.revenue,undefined,'an income range must not become a guessed numeric total');
for(const value of [tierQuote,rangeQuote,noteQuote,moneyInput.fields.notes])assert.ok(tiers.fields.notes.includes(value),'notes preserve exact source context and existing notes: '+value);
for(const value of ['5.00 per person; 10.00 per family','10700.00 - 12650.00'])assert.equal(tiers.fields.notes.includes(value),false,'generated scalar annotations must never replace the original source wording');
assert.ok(tiers.warnings.some(value=>/Price/i.test(value)&&/single|one amount/i.test(value)),'the price warning explains why the scalar was omitted');
assert.ok(tiers.warnings.some(value=>/Expected event income|revenue/i.test(value)&&/single|one amount/i.test(value)),'the income warning explains why the scalar was omitted');
for(const quote of [tierQuote,rangeQuote])assert.ok(tiers.evidence.some(item=>item.field==='notes'&&item.quote===quote),'notes retain each exact source reference');
for(const evidence of tiers.evidence)assert.ok((moneyInput.source+'\n'+moneyInput.fields.notes).includes(evidence.quote),'every retained evidence quote must remain exact source text');
assert.deepEqual(moneyInput,beforeMoney,'normalization must not change the saved source or input fields');

const fabricated=await organizeMoney({suggestions:[{field:'price',value:'999 per visitor; GENERATED_PHRASE_MUST_NOT_APPEAR',quote:tierQuote}],warnings:[]});
assert.ok(fabricated.fields.notes.includes(tierQuote));
assert.equal(JSON.stringify(fabricated).includes('GENERATED_PHRASE_MUST_NOT_APPEAR'),false,'discarded generated money prose must not leak into notes, warnings, or evidence');
assert.equal(fabricated.fields.price,undefined);
const single=await organizeMoney({suggestions:[{field:'price',value:'5.00',quote:tierQuote}],warnings:[]});
assert.equal(single.fields.price,'5.00','valid exact scalar amounts remain unchanged');
assert.equal(single.fields.notes,undefined,'valid scalar suggestions do not rewrite existing notes');
await assert.rejects(organizeMoney({suggestions:[{field:'price',value:'999.00',quote:tierQuote}],warnings:[]}),error=>error.statusCode===502,'a syntactically valid invented amount remains a verification error');
await assert.rejects(organizeMoney({suggestions:[{field:'price',value:'5 to 10',quote:'No such quotation exists.'}],warnings:[]}),error=>error.statusCode===502,'fallback never relaxes exact quote verification');
await assert.rejects(organizeMoney({suggestions:[{field:'approved',value:'500 or 600 pending',quote:'No money was approved.'}],warnings:[]},{...moneyInput,source:'No money was approved.'}),error=>error.statusCode===502,'non-scalar handling cannot bypass negative approval evidence');

const noNotes=structuredClone(moneySchema);noNotes.types.event.fields=noNotes.types.event.fields.filter(field=>field.id!=='notes');
await assert.rejects(organizeMoney({suggestions:[moneyResult.suggestions[0]],warnings:[]},{...moneyInput,fields:{}},noNotes),error=>error.statusCode===502,'a report with no notes destination must fail rather than discard money context');
const longNotes={...moneyInput,fields:{notes:'x'.repeat(6000)}};
await assert.rejects(organizeMoney({suggestions:[moneyResult.suggestions[0]],warnings:[]},longNotes),error=>error.statusCode===502,'notes beyond the field limit must fail without truncation');
assert.equal(longNotes.fields.notes.length,6000,'a failed merge retains the complete original notes');
await assert.rejects(organizeMoney({suggestions:[moneyResult.suggestions[0],{field:'price',value:'5.00',quote:tierQuote}],warnings:[]}),error=>error.statusCode===502,'omitting the first invalid scalar cannot bypass duplicate-field rejection');
assert.equal(moneyCalls,9,'each organization attempt uses exactly one injected response without hidden retry');
console.log('Tiered prices and income ranges retain exact source quotes in notes; invented scalar values, invalid evidence, missing notes, overlong merges and duplicate fields remain blocked.');
