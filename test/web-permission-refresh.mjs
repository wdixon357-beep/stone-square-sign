import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('// Refresh access without'),app.indexOf('const applySubmissionProfiles ='));
function setup(){
 const elements={},calls=[],state={authEpoch:1,user:{id:2,role:'officer',permissions:['minutes.prepare']},activeSection:'minutes'};
 const draft={value:'Unsaved meeting notes'};elements.minutesTranscriptText=draft;
 let result={user:{id:2,role:'officer',permissions:['minutes.view']}};
 const ctx={state,$:id=>elements[id]||(elements[id]={}),window:{setInterval:(fn,ms)=>calls.push(['interval',ms]),addEventListener:(event)=>calls.push(['event',event])},document:{querySelectorAll:()=>[]},apiFetch:async()=>result,can:key=>state.user.permissions.includes(key),applyWorkspacePermissions:user=>calls.push(['apply',user]),showWorkspaceSection:(...args)=>calls.push(['section',...args]),buildingCalendarWorkspace:{refreshPermissions:()=>calls.push(['buildingCalendar'])},treasuryWorkspace:{refreshPermissions:()=>calls.push(['treasury'])},hide:el=>{el.hidden=true},show:el=>{el.hidden=false},renderDocuments:()=>calls.push(['documents']),setMessage:()=>{},authMessage:{}};
 vm.createContext(ctx);vm.runInContext(source,ctx);return{ctx,state,draft,elements,calls,refresh:()=>vm.runInContext('refreshSessionPermissions()',ctx),result:value=>{result=value}};
}
let t=setup();await t.refresh();assert.equal(t.draft.value,'Unsaved meeting notes');assert.equal(t.elements.minutesEditorModal.hidden,true);assert.deepEqual(JSON.parse(JSON.stringify(t.calls.find(x=>x[0]==='section'))),['section','minutes',{skipLoad:true}]);assert.equal(t.state.user.permissions[0],'minutes.view');assert.ok(t.calls.some(x=>x[0]==='interval'&&x[1]===30000));assert.ok(t.calls.some(x=>x[0]==='event'&&x[1]==='focus'));
const applies=t.calls.filter(x=>x[0]==='apply').length;await t.refresh();assert.equal(t.calls.filter(x=>x[0]==='apply').length,applies);
t=setup();t.ctx.apiFetch=async()=>{throw Object.assign(Error('offline'),{status:503})};await t.refresh();assert.equal(t.state.user.permissions[0],'minutes.prepare');assert.equal(t.draft.value,'Unsaved meeting notes');
t=setup();let complete;t.ctx.apiFetch=()=>new Promise(resolve=>complete=resolve);const pending=t.refresh();t.state.authEpoch+=1;complete({user:{id:2,role:'officer',permissions:[]}});await pending;assert.equal(t.state.user.permissions[0],'minutes.prepare');assert.equal(t.calls.filter(x=>x[0]==='apply').length,0);
assert.doesNotMatch(source,/enterWorkspace\(|location\.reload|\.value\s*=/);
console.log('PASS: periodic/focus access refresh, unchanged permissions no-op, retained unsaved inputs, revoked editor hidden, transient errors and stale-session responses safe.');
