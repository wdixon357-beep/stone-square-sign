import assert from 'node:assert/strict';
import express from 'express';

process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
const { connect, close, initSchema, dbRun, dbGet, dbAll } = await import('../db.js');
const { initializeBuildingCalendar, mountBuildingCalendar } = await import('../building-calendar.js');

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
      if (query.has('list')) return Response.json({store:true,requests:requests.filter(request => role !== 'assistant_secretary' || request.attestationRoles.includes('assistant_secretary'))});
      if (query.has('attest')) {
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
  console.log('PASS building attestation alerts, signer boundary, owner filing, and idempotency.');
} finally {
  if (listener) await new Promise(resolve=>listener.close(resolve));
  await close();
}
