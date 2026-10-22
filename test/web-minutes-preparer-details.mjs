import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as minutesDates from '../public/minutes-dates.js';
import * as minutesMeetingDetails from '../public/minutes-meeting-details.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const storageSource = app.slice(app.indexOf('const draftStorageKey ='), app.indexOf('const PROPOSAL_DRAFT_FIELDS ='));
const helperSource = app.slice(app.indexOf('const MINUTES_MEETING_DETAIL_SUFFIXES ='), app.indexOf('const restoreWebDrafts ='));
const submissionSource = app.slice(app.indexOf('let minutesPreparationContext ='), app.indexOf("$('handoffMinutes').addEventListener"));
const details = {meetingDate:'2026-10-15',meetingType:'Stated Communication',degree:'Third Degree',openingTime:'7:30 PM',closingTime:'9:45 PM',presiding:'WM Example',quorum:'Yes',nextMeeting:'2026-11-05'};
const suffixes = {meetingDate:'MeetingDate',meetingType:'MeetingType',degree:'Degree',openingTime:'OpeningTime',closingTime:'ClosingTime',presiding:'Presiding',quorum:'Quorum',nextMeeting:'NextMeeting'};
class Element {
  constructor(id) { this.id=id;this.value='';this.disabled=false;this.files=[];this.listeners={};this.textContent='';this.classes=new Set();this.classList={contains:x=>this.classes.has(x),add:x=>this.classes.add(x),toggle:(x,on)=>{if(on)this.classes.add(x);else this.classes.delete(x);}}; }
  set value(value) { this.currentValue=value;if(this.id==='minutesTranscriptFile'&&value==='')this.files=[]; }
  get value() { return this.currentValue; }
  addEventListener(type,handler) { (this.listeners[type] ||= []).push(handler); }
  async emit(type) { for (const handler of this.listeners[type] || []) await handler({preventDefault(){},target:this}); }
  focus() { this.focused=true; }
  querySelectorAll() { return this.controls || []; }
}
function harness() {
  const elements=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element(match[1])]));
  const calls=[],opened=[],remembered=[],cleared=[],shown=[],refreshes=[],storage=new Map();
  let response={minutes:{id:'synthetic-minutes'}},failure=null,refresh=true,wait=null,refreshWait=null;
  const state={user:{id:2},authEpoch:3,minutesSourceDirty:false};
  const context={FormData,minutesDates,minutesMeetingDetails,state,$:id=>{assert.ok(elements[id],`Actual markup provides ${id}`);return elements[id];},
    setMessage:(element,text,error=false)=>{element.textContent=text;element.error=error;},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{storage.set(key,value);remembered.push({key,values:JSON.parse(value)});},removeItem:key=>{storage.delete(key);cleared.push(key.replace(/^ss22-web-draft:[^:]+:/,''));}},
    show:element=>shown.push(element.id),hide:element=>shown.splice(shown.indexOf(element.id),1),
    apiFetch:async(path,options)=>{calls.push({path,options});const held=wait,requestFailure=failure,requestResponse=response;if(held)await held;if(requestFailure)throw Error(requestFailure);return requestResponse;},
    renderMinutes:async()=>{refreshes.push(state.user?.id);const held=refreshWait;if(held)await held;return refresh;},openMinutesEditor:id=>opened.push(id)};
  vm.createContext(context);
  vm.runInContext(`${storageSource}\n${helperSource}\n${submissionSource}\nthis.submit=submitMinutesSource;this.openClaim=openMinutesClaim;this.closeClaim=closeMinutesClaim;this.collect=collectMinutesMeetingDetails;this.validate=validateMinutesMeetingDetails;this.reflect=reflectMinutesMeetingDetails;this.resetContext=resetMinutesPreparationContext;this.restoreSource=()=>{restoreSessionDraft('minutes-source',MINUTES_SOURCE_DRAFT_FIELDS);reflectMinutesMeetingDetails('minutesIntake');};`,context);
  elements.minutesClaimForm.controls=Object.entries(elements).filter(([id])=>id.startsWith('minutesClaim')||['cancelMinutesClaim','createClaimedMinutes'].includes(id)).map(([,element])=>element);
  context.resetContext();
  const fill=(prefix,values=details)=>{for(const [key,suffix]of Object.entries(suffixes))elements[`${prefix}${suffix}`].value=values[key]||'';};
  return {elements,calls,opened,remembered,cleared,shown,refreshes,storage,state,context,fill,setFailure:value=>failure=value,setRefresh:value=>refresh=value,setWait:value=>wait=value,setRefreshWait:value=>refreshWait=value};
}

