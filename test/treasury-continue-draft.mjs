import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { calculateTreasury } from '../treasury.js';

const incomplete = {
  periodStart:'2026-09-01', periodEnd:'2026-09-30',
  accounts:[{id:'checking',name:'Checking',openingBalance:'120.00',bookBalance:'125.00'}],
  transactions:[{id:'row',description:'Test transaction',amount:'-5.00'}],
  funds:[{amount:'2.00'}], obligations:[{name:'Invoice'}],
};
const calculated = calculateTreasury(incomplete,{includeContinueIssues:true});
const {continueIssues, ...legacyCalculation} = calculated;
assert.deepEqual(legacyCalculation,calculateTreasury(incomplete),'navigation does not change the canonical signing checks');
const targets = new Set(continueIssues.map(issue=>issue.target));
for(const target of ['sourceReviewed','fundsReviewed','obligationsReviewed','accounts.0.activityComplete','accounts.0.statementBalance','accounts.0.depositsInTransit','confirm:accounts.0.bookBalance','transactions.0.account','transactions.0.kind','transactions.0.amount','transactions.0.date','transactions.0.postedDateConfirmed','funds.0.account','obligations.0.amount']){
  assert.ok(targets.has(target),`missing target ${target}`);
}
assert.equal(targets.has('accounts.0.bookBalance'),false,'an entered balance requires confirmation instead of another input');
assert.ok(!JSON.stringify(continueIssues).includes('125.00'),'guidance names the field without disclosing balances');

