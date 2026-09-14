import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderAccessControls } from '../public/access-controls.js';
class Element {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.events={}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  setAttribute() {}
  addEventListener(kind, fn) { this.events[kind]=fn; }
  querySelectorAll(selector) { const all=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]); return selector==='input:checked'?all.filter(el=>el.tag==='input'&&el.checked):selector==='input'?all.filter(el=>el.tag==='input'):all; }
}
global.document = { createElement: tag=>new Element(tag) };
const root=new Element(), calls=[];
await renderAccessControls(root, async (path, init) => {
  calls.push({path, init}); if (init) return {ok:true};
  return { capabilities:[{id:'reports.create',label:'Prepare reports'},{id:'treasury.upload',label:'Upload banking records'}], accounts:[
    {key:'user:1',id:1,name:'Owner',email:'owner@example.test',role:'owner',permissions:[]},
    {key:'user:2',id:2,name:'Officer',email:'officer@example.test',role:'officer',permissions:['reports.create']},
    {key:'invite:3',id:3,name:'Pending officer',email:'pending@example.test',role:'officer',pending:true,permissions:[]},
  ] };
});
const panels=root.children.filter(el=>el.tag==='details');
assert.equal(panels[0].children.some(el=>el.tag==='button'),false);
const fieldset=panels[1].children.find(el=>el.tag==='fieldset');
const inputs=fieldset.querySelectorAll('*').filter(el=>el.tag==='input');
assert.deepEqual(inputs.map(el=>el.checked),[true,false]); inputs[1].checked=true;
await panels[1].children.find(el=>el.tag==='button').events.click();
assert.deepEqual(JSON.parse(calls[1].init.body),{key:'user:2',permissions:['reports.create','treasury.upload']});
await panels[2].children.find(el=>el.tag==='button').events.click();
assert.equal(JSON.parse(calls.filter(call=>call.init).at(-1).init.body).key,'invite:3');
const treasury=fs.readFileSync(new URL('../public/treasury.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export class TreasuryWorkspace','class TreasuryWorkspace');
const apiCalls=[], ui={querySelector:()=>({})};
const ctx={clearTimeout,document:{getElementById:()=>ui},URL:{createObjectURL:()=> 'blob:local',revokeObjectURL(){}},MinutesPreview:class{async show(){}},structuredClone,Uint8Array};
vm.createContext(ctx);vm.runInContext(treasury+'\nglobalThis.TreasuryWorkspace=TreasuryWorkspace;',ctx);
const workspace=Object.create(ctx.TreasuryWorkspace.prototype);workspace.root=ui;workspace.api=async(path)=>{apiCalls.push(path);return{arrayBuffer:async()=>new ArrayBuffer(0)}};workspace.user=()=>({role:'officer',permissions:['treasury.view']});
assert.equal(workspace.can('treasury.prepare'),false);await workspace.openFinal({id:'final-1',status:'ready_for_distribution',draft:{periodEnd:'2026-09-01'}});
assert.deepEqual(apiCalls,['/api/treasury/final-1/pdf']);assert.doesNotMatch(ui.innerHTML,/source-file|Save corrections|data-path/);
const beforePending=apiCalls.length;await workspace.openFinal({id:'pending',status:'awaiting_preparer'});assert.equal(apiCalls.length,beforePending);assert.equal(workspace.canOpenFinal({status:'draft'}),false);assert.equal(workspace.canOpenFinal({status:'distributed'}),true);
const listElements={};workspace.previewView=null;workspace.root={querySelector:id=>listElements[id]||(listElements[id]={})};workspace.api=async(path)=>path==='/api/archives/treasury'?{records:[{id:'old-1',title:'Treasurer Report, January 1, 2024'}]}:{reports:[{id:'pending',status:'awaiting_preparer',draft:{}},{id:'finished',status:'ready_for_distribution',draft:{}}]};await workspace.list();assert.doesNotMatch(listElements['#treasuryList'].innerHTML,/data-id="pending"/);assert.match(listElements['#treasuryList'].innerHTML,/data-id="finished">View PDF/);assert.match(listElements['#treasuryList'].innerHTML,/Historical treasurer reports/);assert.match(listElements['#treasuryList'].innerHTML,/data-treasury="archive-open"/);
workspace.user=()=>({role:'assistant_treasurer',permissions:['treasury.prepare']});assert.equal(workspace.can('treasury.upload'),false);assert.equal(workspace.can('treasury.prepare'),true);
workspace.user=()=>({role:'officer',permissions:['treasury.view']});workspace.api=async(path)=>{apiCalls.push(path);return{arrayBuffer:async()=>new ArrayBuffer(0)}};await workspace.openArchive({id:'old-1',title:'Treasurer Report, January 1, 2024'});assert.match(workspace.root.innerHTML,/All reports/);assert.doesNotMatch(workspace.root.innerHTML,/target="_blank"/);let returned=false;workspace.list=async()=>{returned=true};workspace.dirty=false;workspace.busy=false;await workspace.run('back',{disabled:false,isConnected:false});assert.equal(returned,true);
workspace.user=()=>({role:'assistant_treasurer',permissions:['treasury.prepare']});workspace.open=record=>{workspace.record=record};workspace.api=async(path,init)=>{apiCalls.push(path);assert.equal(init.method,'POST');return{report:{id:'blank'}}};await workspace.run('new-draft',{disabled:false,isConnected:false});assert.equal(workspace.record.id,'blank');assert.equal(apiCalls.at(-1),'/api/treasury/drafts');
console.log('PASS: per-person and pending-invitation access saves, owner controls fixed, final treasury PDF-only view, preparation does not imply upload.');
