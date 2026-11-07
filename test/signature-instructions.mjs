import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { connect,initSchema,dbGet,dbAll,dbRun,close,getAuditActor,isDatabaseTransactionActive } from '../db.js';
import { initSignaturePolicySchema,pinApprovedOwnerSignature } from '../signature-policy.js';
import { initAssistantSchema,createAssistantService,rotateAssistantToken,authenticateAssistantToken,revokeAssistantService } from '../assistant-access.js';
import { initSignatureAuthorizationSchema,registerSignatureOperation,createSignatureRequest,executeSignatureInstruction } from '../signature-authorizations.js';
assert.equal(process.env.DATABASE_URL || '','');assert.equal(process.env.PGLITE_DIR || '','');
process.env.NODE_ENV='test';process.env.APP_BASE_URL='http://127.0.0.1:9999';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const reject=(work,status)=>assert.rejects(work,error=>error.statusCode===status);
let count=0,deliveries=0;
const check=(label,value)=>{assert.ok(value,label);count++;};
await connect();
try {
  await initSchema();await initAssistantSchema();await initSignaturePolicySchema();await initSignatureAuthorizationSchema();
  const createdAt=new Date().toISOString(),image=Buffer.from('Synthetic signature, never personal data');
  const ownerId=(await dbRun("INSERT INTO users(email,password_hash,name,role,created_at) VALUES ('owner@example.test','unused','Synthetic Owner','owner',?)",[createdAt])).lastID;
  await dbRun("INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,'drawn',?)",[ownerId,image,createdAt]);
  await pinApprovedOwnerSignature({ownerUserId:ownerId,expectedProfileSha256:sha(image),authorizationNote:'Synthetic signature approved for isolated tests.'});
  await createAssistantService({ownerUserId:ownerId,permissions:[],expiresInDays:1});
  let token=(await rotateAssistantToken(ownerId)).token,assistant=(await authenticateAssistantToken(token)).assistant;
  await dbRun('CREATE TABLE signature_instruction_fixture(id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1,signed INTEGER NOT NULL DEFAULT 0)');
  const pdf=await PDFDocument.create();pdf.addPage();const artifact=Buffer.from(await pdf.save());
  registerSignatureOperation('documents.sign',{
    snapshot:async({action,renderArtifact})=>{
      const row=await dbGet('SELECT * FROM signature_instruction_fixture WHERE id=? FOR UPDATE',[action.recordId]);
      if(!row)throw Object.assign(new Error('Missing fixture'),{statusCode:404});
      return {title:'Synthetic '+row.id,kind:'document',signingRole:'owner',statement:'Apply my signature to this exact synthetic document.',effects:['Apply this signature only.'],state:row,...(renderArtifact?{artifact}:{})};
    },
    apply:async req=>{
      assert.equal(req.signatureExecutionAuthorization.source,'owner_delegation');
      assert.equal(getAuditActor()?.assistantId,assistant.id);
      await dbRun('UPDATE signature_instruction_fixture SET signed=signed+1 WHERE id=?',[req.params.id]);
      await dbRun('INSERT INTO audit_events(user_id,action,details_json,created_at) VALUES (?,?,?,?)',[req.user.id,'synthetic_delegated_business_write','{}',createdAt]);
      if(req.params.id==='uncertain')throw new Error('Synthetic unknown operation failure');
      if(req.params.id==='rollback')throw Object.assign(new Error('Synthetic existing business guard'),{statusCode:409});
      return {id:req.params.id};
    },
    afterCommit:async()=>{assert.equal(isDatabaseTransactionActive(),false);assert.equal(getAuditActor()?.assistantId,assistant.id);deliveries++;return {};},
  });
  const propose=async(id,key=id)=>{
    await dbRun('INSERT INTO signature_instruction_fixture(id) VALUES (?) ON CONFLICT DO NOTHING',[id]);
    return createSignatureRequest(assistant,{actionId:'documents.sign',method:'POST',path:`/api/documents/${id}/sign`,body:{},requestKey:'test-instruction-'+key});
  };
  const input=request=>({fingerprint:request.fingerprint,instruction:'Sign the exact synthetic document I reviewed.',instructionReference:'synthetic-chat-message-1'});
  const off=await propose('off');
  await reject(()=>executeSignatureInstruction(assistant,off.id,input(off)),403);
  check('Instructed signatures default off',(await dbGet("SELECT signed FROM signature_instruction_fixture WHERE id='off'")).signed===0);
  await createAssistantService({ownerUserId:ownerId,permissions:[],expiresInDays:1,signatureExecution:true});
  await reject(()=>executeSignatureInstruction(assistant,off.id,input(off)),409);
  check('Enabling access does not retroactively authorize old request',(await dbGet('SELECT status FROM assistant_signature_requests WHERE id=?',[off.id])).status==='stale');
  const first=await propose('first');
  for(const body of [{...input(first),ownerId},{...input(first),consent:true},{...input(first),instruction:''},{...input(first),instruction:'x'.repeat(2001)}])await reject(()=>executeSignatureInstruction(assistant,first.id,body),400);
  await reject(()=>executeSignatureInstruction({},first.id,input(first)),401);
  await reject(()=>executeSignatureInstruction(assistant,first.id,{...input(first),fingerprint:'wrong'}),409);
  check('Instruction never sets human consent or owner identity',true);
  const otherOwner=(await dbRun("INSERT INTO users(email,password_hash,name,role,created_at) VALUES ('other@example.test','unused','Other synthetic owner','owner',?)",[createdAt])).lastID;
  await createAssistantService({ownerUserId:otherOwner,permissions:[],expiresInDays:1,signatureExecution:true});
  const other=(await authenticateAssistantToken((await rotateAssistantToken(otherOwner)).token)).assistant;
  await reject(()=>executeSignatureInstruction(other,first.id,input(first)),404);
  check('Another assistant cannot execute the owner request',true);
  await Promise.all([1,2].map(()=>executeSignatureInstruction(assistant,first.id,input(first))));
  const completed=await executeSignatureInstruction(assistant,first.id,input(first));
  check('Concurrent and repeated calls sign exactly once',(await dbGet("SELECT signed FROM signature_instruction_fixture WHERE id='first'")).signed===1&&deliveries===1);
  check('Receipt distinguishes delegation from human confirmation',completed.receipt.authorization.source==='owner_delegation'&&completed.receipt.authorization.instructionProvenance==='relayed_by_assistant'&&completed.receipt.authorization.independentHumanVerification===false&&completed.receipt.executedBy.assistantId===assistant.id);
  check('Exact instruction and grant are retained',completed.receipt.authorization.instruction===input(first).instruction&&completed.receipt.authorization.instructionReference===input(first).instructionReference&&Number.isInteger(completed.receipt.authorization.policyVersion));
  check('Receipt contains no signature bytes',!JSON.stringify(completed).includes(image.toString())&&!JSON.stringify(completed).includes(sha(image)));
  const business=(await dbAll("SELECT actor_type,actor_id,on_behalf_of_user_id FROM audit_events WHERE action='synthetic_delegated_business_write'"));
  check('Business audit identifies Muse acting for owner',business.length===1&&business[0].actor_type==='assistant'&&business[0].actor_id===assistant.id&&business[0].on_behalf_of_user_id===ownerId);
  const changed=await propose('changed');await dbRun("UPDATE signature_instruction_fixture SET revision=2 WHERE id='changed'");
  await reject(()=>executeSignatureInstruction(assistant,changed.id,input(changed)),409);
  check('Changed document does not sign',(await dbGet("SELECT signed FROM signature_instruction_fixture WHERE id='changed'")).signed===0);
  const expired=await propose('expired');await dbRun("UPDATE assistant_signature_requests SET expires_at='2020-01-01T00:00:00Z' WHERE id=?",[expired.id]);
  check('Expired request stays unsigned',(await executeSignatureInstruction(assistant,expired.id,input(expired))).status==='expired');
  const profile=await propose('profile');await dbRun('UPDATE profile_signatures SET signature_bytes=? WHERE user_id=?',[Buffer.from('changed synthetic image'),ownerId]);
  await reject(()=>executeSignatureInstruction(assistant,profile.id,input(profile)),409);
  await dbRun('UPDATE profile_signatures SET signature_bytes=? WHERE user_id=?',[image,ownerId]);
  check('Changed stored signature invalidates request',true);
  const rollback=await propose('rollback');await reject(()=>executeSignatureInstruction(assistant,rollback.id,input(rollback)),409);
  check('Business rejection rolls back without replay',(await executeSignatureInstruction(assistant,rollback.id,input(rollback))).status==='stale'&&(await dbGet("SELECT signed FROM signature_instruction_fixture WHERE id='rollback'")).signed===0);
  const uncertain=await propose('uncertain');const unknown=await executeSignatureInstruction(assistant,uncertain.id,input(uncertain));
  check('Uncertain outcome is terminal and not retried',unknown.status==='uncertain'&&(await executeSignatureInstruction(assistant,uncertain.id,input(uncertain))).status==='uncertain'&&deliveries===1);
  const disabled=await propose('disabled');await createAssistantService({ownerUserId:ownerId,permissions:[],expiresInDays:1,signatureExecution:false});
  await reject(()=>executeSignatureInstruction(assistant,disabled.id,input(disabled)),403);
  await createAssistantService({ownerUserId:ownerId,permissions:[],expiresInDays:1,signatureExecution:true});
  const rotated=await propose('rotated');token=(await rotateAssistantToken(ownerId)).token;
  await reject(()=>executeSignatureInstruction(assistant,rotated.id,input(rotated)),401);
  assistant=(await authenticateAssistantToken(token)).assistant;
  await reject(()=>executeSignatureInstruction(assistant,rotated.id,input(rotated)),409);
  check('Grant changes and token rotation prevent old execution',true);
  const revoked=await propose('revoked');await revokeAssistantService(ownerId);
  await reject(()=>executeSignatureInstruction(assistant,revoked.id,input(revoked)),401);
  check('Revocation immediately prevents signature execution',true);
  check('No other records signed',(await dbAll("SELECT signed FROM signature_instruction_fixture WHERE id<>'first'")).every(row=>row.signed===0));
  const audit=await dbGet("SELECT actor_type,details_json FROM audit_events WHERE action='signature_authorization_applied'");
  check('Application audit never calls delegated execution human',audit.actor_type==='assistant'&&JSON.parse(audit.details_json).applicationActor==='assistant'&&JSON.parse(audit.details_json).authorizationSource==='owner_delegation');
  console.log(`${count} isolated instructed-signature provenance, integrity and replay checks passed.`);
} finally { await close(); }
