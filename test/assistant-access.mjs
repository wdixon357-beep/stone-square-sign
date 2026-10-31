// Isolated PGlite only. No application startup, provider, production or paid work.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
import assert from 'node:assert/strict';
const db = await import('../db.js');
const access = await import('../assistant-access.js');
const actions = await import('../assistant-actions.js');
const { initBuildingStoreSchema } = await import('../building-store.js');
const { assistantBuildingProjection, assistantBuildingAlerts } = await import('../assistant-building.js');
const failures = [];
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log(`PASS ${name}`); } catch (error) { failures.push({name,error}); console.error(`FAIL ${name}: ${error.stack}`); } };
const fails = async (callback, code) => assert.rejects(callback,error=>error.statusCode===code);
await db.connect();
try {
  await db.initSchema();await access.initAssistantSchema();await initBuildingStoreSchema();
  const time = new Date().toISOString();
  const seedUser = async (name,role) => (await db.dbRun('INSERT INTO users (email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
    [`${name.toLowerCase()}@example.invalid`,'synthetic-not-a-password',name,role,time])).lastID;
  const ownerId = await seedUser('Owner','owner'), secretaryId = await seedUser('Secretary','secretary'), otherOwnerId = await seedUser('OtherOwner','owner');
  const permissions = actions.ASSISTANT_CAPABILITIES.filter(item=>['standing','approval'].includes(item.mode)).map(item=>item.id);
  let assistant, token, service;
  const auth = async () => (await access.authenticateAssistantToken(token)).assistant;
  const request = (path, body, key, actionId='calendar.manage',method='PUT') => access.createAssistantRequest(assistant,{path,body,requestKey:key,actionId,method});
  const execute = (proposal, body=proposal.body, key=proposal.id) => access.authorizeAssistantRequest({assistant,method:proposal.method,
    originalUrl:proposal.path,body,headers:{'idempotency-key':key,'x-assistant-request-id':proposal.id}});
  const approve = proposal => access.decideAssistantRequest(ownerId,proposal.id,{decision:'approve',fingerprint:proposal.fingerprint});
  await test('complete ordinary capability catalog and distinct service identity',async()=>{
    const {CAPABILITIES}=await import('../access-control.js');
    for (const item of CAPABILITIES) assert.ok(actions.assistantCapability(item.id),item.id);
    await fails(()=>access.createAssistantService({ownerUserId:secretaryId,permissions}),403);
    await fails(()=>access.createAssistantService({ownerUserId:ownerId,permissions:['documents.sign']}),400);
    await fails(()=>access.createAssistantService({ownerUserId:ownerId,permissions:['invented.action']}),400);
    service=await access.createAssistantService({ownerUserId:ownerId,permissions});
    assert.equal((await db.dbGet('SELECT COUNT(*) AS count FROM users')).count,3);
    const issued=await access.rotateAssistantToken(ownerId);token=issued.token;assistant=await auth();
    assert.ok(token.startsWith('ss22_muse_'));assert.notEqual(assistant.id,ownerId);
    const stored=await db.dbGet('SELECT token_hash FROM assistant_services WHERE id=?',[assistant.id]);
    assert.equal(stored.token_hash,actions.digest(token));assert.ok(!JSON.stringify(assistant).includes(stored.token_hash));
    assert.equal(await access.authenticateAssistantToken('ordinary-session-token'),null);
    await fails(()=>access.authenticateAssistantToken('ss22_muse_invalid'),401);
  });
  await test('explicit default deny, canonical paths and all signature escape routes',async()=>{
    for (const path of ['/api/new-route','/api/profile/signature/child','/api/minutes/id/master-attest/child']) assert.throws(()=>actions.resolveAssistantAction('GET',path));
    for (const path of ['/api/%6dinutes/id','/api/minutes/../profile/signature','//outside/api/','/api/minutes/','/api/minutes//id','https://outside/api/a']) assert.throws(()=>actions.resolveAssistantAction('GET',path));
    for (const [method,path] of [['PUT','/api/profile/signature'],['GET','/api/profile/signature'],['POST','/api/reports/handoff'],['POST','/api/reports/signature'],
      ['POST','/api/officer-reports/deliver'],['POST','/api/dispensations'],['POST','/api/proposals/id/decision'],['POST','/api/minutes/id/master-attest'],['POST','/api/documents/id/sign'],['POST','/api/building/requests/id/decision'],
      ['GET','/api/building/requests/id/agreement'],['POST','/api/minutes/id/preparer-attest'],['POST','/api/treasury/id/preparer-attest'],['POST','/api/tracker/handoff']]) {
      await fails(()=>access.authorizeAssistantRequest({assistant,method,originalUrl:path,body:{},headers:{}}),403);
    }
    assert.ok(actions.isAssistantControlRoute('POST','/api/assistant/mcp'));
    assert.ok(!actions.isAssistantControlRoute('POST','/api/assistant/requests/id/decision'));
    assert.ok(!actions.isAssistantControlRoute('GET','/api/assistant/workspace'));
  });
  await test('human owner guard prevents service and other-office approval',async()=>{
    let status,called=false;
    const response={status(value){status=value;return this;},json(){return this;}};
    access.requireHumanOwner({assistant,user:{id:ownerId,role:'owner'}},response,()=>{called=true;});
    assert.equal(status,403);assert.equal(called,false);
    await fails(()=>access.decideAssistantRequest(secretaryId,'missing',{decision:'approve',fingerprint:'bad'}),403);
    await fails(()=>access.authorizeAssistantRequest({assistant:{id:assistant.id},method:'GET',originalUrl:'/api/dues',body:{}}),401);
  });
  await db.dbRun('CREATE TABLE IF NOT EXISTS lodge_calendar_events (id TEXT PRIMARY KEY,event_json TEXT NOT NULL,revision INTEGER DEFAULT 1,created_by INTEGER,created_at TEXT,updated_at TEXT,deleted_at TEXT)');
  await db.dbRun('INSERT INTO lodge_calendar_events (id,event_json,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)',['event-one','{"title":"Synthetic event"}',1,ownerId,time,time]);
  let proposal;
  const body={title:'Synthetic change',revision:1,startDate:'2026-11-03'};
  await test('exact proposals deduplicate without changed-key reuse',async()=>{
    proposal=await request('/api/lodge-calendar/event-one',body,'proposal-one');
    assert.equal(proposal.status,'pending');
    assert.equal((await request(proposal.path,{...body},'proposal-one')).id,proposal.id);
    await fails(()=>request(proposal.path,{...body,title:'Changed'},'proposal-one'),409);
    await fails(()=>request(proposal.path,body,'wrong-action','minutes.prepare'),400);
    await fails(()=>access.createAssistantRequest(assistant,{actionId:'calendar.manage',method:'PUT',path:proposal.path,body,requestKey:'unknown-field',consent:true}),400);
    await fails(()=>request(proposal.path,{...body,signatureData:'fake'},'forged-signature'),403);
    await fails(()=>request(proposal.path,{...body,nested:{consent:true}},'forged-consent'),403);
    await fails(()=>request(proposal.path,{...body,personalInfoConfirmed:true},'forged-profile-confirmation'),403);
  });
  await test('human approval binds exact fingerprint, current record and payload',async()=>{
    await fails(()=>access.decideAssistantRequest(ownerId,proposal.id,{decision:'approve',fingerprint:'different'}),409);
    proposal=await approve(proposal);assert.equal(proposal.status,'approved');
    await fails(()=>execute(proposal,{...body,title:'Changed after approval'}),409);
    await db.dbRun('UPDATE lodge_calendar_events SET revision=revision+1 WHERE id=?',['event-one']);
    await fails(()=>execute(proposal),409);
    const changed=await request(proposal.path,{...body,revision:2},'proposal-current');
    await db.dbRun('UPDATE lodge_calendar_events SET revision=revision+1 WHERE id=?',['event-one']);
    await fails(()=>approve(changed),409);
  });
  await test('one-use approval, durable receipts and uncertain outcome cannot replay',async()=>{
    let current=await request('/api/lodge-calendar/event-one',{...body,revision:3},'proposal-execute');current=await approve(current);
    const execution=await execute(current);assert.equal(execution.requestId,current.id);
    await fails(()=>execute(current),409);
    await access.completeAssistantRequest(execution,{statusCode:200,response:{ok:true,signatureData:'not retained'}});
    const receipt=await db.dbGet('SELECT status,receipt_json FROM assistant_executions WHERE id=?',[execution.id]);
    assert.equal(receipt.status,'completed');assert.ok(!receipt.receipt_json.includes('signatureData'));
    await fails(()=>execute(current),409);
    assert.equal((await access.completeAssistantRequest(execution,{statusCode:503})).status,'completed');
    let uncertain=await request('/api/lodge-calendar/event-one',{...body,revision:3},'proposal-uncertain');uncertain=await approve(uncertain);
    const unknown=await execute(uncertain);await access.completeAssistantRequest(unknown,{statusCode:200,uncertain:true});
    assert.equal((await db.dbGet('SELECT status FROM assistant_executions WHERE id=?',[unknown.id])).status,'uncertain');
    await fails(()=>execute(uncertain),409);
  });
  await test('file approvals bind actual bytes, names, type and size',async()=>{
    const file={fieldname:'file',originalname:'synthetic.txt',mimetype:'text/plain',buffer:Buffer.from('synthetic data')};
    const files=access.assistantFiles({file});
    let upload=await access.createAssistantRequest(assistant,{actionId:'owner.documents',method:'POST',path:'/api/documents',body:{title:'Synthetic'},files,requestKey:'file-request'});
    upload=await approve(upload);
    await fails(()=>access.authorizeAssistantRequest({assistant,method:'POST',originalUrl:'/api/documents',body:upload.body,file:{...file,buffer:Buffer.from('different data')},headers:{'idempotency-key':upload.id,'x-assistant-request-id':upload.id}}),409);
    const execution=await access.authorizeAssistantRequest({assistant,method:'POST',originalUrl:'/api/documents',body:upload.body,file,headers:{'idempotency-key':upload.id,'x-assistant-request-id':upload.id}});
    await access.completeAssistantRequest(execution,{statusCode:400});
    assert.equal((await db.dbGet('SELECT status FROM assistant_executions WHERE id=?',[execution.id])).status,'failed');
    await fails(()=>execute(upload),409);
    const second={...file,originalname:'second.txt',buffer:Buffer.from('second source')};
    assert.notDeepEqual(access.assistantFiles({files:[file,second]}),access.assistantFiles({files:[second,file]}),'source order is part of approval');
  });
  await test('in-transaction guard catches state changes after the outer gate',async()=>{
    let current=await request('/api/lodge-calendar/event-one',{...body,revision:3},'inner-guard-request');current=await approve(current);
    const execution=await execute(current),req={assistant,assistantExecution:execution,method:'PUT',originalUrl:current.path,body:current.body};
    await fails(()=>access.assertAssistantRecordUnchanged(req),409);
    await db.withTransaction(()=>access.assertAssistantRecordUnchanged(req));
    await db.dbRun('UPDATE lodge_calendar_events SET revision=revision+1 WHERE id=?',['event-one']);
    await fails(()=>db.withTransaction(()=>access.assertAssistantRecordUnchanged(req)),409);
    await access.completeAssistantRequest(execution,{statusCode:409});
    await db.dbRun('INSERT INTO submission_profiles (role,name,address,updated_at) VALUES (?,?,?,?)',['secretary','Synthetic Secretary','Synthetic address',time]);
    let profile=await request('/api/submission-profiles/secretary',{name:'Changed Secretary',address:'New address'},'profile-guard-request','owner.access');profile=await approve(profile);
    const profileExecution=await execute(profile),profileReq={assistant,assistantExecution:profileExecution,method:'PUT',originalUrl:profile.path,body:profile.body};
    await db.withTransaction(()=>access.assertAssistantRecordUnchanged(profileReq));
    await db.dbRun('UPDATE submission_profiles SET address=? WHERE role=?',['Different concurrent address','secretary']);
    await fails(()=>db.withTransaction(()=>access.assertAssistantRecordUnchanged(profileReq)),409);
    await access.completeAssistantRequest(profileExecution,{statusCode:409});
  });
  await test('saved personal reviews survive only unchanged associated facts',async()=>{
    const minutes={officerAttendance:[{name:'Synthetic Secretary',status:'present'}],present:['Synthetic Brother'],excused:[],
      attendanceReview:{officerRoll:true,otherPresent:true,otherExcused:true},sections:[{body:'Original'}]};
    assert.doesNotThrow(()=>actions.assertNoAssistantAttestation({draft:{...minutes,sections:[{body:'Corrected prose'}]}},{kind:'minutes',existingDraft:minutes}));
    assert.throws(()=>actions.assertNoAssistantAttestation({draft:{...minutes,present:['Changed Brother']}},{kind:'minutes',existingDraft:minutes}),error=>error.statusCode===403);
    assert.throws(()=>actions.assertNoAssistantAttestation({draft:minutes},{kind:'minutes'}),error=>error.statusCode===403);
    const treasury={periodStart:'2026-10-01',periodEnd:'2026-10-31',sourceNames:['Synthetic statement'],accounts:[{id:'checking',statement:10,activityComplete:true}],
      transactions:[{date:'2026-10-02',account:'checking',amount:10,postedDateConfirmed:true}],funds:[],obligations:[],unmappedLines:[],
      fundsReviewed:true,obligationsReviewed:true,sourceReviewed:true,fieldReviews:{'accounts.0.statement':'confirmed'}};
    assert.doesNotThrow(()=>actions.assertNoAssistantAttestation({draft:treasury},{kind:'treasury',existingDraft:treasury}));
    const changed=structuredClone(treasury);changed.accounts[0].statement=20;
    assert.throws(()=>actions.assertNoAssistantAttestation({draft:changed},{kind:'treasury',existingDraft:treasury}),error=>error.statusCode===403);
    const forged=structuredClone(treasury);forged.fieldReviews['accounts.0.unknown']='confirmed';
    assert.throws(()=>actions.assertNoAssistantAttestation({draft:forged},{kind:'treasury',existingDraft:treasury}),error=>error.statusCode===403);
  });
  await test('retained source evidence cannot be fabricated or left matched after a value change',async()=>{
    await db.dbRun(`CREATE TABLE treasury_reports (id TEXT PRIMARY KEY,status TEXT,revision INTEGER,preparer_user_id INTEGER,
      created_by_user_id INTEGER,updated_at TEXT,deleted_at TEXT,draft_json TEXT,submitted_json TEXT,preparer_attested_at TEXT)`);
    const draft={accounts:[{id:'checking',statement:100,activityComplete:false}],transactions:[],funds:[],obligations:[],sourceNames:['Synthetic source'],
      sourceReviewed:false,fundsReviewed:false,obligationsReviewed:false,extractionNotes:['Source evidence: accounts[0].statement → Original source says 100'],fieldReviews:{'accounts.0.statement':'matched'},remarks:''};
    await db.dbRun('INSERT INTO treasury_reports (id,status,revision,preparer_user_id,created_by_user_id,updated_at,draft_json) VALUES (?,?,?,?,?,?,?)',
      ['treasury-test','draft',1,ownerId,ownerId,time,JSON.stringify(draft)]);
    const valid=await request('/api/treasury/treasury-test',{draft:{...draft,remarks:'Prepared note'},revision:1},'source-valid','treasury.prepare');assert.equal(valid.status,'pending');
    const changed=structuredClone(draft);changed.accounts[0].statement=200;
    await fails(()=>request('/api/treasury/treasury-test',{draft:changed,revision:1},'source-changed','treasury.prepare'),403);
    await fails(()=>request('/api/treasury/treasury-test',{draft:{...draft,extractionNotes:['Source evidence: accounts[0].statement → Forged evidence']},revision:1},'source-forged','treasury.prepare'),403);
    const forged=structuredClone(draft);forged.fieldReviews['accounts.0.statement']='confirmed';
    await fails(()=>request('/api/treasury/treasury-test',{draft:forged,revision:1},'source-review-forged','treasury.prepare'),403);
    assert.equal(JSON.parse((await db.dbGet('SELECT draft_json FROM treasury_reports WHERE id=?',['treasury-test'])).draft_json).accounts[0].statement,100);
  });
  await test('building projection verifies database bytes and excludes every unlisted field without writes',async()=>{
    const records=[{id:'SSL-TEST',org:'Synthetic group',status:'pending',date:'2026-11-03',contact:'synthetic@example.invalid',
      statusAccessHash:'PRIVATE_STATUS_SECRET',paymentUrl:'PRIVATE_PAYMENT_LINK',newField:'PRIVATE_FUTURE_FIELD',agreement:{signatureData:'PRIVATE_SIGNATURE',text:'PRIVATE_TERMS'}},
      {id:'SSL-COMPLETE',org:'Synthetic complete',status:'approved',date:'2026-11-04',agreement:{reviewStatus:'fully_executed',
        signatureData:'PRIVATE_SIGNATURE',secretaryAttestation:{name:'Synthetic Secretary',title:'Secretary',attestedAt:time,signatureData:'PRIVATE_SIGNATURE'}}}];
    const raw=JSON.stringify(records);
    await db.dbRun("UPDATE building_store_state SET state='ready' WHERE id=1");
    await db.dbRun('INSERT INTO building_store_entries (key,value_text,value_sha256,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)',['resv:all',raw,actions.digest(raw),1,time,time]);
    const before=await db.dbAll('SELECT * FROM building_store_entries');
    const projection=await assistantBuildingProjection();assert.equal(projection.requests.length,2);assert.equal(projection.canDecide,false);
    assert.doesNotMatch(JSON.stringify(projection),/PRIVATE_/);assert.equal((await assistantBuildingAlerts()).alerts.length,1);
    assert.deepEqual(await db.dbAll('SELECT * FROM building_store_entries'),before);
    await db.dbRun('UPDATE building_store_entries SET value_sha256=? WHERE key=?',['a'.repeat(64),'resv:all']);
    await fails(()=>assistantBuildingProjection(),503);
    await db.dbRun('UPDATE building_store_entries SET value_sha256=? WHERE key=?',[actions.digest(raw),'resv:all']);
  });
  await test('audit context reaches direct inserts with literal SQL and isolates human work',async()=>{
    await db.withAuditActor({assistantId:assistant.id,assistantName:'Synthetic Muse',ownerUserId:ownerId,requestId:proposal.id},async()=>{
      await db.dbRun("INSERT INTO audit_events (user_id,action,details_json,created_at) VALUES (?,'literal_action',?,?)",[ownerId,'{}',time]);
      await db.withTransaction(()=>db.dbRun('INSERT INTO "audit_events" (user_id,action,created_at) VALUES (?,?,?)',[ownerId,'quoted_insert',time]));
    });
    await db.dbRun('INSERT INTO audit_events (user_id,action,created_at) VALUES (?,?,?)',[ownerId,'human_action',time]);
    const rows=await db.dbAll('SELECT action,actor_type,actor_id,on_behalf_of_user_id,assistant_request_id FROM audit_events ORDER BY id');
    for(const row of rows.slice(0,2)){assert.equal(row.actor_type,'assistant');assert.equal(row.actor_id,assistant.id);assert.equal(row.on_behalf_of_user_id,ownerId);assert.equal(row.assistant_request_id,proposal.id);}
    assert.equal(rows[2].actor_type,'human');assert.equal(rows[2].actor_id,null);
    assert.throws(()=>db.assistantAuditInsert('INSERT INTO audit_events SELECT * FROM audit_events',[],{assistantId:'x',ownerUserId:1}));
  });
  await db.dbRun(`INSERT INTO meeting_minutes (id,source_name,transcript_text,draft_json,status,created_by_user_id,updated_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,['minutes-own','Synthetic source','Synthetic only','{}','draft',ownerId,ownerId,time,time]);
  await db.dbRun(`INSERT INTO meeting_minutes (id,source_name,transcript_text,draft_json,status,created_by_user_id,updated_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,['minutes-other','Synthetic source','Synthetic only','{}','draft',secretaryId,secretaryId,time,time]);
  await db.dbRun(`INSERT INTO meeting_minutes (id,source_name,transcript_text,draft_json,status,created_by_user_id,updated_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,['minutes-master','Synthetic source','Synthetic only','{}','awaiting_master_attestation',secretaryId,secretaryId,time,time]);
  await test('personal requests are review only and preserve real preparer ownership',async()=>{
    const personal=await request('/api/minutes/minutes-own/preparer-attest',{},'personal-owner','owner.minutes-preparer','POST');
    assert.equal(personal.status,'personal');await fails(()=>approve(personal),403);
    await fails(()=>request('/api/minutes/minutes-other/preparer-attest',{},'other-preparer','owner.minutes-preparer','POST'),403);
    await fails(()=>request('/api/correspondence/letter/sign',{},'wrong-office','owner.correspondence-sign','POST'),403);
    await fails(()=>execute(personal),403);
    let queue=await access.listAssistantAttestations(ownerId);
    assert.ok(queue.find(item=>item.recordId==='minutes-own'));
    assert.ok(!queue.find(item=>item.recordId==='minutes-other'));
    assert.equal(queue.find(item=>item.recordId==='minutes-master').ready,false);
    assert.equal(queue.find(item=>item.recordId==='minutes-own').attestationText,'Attest and send to the Worshipful Master');
    const human={user:{id:ownerId,role:'owner'},method:'POST',originalUrl:personal.path,body:{}};
    human.assistantPersonalReview=await access.captureHumanAssistantReview(human);
    await access.observeHumanAssistantCompletion(human,{statusCode:200});
    assert.equal((await db.dbGet('SELECT status FROM assistant_requests WHERE id=?',[personal.id])).status,'personal');
    await db.dbRun("UPDATE meeting_minutes SET status='awaiting_master_attestation',preparer_attested_at=? WHERE id=?",[time,'minutes-own']);
    await access.observeHumanAssistantCompletion(human,{statusCode:200});
    assert.equal((await db.dbGet('SELECT status FROM assistant_requests WHERE id=?',[personal.id])).status,'completed_personally');
    const another=await request('/api/minutes/minutes-master/master-attest',{},'personal-other-version','owner.minutes-master','POST');
    await db.dbRun('UPDATE meeting_minutes SET draft_json=? WHERE id=?',['{"sections":[{"body":"Changed after assistant request"}]}','minutes-master']);
    const changedHuman={user:{id:ownerId,role:'owner'},method:'POST',originalUrl:another.path,body:{}};
    changedHuman.assistantPersonalReview=await access.captureHumanAssistantReview(changedHuman);
    await db.dbRun('UPDATE meeting_minutes SET master_attested_at=? WHERE id=?',[time,'minutes-master']);
    await access.observeHumanAssistantCompletion(changedHuman,{statusCode:200});
    assert.equal((await db.dbGet('SELECT status FROM assistant_requests WHERE id=?',[another.id])).status,'personal','A signature of different content does not settle the queued version.');
  });
  await test('grants, rotation, expiry, owner role and revocation are current on every request',async()=>{
    await access.createAssistantService({ownerUserId:ownerId,permissions:['dues.self']});
    await fails(()=>access.authorizeAssistantRequest({assistant,method:'GET',originalUrl:'/api/dues',body:{}}),403);
    assert.equal(await access.authorizeAssistantRequest({assistant,method:'GET',originalUrl:'/api/dues/me',body:{}}),null);
    const old=token;token=(await access.rotateAssistantToken(ownerId)).token;
    await fails(()=>access.authenticateAssistantToken(old),401);
    await fails(()=>access.authorizeAssistantRequest({assistant,method:'GET',originalUrl:'/api/dues/me',body:{}}),401);
    assistant=await auth();
    await db.dbRun("UPDATE users SET role='member' WHERE id=?",[ownerId]);
    await fails(()=>access.authenticateAssistantToken(token),403);
    await db.dbRun("UPDATE users SET role='owner' WHERE id=?",[ownerId]);
    await db.dbRun('UPDATE assistant_services SET expires_at=? WHERE id=?',['2000-01-01T00:00:00Z',assistant.id]);
    await fails(()=>access.authenticateAssistantToken(token),401);
    await access.createAssistantService({ownerUserId:ownerId,permissions:['dues.self']});
    assistant=await auth();
    await access.revokeAssistantService(ownerId);
    await fails(()=>access.authenticateAssistantToken(token),401);
    await fails(()=>access.authorizeAssistantRequest({assistant,method:'GET',originalUrl:'/api/dues/me',body:{}}),401);
    const other=await access.createAssistantService({ownerUserId:otherOwnerId,permissions:['dues.self']});assert.notEqual(other.id,service.id);
  });
  await test('365-day access keeps the existing credential and rejects 366 days',async()=>{
    await access.createAssistantService({ownerUserId:ownerId,permissions:['dues.self'],expiresInDays:7});
    const issued=await access.rotateAssistantToken(ownerId);const savedToken=issued.token;
    const before=await db.dbGet('SELECT token_hash,token_version FROM assistant_services WHERE owner_user_id=?',[ownerId]);
    const saved=await access.createAssistantService({ownerUserId:ownerId,permissions:['dues.self'],expiresInDays:365});
    const after=await db.dbGet('SELECT token_hash,token_version FROM assistant_services WHERE owner_user_id=?',[ownerId]);
    assert.deepEqual(after,before);assert.equal((await access.authenticateAssistantToken(savedToken)).user.id,ownerId);
    assert.ok(Date.parse(saved.expiresAt)>Date.now()+364*86400000);
    await fails(()=>access.createAssistantService({ownerUserId:ownerId,permissions:['dues.self'],expiresInDays:366}),400);
  });
} finally { await db.close(); }
if(failures.length) { console.error(`${failures.length} assistant foundation groups failed; ${passed} passed.`);process.exitCode=1; }
else console.log(`All ${passed} assistant foundation adversarial groups passed.`);
