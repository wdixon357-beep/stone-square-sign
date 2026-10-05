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
const duesRoot=new Element(),duesCalls=[];
await renderAccessControls(duesRoot,async(path,init)=>{
  if(init){duesCalls.push(JSON.parse(init.body));return{ok:true};}
  return{capabilities:[{id:'dues.ledger',label:'View full dues ledger'},{id:'dues.manage',label:'Record non-Zeffy dues activity'}],accounts:[
    {key:'user:4',name:'Warden',email:'warden@example.test',role:'warden',permissions:['dues.ledger','dues.manage']},
    {key:'user:5',name:'Treasurer',email:'treasurer@example.test',role:'treasurer',permissions:['dues.ledger','dues.manage']},
  ]};
});
const duesPanels=duesRoot.children.filter(el=>el.tag==='details');
const wardenDues=duesPanels[0].children.find(el=>el.tag==='fieldset').querySelectorAll('input').find(input=>input.value==='dues.manage');
const treasurerDues=duesPanels[1].children.find(el=>el.tag==='fieldset').querySelectorAll('input').find(input=>input.value==='dues.manage');
assert.equal(wardenDues.disabled,true,'unrelated offices cannot grant or keep dues correction in the access control');
assert.equal(wardenDues.checked,false);
assert.equal(treasurerDues.disabled,undefined,'Treasurer correction access remains editable');
assert.equal(treasurerDues.checked,true);
await duesPanels[0].children.find(el=>el.tag==='button').events.click();
assert.deepEqual(duesCalls.at(-1).permissions,['dues.ledger'],'saving Warden access must exclude an invalid dues correction grant');
const treasury=fs.readFileSync(new URL('../public/treasury.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export class TreasuryWorkspace','class TreasuryWorkspace');
const apiCalls=[], ui={querySelector:()=>({})};
const ctx={clearTimeout,document:{getElementById:()=>ui},URL:{createObjectURL:()=> 'blob:local',revokeObjectURL(){}},MinutesPreview:class{async show(){}},structuredClone,Uint8Array};
vm.createContext(ctx);vm.runInContext(treasury+'\nglobalThis.TreasuryWorkspace=TreasuryWorkspace;',ctx);
const workspace=Object.create(ctx.TreasuryWorkspace.prototype);workspace.root=ui;workspace.api=async(path)=>{apiCalls.push(path);return{arrayBuffer:async()=>new ArrayBuffer(0)}};workspace.user=()=>({role:'officer',permissions:['treasury.view']});
const signedTreasury={id:'final-1',status:'ready_for_distribution',draft:{periodStart:'2026-08-21',periodEnd:'2026-09-01',accounts:[{id:'checking',name:'Checking'},{id:'savings',name:'Prime Share'}],transactions:[{date:'2026-08-22',postedDateConfirmed:true,account:'checking',kind:'receipt',description:'Dues deposit',amount:'175.00',reference:'DEP-12'},{date:'2026-08-23',postedDateConfirmed:true,account:'checking',kind:'payment',description:'Facility payment',amount:'20.00',reference:''},{date:'2026-08-24',postedDateConfirmed:true,account:'savings',kind:'transfer_in',description:'Transfer <script>alert(1)</script>',amount:'30.00',reference:'TR-4'}]}};
assert.equal(workspace.can('treasury.prepare'),false);await workspace.openFinal(signedTreasury);
assert.deepEqual(apiCalls,['/api/treasury/final-1/pdf']);assert.doesNotMatch(ui.innerHTML,/source-file|Save corrections|data-path/);
for(const text of ['Transactions included in this report','Dues deposit','Facility payment','Prime Share','Transfer in','Aug 22, 2026','Aug 23, 2026','$175.00','-$20.00','Reference: DEP-12'])assert.ok(ui.innerHTML.includes(text),`signed report shows ${text}`);
assert.ok(ui.innerHTML.includes('Transfer &lt;script&gt;alert(1)&lt;/script&gt;'),'bank-supplied descriptions must be escaped');
assert.doesNotMatch(ui.innerHTML,/<script>alert\(1\)<\/script>/);
assert.ok(ui.innerHTML.indexOf('Transactions included in this report')<ui.innerHTML.indexOf('treasuryFinalPreview'),'signed report shows itemized activity before its PDF');
await workspace.openFinal({id:'final-empty',status:'distributed',draft:{periodStart:'2026-08-21',periodEnd:'2026-09-01',transactions:[]}});
assert.match(ui.innerHTML,/No confirmed bank-posted transactions are included for this report period/,'an empty signed report does not imply zero-dollar activity');
const beforePending=apiCalls.length;await workspace.openFinal({id:'pending',status:'awaiting_preparer'});assert.equal(apiCalls.length,beforePending);assert.equal(workspace.canOpenFinal({status:'draft'}),false);assert.equal(workspace.canOpenFinal({status:'distributed'}),true);
const listElements={};workspace.previewView=null;workspace.root={querySelector:id=>listElements[id]||(listElements[id]={})};workspace.api=async(path)=>path==='/api/archives/treasury'?{records:[{id:'old-1',title:'Treasurer Report, January 1, 2024'}]}:{reports:[{id:'pending',status:'awaiting_preparer',draft:{}},{id:'finished',status:'ready_for_distribution',draft:{}}]};await workspace.list();assert.doesNotMatch(listElements['#treasuryList'].innerHTML,/data-id="pending"/);assert.match(listElements['#treasuryList'].innerHTML,/data-id="finished">View PDF/);assert.match(listElements['#treasuryList'].innerHTML,/Historical treasurer reports/);assert.match(listElements['#treasuryList'].innerHTML,/data-treasury="archive-open"/);
workspace.user=()=>({role:'assistant_treasurer',permissions:['treasury.prepare']});assert.equal(workspace.can('treasury.upload'),false);assert.equal(workspace.can('treasury.prepare'),true);
workspace.user=()=>({role:'officer',permissions:['treasury.view']});workspace.api=async(path)=>{apiCalls.push(path);return{arrayBuffer:async()=>new ArrayBuffer(0)}};await workspace.openArchive({id:'old-1',title:'Treasurer Report, January 1, 2024'});assert.match(workspace.root.innerHTML,/All reports/);assert.doesNotMatch(workspace.root.innerHTML,/target="_blank"/);let returned=false;workspace.list=async()=>{returned=true};workspace.dirty=false;workspace.busy=false;await workspace.run('back',{disabled:false,isConnected:false});assert.equal(returned,true);
workspace.user=()=>({role:'assistant_treasurer',permissions:['treasury.prepare']});workspace.open=record=>{workspace.record=record};workspace.api=async(path,init)=>{apiCalls.push(path);assert.equal(init.method,'POST');return{report:{id:'blank'}}};await workspace.run('new-draft',{disabled:false,isConnected:false});assert.equal(workspace.record.id,'blank');assert.equal(apiCalls.at(-1),'/api/treasury/drafts');
console.log('PASS: per-person access, finalized treasury transaction ledger and PDF view, preparation does not imply upload.');
