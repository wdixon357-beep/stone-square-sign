import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';

process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
const { connect, close, initSchema, dbRun, dbGet, dbAll } = await import('../db.js');
const { initializeBuildingCalendar, mountBuildingCalendar } = await import('../building-calendar.js');
const { buildingStoreHash, executeBuildingStoreOperation, initBuildingStoreSchema } = await import('../building-store.js');
const { readAssistantBuildingArchive } = await import('../assistant-building.js');

await connect();
let listener;
try {
  await initSchema();
  await initializeBuildingCalendar();
  const addUser = async (name, role) => (await dbRun(
    'INSERT INTO users(email,password_hash,name,role,created_at,permissions_json) VALUES(?,?,?,?,?,?)',
    [`${role}@example.org`, 'unused-test-hash', name, role, new Date().toISOString(), JSON.stringify(['building.view','building.decide'])],
  )).lastID;
  const owner = await addUser('Synthetic Master', 'owner');
  const secretary = await addUser('William M. McDuffie', 'secretary');
  const assistant = await addUser('Adrian Reese', 'assistant_secretary');
  for (const id of [secretary, assistant]) await dbRun(
    'INSERT INTO profile_signatures (user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,?,?)',
    [id, Buffer.from('synthetic-signature'), 'drawn', new Date().toISOString()],
  );
  const old = { id:'SSL-OLD', organization:'Synthetic chapter', date:'2026-10-09', status:'approved', revision:'v1', agreementStatus:'awaiting_secretary_attestation', attestationRoles:['secretary'], requesterNotified:false, attestedBy:null };
  const flexible = { id:'SSL-EITHER', organization:'Synthetic chapter', date:'2026-10-16', status:'approved', revision:'f1', agreementStatus:'awaiting_secretary_attestation', attestationRoles:['secretary','assistant_secretary'], requesterNotified:false, attestedBy:null };
  const requests = [old, flexible];
  const emails = [];
  const portalReads = new Map();
  let heldAttestation = null;
  const app = express(); app.use(express.json());
  mountBuildingCalendar(app, {
    requireAuth: async (req,res,next) => {
      req.user = await dbGet('SELECT * FROM users WHERE id=?', [Number(req.get('x-test-user'))]);
      if (!req.user) return res.status(401).json({error:'Sign in'});
      req.authRawToken = `user${req.user.id}`; next();
    },
    sendBuildingEmail: async message => { emails.push(message); return true; },
    fetcher: async (url, options) => {
      const query = new URL(url).searchParams;
      const userId = Number(String(options.headers.Authorization).replace('Bearer user',''));
      const role = userId === owner ? 'owner' : userId === secretary ? 'secretary' : 'assistant_secretary';
      if (query.has('list')) { portalReads.set(userId,(portalReads.get(userId)||0)+1); return Response.json({store:true,requests:requests.filter(request => role !== 'assistant_secretary' || request.attestationRoles.includes('assistant_secretary'))}); }
      if (query.has('attest')) {
        if(heldAttestation) {await heldAttestation.promise;throw new Error('Synthetic uncertain portal outcome');}
        const request = requests.find(item => item.id === query.get('attest'));
        if (!request.attestationRoles.includes(role)) return Response.json({error:'This signed agreement names McDuffie.'},{status:403});
        request.agreementStatus='fully_executed';request.revision='v2';request.attestedBy={name:role==='secretary'?'William M. McDuffie':'Adrian Reese',title:role==='secretary'?'Secretary':'Assistant Secretary',at:new Date().toISOString()};request.requesterNotified=true;
        return Response.json({ok:true,request});
      }
      throw Error(`Unexpected portal URL ${url}`);
    },
  });
  app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({error:error.message}));
  listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));
  const origin=`http://127.0.0.1:${listener.address().port}`;
  const api=async(path,id,body)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'x-test-user':String(id),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};

  assert.equal((await api('/api/building/alerts',owner)).data.alerts.length,0);
  await Promise.all(Array.from({length:12},()=>api('/api/building/alerts',owner)));
  assert.equal(portalReads.get(owner),1,'Repeated owner reminder polls do not download all agreements');
  const secretaryAlerts=(await api('/api/building/alerts',secretary)).data.alerts;
  assert.equal(secretaryAlerts.length,2);
  assert.ok(secretaryAlerts.every(alert=>alert.kind==='attestation_pending'));
  const assistantAlerts=(await api('/api/building/alerts',assistant)).data.alerts;
  assert.equal(assistantAlerts.length,2);
  assert.match(assistantAlerts.find(alert=>alert.id===old.id).message,/McDuffie is named/);
  const assistantList=(await api('/api/building/requests',assistant)).data.requests;
  assert.equal(assistantList.find(request=>request.id===old.id).statusOnly,true);
  assert.equal(assistantList.find(request=>request.id===old.id).agreementText,null);
  assert.equal((await api('/api/building/requests/SSL-OLD/attest',assistant,{revision:'v1'})).status,403);
  assert.equal((await api('/api/building/requests/SSL-OLD/file-completed',secretary,{revision:'v1'})).status,403);
  assert.equal((await api('/api/building/requests/SSL-OLD/file-completed',owner,{revision:'v1'})).status,409);

  const signed=await api('/api/building/requests/SSL-OLD/attest',secretary,{revision:'v1'});
  assert.equal(signed.status,200);
  assert.equal(emails.length,1);
  assert.equal(emails[0].to,'owner@example.org');
  assert.equal((await api('/api/building/alerts',secretary)).data.alerts.some(alert=>alert.id===old.id),false);
  const ready=(await api('/api/building/alerts',owner)).data.alerts;
  assert.equal(ready.length,1);assert.equal(ready[0].kind,'ready_to_file');
  assert.equal((await api('/api/building/requests/SSL-OLD/file-completed',owner,{revision:'v1'})).status,409);
  const filed=await api('/api/building/requests/SSL-OLD/file-completed',owner,{revision:'v2'});
  assert.equal(filed.status,200);assert.ok(filed.data.request.filedCompletedAt);
  assert.equal(filed.data.request.filedCompletedBy,'Synthetic Master');
  assert.equal((await api('/api/building/alerts',owner)).data.alerts.length,0);
  assert.ok((await api('/api/building/requests',owner)).data.requests.find(request=>request.id===old.id).filedCompletedAt);
  assert.equal((await api('/api/building/requests/SSL-OLD/file-completed',owner,{revision:'v2'})).status,200);
  const audits=await dbAll("SELECT action FROM audit_events WHERE action='building_agreement_filed_completed'");
  assert.equal(audits.length,1);
  // A failed or uncertain portal mutation still invalidates snapshots read
  // while it was in flight. Rechecking must reach the source again.
  let releaseAttestation;heldAttestation={promise:new Promise(resolve=>{releaseAttestation=resolve;})};
  const failedAttestation=api('/api/building/requests/SSL-EITHER/attest',assistant,{revision:'f1'});
  await new Promise(resolve=>setTimeout(resolve,20));
  await api('/api/building/alerts',assistant);
  const readsDuringAttempt=portalReads.get(assistant);
  releaseAttestation();assert.equal((await failedAttestation).status,500);heldAttestation=null;
  await api('/api/building/alerts',assistant);
  assert.equal(portalReads.get(assistant),readsDuringAttempt+1,'Uncertain mutation invalidates concurrent reminders in finally');
  await dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify([]),assistant]);
  const readsBeforeRevoked=portalReads.get(assistant);
  assert.equal((await api('/api/building/alerts',assistant)).status,403,'Cached reminders never bypass current access checks');
  assert.equal(portalReads.get(assistant),readsBeforeRevoked);
  console.log('PASS building attestation alerts, signer boundary, owner filing, idempotency, cached polling and access revocation.');
  // After a verified cutover the same portal CAS changes the authoritative
  // archive. Polling must see that revision without bridge or workflow writes.
  const restrictAgain = () => dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify([]),assistant]);
  await dbRun('UPDATE users SET permissions_json=? WHERE id=?',[JSON.stringify(['building.view']),assistant]);
  const warden = await addUser('Synthetic Warden', 'warden');
  await initBuildingStoreSchema();
  const attestingOrganization='Zeta Phi Beta Sorority, Incorporated, Gamma Alpha Rho Zeta Chapter';
  const flexibleTerms={version:'gapz-2026-09-23-v4',text:'Administrative attestation by the Secretary or Assistant Secretary'};
  const archived = [
    {id:old.id,org:attestingOrganization,date:'2026-11-10',status:'approved',
      statusAccessHash:'hidden-status-credential',agreement:{reviewStatus:'awaiting_secretary_attestation'}},
    {id:flexible.id,org:attestingOrganization,date:'2026-11-11',status:'approved',
      agreement:{reviewStatus:'awaiting_secretary_attestation',...flexibleTerms,signatureData:'private-ink'}},
    {id:'SSL-FILED',org:'Synthetic filed chapter',date:'2026-11-12',status:'approved',
      agreement:{reviewStatus:'fully_executed',secretaryAttestation:{attestedAt:'2026-11-10T12:00:00.000Z'}}},
    {id:'SSL-CANCELLED',org:attestingOrganization,date:'2026-11-13',status:'cancelled',
      agreement:{reviewStatus:'awaiting_secretary_attestation'}},
    {id:'SSL-OTHER',org:'Synthetic other chapter',date:'2026-11-14',status:'approved',
      agreement:{reviewStatus:'awaiting_secretary_attestation',...flexibleTerms}},
  ];
  const raw = JSON.stringify(archived);
  const timestamp = new Date().toISOString();
  await dbRun("INSERT INTO building_store_entries(key,value_text,value_sha256,created_at,updated_at) VALUES('resv:all',?,?,?,?)",
    [raw,buildingStoreHash(raw),timestamp,timestamp]);
  await dbRun("UPDATE building_store_state SET state='ready' WHERE id=1");
  const filedRaw = archived.find(record=>record.id==='SSL-FILED');
  const filedRevision = buildingStoreHash(JSON.stringify(filedRaw));
  await dbRun(`INSERT INTO building_workflow_records
    (request_id,organization,event_date,agreement_status,attestation_roles_json,portal_revision,updated_at,filed_revision)
    VALUES (?,?,?,?,?,?,?,?)`,[filedRaw.id,filedRaw.org,filedRaw.date,'fully_executed','[]',filedRevision,timestamp,filedRevision]);
  const beforeReads = [...portalReads];
  const workflowBefore = await dbAll('SELECT * FROM building_workflow_records ORDER BY request_id');
  const direct = await api('/api/building/alerts',assistant);
  assert.equal(direct.status,200);
  assert.deepEqual(direct.data.alerts.map(alert=>alert.id),[old.id,flexible.id]);
  assert.match(direct.data.alerts[0].message,/McDuffie is named/);
  assert.match(direct.data.alerts[1].message,/Review and attest/);
  assert.doesNotMatch(JSON.stringify(direct.data),/private-ink|hidden-status-credential/);
  assert.deepEqual((await api('/api/building/alerts',owner)).data.alerts,[],'The exact filed archive revision stays filed');
  assert.deepEqual((await api('/api/building/alerts',warden)).data.alerts,[],'A Warden has no officer attestation or filing reminder');
  assert.deepEqual(await dbAll('SELECT * FROM building_workflow_records ORDER BY request_id'),workflowBefore);
  assert.deepEqual([...portalReads],beforeReads,'Migrated alert reads do not contact the portal');
  const {revision,sha256,byteLength}=await readAssistantBuildingArchive();
  assert.deepEqual(await readAssistantBuildingArchive({knownArchive:{revision,sha256,byteLength}}),{unchanged:true});

  const compareAndSet = async (expected, records) => {
    const body={operation:'cas',key:'resv:all',expected,value:JSON.stringify(records)};
    const result=await executeBuildingStoreOperation(body,{requestId:crypto.randomUUID(),payloadSha256:buildingStoreHash(JSON.stringify(body))});
    assert.equal(result,1);
    return body.value;
  };
  const changed = structuredClone(archived);
  Object.assign(changed[0].agreement,flexibleTerms);
  const reassigned=await compareAndSet(raw,changed);
  const fromPortalRevision=await api('/api/building/alerts',assistant);
  assert.equal(fromPortalRevision.status,200);
  assert.match(fromPortalRevision.data.alerts[0].message,/Review and attest/,'An updated signature assignment appears on the next poll');
  changed[0].status='denied';
  changed[1].agreement.reviewStatus='fully_executed';
  changed[1].agreement.secretaryAttestation={attestedAt:'2026-11-10T13:00:00.000Z'};
  await compareAndSet(reassigned,changed);
  assert.deepEqual((await api('/api/building/alerts',assistant)).data.alerts,[],'Both prior reminders follow the new live archive transition');
  assert.deepEqual((await api('/api/building/alerts',owner)).data.alerts.map(alert=>alert.id),[flexible.id]);
  assert.deepEqual(await dbAll('SELECT * FROM building_workflow_records ORDER BY request_id'),workflowBefore);
  await restrictAgain();
  assert.equal((await api('/api/building/alerts',assistant)).status,403,'Direct archive reminders still require current permission');
  await dbRun("UPDATE building_store_entries SET value_text=? WHERE key='resv:all'",[raw]);
  assert.equal((await api('/api/building/alerts',owner)).status,503,'A previously cached ready archive never masks a failed integrity check');
  assert.deepEqual([...portalReads],beforeReads,'Active storage failure never falls back to the legacy portal');
  console.log('PASS migrated alert reads, signed-version visibility, request and filing revisions, no workflow writes, active access, and fail-closed recovery.');

} finally {
  if (listener) await new Promise(resolve=>listener.close(resolve));
  await close();
}
