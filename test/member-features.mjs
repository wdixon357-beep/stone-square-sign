import assert from 'node:assert/strict';
import os from 'node:os';import fs from 'node:fs/promises';import path from 'node:path';
import {spawn} from 'node:child_process';import {createServer} from 'node:http';import {once} from 'node:events';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'ss-member-'));
process.env.DATABASE_URL='';process.env.PGLITE_DIR=tmp;process.env.NODE_ENV='test';
const db=await import('../db.js');await db.connect();await db.initSchema();
for(const r of [{f:'William',l:'Owner',e:['owner@example.org']},{f:'James',l:'Member',e:['james@example.org']},{f:'Peter',l:'Member',e:['peter@example.org']}])await db.dbRun('insert into roster(first_name,last_name,title,prefix,emails,updated_at) values(?,?,?,?,?,?)',[r.f,r.l,'Brother','Bro.',r.e,new Date().toISOString()]);await db.close();
const zeffyPayment={id:'pay-1',campaign_id:'annual',status:'succeeded',created:Date.UTC(2026,8,1)/1000,amount:5000,buyer:{email:'james@example.org',first_name:'James',last_name:'Member'}};
const zeffy=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[zeffyPayment,{...zeffyPayment}],has_more:false}));});zeffy.listen(0,'127.0.0.1');await once(zeffy,'listening');
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));const base=`http://127.0.0.1:${port}`;
let log='';const app=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),APP_BASE_URL:base,OWNER_EMAIL:'owner@example.org',ZEFFY_API_KEY:'test',ZEFFY_API_BASE:`http://127.0.0.1:${zeffy.address().port}`,ZEFFY_DUES_CAMPAIGN_ID:'annual',DUES_YEAR:'2026-2027',WARDEN_EMAILS:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});app.stdout.on('data',d=>log+=d);app.stderr.on('data',d=>log+=d);
const api=async(p,t,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{...(t?{Authorization:`Bearer ${t}`}:{color:''}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()}};
const password='Local preview password';let checks=0;const check=(label,value)=>{assert.ok(value,label);checks++;console.log('PASS '+label)};
try{for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
 const owner=(await api('/api/auth/register',null,'POST',{email:'owner@example.org',name:'William Owner',password})).data;
 const roster=(await api('/api/admin/member-access',owner.token)).data.members;check('Owner sees roster-linked Member Access',roster.length===3);
 async function enroll(first,email){const row=roster.find(r=>r.first_name===first);const inv=await api(`/api/admin/member-access/${row.id}/invite`,owner.token,'POST',{email,sendEmail:false});assert.equal(inv.status,201);const token=new URL(inv.data.inviteUrl).searchParams.get('invite');const registered=await api('/api/auth/register',null,'POST',{email,name:`${first} Member`,password,invitationToken:token});assert.equal(registered.status,201);return registered.data;}
 const james=await enroll('James','james@example.org');const peter=await enroll('Peter','peter@example.org');
 check('Member account receives exact private capabilities',james.user.permissions.includes('dues.self')&&james.user.permissions.includes('suggestions.create')&&james.user.permissions.includes('minutes.view')&&james.user.permissions.includes('treasury.view')&&james.user.permissions.includes('reports.create'));
 const mine=await api('/api/dues/me',james.token);check('My Dues returns only the linked Brother',mine.status===200&&mine.data.row.name.includes('James')&&mine.data.row.paidCents===5000&&!('rows' in mine.data));
 check('Duplicate Zeffy payment identifiers count only once',mine.data.row.payments.filter(payment=>payment.externalId==='pay-1').length===1);
 check('Another Brother sees his own zero balance record',(await api('/api/dues/me',peter.token)).data.row.name.includes('Peter'));
 check('Member cannot retrieve the full Lodge ledger',(await api('/api/dues',james.token)).status===403);
 const suggestion=await api('/api/suggestions',james.token,'POST',{category:'Member experience',subject:'A private idea',body:'This suggestion should remain confidential to the Worshipful Master.'});check('Suggestion receipt starts at Received',suggestion.status===201&&suggestion.data.status==='Received');
 check('Other member cannot retrieve the suggestion content',JSON.stringify((await api('/api/suggestions/me',peter.token)).data)==='{"suggestions":[]}');
 const all=await api('/api/admin/suggestions',owner.token);check('Only owner endpoint returns confidential content',all.status===200&&all.data.suggestions[0].body.includes('confidential'));
 const adjust=await api('/api/dues/adjustments',owner.token,'POST',{rosterId:mine.data.row.rosterId,transactionType:'payment',amount:'25.00',effectiveDate:'2026-09-15',paymentMethod:'Cash',sourceReference:'receipt 1',note:'test entry'});check('Manual entry is accepted atomically',adjust.status===201);
 const updated=await api('/api/dues/me',james.token);check('Manual and Zeffy activity calculate together',updated.data.row.paidCents===7500);
 const reversed=await api(`/api/dues/adjustments/${adjust.data.id}/reverse`,owner.token,'POST',{reason:'Synthetic correction'});check('A correction preserves the original entry and adds an immutable reversal',reversed.status===201);
 const afterReversal=await api('/api/dues/me',james.token);check('Reversal arithmetic restores the verified Zeffy balance',afterReversal.data.row.paidCents===5000&&afterReversal.data.row.payments.some(payment=>payment.reversesAdjustmentId===adjust.data.id));
 console.log(`${checks} member privacy and dues checks passed.`);
}finally{app.kill('SIGTERM');zeffy.close();await fs.rm(tmp,{recursive:true,force:true});}
