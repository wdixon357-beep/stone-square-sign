// Isolated PGlite only. No application startup, real documents or providers.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '';
process.env.NODE_ENV = 'test';
import assert from 'node:assert/strict';
const db = await import('../db.js');
const access = await import('../assistant-access.js');
const actions = await import('../assistant-actions.js');
const {validateAssistantInstruction} = await import('../assistant-instructions.js');
const fails = (callback,code) => assert.rejects(callback,error=>error.statusCode===code);
let checks=0;
const test = async (name,fn) => {await fn();checks++;console.log(`PASS ${name}`);};
await db.connect();
try {
  await db.initSchema();await access.initAssistantSchema();await access.initAssistantSchema();
  const now = new Date().toISOString();
  const ownerId=(await db.dbRun('INSERT INTO users (email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
    ['owner-instruction@example.invalid','synthetic','Synthetic Owner','owner',now])).lastID;
  const otherId=(await db.dbRun('INSERT INTO users (email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
    ['other-instruction@example.invalid','synthetic','Synthetic Other','owner',now])).lastID;
  const permissions=['calendar.manage','owner.documents','owner.access'];
  let service=await access.createAssistantService({ownerUserId:ownerId,permissions});
  let token=(await access.rotateAssistantToken(ownerId)).token;
  let assistant=(await access.authenticateAssistantToken(token)).assistant;
  await db.dbRun('CREATE TABLE lodge_calendar_events (id TEXT PRIMARY KEY,event_json TEXT NOT NULL,revision INTEGER,created_by INTEGER,created_at TEXT,updated_at TEXT,deleted_at TEXT)');
  await db.dbRun('INSERT INTO lodge_calendar_events (id,event_json,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['instruction-event','{"title":"Synthetic"}',1,ownerId,now,now]);
  const payload={title:'Specific synthetic change',revision:1};
  const propose=(key,body=payload,extra={})=>access.createAssistantRequest(assistant,{actionId:'calendar.manage',method:'PUT',path:'/api/lodge-calendar/instruction-event',body,requestKey:key,...extra});
  const instruction={instruction:'Update the synthetic event title to Specific synthetic change.',instructionReference:'synthetic-conversation:message-1'};
  const authorize=(request,changes={})=>access.authorizeAssistantInstruction(assistant,request.id,{fingerprint:request.fingerprint,...instruction,...changes});
  const execute=(request,{body=request.body,file,key=request.id}={})=>access.authorizeAssistantRequest({assistant,
    method:request.method,originalUrl:request.path,body,file,headers:{'idempotency-key':key,'x-assistant-request-id':request.id}});
  const save=(extra={})=>access.createAssistantService({ownerUserId:ownerId,permissions,...extra});

  await test('delegation defaults off and cannot be authorized by an instruction alone',async()=>{
    assert.equal(service.commandExecution,false);assert.equal(service.signatureExecution,false);
    const request=await propose('instruction-default-off');
    await fails(()=>authorize(request),403);
    await fails(()=>execute(request),409);
    for(const value of [null,1,'true',{}]) await fails(()=>save({commandExecution:value}),400);
    for(const value of [null,1,'true',{}]) await fails(()=>save({signatureExecution:value}),400);
    assert.ok(!actions.isAssistantControlRoute('PUT','/api/assistant/access'));
    assert.ok(!actions.isAssistantControlRoute('POST','/api/assistant/requests/request/decision'));
    assert.ok(actions.isAssistantControlRoute('POST','/api/assistant/requests/request/instruction'));
    assert.ok(actions.isAssistantControlRoute('POST','/api/assistant/signature-requests/request/instruction'));
    assert.ok(!actions.isAssistantControlRoute('POST','/api/assistant/requests/request/instruction/extra'));
  });
  await test('owner-saved delegation persists when omitted and requires a fresh policy-bound request',async()=>{
    const stale=await propose('instruction-before-policy');
    service=await save({commandExecution:true,signatureExecution:true});
    assert.equal(service.commandExecution,true);assert.equal(service.signatureExecution,true);
    const before=await db.dbGet('SELECT token_hash,token_version FROM assistant_services WHERE id=?',[assistant.id]);
    service=await save();
    assert.equal(service.commandExecution,true);assert.equal(service.signatureExecution,true);
    assert.deepEqual(await db.dbGet('SELECT token_hash,token_version FROM assistant_services WHERE id=?',[assistant.id]),before);
    await fails(()=>authorize(stale),409);
    assert.equal((await access.authenticateAssistantToken(token)).assistant.commandExecution,true);
  });
  await test('instruction fields are exact, bounded and distinct from human confirmation',async()=>{
    const request=await propose('instruction-invalid-fields');
    for(const instruction of ['', '  ',true,{},'x'.repeat(2001)]) await fails(()=>authorize(request,{instruction}),400);
    for(const instructionReference of ['',{},'x'.repeat(301)]) await fails(()=>authorize(request,{instructionReference}),400);
    await fails(()=>authorize(request,{ownerApproved:true}),400);
    await fails(()=>authorize(request,{fingerprint:'wrong'}),409);
    assert.throws(()=>validateAssistantInstruction({instruction:'test',consent:true}),error=>error.statusCode===400);
    assert.deepEqual(validateAssistantInstruction({instruction:'  A specific instruction.  '}),{instruction:'A specific instruction.',instructionReference:null});
    const authorized=await authorize(request);
    assert.equal(authorized.status,'authorized');assert.equal(authorized.authorization.source,'owner_delegation');
    assert.equal(authorized.authorization.actorType,'assistant');assert.equal(authorized.authorization.ownerUserId,ownerId);
    assert.equal(authorized.authorization.instructionProvenance,'relayed_by_assistant');
    assert.equal(authorized.authorization.independentlyVerifiedHumanInstruction,false);
    assert.equal((await authorize(request)).status,'authorized');
    await fails(()=>authorize(request,{instruction:'Different instruction.'}),409);
    await fails(()=>access.decideAssistantRequest(ownerId,request.id,{decision:'approve',fingerprint:request.fingerprint}),409);
  });
  await test('exact payload, file bytes and current record remain bound to delegated instructions',async()=>{
    const request=await propose('instruction-payload');await authorize(request);
    await fails(()=>execute(request,{body:{...payload,title:'Wrong title'}}),409);
    await db.dbRun('UPDATE lodge_calendar_events SET revision=revision+1 WHERE id=?',['instruction-event']);
    await fails(()=>execute(request),409);
    const stale=await propose('instruction-stale-before-authorize');
    await db.dbRun('UPDATE lodge_calendar_events SET revision=revision+1 WHERE id=?',['instruction-event']);
    await fails(()=>authorize(stale),409);
    const file={fieldname:'file',originalname:'synthetic.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-synthetic test bytes')};
    const upload=await propose('instruction-file',{title:'Synthetic PDF'},{actionId:'owner.documents',method:'POST',path:'/api/documents',files:access.assistantFiles({file})});
    await authorize(upload);
    for(const replacement of [{...file,buffer:Buffer.from('%PDF-other bytes')},{...file,originalname:'other.pdf'},{...file,mimetype:'text/plain'}]) await fails(()=>execute(upload,{file:replacement}),409);
    const execution=await execute(upload,{file});
    assert.equal(execution.authorization.source,'owner_delegation');
    await access.completeAssistantRequest(execution,{statusCode:200,response:{id:'synthetic-record'}});
    await fails(()=>execute(upload,{file}),409);
  });
  await test('single execution, transactional recheck and truthful receipts survive concurrent retries',async()=>{
    const request=await propose('instruction-once');await authorize(request);
    const executions=await Promise.allSettled([execute(request),execute(request)]);
    assert.equal(executions.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(executions.find(result=>result.status==='rejected').reason.statusCode,409);
    const execution=executions.find(result=>result.status==='fulfilled').value;
    const req={assistant,assistantExecution:execution,method:request.method,originalUrl:request.path,body:request.body};
    await db.withTransaction(()=>access.assertAssistantRecordUnchanged(req));
    await fails(()=>access.assertAssistantRecordUnchanged(req),409);
    const receipt=await access.completeAssistantRequest(execution,{statusCode:200,response:{ok:true,id:'synthetic-id',documentId:'synthetic-document-id',reference:'Synthetic reference',body:'Private record text'}});
    assert.equal(receipt.actorType,'assistant');assert.equal(receipt.assistantId,assistant.id);
    assert.equal(receipt.authorization.source,'owner_delegation');assert.equal(receipt.authorization.independentlyVerifiedHumanInstruction,false);
    assert.equal(receipt.automaticRetryAllowed,false);
    assert.equal(receipt.id,'synthetic-id');assert.equal(receipt.documentId,'synthetic-document-id');assert.equal(receipt.recordId,'synthetic-document-id');
    assert.equal(receipt.reference,'Synthetic reference');assert.equal(receipt.body,undefined);
    const activity=await db.dbGet("SELECT actor_type,details_json FROM assistant_activity WHERE request_id=? AND action='instruction_authorized'",[request.id]);
    assert.equal(activity.actor_type,'assistant');assert.equal(JSON.parse(activity.details_json).authorization.source,'owner_delegation');
    await fails(()=>execute(request,{key:'different-retry-key'}),409);
    const uncertain=await propose('instruction-uncertain');await authorize(uncertain);
    const unknown=await execute(uncertain);await access.completeAssistantRequest(unknown,{statusCode:503,uncertain:true});
    await fails(()=>execute(uncertain),409);
    const canceled=await propose('instruction-owner-declined');await authorize(canceled);
    assert.equal((await access.decideAssistantRequest(ownerId,canceled.id,{decision:'decline',fingerprint:canceled.fingerprint})).status,'declined');
    await fails(()=>execute(canceled),409);
  });
  await test('policy revocation, expiry and changed grants stop relayed execution',async()=>{
    const request=await propose('instruction-revoke');await authorize(request);
    await save({commandExecution:false});await fails(()=>execute(request),409);await fails(()=>authorize(request),403);
    await save({commandExecution:true});
    const expired=await propose('instruction-expired');
    await db.dbRun('UPDATE assistant_requests SET expires_at=? WHERE id=?',['2000-01-01T00:00:00Z',expired.id]);
    await fails(()=>authorize(expired),409);
    const grant=await propose('instruction-grant-removed');await authorize(grant);
    await save({permissions:['owner.documents']});await fails(()=>execute(grant),403);
    await save();
    const inFlight=await propose('instruction-flight-revoke');await authorize(inFlight);
    const execution=await execute(inFlight);await save({commandExecution:false});
    await fails(()=>db.withTransaction(()=>access.assertAssistantRecordUnchanged({assistant,assistantExecution:execution,
      method:inFlight.method,originalUrl:inFlight.path,body:inFlight.body})),409);
    await access.completeAssistantRequest(execution,{statusCode:409});
  });
  await test('personal claims, other service requests and credential rotation remain excluded',async()=>{
    await save({commandExecution:true});
    await fails(()=>propose('instruction-forged-review',{...payload,sourceReviewed:true}),403);
    await fails(()=>propose('instruction-forged-signature',{...payload,signatureData:'synthetic'}),403);
    const personal=await propose('instruction-personal-action',{}, {actionId:'owner.dispensation-sign',method:'POST',path:'/api/dispensations'});
    assert.equal(personal.status,'personal');await fails(()=>authorize(personal),403);
    const request=await propose('instruction-other-service');
    await access.createAssistantService({ownerUserId:otherId,permissions,commandExecution:true});
    const otherToken=(await access.rotateAssistantToken(otherId)).token;
    const otherAssistant=(await access.authenticateAssistantToken(otherToken)).assistant;
    await fails(()=>access.authorizeAssistantInstruction(otherAssistant,request.id,{fingerprint:request.fingerprint,...instruction}),404);
    for(const path of ['/api/profile/signature','/api/documents/synthetic/sign','/api/minutes/synthetic/master-attest']) {
      await fails(()=>access.authorizeAssistantRequest({assistant,method:path.endsWith('signature')?'PUT':'POST',originalUrl:path,body:{},headers:{}}),403);
    }
    await authorize(request);token=(await access.rotateAssistantToken(ownerId)).token;
    await fails(()=>execute(request),401);
    assistant=(await access.authenticateAssistantToken(token)).assistant;
    await fails(()=>execute(request),409);
    await access.revokeAssistantService(ownerId);await fails(()=>execute(request),401);
  });
  console.log(`All ${checks} delegated command adversarial groups passed.`);
} finally {await db.close();}
