import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { connect,initSchema,dbGet,dbAll,dbRun,withTransaction,isDatabaseTransactionActive,close } from '../db.js';
import { initSignaturePolicySchema,pinApprovedOwnerSignature } from '../signature-policy.js';
import { initAssistantSchema,createAssistantService,rotateAssistantToken,authenticateAssistantToken } from '../assistant-access.js';
import { initSignatureAuthorizationSchema,registerSignatureOperation,createSignatureRequest,confirmSignatureRequest,declineSignatureRequest } from '../signature-authorizations.js';
import crypto from 'node:crypto';
assert.equal(process.env.DATABASE_URL || '','');assert.equal(process.env.PGLITE_DIR || '','');
process.env.NODE_ENV='test';process.env.APP_BASE_URL='http://127.0.0.1:9999';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
let passed=0,deliveries=0,renders=0,mode='normal';const check=(label,value)=>{assert.ok(value,label);passed++;};
const rejects=async(fn,status)=>assert.rejects(fn,error=>error.statusCode===status);
await connect();
try {
 await initSchema();await initAssistantSchema();await initSignaturePolicySchema();await initSignatureAuthorizationSchema();
 const time=new Date().toISOString();
 const ownerId=(await dbRun("INSERT INTO users(email,password_hash,name,role,created_at) VALUES ('synthetic-owner@example.test','unused','Synthetic owner','owner',?)",[time])).lastID;
 const image=Buffer.from('isolated image bytes, never a real signature');
 await dbRun("INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,'drawn',?)",[ownerId,image,time]);
 await pinApprovedOwnerSignature({ownerUserId:ownerId,expectedProfileSha256:sha(image),authorizationNote:'Synthetic owner approval for isolated controller tests only.'});
 await createAssistantService({ownerUserId:ownerId,permissions:[],expiresInDays:1});
 const token=(await rotateAssistantToken(ownerId)).token;const authenticated=await authenticateAssistantToken(token);
 await dbRun('CREATE TABLE signature_test_records(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,signed INTEGER NOT NULL DEFAULT 0)');
 for(const id of ['first','changed','rollback','uncertain','declined','expired','rotated'])await dbRun('INSERT INTO signature_test_records(id,revision) VALUES (?,1)',[id]);
 const pdf=await PDFDocument.create();pdf.addPage();const artifact=Buffer.from(await pdf.save());
 registerSignatureOperation('documents.sign',{
   snapshot:async({action,renderArtifact})=>{if(renderArtifact)renders++;const row=await dbGet('SELECT * FROM signature_test_records WHERE id=? FOR UPDATE',[action.recordId]);if(!row)throw Object.assign(new Error('Missing fixture'),{statusCode:404});return {title:'Synthetic exact record '+row.id,kind:'document',signingRole:'owner',statement:'I reviewed this exact synthetic document and authorize applying my stored synthetic signature.',effects:['Apply the synthetic signature.','Send the synthetic notice after commit.'],state:row,...(renderArtifact?{artifact}:{})};},
   apply:async req=>{await dbRun('UPDATE signature_test_records SET signed=signed+1 WHERE id=?',[req.params.id]);if(mode==='rollback')throw Object.assign(new Error('Synthetic safe business guard failed'),{statusCode:409});if(mode==='uncertain')throw new Error('Synthetic unknown application failure');return {id:req.params.id};},
   afterCommit:async outcome=>{check('Delivery is outside all transactions',!isDatabaseTransactionActive());check('Delivery observes committed signature',(await dbGet('SELECT signed FROM signature_test_records WHERE id=?',[outcome.id])).signed===1);check('Delivery observes consumed authorization',(await dbGet("SELECT status FROM assistant_signature_requests WHERE path=?",[`/api/documents/${outcome.id}/sign`])).status==='completed');deliveries++;return {notificationWarnings:['Synthetic delivery warning']};},
 });
 registerSignatureOperation('owner.dispensation-sign',{snapshot:async()=>{throw new Error('Invalid metadata must be rejected before snapshot/render.');},apply:async()=>{throw new Error('Unreachable invalid operation.');}});
 for(const body of [{title:{nested:'untrusted'}},{requestDetails:'x'.repeat(601)},{requestDate:'x'.repeat(11)},{worshipfulMasterAddress:'x'.repeat(161)}])await assert.rejects(()=>createSignatureRequest(authenticated.assistant,{actionId:'owner.dispensation-sign',method:'POST',path:'/api/dispensations',requestKey:'invalid-input-key',body}),error=>error.statusCode===400&&error.code==='INVALID_SIGNATURE_FIELDS');
 check('Nested and oversized creation values fail before rendering or storage',true);
 registerSignatureOperation('owner.treasury-attest',{snapshot:async()=>{throw new Error('Invalid revision must fail before snapshot.');},apply:async()=>{throw new Error('Unreachable invalid revision.');}});
 for(const revision of ['1',0,-1,1.5,Number.MAX_SAFE_INTEGER+1,{}])await assert.rejects(()=>createSignatureRequest(authenticated.assistant,{actionId:'owner.treasury-attest',method:'POST',path:'/api/treasury/fixture/preparer-attest',requestKey:'invalid-revision-key',body:{revision}}),error=>error.statusCode===400&&error.code==='INVALID_SIGNATURE_REVISION');
 check('Treasury revision must be a positive safe integer',true);
 const proposal=(id,extra={})=>({actionId:'documents.sign',method:'POST',path:`/api/documents/${id}/sign`,body:{},requestKey:'synthetic-'+id,...extra});
 await rejects(()=>createSignatureRequest({},proposal('first')),401);
 await rejects(()=>createSignatureRequest(authenticated.assistant,proposal('first',{body:{consent:true}})),400);
 await rejects(()=>createSignatureRequest(authenticated.assistant,{actionId:'owner.report-signature',method:'POST',path:'/api/reports/handoff',body:{},requestKey:'external-report'}),403);
 const first=await createSignatureRequest(authenticated.assistant,proposal('first'));
 const beforeDuplicateRender=renders;
 await assert.rejects(()=>createSignatureRequest(authenticated.assistant,proposal('first',{requestKey:'same-pending-new-key'})),error=>error.statusCode===409&&error.code==='SIGNATURE_REQUEST_ALREADY_QUEUED'&&error.message.includes(first.id));
 check('Different request key cannot duplicate the same pending state',true);
 check('Duplicate state never renders or stores another PDF',renders===beforeDuplicateRender);
 check('Queued request does not sign',(await dbGet("SELECT signed FROM signature_test_records WHERE id='first'")).signed===0);
 check('Frozen PDF hash exact',first.artifactSHA256===sha(artifact));
 check('Approval URL uses configured origin',first.authorizationUrl===`http://127.0.0.1:9999/?signatureRequest=${first.id}`);
 check('Request contains no signature bytes or profile digest',!JSON.stringify(first).includes(sha(image))&&!('profileDigest' in first));
 check('Exact repeated proposal is idempotent',(await createSignatureRequest(authenticated.assistant,proposal('first'))).id===first.id);
 await rejects(()=>createSignatureRequest(authenticated.assistant,proposal('changed',{requestKey:'synthetic-first'})),409);
 await rejects(()=>confirmSignatureRequest(ownerId,first.id,{fingerprint:'wrong',consent:true}),409);
 await rejects(()=>confirmSignatureRequest(ownerId,first.id,{fingerprint:first.fingerprint,consent:false}),400);
 const results=await Promise.all([1,2].map(()=>confirmSignatureRequest(ownerId,first.id,{fingerprint:first.fingerprint,consent:true})));
 check('Concurrent confirmation applies signature once',(await dbGet("SELECT signed FROM signature_test_records WHERE id='first'")).signed===1);
 check('Delivery runs once',deliveries===1);
 const result=await confirmSignatureRequest(ownerId,first.id,{fingerprint:first.fingerprint,consent:true});
 check('Completed replay returns receipt only',result.status==='completed'&&deliveries===1);
 check('Receipt identifies actual actors',result.receipt.appliedBy==='system'&&result.receipt.authorizedBy.userId===ownerId&&result.receipt.requestedBy.assistantId===authenticated.assistant.id);
 check('Delivery warning preserved',result.receipt.notificationState==='warnings'&&result.receipt.notificationWarnings.length===1);
 const changed=await createSignatureRequest(authenticated.assistant,proposal('changed'));await dbRun("UPDATE signature_test_records SET revision=2 WHERE id='changed'");
 await rejects(()=>confirmSignatureRequest(ownerId,changed.id,{fingerprint:changed.fingerprint,consent:true}),409);
 check('Changed document cannot sign',(await dbGet("SELECT signed FROM signature_test_records WHERE id='changed'")).signed===0);
 const rolled=await createSignatureRequest(authenticated.assistant,proposal('rollback'));mode='rollback';await rejects(()=>confirmSignatureRequest(ownerId,rolled.id,{fingerprint:rolled.fingerprint,consent:true}),409);
 check('Business write rolls back with failed operation',(await dbGet("SELECT signed FROM signature_test_records WHERE id='rollback'")).signed===0);
 check('Rolled-back intent cannot be replayed',(await confirmSignatureRequest(ownerId,rolled.id,{fingerprint:rolled.fingerprint,consent:true})).status==='stale');
 mode='normal';const uncertain=await createSignatureRequest(authenticated.assistant,proposal('uncertain'));mode='uncertain';
 const unknown=await confirmSignatureRequest(ownerId,uncertain.id,{fingerprint:uncertain.fingerprint,consent:true});check('Unknown failure is terminal uncertain',unknown.status==='uncertain'&&deliveries===1);
 check('Unknown operation rolled back',(await dbGet("SELECT signed FROM signature_test_records WHERE id='uncertain'")).signed===0);
 mode='normal';check('Uncertain replay never signs',(await confirmSignatureRequest(ownerId,uncertain.id,{fingerprint:uncertain.fingerprint,consent:true})).status==='uncertain');
 const declined=await createSignatureRequest(authenticated.assistant,proposal('declined'));check('Owner can decline',(await declineSignatureRequest(ownerId,declined.id)).status==='declined');
 check('Decline prevents signature',(await confirmSignatureRequest(ownerId,declined.id,{fingerprint:declined.fingerprint,consent:true})).status==='declined');
 const expired=await createSignatureRequest(authenticated.assistant,proposal('expired'));await dbRun('UPDATE assistant_signature_requests SET expires_at=? WHERE id=?',['2020-01-01T00:00:00Z',expired.id]);
 check('Expired confirmation never signs',(await confirmSignatureRequest(ownerId,expired.id,{fingerprint:expired.fingerprint,consent:true})).status==='expired');
 const rotated=await createSignatureRequest(authenticated.assistant,proposal('rotated'));await rotateAssistantToken(ownerId);
 await rejects(()=>confirmSignatureRequest(ownerId,rotated.id,{fingerprint:rotated.fingerprint,consent:true}),409);
 check('Rotation invalidates pending authorization',(await dbGet('SELECT status FROM assistant_signature_requests WHERE id=?',[rotated.id])).status==='stale');
 check('No other synthetic record signed',(await dbAll("SELECT signed FROM signature_test_records WHERE id<>'first'")).every(row=>row.signed===0));
 const audits=await dbAll("SELECT action,details_json,actor_type FROM audit_events WHERE action LIKE 'signature_authorization_%'");
 check('Authorization and application audits retained',audits.some(row=>row.action==='signature_authorization_confirmed')&&audits.some(row=>row.action==='signature_authorization_applied'));
 check('Confirmation audit is human authority, not assistant execution',audits.filter(row=>row.action==='signature_authorization_applied').every(row=>row.actor_type==='human'&&JSON.parse(row.details_json).applicationActor==='system'));
 const fresh=(await authenticateAssistantToken((await rotateAssistantToken(ownerId)).token)).assistant;
 let limited=false;
 for(let index=0;index<35;index++){
   const id='rate-'+index;await dbRun('INSERT INTO signature_test_records(id,revision) VALUES (?,1)',[id]);
   try{await createSignatureRequest(fresh,proposal(id));}catch(error){assert.equal(error.statusCode,429);limited=true;break;}
 }
 check('New signature requests share the bounded recent queue limit',limited);
 await dbRun("INSERT INTO signature_test_records(id,revision) VALUES ('rate-over-limit',1)");
 let renderAtLimit=renders;
 await rejects(()=>createSignatureRequest(fresh,proposal('rate-over-limit')),429).catch(error=>{throw error;});
 check('Rate rejection occurs before PDF rendering',renders===renderAtLimit);
 // Isolated fixture time changes exercise the pending cap independently of the
 // recent limit; no retained history is deleted by production code.
 for(let index=35;index<140;index++){
   await dbRun("UPDATE assistant_signature_requests SET created_at='2020-01-01T00:00:00Z' WHERE assistant_id=?",[fresh.id]);
   const id='pending-'+index;await dbRun('INSERT INTO signature_test_records(id,revision) VALUES (?,1)',[id]);
   try{await createSignatureRequest(fresh,proposal(id));}catch(error){assert.equal(error.statusCode,429);break;}
 }
 const pendingCount=Number((await dbGet("SELECT COUNT(*) AS total FROM assistant_signature_requests WHERE assistant_id=? AND status IN ('pending','processing','uncertain') AND (expires_at>? OR status IN ('processing','uncertain'))",[fresh.id,new Date().toISOString()])).total);
 check('Pending request archive is bounded at 100',pendingCount===100);
 await dbRun("UPDATE assistant_signature_requests SET status='declined',created_at='2020-01-01T00:00:00Z' WHERE assistant_id=?",[fresh.id]);
 await dbRun("UPDATE assistant_signature_requests SET artifact_bytes=decode(repeat('00',67108864),'hex') WHERE id=?",[first.id]);
 await dbRun("INSERT INTO signature_test_records(id,revision) VALUES ('archive-budget',1)");renderAtLimit=renders;
 await assert.rejects(()=>createSignatureRequest(fresh,proposal('archive-budget')),error=>error.statusCode===429&&error.code==='SIGNATURE_ARTIFACT_BUDGET');
 check('64 MiB retained-all-status budget blocks before PDF rendering',renders===renderAtLimit);
 console.log(`${passed} isolated signature authorization integrity, atomicity, replay and post-commit checks passed.`);
} finally {await close();}
