import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun, withTransaction, isUniqueViolation, isDatabaseTransactionActive } from './db.js';
import { ASSISTANT_CAPABILITIES, assistantCapability, assistantError, digest, stableJson,
  canonicalAssistantPath, resolveAssistantAction, isAssistantControlRoute, assistantRecordState,
  assertNoAssistantAttestation } from './assistant-actions.js';
export { ASSISTANT_CAPABILITIES, resolveAssistantAction, isAssistantControlRoute } from './assistant-actions.js';

const TOKEN_PREFIX = 'ss22_muse_';
const MAX_BODY_BYTES = 512_000;
const authProof = new WeakMap();
const now = () => new Date().toISOString();
const plus = (time, milliseconds) => new Date(Date.parse(time) + milliseconds).toISOString();
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const text = (value, maximum) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const ownKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const boundedJson = value => {
  const serialized = stableJson(value ?? {});
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw assistantError(413, 'The assistant request is too large.');
  return serialized;
};
const safeService = row => row ? { id: row.id, name: row.name, enabled: Boolean(row.enabled),
  expiresAt: row.expires_at, permissions: parse(row.permissions_json, []), createdAt: row.created_at,
  updatedAt: row.updated_at, tokenIssuedAt: row.token_issued_at || null, hasToken: Boolean(row.token_hash),
  revokedAt: row.revoked_at || null } : null;
const serviceByOwner = ownerId => dbGet('SELECT * FROM assistant_services WHERE owner_user_id=?',[ownerId]);

