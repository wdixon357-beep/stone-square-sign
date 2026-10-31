import { dbAll, dbGet } from './db.js';
import { BUILDING_STORE_MAX_VALUE_BYTES } from './building-store.js';
import { assistantError, digest } from './assistant-actions.js';

const string = (value, length = 500) => typeof value === 'string' ? value.slice(0,length) : '';
const safeTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0,40) : null;
const status = value => ['pending','approved','denied','cancelled'].includes(value) ? value : 'unknown';
const hasTable = async table => Boolean((await dbGet('SELECT to_regclass(?) AS present',[`public.${table}`]))?.present);

// One SELECT binds raw bytes, retained digest, actual database digest, length,
// expiry and migration readiness to the same database observation. No portal
// credentials, cache refresh, synchronization or workflow writes are involved.
export async function readAssistantBuildingArchive() {
  if (!await hasTable('building_store_entries') || !await hasTable('building_store_state')) throw assistantError(503,'Building record storage is unavailable.');
  const row = await dbGet(`SELECT value_text,value_sha256,revision::text AS revision,expires_at,
    octet_length(convert_to(value_text,'UTF8')) AS value_bytes,
    encode(sha256(convert_to(value_text,'UTF8')),'hex') AS actual_sha256,
    (SELECT state FROM building_store_state WHERE id=1) AS store_state
    FROM building_store_entries WHERE key='resv:all'`);
  if (!row || row.store_state !== 'ready' || row.expires_at !== null || !/^[1-9][0-9]*$/.test(row.revision)
      || !/^[a-f0-9]{64}$/.test(row.value_sha256 || '') || row.actual_sha256 !== row.value_sha256
      || !Number.isSafeInteger(Number(row.value_bytes)) || Number(row.value_bytes) > BUILDING_STORE_MAX_VALUE_BYTES
      || Buffer.byteLength(row.value_text) !== Number(row.value_bytes) || digest(row.value_text) !== row.actual_sha256) {
    throw assistantError(503,'Building records could not be verified.');
  }
  let records;
  try { records = JSON.parse(row.value_text); } catch { throw assistantError(503,'Building records could not be verified.'); }
  if (!Array.isArray(records) || records.length > 10000) throw assistantError(503,'Building records could not be verified.');
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,100}$/.test(record.id) || ids.has(record.id)) throw assistantError(503,'Building record identities could not be verified.');
    ids.add(record.id);
  }
  return {records,revision:row.revision,sha256:row.actual_sha256,byteLength:Number(row.value_bytes)};
}

export async function assistantBuildingProjection() {
  const archive = await readAssistantBuildingArchive();
  const filed = await hasTable('building_workflow_records')
    ? await dbAll('SELECT request_id,filed_revision,filed_at FROM building_workflow_records WHERE filed_revision IS NOT NULL') : [];
  const filingById = new Map(filed.map(row=>[row.request_id,row]));
  const requests = archive.records.map(record=>{
    const agreement=record.agreement && typeof record.agreement==='object' ? record.agreement : {};
    const revision=digest(JSON.stringify(record)), filing=filingById.get(record.id);
    const agreementStatus=['awaiting_secretary_attestation','fully_executed'].includes(agreement.reviewStatus)
      ? agreement.reviewStatus : ['awaiting_secretary_attestation','fully_executed'].includes(record.agreementStatus)
        ? record.agreementStatus : string(agreement.reviewStatus,80)||'pending';
    // An explicit allowlist prevents newly added portal fields from silently
    // returning status secrets, private links, payment URLs or handwriting.
    return {id:record.id,organization:string(record.org||record.organization,500),
      contactName:string(record.name||record.contactName,250),contact:string(record.contact,250),phone:string(record.phone,50),
      date:string(record.date,10),start:string(record.start,5),end:string(record.end,5),
      spaces:Array.isArray(record.spaces)?record.spaces.filter(item=>typeof item==='string').slice(0,10).map(item=>item.slice(0,100)):[],
      description:string(record.purpose||record.description,3000),status:status(record.status),note:string(record.note,3000),
      decidedAt:safeTime(record.decidedAt),decidedBy:string(record.decidedBy,250),revision,
      agreementStatus,requesterNotified:record.requesterNotified===true,
      attestedBy:agreement.secretaryAttestation?.attestedAt ? {name:string(agreement.secretaryAttestation.name,250),
        title:string(agreement.secretaryAttestation.title,100),at:safeTime(agreement.secretaryAttestation.attestedAt)} : null,
      filedCompletedAt:filing?.filed_revision===revision?safeTime(filing.filed_at):null,
      canDecide:false,canAttest:false,canFile:false,personalReviewRequired:true};
  });
  return {requests,canDecide:false,readOnly:true,source:'verified_local_postgres',archiveRevision:archive.revision};
}

export async function assistantBuildingAlerts() {
  const projection = await assistantBuildingProjection();
  return {alerts:projection.requests.filter(record=>record.status==='approved' && record.agreementStatus==='fully_executed'
      && record.attestedBy?.at && !record.filedCompletedAt).map(record=>({id:record.id,requestId:record.id,kind:'ready_to_file',
      title:`Building agreement ready to file: ${record.organization}, ${record.date}`,
      message:'Open the current agreement in your own session and inspect it before filing.',personalReviewRequired:true})),readOnly:true,source:projection.source};
}