const source = await readFile(new URL('../public/treasury.js',import.meta.url),'utf8');
const Workspace = vm.runInNewContext(source.replace(/^import .*$/gm,'').replace('export class','class')+'\nTreasuryWorkspace',{CSS:{escape:String}});
const focus = [], notices = [], opened = [], workspace = Object.create(Workspace.prototype);
const focused = target => ({focus:()=>focus.push(target)});
const report = {id:'draft',status:'draft',preparerUserId:2,revision:1,draft:{transactions:[{}]},continueIssues};
Object.assign(workspace,{
  workspaceUserId:2,
  user:()=>({id:2,role:'treasurer',permissions:['treasury.prepare']}),
  record:report,
  draft:structuredClone(report.draft),
  dirty:true,
  open:record=>{opened.push(record.id);workspace.record=record;workspace.draft=record.draft;},
  message:label=>notices.push(label),
  showEditorTab:tab=>{workspace.editorTab=tab;},
  root:{querySelector:selector=>selector.includes('transactions.0.date')?focused(selector):selector.includes('postedDateConfirmed')?focused(selector):selector.startsWith('button[data-path=')?focused(selector):selector.includes('data-treasury-tab')?focused(selector):null},
});
const openDraft = workspace.draft;
assert.ok(workspace.continueDraft(report,'transactions.0.date'));
assert.strictEqual(workspace.draft,openDraft);
assert.equal(workspace.editorTab,'transactions');
assert.match(focus.at(-1),/input\[data-path="transactions\.0\.date"/);
assert.ok(workspace.continueDraft(report,'confirm:accounts.0.bookBalance'));
assert.equal(workspace.editorTab,'accounts');
assert.equal(focus.at(-1),'button[data-path="accounts.0.bookBalance"]');
assert.equal(workspace.continueDraft({...report,id:'other'}),false);
assert.match(notices.at(-1),/Save the open report/);
assert.equal(opened.length,0);
assert.equal(workspace.continueDraft({...report,preparerUserId:5}),false);
assert.equal(workspace.continueDraft({...report,status:'ready_for_distribution'}),false);
workspace.draft.transactions.push({});
workspace.continueDraft(report,'transactions.0.date');
assert.equal(focus.at(-1),'[data-treasury-tab="transactions"]','unsaved row changes preserve the worksheet and avoid a stale saved-row link');
workspace.draft.transactions.pop();
workspace.changedRowCollections = new Set(['transactions']);
workspace.continueDraft(report,'transactions.0.date');
assert.equal(focus.at(-1),'[data-treasury-tab="transactions"]','replacing a row can change its identity without changing the row count');
const oldFocusCount = focus.length;
assert.ok(workspace.continueDraft({...report,revision:2},'transactions.0.date'));
assert.equal(workspace.editorTab,'review');
assert.equal(focus.length,oldFocusCount,'a newer saved revision cannot focus an older positional row');
assert.strictEqual(workspace.draft,openDraft);
assert.match(notices.at(-1),/newer saved revision/);

const base = 'http://127.0.0.1:3557';
const ownerEmail = 'continue-owner@example.org';
const password = 'Synthetic treasury test password';
const server = spawn(process.execPath,['server.js'],{
  env:{...process.env,PORT:'3557',NODE_ENV:'test',DATABASE_URL:'',PGLITE_DIR:'',OPENAI_API_KEY:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',LODGE_ACCESS_CODE:'',OWNER_EMAIL:ownerEmail,APP_BASE_URL:base},
  stdio:'ignore',
});
async function api(path, token, method='GET', body) {
  const form=body instanceof FormData;
  const result=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(!form&&body?{'Content-Type':'application/json'}:{})},body:form?body:body&&JSON.stringify(body)});
  return {status:result.status,data:await result.json()};
}
try {
  for(let i=0;i<100;i++){
    try{if((await fetch(base+'/api/health')).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const {data:owner} = await api('/api/auth/register',null,'POST',{email:ownerEmail,name:'Synthetic Owner',password});
  async function invite(role) {
    const email=`continue-${role}@example.org`, name=`Synthetic ${role}`;
    const {data} = await api('/api/officers/invite',owner.token,'POST',{email,name,role});
    const created = await api('/api/auth/register',null,'POST',{email,name,password,invitationToken:new URL(data.inviteUrl).searchParams.get('invite')});
    assert.equal(created.status,201);
    return created.data;
  }
  const treasurer=await invite('treasurer'), viewer=await invite('viewer');
  const access=await api('/api/admin/access',owner.token,'PUT',{key:`user:${viewer.user.id}`,permissions:['treasury.view']});
  assert.equal(access.status,200);
  const own=(await api('/api/treasury/drafts',treasurer.token,'POST')).data.report;
  const other=(await api('/api/treasury/drafts',owner.token,'POST')).data.report;
  assert.ok(own.continueIssues.length>0);
  const handoff=new FormData();
  handoff.set('intent','save');
  handoff.set('sourceText','Checking\nOpening balance is $10.00. This banking note is used for a private handoff test.');
  const waiting=(await api('/api/treasury/generate',owner.token,'POST',handoff)).data.report;
  assert.equal(waiting.status,'awaiting_preparer');
  assert.equal(waiting.continueIssues,undefined);
  const list=token=>api('/api/treasury?drafts=1',token);
  assert.equal((await list(null)).status,401);
  assert.deepEqual((await list(viewer.token)).data.reports,[]);
  assert.deepEqual((await list(treasurer.token)).data.reports.map(item=>item.id),[own.id]);
  assert.deepEqual((await list(owner.token)).data.reports.map(item=>item.id),[other.id]);
  const general=(await api('/api/treasury',owner.token)).data.reports;
  assert.equal(general.find(item=>item.id===own.id).continueIssues,undefined,'owner oversight does not make another preparer’s draft a personal action');
  const cleanAccount={id:'checking',name:'Checking',activityComplete:true,openingBalance:'0.00',statementBalance:'0.00',bookBalance:'0.00',depositsInTransit:'0.00',outstandingChecks:'0.00'};
  const saved=await api(`/api/treasury/${own.id}`,treasurer.token,'PUT',{revision:own.revision,draft:{
    ...own.draft, accounts:[cleanAccount,{...cleanAccount,id:'savings',name:'Savings'}], sourceReviewed:true, fundsReviewed:true, obligationsReviewed:true,
    fieldReviews:Object.fromEntries([0,1].flatMap(index=>Object.keys(cleanAccount).filter(key=>!['id','name','activityComplete'].includes(key)).map(key=>[`accounts.${index}.${key}`,'confirmed']))),
  }});
  assert.equal(saved.status,200);
  assert.equal(saved.data.report.calculation.ready,true,saved.data.report.calculation.issues.join(" "));
  assert.deepEqual(saved.data.report.continueIssues,[]);
  const signature=(await readFile(new URL('./signature.b64',import.meta.url),'utf8')).trim();
  const profile=await api('/api/profile/signature',treasurer.token,'PUT',{signatureData:`data:image/png;base64,${signature}`,signatureType:'drawn'});
  assert.equal(profile.status,200);
  const final=await api(`/api/treasury/${own.id}/preparer-attest`,treasurer.token,'POST',{revision:saved.data.report.revision});
  assert.equal(final.status,200);
  assert.equal(final.data.report.continueIssues,undefined);
  assert.deepEqual((await list(treasurer.token)).data.reports,[]);
} finally {
  server.kill('SIGTERM');
}
console.log('PASS: Treasury Continue Draft exact signing checks, field focus, draft preservation, and personal queue access.');
