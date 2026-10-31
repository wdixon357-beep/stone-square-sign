import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { currentAssistant, requireHumanOwner } from './assistant-access.js';
import { canonicalAssistantPath, resolveAssistantAction, stableJson, digest, assistantError } from './assistant-actions.js';
import { assertApprovedSignature } from './signature-policy.js';

const now = () => new Date().toISOString();
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const fail = (status, code, message) => Object.assign(assistantError(status, message), { code });
const keysOnly = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const bytes = value => Buffer.from(value || []);
const listColumns = 'id,action_id,method,path,title,kind,status,created_at,expires_at,artifact_sha256,fingerprint,statement,effects_json,signing_role,reason,receipt_json';
const terminal = new Set(['completed','declined','expired','stale','uncertain']);
const adapters = new Map();

// Registration is application wiring, never a network endpoint. Every adapter's
// apply function performs only transactional database work. Delivery is separate.
export function registerSignatureOperation(actionId, operation) {
  if (adapters.has(actionId) || typeof operation?.snapshot !== 'function' || typeof operation?.apply !== 'function') {
    throw new Error('Register each complete signature operation once.');
  }
  adapters.set(actionId, operation);
}
export function signatureBindingValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { sha256: digest(bytes(value)), length: value.length };
  if (Array.isArray(value)) return value.map(signatureBindingValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,signatureBindingValue(item)]));
  return value;
}
const stateDigest = snapshot => digest(stableJson(signatureBindingValue(snapshot)));
let rendererIdentity;
async function rendererDigest() {
  // Include the actual implementation and render dependencies, not only a
  // hand-maintained version label. Confirmation never re-renders a timestamped PDF.
  rendererIdentity ||= (async()=>{
    const root=(await readdir(new URL('.',import.meta.url))).filter(name=>name.endsWith('.js')).sort();
    const publicFiles=(await readdir(new URL('./public/',import.meta.url))).filter(name=>name.endsWith('.js')).sort().map(name=>'public/'+name);
    const files=[...root,...publicFiles,'package.json','package-lock.json','assets/lodge-seal.png','assets/grand-lodge-dispensation-template.pdf'];
    return digest(stableJson(await Promise.all(files.map(async file=>[file,digest(await readFile(new URL(file,import.meta.url)))]))));
  })();
  return rendererIdentity;
}
function approvalOrigin() {
  let url;
  try { url = new URL(process.env.APP_BASE_URL || 'https://stone-square-sign.onrender.com'); }
  catch { throw fail(503,'SIGNATURE_ORIGIN_UNAVAILABLE','The secure confirmation address is unavailable.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw fail(503,'SIGNATURE_ORIGIN_UNAVAILABLE','The secure confirmation address must be a configured HTTPS origin.');
  }
  return url.origin;
}
export async function initSignatureAuthorizationSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS assistant_signature_requests (
    id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistant_services(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
    request_key TEXT NOT NULL, action_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, signing_role TEXT NOT NULL,
    statement TEXT NOT NULL, effects_json TEXT NOT NULL, artifact_bytes BYTEA NOT NULL, artifact_sha256 TEXT NOT NULL,
    state_digest TEXT NOT NULL, renderer_digest TEXT NOT NULL, profile_digest TEXT NOT NULL,
    policy_version INTEGER NOT NULL, token_version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, processing_at TEXT, completed_at TEXT,
    reason TEXT, receipt_json TEXT, UNIQUE(assistant_id,request_key))`);
  await dbRun('CREATE INDEX IF NOT EXISTS assistant_signature_requests_owner ON assistant_signature_requests(owner_user_id,created_at DESC)');
}
async function ownerFor(id, lock = false) {
  const user = await dbGet(`SELECT * FROM users WHERE id=?${lock?' FOR UPDATE':''}`,[id]);
  if (!user || user.role !== 'owner' || user.access_revoked_at) throw fail(403,'OWNER_REQUIRED','Your active Worshipful Master account is required.');
  return user;
}
async function profileFor(user) {
  const profile = await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=? FOR SHARE',[user.id]);
  const policy = await dbGet('SELECT signature_sha256,authorized_at FROM owner_signature_policies WHERE user_id=? FOR SHARE',[user.id]);
  const signature = bytes(profile?.signature_bytes);
  if (!signature.length || !policy) throw fail(409,'APPROVED_SIGNATURE_REQUIRED','Save and approve your signature profile before requesting this confirmation.');
  await assertApprovedSignature(user,signature);
  return digest(stableJson({image:digest(signature),policy}));
}
function currentStatus(row) {
  return row.status === 'pending' && Date.parse(row.expires_at) <= Date.now() ? 'expired' : row.status;
}
export function serializeSignatureRequest(row) {
  const status = currentStatus(row);
  return { id:row.id,actionId:row.action_id,recordId:resolveAssistantAction(row.method,row.path).recordId || 'new-dispensation',
    title:row.title,kind:row.kind,status,createdAt:row.created_at,expiresAt:row.expires_at,
    artifactSHA256:row.artifact_sha256,fingerprint:row.fingerprint,statement:row.statement,
    effects:parse(row.effects_json,[]),signingRole:row.signing_role,ready:status==='pending',
    reason:status==='expired'?'This confirmation expired. Ask Muse to prepare a new request.':row.reason || null,
    authorizationUrl:`${approvalOrigin()}/?signatureRequest=${encodeURIComponent(row.id)}`,
    ...(row.receipt_json?{receipt:parse(row.receipt_json)}:{}) };
}
async function findRequest(id, ownerId, assistantId = null, lock = false) {
  const row = await dbGet(`SELECT * FROM assistant_signature_requests WHERE id=? AND owner_user_id=?${lock?' FOR UPDATE':''}`,[id,ownerId]);
  if (!row || (assistantId && row.assistant_id !== assistantId)) throw fail(404,'SIGNATURE_REQUEST_NOT_FOUND','Signature request not found.');
  return row;
}
async function audit(row, action, details = {}) {
  await dbRun('INSERT INTO audit_events (user_id,action,details_json,created_at) VALUES (?,?,?,?)',
    [row.owner_user_id,action,stableJson({signatureRequestId:row.id,actionId:row.action_id,
      requesterAssistantId:row.assistant_id,...details}),now()]);
}
export async function createSignatureRequest(assistant, input) {
  if (!keysOnly(input,['actionId','method','path','body','requestKey']) || !/^[A-Za-z0-9_.:-]{8,160}$/.test(input.requestKey || '')) {
    throw fail(400,'INVALID_SIGNATURE_REQUEST','Provide the exact action, record path and a unique request key.');
  }
  const method = String(input.method || '').toUpperCase(), path = canonicalAssistantPath(input.path);
  if (path.includes('?') || method !== 'POST') throw fail(400,'INVALID_SIGNATURE_REQUEST','Choose the exact signing POST path without a query.');
  const action = resolveAssistantAction(method,path), operation = adapters.get(action.id);
  if (action.id !== input.actionId || action.mode !== 'personal' || !operation) {
    throw fail(403,'SIGNATURE_REQUEST_UNSUPPORTED','This signing action is not supported by secure confirmation. Open its existing personal workflow.');
  }
  const body = input.body ?? {};
  const allowedBody=action.id==='owner.treasury-attest'?['revision']:action.id==='owner.dispensation-sign'
    ?['requestDate','eventDate','requestDetails','eventTime','locationName','streetAddress','cityState','worshipfulMasterAddress','title']:[];
  if (!keysOnly(body,allowedBody)) {
    throw fail(400,'SIGNATURE_REQUEST_PERSONAL_FLAGS','Muse cannot supply review, attestation, consent, signature or changed-document fields. Prepare the saved record first.');
  }
  if(action.id==='owner.dispensation-sign'){
    const limits={requestDate:10,eventDate:10,requestDetails:600,eventTime:40,locationName:120,streetAddress:120,cityState:120,worshipfulMasterAddress:160,title:200};
    if(Object.entries(body).some(([key,value])=>typeof value!=='string'||value.length>limits[key]))throw fail(400,'INVALID_SIGNATURE_FIELDS','Use plain text within the displayed field limits. Oversized or nested document values cannot be queued.');
  }
  if(action.id==='owner.treasury-attest'&&(!Number.isSafeInteger(body.revision)||body.revision<1))throw fail(400,'INVALID_SIGNATURE_REVISION','Provide the exact positive integer report revision.');
  const payload = stableJson({actionId:action.id,method,path,body});
  return withTransaction(async () => {
    const service = await currentAssistant(assistant), owner = await ownerFor(service.owner_user_id,true);
    // Serialize creation with configuration changes and prevent stale credential
    // creation during rotation. The credential is rechecked after this row lock.
    await dbGet('SELECT id FROM assistant_services WHERE id=? FOR UPDATE',[service.id]);
    const current = await currentAssistant(assistant);
    const existing = await dbGet('SELECT * FROM assistant_signature_requests WHERE assistant_id=? AND request_key=?',[service.id,input.requestKey]);
    if (existing) {
      if (existing.payload_hash !== digest(payload)) throw fail(409,'SIGNATURE_REQUEST_KEY_CONFLICT','This request key already belongs to different signing details.');
      return serializeSignatureRequest(existing);
    }
    const createdAt = now(), expiresAt = new Date(Math.min(Date.parse(createdAt)+15*60_000,Date.parse(current.expires_at))).toISOString();
    const snapshot = await operation.snapshot({owner,action,body,renderArtifact:false,lock:true});
    const profileDigest = await profileFor(owner), renderer = await rendererDigest();
    const metadata = {title:snapshot.title,kind:snapshot.kind,statement:snapshot.statement,effects:snapshot.effects,signingRole:snapshot.signingRole};
    const state = stateDigest({state:snapshot.state,metadata});
    const duplicate=await dbGet(`SELECT * FROM assistant_signature_requests WHERE assistant_id=? AND action_id=? AND path=?
      AND state_digest=? AND profile_digest=? AND renderer_digest=? AND policy_version=? AND token_version=?
      AND ((status='pending' AND expires_at>?) OR status IN ('processing','uncertain')) ORDER BY created_at DESC LIMIT 1`,
      [current.id,action.id,path,state,profileDigest,renderer,current.policy_version,current.token_version,createdAt]);
    if(duplicate)throw fail(409,'SIGNATURE_REQUEST_ALREADY_QUEUED',`A matching signing request already exists. Read its status at /api/assistant/signature-requests/${duplicate.id} and use its original request key. No second request was created.`);
    const recentSince=new Date(Date.parse(createdAt)-60_000).toISOString();
    const pending=await dbGet(`SELECT
      (SELECT COUNT(*) FROM assistant_signature_requests WHERE assistant_id=? AND ((status='pending' AND expires_at>?) OR status IN ('processing','uncertain')))
      +(SELECT COUNT(*) FROM assistant_requests WHERE assistant_id=? AND status IN ('pending','personal','approved','executing','uncertain') AND (expires_at>? OR status IN ('executing','uncertain'))) AS count`,[current.id,createdAt,current.id,createdAt]);
    const recent=await dbGet(`SELECT (SELECT COUNT(*) FROM assistant_signature_requests WHERE assistant_id=? AND created_at>?)
      +(SELECT COUNT(*) FROM assistant_requests WHERE assistant_id=? AND created_at>?) AS count`,[current.id,recentSince,current.id,recentSince]);
    const retained=Number((await dbGet('SELECT COALESCE(SUM(octet_length(artifact_bytes)),0) AS bytes FROM assistant_signature_requests WHERE assistant_id=?',[current.id])).bytes);
    const artifactBudget=64*1024*1024;
    if(Number(pending.count)>=100||Number(recent.count)>=30)throw fail(429,'SIGNATURE_QUEUE_FULL','Review the existing assistant queue before requesting more signatures.');
    if(retained>=artifactBudget)throw fail(429,'SIGNATURE_ARTIFACT_BUDGET','The retained signature review archive is full. Use the existing personal signing workflow; no history was deleted.');
    const rendered=await operation.snapshot({owner,action,body,renderArtifact:true,lock:true});
    const renderedMetadata={title:rendered.title,kind:rendered.kind,statement:rendered.statement,effects:rendered.effects,signingRole:rendered.signingRole};
    if(stateDigest({state:rendered.state,metadata:renderedMetadata})!==state)throw fail(409,'SIGNATURE_REQUEST_STALE','The signing details changed while preparing the PDF. Nothing was queued.');
    const artifact = bytes(rendered.artifact);
    if (!artifact.length || artifact.length>12*1024*1024 || artifact.subarray(0,5).toString()!=='%PDF-') throw fail(409,'SIGNATURE_ARTIFACT_UNAVAILABLE','The complete review PDF is unavailable. Nothing was authorized.');
    if(retained+artifact.length>artifactBudget)throw fail(429,'SIGNATURE_ARTIFACT_BUDGET','The retained signature review archive cannot hold this complete PDF. Use the existing personal signing workflow; no history was deleted.');
    const id = crypto.randomUUID(), artifactHash = digest(artifact);
    const fingerprint = digest(stableJson({id,ownerId:owner.id,assistantId:current.id,tokenVersion:current.token_version,
      policyVersion:current.policy_version,payloadHash:digest(payload),state,profileDigest,renderer,artifactHash,metadata,createdAt,expiresAt}));
    await dbRun(`INSERT INTO assistant_signature_requests (id,assistant_id,owner_user_id,request_key,action_id,method,path,body_json,
      payload_hash,title,kind,signing_role,statement,effects_json,artifact_bytes,artifact_sha256,state_digest,renderer_digest,profile_digest,
      policy_version,token_version,fingerprint,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      [id,current.id,owner.id,input.requestKey,action.id,method,path,stableJson(body),digest(payload),snapshot.title,snapshot.kind,
        snapshot.signingRole,snapshot.statement,stableJson(snapshot.effects),artifact,artifactHash,state,renderer,profileDigest,
        current.policy_version,current.token_version,fingerprint,createdAt,expiresAt]);
    const row = await findRequest(id,owner.id);
    await audit(row,'signature_authorization_requested',{artifactSHA256:artifactHash,expiresAt,automaticRetryAllowed:false});
    return serializeSignatureRequest(row);
  });
}
async function validatePending(row, owner) {
  if (currentStatus(row)!=='pending' && row.status!=='processing') throw fail(409,'SIGNATURE_REQUEST_NOT_PENDING','This confirmation is no longer pending. Read its receipt before doing anything else.');
  if (Date.parse(row.expires_at)<=Date.now()) throw fail(409,'SIGNATURE_REQUEST_EXPIRED','This confirmation expired. Ask Muse to prepare a new request.');
  const service = await dbGet('SELECT * FROM assistant_services WHERE id=? FOR UPDATE',[row.assistant_id]);
  if (service?.owner_user_id!==row.owner_user_id || !service?.enabled || service.revoked_at || !service.token_hash || Date.parse(service.expires_at)<=Date.now()
      || service.policy_version!==row.policy_version || service.token_version!==row.token_version) {
    throw fail(409,'SIGNATURE_REQUEST_STALE','Muse access changed. Ask Muse to prepare a new request.');
  }
  if (await profileFor(owner)!==row.profile_digest || await rendererDigest()!==row.renderer_digest) throw fail(409,'SIGNATURE_REQUEST_STALE','The saved signature or signing software changed. Prepare a new confirmation.');
  if (digest(bytes(row.artifact_bytes))!==row.artifact_sha256) throw fail(409,'SIGNATURE_REQUEST_STALE','The retained review PDF failed its integrity check. Nothing was signed.');
  const action = resolveAssistantAction(row.method,row.path), operation = adapters.get(action.id);
  if (!operation) throw fail(409,'SIGNATURE_REQUEST_STALE','This signing operation is unavailable.');
  const body = parse(row.body_json,{}), snapshot = await operation.snapshot({owner,action,body,renderArtifact:false,lock:true});
  const metadata = {title:snapshot.title,kind:snapshot.kind,statement:snapshot.statement,effects:snapshot.effects,signingRole:snapshot.signingRole};
  if (stateDigest({state:snapshot.state,metadata})!==row.state_digest) throw fail(409,'SIGNATURE_REQUEST_STALE','The document, assignment or signing details changed. Review a new confirmation.');
  return {action,operation,body,snapshot};
}
export async function confirmSignatureRequest(ownerId,id,input,requestContext={}) {
  if (!keysOnly(input,['fingerprint','consent']) || input.consent!==true) throw fail(400,'SIGNATURE_CONSENT_REQUIRED','Choose Authorize and apply signature to confirm this exact version.');
  // Persist processing before any business write. A crash or unknown commit
  // outcome cannot turn a second click into another signing attempt.
  let claimed = false;
  try {
    const existing = await withTransaction(async () => {
      const owner = await ownerFor(ownerId,true), row = await findRequest(id,ownerId,null,true);
      if (row.fingerprint!==input.fingerprint) throw fail(409,'SIGNATURE_FINGERPRINT_MISMATCH','This confirmation differs from the version displayed. Reopen it.');
      if (terminal.has(currentStatus(row)) || row.status==='processing') return serializeSignatureRequest(row);
      try { await validatePending(row,owner); } catch(error) {
        if (error.statusCode && error.statusCode<500 && error.code!=='SIGNATURE_REQUEST_EXPIRED') {error.code='SIGNATURE_REQUEST_STALE';error.statusCode=409;}
        throw error;
      }
      await dbRun("UPDATE assistant_signature_requests SET status='processing',processing_at=? WHERE id=? AND status='pending'",[now(),id]);
      await audit(row,'signature_authorization_confirmed',{authorizedByUserId:owner.id,applicationActor:'system',statement:row.statement,effects:parse(row.effects_json,[]),artifactSHA256:row.artifact_sha256});
      claimed = true;
      return null;
    });
    if (existing) return existing;
  } catch(error) {
    if (error.code==='SIGNATURE_REQUEST_STALE' || error.code==='SIGNATURE_REQUEST_EXPIRED') await dbRun("UPDATE assistant_signature_requests SET status=?,reason=? WHERE id=? AND owner_user_id=? AND status='pending'",[error.code==='SIGNATURE_REQUEST_EXPIRED'?'expired':'stale',error.message,id,ownerId]);
    throw error;
  }
  if (!claimed) throw fail(409,'SIGNATURE_REQUEST_NOT_PENDING','Read the request status before continuing.');
  let operation, outcome, appliedRequest;
  try {
    await withTransaction(async () => {
      const owner = await ownerFor(ownerId,true), row = await findRequest(id,ownerId,null,true);
      if (row.status!=='processing') throw fail(409,'SIGNATURE_REQUEST_NOT_PENDING','This request already has a recorded outcome.');
      const validated = await validatePending(row,owner); operation = validated.operation;
      const req = {...requestContext,user:owner,assistant:null,params:{id:validated.action.recordId},body:validated.body,signatureAuthorizationSnapshot:validated.snapshot};
      appliedRequest = req;
      outcome = await operation.apply(req);
      if(!validated.action.recordId && (typeof outcome?.documentId!=='string'||!outcome.documentId))throw fail(500,'SIGNATURE_RECORD_UNVERIFIED','The created record could not be verified.');
      await operation.verifyOutcome?.(outcome,req);
      const completedAt = now(), receipt = {authorizedBy:{userId:owner.id,name:owner.name},requestedBy:{assistantId:row.assistant_id,
        name:(await dbGet('SELECT name FROM assistant_services WHERE id=?',[row.assistant_id]))?.name || 'Muse Assistant'},appliedBy:'system',
        recordId:outcome?.documentId || validated.action.recordId,actionId:row.action_id,completedAt,notificationState:'pending',notificationWarnings:[],automaticRetryAllowed:false};
      await dbRun("UPDATE assistant_signature_requests SET status='completed',completed_at=?,receipt_json=? WHERE id=? AND status='processing'",[completedAt,stableJson(receipt),id]);
      await audit(row,'signature_authorization_applied',{authorizedByUserId:owner.id,applicationActor:'system',recordId:outcome?.documentId || validated.action.recordId,artifactSHA256:row.artifact_sha256});
    });
  } catch(error) {
    // Even a transport error after COMMIT must never overwrite a completed
    // receipt. No automatic reapplication is offered for uncertain outcomes.
    const safeFailure = error.statusCode && error.statusCode<500;
    await dbRun("UPDATE assistant_signature_requests SET status=?,reason=? WHERE id=? AND owner_user_id=? AND status='processing'",
      [safeFailure?'stale':'uncertain',safeFailure?error.message:'The signing outcome needs verification. Read the record and receipt; do not repeat the signature.',id,ownerId]);
    if (safeFailure) throw error;
    return serializeSignatureRequest(await findRequest(id,ownerId));
  }
  let warnings=[],notificationState='completed';
  try {
    const result = await operation.afterCommit?.(outcome,appliedRequest);
    warnings = (result?.notificationWarnings || []).filter(value=>typeof value==='string').map(value=>value.slice(0,500)).slice(0,20);
    if (warnings.length) notificationState='warnings';
  } catch { notificationState='uncertain'; warnings=['The signature is saved. Notification delivery needs verification; it was not automatically repeated.']; }
  // This is delivery metadata only. A lost update leaves pending, which is a
  // verification task rather than permission to resend or sign again.
  await withTransaction(async () => {
    const row = await findRequest(id,ownerId,null,true), receipt=parse(row.receipt_json,{});
    await dbRun('UPDATE assistant_signature_requests SET receipt_json=? WHERE id=?',[stableJson({...receipt,notificationState,notificationWarnings:warnings}),id]);
  });
  return serializeSignatureRequest(await findRequest(id,ownerId));
}
// A fresh detail read may invalidate request metadata, but never signs or
// retries business work. It exposes nonready state before the owner confirms.
export async function readSignatureRequest(id,ownerId,assistantId=null) {
  return withTransaction(async()=>{
    const owner=await ownerFor(ownerId,true),row=await findRequest(id,ownerId,assistantId,true);
    if(row.status==='pending'){
      try{await validatePending(row,owner);}catch(error){
        if(error.statusCode&&error.statusCode<500){
          const status=error.code==='SIGNATURE_REQUEST_EXPIRED'?'expired':'stale';
          await dbRun("UPDATE assistant_signature_requests SET status=?,reason=? WHERE id=? AND status='pending'",[status,error.message,id]);
          return serializeSignatureRequest(await findRequest(id,ownerId,assistantId));
        }
        throw error;
      }
    }
    return serializeSignatureRequest(row);
  });
}
export async function declineSignatureRequest(ownerId,id,input={}) {
  if (!keysOnly(input,['note']) || (input.note!==undefined && typeof input.note!=='string') || String(input.note || '').length>1000) throw fail(400,'INVALID_SIGNATURE_DECLINE','Provide an optional note of at most 1000 characters.');
  return withTransaction(async () => {
    await ownerFor(ownerId,true);const row=await findRequest(id,ownerId,null,true);
    if (row.status==='pending') { await dbRun("UPDATE assistant_signature_requests SET status='declined',reason=? WHERE id=?",[String(input.note || '').trim() || 'Declined by the owner.',id]);await audit(row,'signature_authorization_declined'); }
    return serializeSignatureRequest(await findRequest(id,ownerId));
  });
}
export function mountSignatureAuthorizationRoutes(app,{requireAuth,requireOwner}) {
  const route = fn => async(req,res,next)=>{try{res.setHeader('Cache-Control','private, no-store');res.setHeader('Pragma','no-cache');await fn(req,res);}catch(error){next(error);}};
  const human=[requireAuth,requireOwner,requireHumanOwner];
  const identity=async req=>req.assistant?{service:await currentAssistant(req.assistant)}:{owner:await ownerFor(req.user.id)};
  app.post('/api/assistant/signature-requests',requireAuth,route(async(req,res)=>{
    if(!req.assistant)throw fail(403,'ASSISTANT_REQUESTER_REQUIRED','Muse must request this confirmation using its separate service access.');
    res.status(201).json({request:await createSignatureRequest(req.assistant,req.body)});
  }));
  app.get('/api/assistant/signature-requests',requireAuth,route(async(req,res)=>{
    const {service,owner}=await identity(req),rows=service?await dbAll(`SELECT ${listColumns} FROM assistant_signature_requests WHERE owner_user_id=? AND assistant_id=? ORDER BY created_at DESC LIMIT 100`,[service.owner_user_id,service.id]):await dbAll(`SELECT ${listColumns} FROM assistant_signature_requests WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 100`,[owner.id]);
    res.json({requests:rows.map(serializeSignatureRequest)});
  }));
  app.get('/api/assistant/signature-requests/:id',requireAuth,route(async(req,res)=>{
    const {service,owner}=await identity(req);res.json({request:await readSignatureRequest(req.params.id,service?.owner_user_id || owner.id,service?.id)});
  }));
  app.get('/api/assistant/signature-requests/:id/preview',...human,route(async(req,res)=>{
    await ownerFor(req.user.id);const row=await findRequest(req.params.id,req.user.id);
    if(digest(bytes(row.artifact_bytes))!==row.artifact_sha256)throw fail(409,'SIGNATURE_ARTIFACT_CONFLICT','The retained review PDF failed its integrity check.');
    res.setHeader('Content-Disposition','inline; filename="signature-review.pdf"');res.setHeader('X-Artifact-SHA256',row.artifact_sha256);res.type('application/pdf').send(bytes(row.artifact_bytes));
  }));
  app.post('/api/assistant/signature-requests/:id/confirm',...human,route(async(req,res)=>res.json({request:await confirmSignatureRequest(req.user.id,req.params.id,req.body,{ip:req.ip,get:req.get.bind(req),protocol:req.protocol,headers:req.headers})})));
  app.post('/api/assistant/signature-requests/:id/decline',...human,route(async(req,res)=>res.json({request:await declineSignatureRequest(req.user.id,req.params.id,req.body)})));
}
