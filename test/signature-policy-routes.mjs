import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { connect, close, initSchema, dbGet, dbAll, dbRun } from '../db.js';
import { pinApprovedOwnerSignature } from '../signature-policy.js';
import { initTreasurySchema, mountTreasuryRoutes } from '../treasury-routes.js';
import { initializeBuildingCalendar, mountBuildingCalendar } from '../building-calendar.js';
import { treasuryReportingWindow } from '../treasury-period.js';
import { completeTreasuryFixture } from './treasury.mjs';

assert.equal(process.env.DATABASE_URL || '', '', 'Use only an isolated in-memory database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Do not use an existing local database.');
await connect();
let listener;
const approved = Buffer.from((await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim(), 'base64');
const different = Buffer.concat([approved, Buffer.from('synthetic different image bytes')]);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const time = new Date().toISOString();
const note = 'The owner explicitly authorized this independently inspected saved signature image.';
const remoteCalls = [], emails = [];
let releaseApproval, approvalStarted;
const startedApproval = new Promise(resolve => {approvalStarted = resolve;});
const heldApproval = new Promise(resolve => {releaseApproval = resolve;});
async function user(name, role) {
  const {lastID} = await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
    [`${name}@example.test`, 'unused', name, role, time]);
  await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,?,?)',
    [lastID, approved, 'drawn', time]);
  return {id:lastID,role};
}
const pin = account => pinApprovedOwnerSignature({ownerUserId:account.id,expectedProfileSha256:sha(approved),authorizationNote:note});
async function report(id, account, end, priorEnds = []) {
  const draft=structuredClone(completeTreasuryFixture);
  Object.assign(draft,treasuryReportingWindow(end,priorEnds));
  draft.transactions.forEach(row=>row.date=draft.periodStart);
  await dbRun(`INSERT INTO treasury_reports(id,draft_json,source_text,status,created_by_user_id,preparer_name,preparer_role,
    created_at,updated_at,preparer_user_id,uploader_name) VALUES (?,?,?,'draft',?,?,?,?,?,?,?)`,
  [id,JSON.stringify(draft),'Synthetic uploaded banking source.',account.id,'Synthetic preparer',account.role,time,time,account.id,'Synthetic uploader']);
  return dbGet('SELECT * FROM treasury_reports WHERE id=?',[id]);
}