for(const prefix of ['minutesIntake','minutesClaim']) {
  for(const suffix of Object.values(suffixes)) assert.match(html,new RegExp(`id="${prefix}${suffix}"`));
  assert.match(html,new RegExp(`id="${prefix}MeetingType"><option value="">`),'Meeting type requires a deliberate choice');
  assert.match(html,new RegExp(`id="${prefix}Quorum"><option value="">`),'Quorum is never defaulted');
  const sequence=['MeetingDate','MeetingType','Degree','Quorum','OpeningTime','ClosingTime','TimeHelp','Presiding','NextMeeting'];
  const positions=sequence.map(suffix=>html.indexOf(`id="${prefix}${suffix}"`));
  assert.ok(positions.every((position,index)=>index===0||position>positions[index-1]),'Desktop fields form four paired rows while phone reading order remains coherent');
}
{
 const h=harness();h.elements.minutesTranscriptText.value='Retained synthetic source';
 await h.context.submit();assert.equal(h.calls.length,0);assert.equal(h.elements.minutesTranscriptText.value,'Retained synthetic source');
 assert.match(h.elements.minutesMessage.textContent,/Complete the meeting details/);
 h.fill('minutesIntake');h.elements.minutesIntakeClosingTime.value='945';await h.context.submit();assert.equal(h.calls.length,0,'An ambiguous clock never starts generation');
 assert.equal(h.elements.minutesIntakeOpeningTime.value,'7:30 PM');assert.equal(h.elements.minutesIntakeClosingTime.value,'945');
 h.elements.minutesIntakeClosingTime.value='9:45 PM';h.setFailure('Synthetic unavailable');await h.context.submit();assert.equal(h.calls.length,1);
 const sent=JSON.parse(h.calls[0].options.body.get('meetingDetails'));assert.deepEqual(sent,details);assert.equal(h.calls[0].options.body.get('transcriptText'),'Retained synthetic source');
 for(const [key,suffix]of Object.entries(suffixes)) assert.equal(h.elements[`minutesIntake${suffix}`].value,details[key],'A failed request retains each entered detail');
 assert.equal(h.elements.minutesTranscriptText.value,'Retained synthetic source');assert.match(h.elements.minutesMessage.textContent,/source remains/);
 assert.equal(h.elements.generateMinutes.disabled,false);assert.equal(h.elements.minutesIntakeClosingTime.disabled,false);
 h.setFailure(null);await h.context.submit();assert.equal(h.calls.length,2,'Only the deliberate second click sends another request');assert.deepEqual(h.opened,['synthetic-minutes']);
 assert.equal(h.elements.minutesTranscriptText.value,'');assert.equal(h.elements.minutesIntakeClosingTime.value,'');assert.ok(h.cleared.includes('minutes-source'));
}
{
 const h=harness();h.elements.minutesTranscriptText.value='Source-only owner handoff';await h.context.submit({handoff:true});
 assert.equal(h.calls[0].path,'/api/minutes/handoff');assert.equal(h.calls[0].options.body.get('meetingDetails'),null,'Handoff does not invent or require preparer metadata');
 assert.equal(h.calls[0].options.body.get('transcriptText'),'Source-only owner handoff');assert.equal(h.opened.length,0);
}
{
 const h=harness();h.fill('minutesIntake',{...details,meetingDate:'October 15, 2026',nextMeeting:'Thursday, November 5, 2026',meetingType:'other'});h.elements.minutesIntakeMeetingTypeOther.value='Special Communication';
 const actual=JSON.parse(JSON.stringify(h.context.collect('minutesIntake')));assert.equal(actual.meetingType,'Special Communication');assert.equal(actual.meetingDate,'2026-10-15');assert.equal(actual.nextMeeting,'2026-11-05');
 await h.elements.minutesIntakeClosingTime.emit('input');assert.equal(h.state.minutesSourceDirty,true);assert.equal(h.remembered.at(-1).values.minutesIntakeClosingTime,'9:45 PM');
 h.elements.minutesIntakeMeetingDateCalendar.value='2026-10-16';await h.elements.minutesIntakeMeetingDateCalendar.emit('change');
 assert.match(h.elements.minutesIntakeMeetingDate.value,/Friday, October 16, 2026/);assert.match(h.remembered.at(-1).values.minutesIntakeMeetingDate,/October 16/);
}
{
 const h=harness();h.context.openClaim({id:'synthetic-source'});assert.equal(h.calls.length,0,'Opening claim details never claims or generates');assert.ok(h.shown.includes('minutesClaimModal'));
 await h.elements.minutesClaimForm.emit('submit');assert.equal(h.calls.length,0,'Missing details never start a claim');
 h.fill('minutesClaim');h.setFailure('Synthetic verification error');await h.elements.minutesClaimForm.emit('submit');assert.equal(h.calls[0].path,'/api/minutes/synthetic-source/claim');
 assert.deepEqual(JSON.parse(h.calls[0].options.body),{meetingDetails:details});assert.equal(h.elements.minutesClaimClosingTime.value,'9:45 PM');assert.ok(h.shown.includes('minutesClaimModal'));assert.match(h.elements.minutesClaimMessage.textContent,/details remain/);
 h.setFailure(null);await h.elements.minutesClaimForm.emit('submit');assert.deepEqual(h.opened,['synthetic-minutes']);assert.ok(h.cleared.includes('minutes-claim:synthetic-source'));assert.equal(h.shown.includes('minutesClaimModal'),false);
}
{
 const h=harness();h.fill('minutesIntake');h.elements.minutesTranscriptText.value='First account source';
 let release;h.setWait(new Promise(resolve=>{release=resolve;}));const pending=h.context.submit();
 h.state.authEpoch+=1;h.state.user={id:9};h.elements.minutesTranscriptText.value='New account source';h.elements.minutesIntakeClosingTime.value='10:15 PM';
 release();await pending;assert.equal(h.elements.minutesTranscriptText.value,'New account source');assert.equal(h.elements.minutesIntakeClosingTime.value,'10:15 PM');assert.equal(h.opened.length,0);assert.equal(h.cleared.length,0,'A late prior-account response cannot clear the current account draft');
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
for(const oldFails of [false,true]) for(const finishOldFirst of [false,true]) {
 const h=harness(),old=deferred(),current=deferred();
 h.fill('minutesIntake');h.elements.minutesTranscriptText.value='Retained first-account source';h.setWait(old.promise);h.setFailure(oldFails?'Old account failure':null);
 const oldRequest=h.context.submit();
 h.state.authEpoch+=1;h.state.user={id:9};h.context.resetContext();
 assert.equal(h.elements.generateMinutes.disabled,false,'Only entering the changed account context releases stale controls');
 h.fill('minutesIntake',{...details,presiding:'New Presiding Officer',closingTime:'10:15 PM'});h.elements.minutesTranscriptText.value='Current account source';
 h.setWait(current.promise);h.setFailure('Current request needs review');const currentRequest=h.context.submit();
 h.context.resetContext();assert.equal(h.elements.generateMinutes.disabled,true,'Re-entering the same context never unlocks an owned pending request');
 let lastRequest=currentRequest,last=current;
 if(!finishOldFirst) {
   current.resolve();await currentRequest;
   assert.equal(h.elements.minutesTranscriptText.value,'Current account source');
   last=deferred();h.setWait(last.promise);lastRequest=h.context.submit();
 }
 const requestCount=h.calls.length,refreshCount=h.refreshes.length;
 old.resolve();await oldRequest;
 assert.equal(h.elements.generateMinutes.disabled,true,'Old success/error/finally cannot unlock the current account request');
 assert.equal(h.elements.handoffMinutes.disabled,true);assert.equal(h.elements.minutesIntakeClosingTime.disabled,true);
 assert.equal(h.elements.minutesTranscriptText.value,'Current account source');assert.equal(h.elements.minutesIntakePresiding.value,'New Presiding Officer');assert.equal(h.elements.minutesIntakeClosingTime.value,'10:15 PM');
 assert.equal(h.refreshes.length,refreshCount,'An old account result never launches a list refresh');assert.equal(h.opened.length,0);assert.equal(h.cleared.length,0);
 await h.context.submit();assert.equal(h.calls.length,requestCount,'A duplicate click is ignored while the current operation owns the form');
 last.resolve();await lastRequest;assert.equal(h.elements.generateMinutes.disabled,false);assert.equal(h.elements.minutesIntakeClosingTime.disabled,false);
}
for(const oldFails of [false,true]) for(const finishOldFirst of [false,true]) {
 const h=harness(),old=deferred(),current=deferred();
 h.context.openClaim({id:'old-account-source'});h.fill('minutesClaim');h.setWait(old.promise);h.setFailure(oldFails?'Old claim failed':null);
 const oldRequest=h.elements.minutesClaimForm.emit('submit');
 h.state.authEpoch+=1;h.state.user={id:9};h.context.resetContext();h.context.openClaim({id:'current-account-source'});
 h.fill('minutesClaim',{...details,presiding:'Current Presiding Officer',closingTime:'10:15 PM'});h.setWait(current.promise);h.setFailure('Current claim needs review');
 const currentRequest=h.elements.minutesClaimForm.emit('submit');h.context.resetContext();
 assert.equal(h.elements.createClaimedMinutes.disabled,true,'The same account-context reset cannot unlock a pending claim');
 let lastRequest=currentRequest,last=current;
 if(!finishOldFirst) {current.resolve();await currentRequest;last=deferred();h.setWait(last.promise);lastRequest=h.elements.minutesClaimForm.emit('submit');}
 const requestCount=h.calls.length,refreshCount=h.refreshes.length;
 old.resolve();await oldRequest;
 assert.equal(h.elements.createClaimedMinutes.disabled,true,'Old claim success/error/finally cannot release the current claim busy state');
 assert.equal(h.elements.minutesClaimClosingTime.disabled,true);assert.equal(h.elements.closeMinutesClaim.disabled,true);
 assert.equal(h.elements.minutesClaimPresiding.value,'Current Presiding Officer');assert.equal(h.elements.minutesClaimClosingTime.value,'10:15 PM');
 assert.equal(h.refreshes.length,refreshCount,'An old claim result never starts another account list refresh');assert.equal(h.opened.length,0);assert.equal(h.cleared.length,0);
 await h.elements.minutesClaimForm.emit('submit');assert.equal(h.calls.length,requestCount,'The current pending claim still rejects duplicate submissions');
 h.context.closeClaim();assert.ok(h.shown.includes('minutesClaimModal'),'The old finally cannot make a pending current claim cancellable');
 last.resolve();await lastRequest;assert.equal(h.elements.createClaimedMinutes.disabled,false);assert.equal(h.elements.minutesClaimClosingTime.disabled,false);
}
{
 const h=harness(),refresh=deferred(),next=deferred();
 h.context.openClaim({id:'first-source'});h.fill('minutesClaim');h.setRefreshWait(refresh.promise);
 const first=h.elements.minutesClaimForm.emit('submit');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.refreshes.length,1);assert.equal(h.elements.createClaimedMinutes.disabled,false,'A completed claim releases its own controls before waiting for the list');
 h.context.openClaim({id:'next-source'});h.fill('minutesClaim',{...details,presiding:'Next Presiding Officer'});h.setRefreshWait(null);h.setWait(next.promise);h.setFailure('Next claim needs review');
 const second=h.elements.minutesClaimForm.emit('submit');refresh.resolve();await first;
 assert.equal(h.elements.createClaimedMinutes.disabled,true);assert.equal(h.elements.minutesClaimPresiding.value,'Next Presiding Officer');assert.equal(h.opened.length,0,'An old refresh never replaces the newly selected claim');
 await h.elements.minutesClaimForm.emit('submit');assert.equal(h.calls.length,2,'Opening a new claim during old refresh never permits duplicate submission');
 next.resolve();await second;assert.equal(h.elements.createClaimedMinutes.disabled,false);
}
{
 const h=harness(),oldFile={name:'Original meeting notes.txt'};
 h.fill('minutesIntake');h.elements.minutesTranscriptText.value='First account exact source\nRetained second line.';h.elements.minutesSourceType.value='compiled_notes';h.elements.minutesTranscriptFile.files=[oldFile];
 h.context.openClaim({id:'private-first-source'});h.fill('minutesClaim',{...details,presiding:'First Claim Presiding Officer'});
 h.state.authEpoch+=1;h.state.user={id:9};h.context.resetContext();h.context.restoreSource();
 assert.equal(h.elements.minutesTranscriptText.value,'','A new account without a saved draft cannot see the old pasted source');
 assert.equal(h.elements.minutesTranscriptFile.files.length,0,'An old selected file is never exposed to the next account');assert.equal(h.elements.minutesSelectedFile.textContent,'No file selected');assert.equal(h.elements.minutesSourceType.value,'auto');
 for(const suffix of Object.values(suffixes)) assert.equal(h.elements[`minutesIntake${suffix}`].value,'','The new account starts with blank private meeting facts');
 assert.equal(h.state.minutesSourceDirty,false);assert.equal(h.storage.has('ss22-web-draft:2:minutes-source'),true,'The previous account source is retained in its own session draft');
 h.fill('minutesIntake',{...details,presiding:'Second Account Officer',closingTime:'10:15 PM'});h.elements.minutesTranscriptText.value='Second account exact source';h.elements.minutesSourceType.value='transcript';
 h.state.authEpoch+=1;h.state.user={id:2};h.context.resetContext();h.context.restoreSource();
 assert.equal(h.elements.minutesTranscriptText.value,'First account exact source\nRetained second line.');assert.equal(h.elements.minutesSourceType.value,'compiled_notes');
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.collect('minutesIntake'))),details,'Returning to the first account restores its exact meeting details');
 assert.equal(oldFile.name,'Original meeting notes.txt','Clearing the file input does not alter the original file');assert.equal(h.elements.minutesTranscriptFile.files.length,0,'File selection requires that account to choose its original file again');
 h.context.openClaim({id:'private-first-source'});assert.equal(h.elements.minutesClaimPresiding.value,'First Claim Presiding Officer','Claim details are restored only for their account and source');
 h.state.authEpoch+=1;h.state.user={id:9};h.context.resetContext();h.context.restoreSource();
 assert.equal(h.elements.minutesTranscriptText.value,'Second account exact source');assert.equal(h.elements.minutesSourceType.value,'transcript');assert.equal(h.context.collect('minutesIntake').presiding,'Second Account Officer');assert.equal(h.context.collect('minutesIntake').closingTime,'10:15 PM');
 assert.equal(h.cleared.length,0,'Account switches never delete another account saved draft');assert.equal(h.calls.length,0,'Privacy resets never upload a source or run generation');
}
assert.match(app,/meetingDetailsVersion: currentMinutes\(\)\.draft\.meetingDetailsVersion/,'Edited new records retain the explicit-details version marker');
assert.match(app,/meetingDetails: minutesMeetingDetails\.normalizeMinutesMeetingDetails\(meetingDetails\)/,'A deliberate reorganization carries the currently edited details');
assert.match(app,/minutesMeetingDetails\.minutesMeetingDetailsIssues\(Object\.fromEntries/,'Submission validates the preparer details before saving or signing');
assert.match(app,/resetMinutesPreparationContext\(\);\s+restoreWebDrafts/,'A new signed-in workspace resets prior-account operation ownership before restoring its own draft');
console.log('PASS: required eight-field intake, explicit clocks, source-only handoff, metadata carry, claim validation, failure preservation, owned operation ordering and private account draft restoration using actual browser functions.');
