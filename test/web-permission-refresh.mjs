import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('// Refresh access without'),app.indexOf('const applySubmissionProfiles ='));
const signaturePolicy=app.slice(app.indexOf('const can = '),app.indexOf('const DUES_MANAGEMENT_ROLES'));
function setup(){
 const elements={},calls=[],state={authEpoch:1,user:{id:2,role:'officer',permissions:['minutes.prepare']},activeSection:'minutes'};
 const draft={value:'Unsaved meeting notes'};elements.minutesTranscriptText=draft;
 let result={user:{id:2,role:'officer',permissions:['minutes.view']}};
 const element=id=>{
  if(!elements[id]){
   const el={};el.classList={contains:value=>value==='hidden'&&el.hidden===true};elements[id]=el;
  }
  return elements[id];
 };
 const ctx={state,legacyReportBridge:{request:()=>calls.push(['legacyRequest',state.user?.id]),clear:()=>calls.push(['legacyClear',state.user])},clearMemberAccessInvite:()=>calls.push(['clearInvite']),$:element,window:{setInterval:(fn,ms)=>calls.push(['interval',ms]),addEventListener:(event)=>calls.push(['event',event])},document:{querySelectorAll:()=>[]},apiFetch:async()=>result,applyWorkspacePermissions:user=>calls.push(['apply',user]),showWorkspaceSection:(...args)=>calls.push(['section',...args]),buildingCalendarWorkspace:{refreshPermissions:()=>calls.push(['buildingCalendar'])},treasuryWorkspace:{refreshPermissions:()=>calls.push(['treasury'])},hide:el=>{el.hidden=true},show:el=>{el.hidden=false},renderDocuments:()=>calls.push(['documents']),openSignatureSetup:required=>calls.push(['signatureProfile',required]),setMessage:()=>{},authMessage:{}};
 vm.createContext(ctx);vm.runInContext(signaturePolicy+source,ctx);return{ctx,state,draft,elements,calls,refresh:()=>vm.runInContext('refreshSessionPermissions()',ctx),result:value=>{result=value}};
}
let t=setup();await t.refresh();assert.equal(t.draft.value,'Unsaved meeting notes');assert.equal(t.elements.minutesEditorModal.hidden,true);assert.deepEqual(JSON.parse(JSON.stringify(t.calls.find(x=>x[0]==='section'))),['section','minutes',{skipLoad:true}]);assert.equal(t.state.user.permissions[0],'minutes.view');assert.ok(t.calls.some(x=>x[0]==='interval'&&x[1]===30000));assert.ok(t.calls.some(x=>x[0]==='event'&&x[1]==='focus'));
assert.deepEqual(t.calls.find(x=>x[0]==='legacyRequest'),['legacyRequest',2]);
const applies=t.calls.filter(x=>x[0]==='apply').length;await t.refresh();assert.equal(t.calls.filter(x=>x[0]==='apply').length,applies);assert.equal(t.calls.filter(x=>x[0]==='legacyRequest').length,2);
t=setup();t.ctx.apiFetch=async()=>{throw Object.assign(Error('offline'),{status:503})};await t.refresh();assert.equal(t.state.user.permissions[0],'minutes.prepare');assert.equal(t.draft.value,'Unsaved meeting notes');
t=setup();let complete;t.ctx.apiFetch=()=>new Promise(resolve=>complete=resolve);const pending=t.refresh();t.state.authEpoch+=1;complete({user:{id:2,role:'officer',permissions:[]}});await pending;assert.equal(t.state.user.permissions[0],'minutes.prepare');assert.equal(t.calls.filter(x=>x[0]==='apply').length,0);
t=setup();t.ctx.apiFetch=async()=>{throw Object.assign(Error('expired'),{status:401})};await t.refresh();assert.equal(t.state.user,null);assert.equal(t.state.authEpoch,2);assert.deepEqual(t.calls.find(x=>x[0]==='legacyClear'),['legacyClear',null]);assert.ok(t.calls.some(x=>x[0]==='clearInvite'));assert.equal(t.elements.appCard.hidden,true);assert.equal(t.elements.authCard.hidden,false);
t=setup();t.state.user={id:2,role:'owner',permissions:[],hasSignature:true};t.result({user:{...t.state.user,signatureProfileLocked:true}});await t.refresh();assert.equal(t.state.user.signatureProfileLocked,true);assert.deepEqual(t.calls.find(x=>x[0]==='signatureProfile'),['signatureProfile',false],'a new server lock converts an already open signature editor to the saved-profile view');assert.equal(t.draft.value,'Unsaved meeting notes');
const profileRefreshes=t.calls.filter(x=>x[0]==='signatureProfile').length;await t.refresh();assert.equal(t.calls.filter(x=>x[0]==='signatureProfile').length,profileRefreshes,'an unchanged signature lock does not keep reopening the profile');
t=setup();t.state.user={id:2,role:'owner',permissions:[],hasSignature:true};t.ctx.$('signatureSetupModal').hidden=true;t.result({user:{...t.state.user,signatureProfileLocked:true}});await t.refresh();assert.equal(t.calls.some(x=>x[0]==='signatureProfile'),false,'a background lock update does not open a closed profile');assert.equal(t.draft.value,'Unsaved meeting notes');
assert.doesNotMatch(source,/enterWorkspace\(|location\.reload|\.value\s*=/);
console.log('PASS: periodic/focus access refresh, unchanged permissions no-op, retained unsaved inputs, revoked editor hidden, transient errors and stale-session responses safe; legacy recovery follows account refresh and clears on expiration.');
