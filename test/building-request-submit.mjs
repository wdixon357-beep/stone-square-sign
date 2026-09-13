import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
process.env.DATABASE_URL='';process.env.PGLITE_DIR='';process.env.NODE_ENV='test';
const {connect,close,initSchema,dbRun,dbGet}=await import('../db.js');
const {initializeBuildingCalendar,mountBuildingCalendar,buildingSubmission}=await import('../building-calendar.js');
let listener,checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name)};
const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const valid={submissionId:crypto.randomUUID(),organization:'Stone Square Lodge No. 22',purpose:'Synthetic meeting request',spaces:['Lodge building'],bookings:[{date:future(30),start:'10:00',end:'12:00'}]};
await connect();
try{
 await initSchema();await initializeBuildingCalendar();
 async function makeUser(label,role,permissions){return(await dbRun('INSERT INTO users(email,password_hash,name,role,created_at,permissions_json) VALUES(?,?,?,?,?,?)',[label+'@example.invalid','unused',label,role,new Date().toISOString(),JSON.stringify(permissions)])).lastID}
 const owner=await makeUser('submit-owner','owner',[]),requester=await makeUser('submit-requester','officer',['building.request']),viewer=await makeUser('submit-viewer','officer',['building.view']),second=await makeUser('submit-second','officer',['building.request']);
 let busy=[],warning='',sourceFailure=false,portalStatus=200;const calls=[];const submissions=[];const keys=new Map();const fingerprints=new Map();
 const app=express();app.use(express.json());mountBuildingCalendar(app,{requireAuth:async(req,res,next)=>{req.user=await dbGet('SELECT * FROM users WHERE id=?',[Number(req.get('x-test-user'))||-1]);if(!req.user)return res.status(401).json({error:'Sign in'});next()},fetcher:async(url,init={})=>{
  calls.push({url,init});assert.equal(new URL(url).origin,'https://request.stonesquare22pha.org');
  if(url.includes('/api/calendar')){if(sourceFailure)throw Error('Synthetic source unavailable');return Response.json({busy,warning})}
  if(url.includes('?submission=')){const params=new URL(url).searchParams;const key=params.get('submission');if(keys.has(key)&&params.get('fingerprint')!==fingerprints.get(key))return Response.json({error:'Changed request details'},{status:409});return Response.json(keys.has(key)?{ok:true,ref:keys.get(key),refs:[keys.get(key)],wmNotified:true}:{ok:false,refs:[]})}
  assert.equal(init.method,'POST');const body=JSON.parse(init.body);submissions.push(body);if(portalStatus!==200)return Response.json({error:'Synthetic portal conflict'},{status:portalStatus});
  if(!keys.has(body.clientSubmissionKey)){keys.set(body.clientSubmissionKey,'SSL-TEST-'+keys.size);fingerprints.set(body.clientSubmissionKey,crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'))}
  return Response.json({ok:true,ref:keys.get(body.clientSubmissionKey),refs:[keys.get(body.clientSubmissionKey)],wmNotified:true});
 }});app.use((error,req,res,next)=>res.status(error.statusCode||500).json({error:error.message}));
 listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));const origin=`http://127.0.0.1:${listener.address().port}`;
 async function api(path,id,method='GET',body){const r=await fetch(origin+path,{method,headers:{...(id?{'x-test-user':String(id),Authorization:'Bearer synthetic-session'}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()}}
 const path='/api/building/requests',availability=`/api/building/availability?from=${future(29)}&to=${future(32)}`;
 for(const [p,m,b] of [[path,'POST',valid],[availability,'GET',undefined]]){check('Anonymous denied '+m,(await api(p,undefined,m,b)).status===401);check('View permission does not grant submission '+m,(await api(p,viewer,m,b)).status===403)}
 check('No unauthorized requests reach portal',calls.length===0);
 check('Requester can inspect availability',(await api(availability,requester)).status===200);
 check('Oversized availability range rejected',(await api(`/api/building/availability?from=${future(1)}&to=${future(400)}`,requester)).status===400);
 for(const body of [{...valid,submissionId:'bad'},{...valid,purpose:''},{...valid,spaces:[]},{...valid,spaces:['Unknown room']},{...valid,bookings:[null]},{...valid,bookings:[valid.bookings[0],valid.bookings[0]]},{...valid,bookings:[]},{...valid,bookings:Array.from({length:13},(_,i)=>({date:future(i+1),start:'10:00',end:'12:00'}))},{...valid,bookings:[{date:'2026-02-30',start:'10:00',end:'12:00'}]},{...valid,bookings:[{date:'2000-01-01',start:'10:00',end:'12:00'}]},{...valid,bookings:[{date:future(30),start:'25:00',end:'26:00'}]},{...valid,bookings:[{date:future(30),start:'12:00',end:'10:00'}]}])check('Invalid submission rejected',(await api(path,requester,'POST',body)).status===400);
 let r=await api(path,requester,'POST',{...valid,org:'Forged organization',name:'Forged Name',contact:'forged@example.invalid',email:'forged@example.invalid',status:'approved',decidedBy:'WM',agreement:{signature:'FORGED'}});check('Valid request submitted',r.status>=200&&r.status<300&&r.data.ok);
 const submitted=submissions.at(-1);check('Identity bound to signed-in account',submitted.name==='submit-requester'&&submitted.contact==='submit-requester@example.invalid');check('Organization bound to Lodge',submitted.org==='Stone Square Lodge No. 22');check('Cannot inject decision or agreement',!('status'in submitted)&&!('decidedBy'in submitted)&&!('agreement'in submitted));
 const firstKey=submitted.clientSubmissionKey;check('Opaque idempotency key',/^[a-f0-9]{64}$/.test(firstKey));
 const submittedCount=submissions.length;busy=[{date:future(30),start:'10:00',end:'12:00',status:'pending'}];const retry=await api(path,requester,'POST',valid);check('Retry reuses same reference despite own pending hold',retry.status===200&&retry.data.ref===r.data.ref);check('Retry does not submit or notify again',submissions.length===submittedCount);busy=[];check('Changed retry cannot silently reuse old details',(await api(path,requester,'POST',{...valid,purpose:'Changed details'})).status===409);
 await api(path,second,'POST',valid);check('Same client UUID cannot collide across accounts',submissions.at(-1).clientSubmissionKey!==firstKey);
 busy=[{date:future(30),start:'11:00',end:'13:00',spaces:['Lodge building'],status:'approved',label:'Synthetic booking'}];let before=submissions.length;
 check('Known overlap rejected',(await api(path,requester,'POST',{...valid,submissionId:crypto.randomUUID()})).status===409);check('Overlap never forwarded',submissions.length===before);
 busy=[{date:future(30),start:'',end:'',allDay:false,status:'approved'}];check('Unknown times need acknowledgement',(await api(path,requester,'POST',{...valid,submissionId:crypto.randomUUID()})).status===400);check('Acknowledged unknown times remain requests',(await api(path,requester,'POST',{...valid,submissionId:crypto.randomUUID(),acknowledgeAvailabilityWarning:true})).status===201);
 busy=[];warning='Availability source incomplete';check('Warning requires explicit acknowledgement',(await api(path,requester,'POST',{...valid,submissionId:crypto.randomUUID()})).status===400);
 check('Truthy text is not explicit acknowledgement',(await api(path,requester,'POST',{...valid,submissionId:crypto.randomUUID(),acknowledgeAvailabilityWarning:'false'})).status===400);
 check('Acknowledged warning can submit',(await api(path,requester,'POST',{...valid,submissionId:crypto.randomUUID(),acknowledgeAvailabilityWarning:true})).data.ok);
 sourceFailure=true;const unavailable=await api(availability,requester);check('Unavailable availability is explicitly marked',unavailable.status===200&&Boolean(unavailable.data.warning));sourceFailure=false;warning='';
 await dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify(['building.view']),second]);check('Revoked submission access applies immediately',(await api(path,second,'POST',{...valid,submissionId:crypto.randomUUID()})).status===403);
 portalStatus=409;check('Portal conflict propagates',(await api(path,owner,'POST',{...valid,submissionId:crypto.randomUUID()})).status===409);
 console.log(`PASS ${checks} isolated building submission checks; no live writes or notifications.`);
}finally{if(listener)await new Promise(resolve=>listener.close(resolve));await close()}