try {
  await initSchema();await initTreasurySchema();await initializeBuildingCalendar();
  assert.equal((await dbGet('SELECT COUNT(*) AS total FROM owner_signature_policies')).total,0,'Explicit route schema initialization never pins a signature.');
  const owner=await user('approved-owner','owner'),secretary=await user('secretary','secretary'),warden=await user('warden','warden'),racingOwner=await user('racing-owner','owner');
  await dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify(['building.view','building.decide']),warden.id]);
  await pin(owner);
  const app=express();app.use(express.json());
  const requireAuth=async(req,res,next)=>{
    try {req.user=await dbGet('SELECT * FROM users WHERE id=?',[Number(req.get('x-test-user'))]);
      if(!req.user)return res.status(401).json({error:'Synthetic sign-in required.'});
      req.authRawToken='synthetic-test-token';next();
    }catch(error){next(error);}
  };
  mountTreasuryRoutes(app,{requireAuth,rateLimit:()=> (_req,_res,next)=>next(),sendEmail:async message=>{emails.push(message);return false;},baseUrl:()=> 'http://synthetic.invalid',broadcast:()=>{},generationFor:()=>{throw Error('No provider calls allowed.');}});
  mountBuildingCalendar(app,{requireAuth,sendBuildingEmail:async message=>{emails.push(message);return false;},fetcher:async(url,init)=>{
    assert.equal(new URL(url).origin,'https://request.stonesquare22pha.org');
    assert.ok(url.includes('decide='),'Only the synthetic decision endpoint is expected.');
    const body=JSON.parse(init.body);remoteCalls.push({url,body});
    if(url.includes('pending-pin')){approvalStarted();await heldApproval;}
    return Response.json({ok:true,request:{id:new URL(url).searchParams.get('decide'),status:body.decision,revision:'next'}});
  }});
  app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({error:error.message,code:error.code}));
  listener=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  const origin=`http://127.0.0.1:${listener.address().port}`;
  async function api(path,account,body){const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','x-test-user':String(account.id)},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
  const treasury=await report('owner-report',owner,'2026-10-19');
  await dbRun('UPDATE profile_signatures SET signature_bytes=? WHERE user_id=?',[different,owner.id]);
  const rejectedTreasury=await api('/api/treasury/owner-report/preparer-attest',owner,{revision:treasury.revision});
  assert.equal(rejectedTreasury.status,409);assert.equal(rejectedTreasury.data.code,'APPROVED_SIGNATURE_REQUIRED');
  assert.deepEqual(await dbGet('SELECT * FROM treasury_reports WHERE id=?',[treasury.id]),treasury);
  assert.equal((await dbGet('SELECT COUNT(*) AS total FROM treasury_attestations WHERE report_id=?',[treasury.id])).total,0);
  assert.equal((await dbGet("SELECT COUNT(*) AS total FROM audit_events WHERE action='treasury_preparer_attested'")).total,0);
  assert.equal(emails.length,0,'A rejected signature never generates a completion notification.');
  const rejectedBuilding=await api('/api/building/requests/owner-approval/decision',owner,{decision:'approved',revision:'original'});
  assert.equal(rejectedBuilding.status,409);assert.equal(rejectedBuilding.data.code,'APPROVED_SIGNATURE_REQUIRED');
  assert.equal(remoteCalls.length,0,'An inconsistent pinned signature never reaches the building service.');
  assert.equal((await dbGet("SELECT COUNT(*) AS total FROM audit_events WHERE action='building_request_decided'")).total,0);

  const declined=await api('/api/building/requests/owner-decline/decision',owner,{decision:'denied',note:'Synthetic decline.',revision:'original'});
  assert.equal(declined.status,200);assert.equal(remoteCalls.at(-1).body.signatureData,null,'A decline remains available without applying a signature.');
  await dbRun('UPDATE profile_signatures SET signature_bytes=? WHERE user_id=?',[approved,owner.id]);
  const acceptedTreasury=await api('/api/treasury/owner-report/preparer-attest',owner,{revision:treasury.revision});
  assert.equal(acceptedTreasury.status,200,JSON.stringify(acceptedTreasury.data));
  const attestation=await dbGet('SELECT signature_bytes FROM treasury_attestations WHERE report_id=?',[treasury.id]);
  assert.deepEqual(Buffer.from(attestation.signature_bytes),approved);
  const acceptedBuilding=await api('/api/building/requests/owner-approval/decision',owner,{decision:'approved',revision:'original'});
  assert.equal(acceptedBuilding.status,200);assert.equal(remoteCalls.at(-1).body.signatureData,'data:image/png;base64,'+approved.toString('base64'));
  await dbRun('UPDATE profile_signatures SET signature_bytes=? WHERE user_id=?',[different,secretary.id]);
  const secretaryReport=await report('secretary-report',secretary,'2026-10-20',['2026-10-19']);
  const secretarySignature=await api('/api/treasury/secretary-report/preparer-attest',secretary,{revision:secretaryReport.revision});
  assert.equal(secretarySignature.status,200,JSON.stringify(secretarySignature.data));
  assert.deepEqual(Buffer.from((await dbGet('SELECT signature_bytes FROM treasury_attestations WHERE report_id=?',[secretaryReport.id])).signature_bytes),different,'The Secretary retains his own independent signature.');
  await dbRun('UPDATE profile_signatures SET signature_bytes=? WHERE user_id=?',[different,warden.id]);
  const wardenApproval=await api('/api/building/requests/warden-approval/decision',warden,{decision:'approved',revision:'original'});
  assert.equal(wardenApproval.status,200);assert.equal(remoteCalls.at(-1).body.signatureData,'data:image/png;base64,'+different.toString('base64'));

  const pendingApproval=api('/api/building/requests/pending-pin/decision',racingOwner,{decision:'approved',revision:'original'});
  await startedApproval;
  let pinFinished=false;
  const pendingPin=pin(racingOwner).then(result=>{pinFinished=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(pinFinished,false,'An in-flight signed portal mutation retains the user lock until it completes.');
  releaseApproval();
  assert.equal((await pendingApproval).status,200);assert.equal((await pendingPin).locked,true);
  assert.equal((await dbAll("SELECT * FROM audit_events WHERE action='building_request_decided'")).length,4);
  console.log('PASS: route-level approved signature enforcement for Treasury and Building, rejection before mutations/notifications, unchanged decline and other-officer behavior, and pin ordering during a pending approval.');
} finally {
  releaseApproval();
  if(listener)await new Promise(resolve=>listener.close(resolve));
  await close();
}