export async function initAssistantSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS assistant_services (
    id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id), name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false, expires_at TEXT NOT NULL, permissions_json TEXT NOT NULL,
    policy_version INTEGER NOT NULL DEFAULT 1, token_version INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT UNIQUE, token_issued_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS assistant_requests (
    id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistant_services(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
    request_key TEXT NOT NULL, action_id TEXT NOT NULL, title TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
    body_json TEXT NOT NULL, files_json TEXT NOT NULL DEFAULT '[]', payload_hash TEXT NOT NULL,
    record_fingerprint TEXT NOT NULL, fingerprint TEXT NOT NULL, policy_version INTEGER NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, decision_note TEXT,
    navigation_json TEXT, receipt_json TEXT, UNIQUE(assistant_id,request_key))`);
  await dbRun(`CREATE INDEX IF NOT EXISTS assistant_requests_owner ON assistant_requests(owner_user_id,created_at DESC)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS assistant_executions (
    id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistant_services(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT UNIQUE REFERENCES assistant_requests(id), idempotency_key TEXT NOT NULL, action_id TEXT NOT NULL,
    method TEXT NOT NULL, path TEXT NOT NULL, payload_hash TEXT NOT NULL, record_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, response_status INTEGER, receipt_json TEXT,
    UNIQUE(assistant_id,idempotency_key))`);
  await dbRun(`CREATE TABLE IF NOT EXISTS assistant_activity (
    id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistant_services(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
    actor_type TEXT NOT NULL, action TEXT NOT NULL, request_id TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await dbRun('CREATE INDEX IF NOT EXISTS assistant_activity_owner ON assistant_activity(owner_user_id,created_at DESC)');
}

async function requireCurrentOwner(ownerId) {
  const owner = await dbGet('SELECT * FROM users WHERE id=?',[ownerId]);
  if (!owner || owner.role !== 'owner' || owner.access_revoked_at) throw assistantError(403, 'Current Worshipful Master access is required.');
  return owner;
}
function validService(row, time = now()) {
  if (!row || !row.enabled || row.revoked_at || !row.token_hash || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.parse(time)) {
    throw assistantError(401, 'Muse Assistant access has expired or been revoked.');
  }
  return row;
}
async function activity(row, actorType, action, requestId = null, details = {}) {
  await dbRun('INSERT INTO assistant_activity (id,assistant_id,owner_user_id,actor_type,action,request_id,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [crypto.randomUUID(),row.id,row.owner_user_id,actorType,action,requestId,boundedJson(details),now()]);
}

export async function createAssistantService({ ownerUserId, name = 'Muse Assistant', permissions = [], expiresInDays = 7, enabled = true }) {
  await requireCurrentOwner(ownerUserId);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30 || typeof enabled !== 'boolean') {
    throw assistantError(400, 'Choose an expiry from 1 to 30 days and a valid access setting.');
  }
  if (!Array.isArray(permissions) || permissions.some(id => {
    const item = assistantCapability(id); return !item || !['standing','approval'].includes(item.mode);
  })) throw assistantError(400, 'Only listed preparation and approval actions can be granted. Personal actions stay with you.');
  const cleanedName = text(name, 80);
  if (!cleanedName) throw assistantError(400, 'Enter an assistant name.');
  const time = now(), expiry = plus(time, expiresInDays * 86400000), grants = [...new Set(permissions)].sort();
  return withTransaction(async () => {
    const previous = await serviceByOwner(ownerUserId);
    if (previous) {
      await dbRun(`UPDATE assistant_services SET name=?,enabled=?,expires_at=?,permissions_json=?,policy_version=policy_version+1,
        revoked_at=?,updated_at=? WHERE id=?`,[cleanedName,enabled,expiry,stableJson(grants),enabled?null:time,time,previous.id]);
      if (!enabled) await dbRun('UPDATE assistant_services SET token_hash=NULL,token_version=token_version+1 WHERE id=?',[previous.id]);
    } else {
      await dbRun(`INSERT INTO assistant_services (id,owner_user_id,name,enabled,expires_at,permissions_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),ownerUserId,cleanedName,enabled,expiry,stableJson(grants),time,time]);
    }
    const row = await serviceByOwner(ownerUserId);
    await activity(row,'human','access_saved',null,{ permissions: grants, enabled, expiresAt: expiry });
    return safeService(row);
  });
}

export async function rotateAssistantToken(ownerUserId) {
  await requireCurrentOwner(ownerUserId);
  return withTransaction(async () => {
    const row = await serviceByOwner(ownerUserId), time = now();
    if (!row?.enabled || row.revoked_at || Date.parse(row.expires_at) <= Date.parse(time)) throw assistantError(409, 'Save enabled, current assistant access before issuing a token.');
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    await dbRun(`UPDATE assistant_services SET token_hash=?,token_issued_at=?,token_version=token_version+1,
      policy_version=policy_version+1,updated_at=? WHERE id=?`,[digest(token),time,time,row.id]);
    await activity(row,'human','token_rotated');
    return { assistant: safeService(await serviceByOwner(ownerUserId)), token };
  });
}
export async function revokeAssistantService(ownerUserId) {
  await requireCurrentOwner(ownerUserId);
  const row = await serviceByOwner(ownerUserId);
  if (row) await withTransaction(async () => {
    const time = now();
    await dbRun(`UPDATE assistant_services SET enabled=false,token_hash=NULL,revoked_at=?,updated_at=?,
      policy_version=policy_version+1,token_version=token_version+1 WHERE id=?`,[time,time,row.id]);
    await activity(row,'human','access_revoked');
  });
  return { ok: true };
}
export async function authenticateAssistantToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  if (!/^ss22_muse_[A-Za-z0-9_-]{43}$/.test(rawToken)) throw assistantError(401, 'Invalid Muse Assistant credential.');
  const row = validService(await dbGet('SELECT * FROM assistant_services WHERE token_hash=?',[digest(rawToken)]));
  const user = await requireCurrentOwner(row.owner_user_id), assistant = safeService(row);
  authProof.set(assistant,{ tokenHash: row.token_hash, tokenVersion: row.token_version });
  return { assistant, user };
}
async function currentAssistant(assistant) {
  const proof = authProof.get(assistant);
  if (!proof) throw assistantError(401, 'A verified Muse Assistant credential is required.');
  const row = validService(await dbGet('SELECT * FROM assistant_services WHERE id=?',[assistant.id]));
  await requireCurrentOwner(row.owner_user_id);
  if (row.token_hash !== proof.tokenHash || row.token_version !== proof.tokenVersion) throw assistantError(401, 'This Muse Assistant credential has been replaced.');
  return row;
}
const hasGrant = (row, action) => parse(row.permissions_json,[]).includes(action.id);
function checkActionGrant(row, action, { personalRequest = false } = {}) {
  if (action.mode === 'unavailable') throw assistantError(403, action.description);
  if (action.mode === 'personal') {
    if (personalRequest) return;
    throw assistantError(403, 'This action requires your own review and tap in the website or Mac app.');
  }
  if (!hasGrant(row,action)) throw assistantError(403, 'This action has not been granted to Muse Assistant.');
}

export function assistantFiles(req) {
  let values = req.file ? [req.file] : [];
  if (Array.isArray(req.files)) values = values.concat(req.files);
  else if (req.files && typeof req.files === 'object') values = values.concat(...Object.values(req.files));
  return values.map(file => {
    if (!Buffer.isBuffer(file.buffer)) throw assistantError(400, 'The actual uploaded file bytes are required for approval.');
    return { fieldname: String(file.fieldname || ''), originalname: String(file.originalname || ''),
      mimetype: String(file.mimetype || ''), size: file.buffer.length, sha256: digest(file.buffer) };
  });
}
function validateFiles(files = []) {
  if (!Array.isArray(files) || files.length > 12) throw assistantError(400, 'Choose a bounded file list.');
  return files.map(file => {
    if (!ownKeys(file,['fieldname','originalname','mimetype','size','sha256']) || !Number.isInteger(file.size)
      || file.size < 0 || file.size > 30_000_000 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !['fieldname','originalname','mimetype'].every(key => typeof file[key] === 'string' && file[key].length <= 500)) {
      throw assistantError(400, 'Every file needs its exact name, type, byte length and SHA256.');
    }
    return { fieldname:file.fieldname, originalname:file.originalname, mimetype:file.mimetype, size:file.size, sha256:file.sha256 };
  });
}
const payloadHash = (action, body, files) => digest(stableJson({ actionId:action.id, method:action.method,path:action.path,body,files }));
const recordFingerprint = async (action,row) => digest(stableJson(await assistantRecordState(action,row.owner_user_id)));
const requestFingerprint = (row, action, payload, record) => digest(stableJson({ assistantId:row.id,ownerId:row.owner_user_id,
  policyVersion:row.policy_version,actionId:action.id,method:action.method,path:action.path,payload,record }));
async function checkBodyClaims(action,body,ownerId) {
  const kind=action.recordTable==='meeting_minutes'?'minutes':action.recordTable==='treasury_reports'?'treasury':null;
  const record=kind ? await assistantRecordState(action,ownerId) : null;
  const existingDraft=parse(record?.draft_json);
  if (kind==='treasury' && body?.draft) {
    for (const key of ['extractionNotes','sourceNames']) if (stableJson(body.draft[key]??[])!==stableJson(existingDraft?.[key]??[])) {
      throw assistantError(403,'The retained banking source names and extraction evidence cannot be replaced by Muse Assistant.');
    }
    const sourcePaths=new Set(Object.entries(existingDraft?.fieldReviews||{}).filter(([,state])=>state==='matched').map(([path])=>path));
    for (const note of existingDraft?.extractionNotes||[]) for (const match of String(note).matchAll(/Source evidence: ([a-z]+\[?\d*\]?\.[A-Za-z0-9_.\[\]-]+)\s*[→-]/g)) {
      sourcePaths.add(match[1].replaceAll('[','.').replaceAll(']',''));
    }
    const valueAt=(draft,path)=>path.split('.').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,draft);
    for (const path of sourcePaths) if (stableJson(valueAt(existingDraft,path)??null)!==stableJson(valueAt(body.draft,path)??null)) {
      throw assistantError(403,'A source-matched financial value requires your own correction and review.');
    }
  }
  assertNoAssistantAttestation(body,{kind,existingDraft});
}
export function serializeAssistantRequest(row) {
  const action = assistantCapability(row.action_id);
  return { id:row.id,actionId:row.action_id,title:row.title,method:row.method,path:row.path,body:parse(row.body_json,{}),
    files:parse(row.files_json,[]),status:row.status,fingerprint:row.fingerprint,createdAt:row.created_at,expiresAt:row.expires_at,
    decidedAt:row.decided_at,decisionNote:row.decision_note,effects:action?.effects || [],
    navigation:parse(row.navigation_json),receipt:parse(row.receipt_json),mode:action?.mode || 'unavailable' };
}

export async function createAssistantRequest(assistant, input) {
  const row = await currentAssistant(assistant);
  if (!ownKeys(input,['actionId','method','path','body','requestKey','title','files'])) throw assistantError(400, 'Unsupported assistant request fields.');
  const action = resolveAssistantAction(input.method,input.path), body = parse(boundedJson(input.body ?? {})), files = validateFiles(input.files);
  if (action.id !== input.actionId) throw assistantError(400, 'The selected action does not match its exact method and path.');
  checkActionGrant(row,action,{ personalRequest:true });
  // A personal proposal describes the document, not a pre-filled signature or
  // consent. The human supplies the actual consent in the existing workflow.
  await checkBodyClaims(action,body,row.owner_user_id);
  const key = input.requestKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(key)) throw assistantError(400, 'Use one stable request key for this proposal.');
  const payload = payloadHash(action,body,files);
  const previous = await dbGet('SELECT * FROM assistant_requests WHERE assistant_id=? AND request_key=?',[row.id,key]);
  if (previous) {
    if (previous.payload_hash !== payload) throw assistantError(409, 'That request key already belongs to a different proposal.');
    return serializeAssistantRequest(previous);
  }
  const record = await recordFingerprint(action,row), time = now(), id = crypto.randomUUID();
  const fingerprint = requestFingerprint(row,action,payload,record);
  try {
    await withTransaction(async () => {
      await dbGet('SELECT id FROM assistant_services WHERE id=? FOR UPDATE',[row.id]);
      const active=await currentAssistant(assistant);
      if (active.policy_version!==row.policy_version) throw assistantError(409,'Assistant access changed. Refresh before proposing this action.');
      const pending=await dbGet("SELECT COUNT(*) AS count FROM assistant_requests WHERE assistant_id=? AND status IN ('pending','personal','approved','executing','uncertain') AND (expires_at>? OR status IN ('executing','uncertain'))",[row.id,time]);
      const recent=await dbGet('SELECT COUNT(*) AS count FROM assistant_requests WHERE assistant_id=? AND created_at>?',[row.id,plus(time,-60000)]);
      if (Number(pending.count)>=100 || Number(recent.count)>=30) throw assistantError(429,'Review the existing assistant queue before adding more requests.');
      await dbRun(`INSERT INTO assistant_requests (id,assistant_id,owner_user_id,request_key,action_id,title,method,path,body_json,
        files_json,payload_hash,record_fingerprint,fingerprint,policy_version,status,created_at,expires_at,navigation_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,row.id,row.owner_user_id,key,action.id,text(input.title,160)||action.label,
        action.method,action.path,stableJson(body),stableJson(files),payload,record,fingerprint,row.policy_version,
        action.mode==='personal'?'personal':'pending',time,plus(time,3600000),action.navigation?stableJson(action.navigation):null]);
      await activity(row,'assistant','review_requested',id,{actionId:action.id,mode:action.mode});
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const duplicate = await dbGet('SELECT * FROM assistant_requests WHERE assistant_id=? AND request_key=?',[row.id,key]);
    if (!duplicate || duplicate.payload_hash !== payload) throw assistantError(409, 'That request key already belongs to a different proposal.');
    return serializeAssistantRequest(duplicate);
  }
  return serializeAssistantRequest(await dbGet('SELECT * FROM assistant_requests WHERE id=?',[id]));
}

export async function decideAssistantRequest(ownerId, id, input) {
  await requireCurrentOwner(ownerId);
  if (!ownKeys(input,['decision','fingerprint','note']) || !['approve','decline'].includes(input.decision)) throw assistantError(400, 'Choose approve or decline.');
  return withTransaction(async () => {
    const request = await dbGet('SELECT * FROM assistant_requests WHERE id=? AND owner_user_id=? FOR UPDATE',[id,ownerId]);
    if (!request) throw assistantError(404, 'Assistant request not found.');
    const row = validService(await dbGet('SELECT * FROM assistant_services WHERE id=?',[request.assistant_id]));
    if (request.fingerprint !== input.fingerprint) throw assistantError(409, 'Review the current request before deciding.');
    if (Date.parse(request.expires_at) <= Date.now()) throw assistantError(409, 'This request has expired.');
    if (!['pending','personal'].includes(request.status)) throw assistantError(409, 'This request has already been decided or executed.');
    const action = resolveAssistantAction(request.method,request.path);
    if (input.decision === 'approve') {
      if (action.mode === 'personal') throw assistantError(403, 'Open the record and complete your own review and tap. An approval cannot delegate this action.');
      checkActionGrant(row,action);
      if (request.policy_version !== row.policy_version || request.record_fingerprint !== await recordFingerprint(action,row)) throw assistantError(409, 'The record or access settings changed. Request a fresh review.');
    }
    const time = now(), status = input.decision === 'approve' ? 'approved' : 'declined';
    await dbRun('UPDATE assistant_requests SET status=?,decided_at=?,decision_note=?,expires_at=? WHERE id=?',
      [status,time,text(input.note,1000)||null,input.decision==='approve'?plus(time,15*60000):request.expires_at,id]);
    await activity(row,'human',`request_${status}`,id,{actionId:action.id});
    return serializeAssistantRequest(await dbGet('SELECT * FROM assistant_requests WHERE id=?',[id]));
  });
}

// Approval consumption is atomic with this durable execution ledger. It is
// deliberately NOT described as atomic with a legacy route's business transaction.
// A crash after consumption leaves executing/uncertain and forbids automatic replay.
export async function authorizeAssistantRequest(req) {
  if (!req.assistant) return null;
  const row = await currentAssistant(req.assistant), path = canonicalAssistantPath(req.originalUrl || req.url || req.path);
  const method = String(req.method).toUpperCase();
  if (isAssistantControlRoute(method,path)) return null;
  const action = resolveAssistantAction(method,path);
  checkActionGrant(row,action);
  const body = parse(boundedJson(req.body ?? {}));
  await checkBodyClaims(action,body,row.owner_user_id);
  if (action.mode === 'standing') return null;
  const get = name => req.get?.(name) ?? req.headers?.[name.toLowerCase()];
  const key = get('Idempotency-Key'), requestId = get('X-Assistant-Request-Id');
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(key) || typeof requestId !== 'string') {
    throw assistantError(428, 'An approved exact request and stable Idempotency-Key are required.');
  }
  const files = assistantFiles(req), payload = payloadHash(action,body,files);
  const prior = await dbGet('SELECT * FROM assistant_executions WHERE assistant_id=? AND idempotency_key=?',[row.id,key]);
  if (prior) throw assistantError(409, prior.payload_hash !== payload ? 'That key already belongs to a different operation.'
    : `This operation is already ${prior.status}. Inspect its receipt; it will not be repeated.`);
  return withTransaction(async () => {
    const request = await dbGet('SELECT * FROM assistant_requests WHERE id=? AND assistant_id=? FOR UPDATE',[requestId,row.id]);
    if (!request || request.status !== 'approved' || Date.parse(request.expires_at) <= Date.now()) throw assistantError(409, 'This exact request has no current unused approval.');
    const freshRow = validService(await dbGet('SELECT * FROM assistant_services WHERE id=? FOR UPDATE',[row.id]));
    checkActionGrant(freshRow,action);
    if (freshRow.token_version !== row.token_version || request.policy_version !== freshRow.policy_version
      || request.payload_hash !== payload || request.action_id !== action.id || request.method !== method || request.path !== path) {
      throw assistantError(409, 'The approved payload, files or access settings do not match.');
    }
    const record = await recordFingerprint(action,freshRow);
    if (record !== request.record_fingerprint) throw assistantError(409, 'The record changed after approval. Request a fresh review.');
    const time = now(), executionId = crypto.randomUUID();
    try {
      await dbRun(`INSERT INTO assistant_executions (id,assistant_id,owner_user_id,request_id,idempotency_key,action_id,method,path,
        payload_hash,record_fingerprint,status,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [executionId,row.id,row.owner_user_id,request.id,key,action.id,method,path,payload,record,'executing',time]);
    } catch (error) { if (isUniqueViolation(error)) throw assistantError(409, 'This operation was already consumed. It will not be repeated.'); throw error; }
    const changed = await dbRun("UPDATE assistant_requests SET status='executing' WHERE id=? AND status='approved'",[request.id]);
    if (!changed.changes) throw assistantError(409, 'This approval was already consumed.');
    await activity(row,'assistant','execution_started',request.id,{executionId,actionId:action.id});
    return { id:executionId,assistantId:row.id,assistantName:row.name,ownerUserId:row.owner_user_id,requestId:request.id,
      actionId:action.id,method,path,status:'executing',startedAt:time };
  });
}

// Call inside the existing record transaction, after its row lock and before
// changing anything. A pre-handler fingerprint alone does not close that race.
export async function assertAssistantRecordUnchanged(req) {
  if (!req.assistant) return;
  if (!isDatabaseTransactionActive()) throw assistantError(409,'The approved change requires the existing record transaction.');
  const execution = req.assistantExecution;
  if (!execution?.requestId) throw assistantError(409,'The assistant execution receipt is unavailable.');
  const row = await currentAssistant(req.assistant), action = resolveAssistantAction(req.method,req.originalUrl||req.url||req.path);
  if (action.recordTable==='submission_profiles') {
    // Also protects the absent-profile case against a concurrent first insert.
    await dbRun('LOCK TABLE submission_profiles IN SHARE ROW EXCLUSIVE MODE');
  } else if (action.recordTable && action.recordTable!=='building') {
    await dbGet(`SELECT ${action.recordTable==='submission_profiles'?'role':'id'} FROM ${action.recordTable} WHERE id=? FOR UPDATE`,[action.recordId]);
  } else if (action.id==='owner.access') {
    await dbRun('LOCK TABLE users, invitations, submission_profiles IN SHARE ROW EXCLUSIVE MODE');
  }
  const request = await dbGet("SELECT * FROM assistant_requests WHERE id=? AND assistant_id=? AND status='executing'",[execution.requestId,row.id]);
  checkActionGrant(row,action);
  if (!request || request.policy_version!==row.policy_version || request.record_fingerprint !== await recordFingerprint(action,row)) throw assistantError(409,'The record changed after approval. No change was authorized.');
}

export async function completeAssistantRequest(execution, { statusCode, response, uncertain = false } = {}) {
  if (!execution?.id) return null;
  const status = uncertain || !Number.isInteger(statusCode) || statusCode >= 500 ? 'uncertain'
    : statusCode >= 200 && statusCode < 300 ? 'completed' : 'failed';
  // Retain only a bounded receipt, never response bodies which may hold private
  // PDFs, signature images, tokens, source material or unrelated records.
  let responseHash = null;
  if (response !== undefined) { try { responseHash = digest(boundedJson(response)); } catch { /* no response bytes retained */ } }
  const time = now(), receipt = { executionId:execution.id,status,statusCode:Number.isInteger(statusCode)?statusCode:null,
    completedAt:time,responseHash,automaticRetryAllowed:false };
  return withTransaction(async () => {
    const changed = await dbRun("UPDATE assistant_executions SET status=?,completed_at=?,response_status=?,receipt_json=? WHERE id=? AND status='executing'",
      [status,time,receipt.statusCode,stableJson(receipt),execution.id]);
    if (!changed.changes) return parse((await dbGet('SELECT receipt_json FROM assistant_executions WHERE id=?',[execution.id]))?.receipt_json);
    await dbRun("UPDATE assistant_requests SET status=?,receipt_json=? WHERE id=? AND status='executing'",[status,stableJson(receipt),execution.requestId]);
    const row = await dbGet('SELECT * FROM assistant_services WHERE id=?',[execution.assistantId]);
    await activity(row,'assistant',`execution_${status}`,execution.requestId,{executionId:execution.id,statusCode:receipt.statusCode});
    return receipt;
  });
}

const exists = async table => Boolean((await dbGet('SELECT to_regclass(?) AS present',[`public.${table}`]))?.present);
export async function listAssistantAttestations(ownerId) {
  await requireCurrentOwner(ownerId);
  const items = [], add = item => items.push({ actionLabel:'Open review',ready:true,
    reason:'Review the current record. Existing source, office, consent and signature checks still apply.', ...item,revision:String(item.revision) });
  const minutes = await dbAll(`SELECT id,meeting_date,status,updated_at,created_by_user_id,submitted_draft_json,preparer_attested_at
    FROM meeting_minutes WHERE status='awaiting_master_attestation' OR (status='draft' AND created_by_user_id=?) ORDER BY updated_at DESC LIMIT 150`,[ownerId]);
  for (const row of minutes) {
    const master = row.status === 'awaiting_master_attestation';
    add({id:`minutes:${row.id}:${master?'master':'preparer'}`,kind:master?'minutes_master':'minutes_preparer',recordId:row.id,
      title:`${row.meeting_date || 'Undated'} meeting minutes`,status:row.status,section:'minutes',revision:row.updated_at,
      attestationText:master?'Review, sign and publish to officers':'Attest and send to the Worshipful Master',consentTextSource:'existing_action_label',
      reviewGuidance:master?'Review the submitted minutes and your corrections before personally attesting as Worshipful Master.'
        :'Confirm the required meeting details, attendance and source review as the actual preparer before personally attesting.',
      effects:assistantCapability(master?'owner.minutes-master':'owner.minutes-preparer').effects,
      ...(master && (!row.preparer_attested_at || !row.submitted_draft_json)?{ready:false,reason:'The retained preparer submission or attestation is incomplete.'}:{}) });
  }
  const documents = await dbAll(`SELECT DISTINCT d.id,d.title,d.original_name,d.status,d.updated_at FROM documents d
    JOIN document_signers s ON s.document_id=d.id WHERE d.status NOT IN ('completed','rescinded') AND s.signed_at IS NULL
    AND s.superseded_at IS NULL AND (s.user_id=? OR (s.user_id IS NULL AND s.signer_role='owner')) ORDER BY d.updated_at DESC LIMIT 150`,[ownerId]);
  for (const row of documents) add({id:`document:${row.id}`,kind:'document_signature',recordId:row.id,title:row.title||row.original_name,
    status:row.status,section:'documents',revision:row.updated_at,
    attestationText:'I agree that this electronic signature represents my signature on this document.',consentTextSource:'existing_consent',
    reviewGuidance:'Review the complete current PDF before personally confirming this consent.',effects:assistantCapability('documents.sign').effects});
  if (await exists('treasury_reports')) {
    for (const row of await dbAll("SELECT id,status,revision,draft_json FROM treasury_reports WHERE preparer_user_id=? AND status='draft' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 150",[ownerId])) {
      const draft = parse(row.draft_json,{});
      add({id:`treasury:${row.id}`,kind:'treasury_preparer',recordId:row.id,title:`Treasurer report${draft.periodEnd?` through ${draft.periodEnd}`:''}`,
        status:row.status,section:'treasury',revision:row.revision,attestationText:'Sign and finalize report',consentTextSource:'existing_action_label',
        reviewGuidance:'Review the financial source, reporting period and calculations as the assigned preparer before personally attesting.',effects:assistantCapability('owner.treasury-attest').effects});
    }
  }
  if (await exists('building_store_entries')) {
    const state = await dbGet('SELECT state FROM building_store_state WHERE id=1');
    if (state?.state === 'ready') {
      const {readAssistantBuildingArchive}=await import('./assistant-building.js');
      const {records:requests}=await readAssistantBuildingArchive();
      if (Array.isArray(requests)) for (const record of requests.slice(0,500)) {
        if (record.status === 'pending') add({id:`building:${record.id}:decision`,kind:'building_decision',recordId:String(record.id),
          title:`${record.org || 'Building request'}${record.date?` on ${record.date}`:''}`,status:record.status,section:'building',
          revision:digest(JSON.stringify(record)),attestationText:'Review the original terms and Lodge authorization yourself. Approving applies your saved signature.',effects:assistantCapability('building.decide').effects});
        if (record.status === 'approved' && record.agreement?.reviewStatus === 'fully_executed' && record.agreement?.secretaryAttestation?.attestedAt) {
          const filed = await exists('building_workflow_records') && await dbGet('SELECT filed_revision FROM building_workflow_records WHERE request_id=?',[record.id]);
          const revision = digest(JSON.stringify(record));
          if (filed?.filed_revision !== revision) add({id:`building:${record.id}:file`,kind:'building_file',recordId:String(record.id),
            title:`File ${record.org || 'building agreement'}`,status:'fully_executed',section:'building',revision,
            attestationText:'Inspect the fully executed agreement and personally record its filing.',effects:assistantCapability('owner.building-file').effects});
        }
      }
    }
  }
  const service = await serviceByOwner(ownerId);
  if (service) for (const request of await dbAll("SELECT * FROM assistant_requests WHERE assistant_id=? AND status='personal' AND expires_at>? ORDER BY created_at DESC LIMIT 150",[service.id,now()])) {
    const action = resolveAssistantAction(request.method,request.path), navigation = parse(request.navigation_json);
    // Link a discovered record once; preserve the request for its exact receipt.
    const existing = items.find(item => item.recordId === action.recordId && item.section === navigation?.section);
    if (existing) { existing.requestId = request.id; continue; }
    add({id:`request:${request.id}`,kind:'personal_request',recordId:action.recordId,title:request.title,status:'personal',
      section:navigation?.section||'profile',revision:request.record_fingerprint,requestId:request.id,
      attestationText:action.description,effects:action.effects});
  }
  return items;
}

const personalBody = value => value && typeof value==='object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([key])=>!['personalInfoConfirmed','consent','signatureData','signature','acknowledgeAvailabilityWarning'].includes(key)).map(([key,item])=>[key,personalBody(item)]))
  : Array.isArray(value)?value.map(personalBody):value;
export async function captureHumanAssistantReview(req) {
  if (req.assistant || req.user?.role!=='owner' || !['POST','PUT'].includes(req.method)) return null;
  let action;try {action=resolveAssistantAction(req.method,req.originalUrl||req.url||req.path);} catch {return null;}
  if (action.mode!=='personal') return null;
  const state=await assistantRecordState(action,req.user.id,{checkEligibility:false});
  return {actionId:action.id,path:action.path,fingerprint:digest(stableJson(state)),at:now(),
    body:boundedJson(personalBody(req.body??{}))};
}
export async function observeHumanAssistantCompletion(req, { statusCode, response } = {}) {
  if (req.assistant || req.user?.role !== 'owner' || !Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) return;
  let action;
  try { action = resolveAssistantAction(req.method,req.originalUrl||req.url||req.path); } catch { return; }
  if (action.mode !== 'personal') return;
  const reviewed=req.assistantPersonalReview;
  if (!reviewed || reviewed.actionId!==action.id || reviewed.path!==action.path) return;
  const service = await serviceByOwner(req.user.id);
  if (!service) return;
  const requests = await dbAll("SELECT * FROM assistant_requests WHERE assistant_id=? AND action_id=? AND path=? AND status='personal'",[service.id,action.id,action.path]);
  const matching=requests.filter(request=>{
    const proposed=personalBody(parse(request.body_json,{}));
    return (!Object.keys(proposed||{}).length || stableJson(proposed)===reviewed.body)
      && (!action.recordTable || request.record_fingerprint===reviewed.fingerprint);
  });
  for (const request of matching) {
    if (action.id==='owner.dispensation-sign') {
      // A creation has no previous row. Exact preparatory content, the actual
      // response and retained human signing/audit evidence must all agree.
      if (matching.length!==1 || stableJson(personalBody(parse(request.body_json,{})))!==reviewed.body) continue;
      const documentId=response?.documentId||response?.document?.id||response?.id;
      if (typeof documentId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(documentId)) continue;
      const signed=await dbGet(`SELECT d.id,d.created_at FROM documents d WHERE d.id=? AND d.owner_user_id=?
        AND d.template_kind='dispensation_v1' AND d.created_at>=? AND EXISTS (
          SELECT 1 FROM document_signers s WHERE s.document_id=d.id AND s.user_id=? AND s.signer_role='worshipful_master'
          AND s.signed_at IS NOT NULL AND octet_length(s.signature_bytes)>0) AND EXISTS (
          SELECT 1 FROM audit_events a WHERE a.document_id=d.id AND a.user_id=? AND a.actor_type='human'
          AND a.action='dispensation_created_from_template' AND a.created_at>=?)`,
      [documentId,req.user.id,request.created_at,req.user.id,req.user.id,request.created_at]);
      if (!signed) continue;
      const receipt={actorType:'human',ownerUserId:req.user.id,status:'completed_personally',observedAt:now(),statusCode,
        actionId:action.id,documentId:signed.id,createdAt:signed.created_at,automaticRetryAllowed:false};
      await dbRun("UPDATE assistant_requests SET status='completed_personally',receipt_json=? WHERE id=? AND status='personal'",[stableJson(receipt),request.id]);
      await activity(service,'human','personal_action_completed',request.id,{actionId:action.id,documentId:signed.id});
      continue;
    }
    if (action.id==='building.request') {
      if (matching.length!==1 || stableJson(personalBody(parse(request.body_json,{})))!==reviewed.body) continue;
      const refs=Array.isArray(response?.refs)?response.refs.filter(item=>typeof item==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(item)).slice(0,12):[];
      if (refs.length) await dbRun("UPDATE assistant_requests SET receipt_json=? WHERE id=? AND status='personal'",[stableJson({status:'personal_submission_observed_unverified',
        actorType:'human',ownerUserId:req.user.id,observedAt:now(),refs,reason:'The returned references have not been independently matched to the original local archive submission.',automaticRetryAllowed:false}),request.id]);
      continue;
    }
    const current = await assistantRecordState(action,service.owner_user_id,{checkEligibility:false}).then(state=>digest(stableJson(state))).catch(()=>null);
    // Successful personal POST/PUT plus an actual stored transition is a receipt.
    // Viewing a signature image or an unchanged record never completes a request.
    if (!current || current === request.record_fingerprint || req.method === 'GET') continue;
    const receipt = {actorType:'human',ownerUserId:req.user.id,status:'completed_personally',observedAt:now(),statusCode,
      actionId:action.id,recordFingerprint:current,automaticRetryAllowed:false};
    await dbRun("UPDATE assistant_requests SET status='completed_personally',receipt_json=? WHERE id=? AND status='personal'",[stableJson(receipt),request.id]);
    await activity(service,'human','personal_action_completed',request.id,{actionId:action.id});
  }
}

export function requireHumanOwner(req,res,next) {
  if (req.assistant || req.user?.role !== 'owner' || req.user?.access_revoked_at) return res.status(403).json({error:'Your own Worshipful Master session is required.'});
  next();
}
const route = handler => async(req,res,next) => { try { res.setHeader('Cache-Control','private, no-store');res.setHeader('Pragma','no-cache');await handler(req,res); } catch(error) { next(error); } };
async function listRequests(ownerId, assistantId = null) {
  const rows = assistantId ? await dbAll('SELECT * FROM assistant_requests WHERE owner_user_id=? AND assistant_id=? ORDER BY created_at DESC LIMIT 150',[ownerId,assistantId])
    : await dbAll('SELECT * FROM assistant_requests WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 150',[ownerId]);
  return rows.map(serializeAssistantRequest);
}
export function mountAssistantRoutes(app,{requireAuth,requireOwner}) {
  const human = [requireAuth,requireOwner,requireHumanOwner];
  app.get('/api/assistant/workspace',...human,route(async(req,res)=>{
    await requireCurrentOwner(req.user.id);
    const service = await serviceByOwner(req.user.id), requests = await listRequests(req.user.id);
    const recent = await dbAll('SELECT id,actor_type AS "actorType",action,request_id AS "requestId",details_json,created_at AS "createdAt" FROM assistant_activity WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 100',[req.user.id]);
    res.json({assistant:safeService(service),capabilities:ASSISTANT_CAPABILITIES,requests,
      attestations:await listAssistantAttestations(req.user.id),activity:recent.map(({details_json,...item})=>({...item,details:parse(details_json,{})}))});
  }));
  app.put('/api/assistant/access',...human,route(async(req,res)=>{
    if (!ownKeys(req.body,['name','permissions','expiresInDays','enabled'])) throw assistantError(400,'Unsupported access fields.');
    res.json({assistant:await createAssistantService({ownerUserId:req.user.id,...req.body})});
  }));
  app.post('/api/assistant/access/token',...human,route(async(req,res)=>res.json(await rotateAssistantToken(req.user.id))));
  app.delete('/api/assistant/access',...human,route(async(req,res)=>res.json(await revokeAssistantService(req.user.id))));
  app.get('/api/assistant/me',requireAuth,route(async(req,res)=>{
    if (!req.assistant) throw assistantError(403,'Use a Muse Assistant service credential for this endpoint.');
    const row = await currentAssistant(req.assistant);
    res.json({assistant:safeService(row),capabilities:ASSISTANT_CAPABILITIES.filter(action=>hasGrant(row,action)||action.mode==='personal'),
      instructions:{requests:'/api/assistant/requests',mcp:'/api/assistant/mcp',approvalHeader:'X-Assistant-Request-Id',idempotencyHeader:'Idempotency-Key',
        personalActions:'Queue review only. The owner must review and tap in the website or Mac app.',automaticRetryAllowed:false}});
  }));
  app.get('/api/assistant/requests',requireAuth,route(async(req,res)=>{
    if (req.assistant) { const row = await currentAssistant(req.assistant); return res.json({requests:await listRequests(row.owner_user_id,row.id)}); }
    await requireCurrentOwner(req.user.id);res.json({requests:await listRequests(req.user.id)});
  }));
  app.get('/api/assistant/requests/:id',requireAuth,route(async(req,res)=>{
    const row = req.assistant ? await currentAssistant(req.assistant) : null;
    if (!row) await requireCurrentOwner(req.user.id);
    const request = await dbGet('SELECT * FROM assistant_requests WHERE id=? AND owner_user_id=?',[req.params.id,row?.owner_user_id||req.user.id]);
    if (!request || (row && request.assistant_id !== row.id)) throw assistantError(404,'Assistant request not found.');
    res.json({request:serializeAssistantRequest(request)});
  }));
  app.post('/api/assistant/requests',requireAuth,route(async(req,res)=>{
    if (!req.assistant) throw assistantError(403,'Only the separately authenticated assistant may propose an assistant request.');
    res.status(201).json({request:await createAssistantRequest(req.assistant,req.body)});
  }));
  app.post('/api/assistant/requests/:id/decision',...human,route(async(req,res)=>res.json({request:await decideAssistantRequest(req.user.id,req.params.id,req.body)})));
  app.get('/api/assistant/attestations',...human,route(async(req,res)=>res.json({attestations:await listAssistantAttestations(req.user.id)})));
}
