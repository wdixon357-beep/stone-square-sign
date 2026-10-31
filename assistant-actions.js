// The allowlist is deliberately independent of Express route matching. A new
// application route is unavailable to service credentials until reviewed here.
import crypto from 'node:crypto';
import { dbGet } from './db.js';

export const assistantError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const capability = (id, label, group, mode, description, effects = []) => ({ id, label, group, mode, description, effects });
export const ASSISTANT_CAPABILITIES = Object.freeze([
  capability('building.request','Prepare building requests','Building','personal','Prepare the request for your own review and submission. The existing portal requires a human session.', ['Your own submission creates the request and may notify officers.']),
  capability('building.view','Review building requests','Building','standing','View request details without retrieving reusable signature images.'),
  capability('building.decide','Approve or decline building requests','Building','personal','Open the current request for your decision. Approval applies your saved signature.', ['May apply your saved signature and notify the requester.']),
  capability('calendar.view','View Lodge Calendar','Calendar','standing','Read the existing calendar.'),
  capability('calendar.manage','Manage Lodge Calendar','Calendar','approval','Propose exact event additions, changes or removals.'),
  capability('reports.create','Prepare reports','Reports','approval','Organize supplied material under existing source and spending limits. Signed report access stays personal.', ['Existing generation charges may apply; no budget increase or automatic retry.']),
  capability('minutes.view','View meeting minutes','Minutes','standing','Read current minutes and historical records through the assistant read projection.'),
  capability('minutes.prepare','Prepare and edit minutes','Minutes','approval','Prepare exact draft changes, preserving source, preparer ownership and confirmations.', ['Generation may use the existing allowance. Does not attest or sign.']),
  capability('treasury.view','View treasurer reports','Treasury','standing','Read reports and their current state.'),
  capability('treasury.prepare','Prepare treasurer reports','Treasury','approval','Propose exact draft work subject to assignment, period and financial checks. Correcting a source-matched financial value and making personal review confirmations require your own action.', ['Does not attest, sign or alter existing signed reports.']),
  capability('treasury.upload','Provide banking records','Treasury','approval','Provide exact files for an approved operation under the existing upload permission.', ['Existing generation charges may apply.']),
  capability('dues.self','View your dues','Dues','standing','Read the owner account’s current dues.'),
  capability('dues.ledger','View dues ledger','Dues','standing','Read the Lodge ledger and exports.'),
  capability('dues.manage','Record dues activity','Dues','approval','Propose exact adjustments or reversals; existing evidence rules remain.'),
  capability('suggestions.create','Prepare confidential suggestions','Members','approval','Propose an exact confidential submission.'),
  capability('documents.status','View dispensations','Dispensations','standing','Read assigned or owner-visible documents, statuses and retained PDFs.'),
  capability('documents.sign','Sign assigned dispensations','Dispensations','personal','Open the complete document for your own signature.', ['Applies your saved signature; existing completion and notice rules apply.']),
  capability('candidates.view','View Candidate Tracker','Candidates','unavailable','The tracker requires an owner assertion which cannot be handed to an assistant credential.'),
  capability('candidates.edit','Edit Candidate Tracker','Candidates','unavailable','External tracker changes are not exposed through this service identity.'),
  capability('proposals.create','Submit personal dispensation proposals','Dispensations','unavailable','Proposal preparation is assigned to Wardens. Owner review is listed separately.'),
  capability('signature.manage','Manage your signature','Personal','personal','Signature images and signature changes require your own action.'),
  capability('settings.manage','Manage your settings','Personal','personal','Session, sign-in and personal security changes require your own action.'),
  capability('owner.profile','Read owner workspace identity','Administration','standing','Read your current name, office and workspace permissions.'),
  capability('owner.officers','Review officer access','Administration','standing','Read officer, invitation and permission metadata.'),
  capability('owner.access','Change officer access','Administration','approval','Propose exact office, permission, invitation or revocation changes.', ['May grant or remove access, or send an invitation.']),
  capability('owner.activity','Review private activity','Administration','standing','Read existing activity and incident metadata without creating synthetic incidents.'),
  capability('owner.suggestions','Review confidential suggestions','Members','standing','Read suggestions visible to the owner.'),
  capability('owner.suggestion-status','Update suggestion status','Members','approval','Propose a status change on an existing suggestion.'),
  capability('owner.agendas','Prepare meeting agendas','Reports','approval','Propose exact agenda changes without signing.'),
  capability('owner.agendas-view','View meeting agendas','Reports','standing','Read private owner agendas and previews.'),
  capability('owner.correspondence','Prepare Lodge correspondence','Correspondence','approval','Prepare or return exact drafts. Existing signer assignment and office rules remain.', ['Submitting a draft may notify its assigned Secretary.']),
  capability('owner.correspondence-view','Review correspondence','Correspondence','standing','Read owner-visible letters and PDFs.'),
  capability('owner.correspondence-sign','Sign correspondence','Correspondence','unavailable','Correspondence signing belongs to the assigned Secretary or Assistant Secretary, not the owner.'),
  capability('owner.documents','Prepare dispensations','Dispensations','approval','Propose exact documents and owner workflow changes.', ['May create documents or send existing workflow notices.']),
  capability('owner.dispensation-sign','Create and sign a dispensation','Dispensations','personal','Review the completed official template and personally create it with your saved signature.', ['Applies your saved signature, creates the document and sends Secretary notices.']),
  capability('owner.record-approval','Record an approval assertion','Dispensations','personal','You record and confirm the actual approval evidence yourself.'),
  capability('owner.proposals-view','Review Warden proposals','Dispensations','standing','Read all submitted proposals.'),
  capability('owner.proposals-decide','Decide Warden proposals','Dispensations','personal','Review the exact proposal yourself. Approval creates the document with your saved signature.', ['Approval applies your saved signature, creates a document and notifies officers.']),
  capability('owner.minutes-preparer','Attest as actual minutes preparer','Minutes','personal','Only your own draft can reach your preparer attestation.', ['Confirms preparer facts and applies your signature.']),
  capability('owner.minutes-master','Attest as Worshipful Master','Minutes','personal','Open submitted minutes, review current corrections and tap to attest.', ['Applies your signature, files the signed PDF and publishes internal availability.']),
  capability('owner.minutes-lodge-approval','Record Lodge approval of minutes','Minutes','personal','You confirm the actual Lodge approval date and evidence.'),
  capability('owner.minutes-workflow','Manage minutes workflow','Minutes','approval','Propose exact distribution markers, reopening or controlled deletion.'),
  capability('owner.treasury-attest','Attest to your treasurer report','Treasury','personal','Only the actual assigned preparer can attest.', ['Applies your signature and finalizes the report.']),
  capability('owner.treasury-access','Manage treasury assignments and access','Treasury','approval','Propose exact access changes under existing rules.'),
  capability('owner.treasury-workflow','Manage treasurer report workflow','Treasury','approval','Propose exact distribution markers or controlled draft deletion.'),
  capability('owner.building-file','File a completed building agreement','Building','personal','You inspect and file the current fully executed agreement.'),
  capability('owner.building-attest','Secretary building attestation','Building','unavailable','This attestation belongs to the Secretary or Assistant Secretary.'),
  capability('owner.building-agreement','Review captured building signatures','Building','personal','The captured agreement contains reusable signature images and opens only in your own session.'),
  capability('owner.report-signature','Use owner signature in Report Generator','Reports','personal','Signature images, signed handoffs and final report delivery require your own action.'),
  capability('owner.received-reports','Review received officer reports','Reports','standing','Read existing submitted reports without fabricating a new submission.'),
]);
const byId = new Map(ASSISTANT_CAPABILITIES.map(item => [item.id, item]));
export const assistantCapability = id => byId.get(id) || null;

// Serialization rejects coercions, cycles, prototype setters and non-JSON values.
export function stableJson(value, depth = 0) {
  if (depth > 35) throw assistantError(400, 'The request is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    if (keys.some(key => ['__proto__','prototype','constructor'].includes(key))) throw assistantError(400, 'Unsupported request field.');
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(',')}}`;
  }
  throw assistantError(400, 'The request must contain plain JSON values.');
}
export function canonicalAssistantPath(value) {
  if (typeof value !== 'string' || value.length > 3000 || !value.startsWith('/api/') || value.startsWith('//')
      || /[\\\x00-\x20#]/.test(value)) throw assistantError(400, 'Use an exact local API path.');
  const rawPath = value.split('?')[0];
  if (rawPath.includes('%') || rawPath.includes('//') || rawPath.endsWith('/') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) {
    throw assistantError(400, 'Use an exact unescaped API path.');
  }
  const url = new URL(value, 'http://assistant.invalid');
  if (url.pathname !== rawPath) throw assistantError(400, 'The API path is not canonical.');
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}
const routes = [];
function route(methods, path, id, table = null, section = null, mode = null) {
  const keys = [];
  const pattern = path.split('/').map(part => part.startsWith(':') ? (keys.push(part.slice(1)), '([A-Za-z0-9_-]+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
  for (const method of methods.split('|')) routes.push({ method, re: new RegExp(`^${pattern}$`), keys, id, table, section, mode });
}
route('GET','/api/auth/me','owner.profile');
route('GET','/api/officers','owner.officers');
route('GET','/api/admin/access','owner.officers');
route('GET','/api/admin/member-access','owner.officers');
route('POST','/api/officers/invite','owner.access');
route('PUT','/api/admin/accounts/:id/role','owner.access','users');
route('PUT','/api/officers/invitations/role','owner.access');
route('POST','/api/officers/revoke','owner.access');
route('PUT','/api/admin/access','owner.access');
route('POST','/api/admin/member-access/:id/invite','owner.access','roster');
route('GET','/api/admin/activity','owner.activity');
route('GET','/api/admin/suggestions','owner.suggestions');
route('PATCH','/api/admin/suggestions/:id','owner.suggestion-status','suggestions');
route('POST','/api/suggestions','suggestions.create');
route('GET','/api/suggestions/me','suggestions.create',null,null,'standing');
route('GET','/api/dues/me','dues.self');
for (const p of ['/api/dues','/api/dues/export.pdf','/api/dues/export.xlsx']) route('GET',p,'dues.ledger');
route('POST','/api/dues/manual-assist','dues.manage');
route('POST','/api/dues/adjustments','dues.manage');
route('POST','/api/dues/adjustments/:id/reverse','dues.manage','dues_adjustments');
route('GET','/api/building/availability','building.view');
route('GET','/api/building/requests','building.view');
route('GET','/api/building/alerts','building.view',null,'building');
route('POST','/api/building/requests','building.request',null,'building');
route('POST','/api/building/requests/:id/decision','building.decide','building','building');
route('POST','/api/building/requests/:id/attest','owner.building-attest','building','building');
route('POST','/api/building/requests/:id/file-completed','owner.building-file','building','building');
route('GET','/api/building/requests/:id/agreement','owner.building-agreement','building','building');
route('GET','/api/lodge-calendar','calendar.view');
route('POST','/api/lodge-calendar','calendar.manage',null,'calendar');
route('PUT|DELETE','/api/lodge-calendar/:id','calendar.manage','lodge_calendar_events','calendar');
route('GET','/api/minutes','minutes.view',null,'minutes');
route('GET','/api/minutes/review-alerts','minutes.view');
route('GET','/api/minutes/completion-alerts','minutes.view');
route('POST','/api/minutes/:id/completion-alert-seen','owner.minutes-workflow','meeting_minutes','minutes');
route('POST','/api/minutes/handoff','minutes.prepare',null,'minutes');
route('POST','/api/minutes/generate','minutes.prepare',null,'minutes');
route('POST','/api/minutes/:id/claim','minutes.prepare','meeting_minutes','minutes');
route('POST','/api/minutes/:id/reorganize','minutes.prepare','meeting_minutes','minutes');
route('PUT','/api/minutes/:id','minutes.prepare','meeting_minutes','minutes');
route('DELETE','/api/minutes/:id','owner.minutes-workflow','meeting_minutes','minutes');
route('GET','/api/minutes/:id','minutes.view','meeting_minutes','minutes');
route('GET','/api/minutes/:id/pdf','minutes.view','meeting_minutes','minutes');
route('GET','/api/minutes/:id/docx','minutes.view','meeting_minutes','minutes');
route('POST','/api/minutes/:id/preview','minutes.view','meeting_minutes','minutes','standing');
route('POST','/api/minutes/:id/preparer-attest','owner.minutes-preparer','meeting_minutes','minutes');
route('POST','/api/minutes/:id/master-attest','owner.minutes-master','meeting_minutes','minutes');
route('POST','/api/minutes/:id/lodge-approval','owner.minutes-lodge-approval','meeting_minutes','minutes');
for (const p of ['mark-distributed','reopen']) route('POST',`/api/minutes/:id/${p}`,'owner.minutes-workflow','meeting_minutes','minutes');
for (const p of ['/api/treasury','/api/treasury/access','/api/treasury/preparers','/api/treasury/alerts']) route('GET',p,'treasury.view');
route('PUT','/api/treasury/access/:id','owner.treasury-access','users','treasury');
route('POST','/api/treasury/alerts/:id/dismiss','owner.treasury-workflow','treasury_reports','treasury');
route('POST','/api/treasury/drafts','treasury.prepare',null,'treasury');
route('POST','/api/treasury/generate','treasury.upload',null,'treasury');
for (const p of ['assign','organize']) route('POST',`/api/treasury/:id/${p}`,'treasury.prepare','treasury_reports','treasury');
route('PUT','/api/treasury/:id','treasury.prepare','treasury_reports','treasury');
route('GET','/api/treasury/:id/pdf','treasury.view','treasury_reports','treasury');
route('GET','/api/treasury/:id/source','treasury.prepare','treasury_reports','treasury','standing');
route('GET','/api/treasury/:id/sources/:sourceId','treasury.prepare','treasury_reports','treasury','standing');
route('POST','/api/treasury/:id/preview','treasury.view','treasury_reports','treasury','standing');
route('POST','/api/treasury/:id/preparer-attest','owner.treasury-attest','treasury_reports','treasury');
route('POST','/api/treasury/:id/mark-distributed','owner.treasury-workflow','treasury_reports','treasury');
route('DELETE','/api/treasury/:id','owner.treasury-workflow','treasury_reports','treasury');
for (const p of ['/api/archives/minutes','/api/archives/treasury']) route('GET',p,p.endsWith('minutes')?'minutes.view':'treasury.view');
route('GET','/api/archives/minutes/:id/pdf','minutes.view','historical_reports','minutes');
route('GET','/api/archives/treasury/:id/pdf','treasury.view','historical_reports','treasury');
route('GET','/api/agendas','owner.agendas-view');
route('POST','/api/agendas','owner.agendas',null,'agendas');
route('GET','/api/agendas/:id','owner.agendas-view','agendas','agendas');
route('GET','/api/agendas/:id/pdf','owner.agendas-view','agendas','agendas');
route('POST','/api/agendas/:id/preview','owner.agendas-view','agendas','agendas','standing');
route('PUT|DELETE','/api/agendas/:id','owner.agendas','agendas','agendas');
for (const p of ['/api/correspondence','/api/correspondence/signers','/api/correspondence/alerts']) route('GET',p,'owner.correspondence-view');
route('POST','/api/correspondence','owner.correspondence',null,'correspondence');
route('PUT','/api/correspondence/:id','owner.correspondence','correspondence_drafts','correspondence');
for (const p of ['submit','return']) route('POST',`/api/correspondence/:id/${p}`,'owner.correspondence','correspondence_drafts','correspondence');
route('POST','/api/correspondence/:id/sign','owner.correspondence-sign','correspondence_drafts','correspondence');
route('GET','/api/correspondence/:id/pdf','owner.correspondence-view','correspondence_drafts','correspondence');
route('GET','/api/documents','documents.status');
route('GET','/api/approvals','documents.status');
for (const suffix of ['','/file','/original','/endorsed','/audit']) route('GET',`/api/documents/:id${suffix}`,'documents.status','documents','documents');
route('POST','/api/documents','owner.documents',null,'documents');
route('POST','/api/dispensations','owner.dispensation-sign',null,'createDispensation');
for (const p of ['parse','preview']) route('POST',`/api/dispensations/${p}`,'owner.documents',null,'documents','standing');
route('POST','/api/locations/search','owner.documents',null,'documents','standing');
route('GET','/api/submission-profiles','owner.officers');
route('PUT','/api/submission-profiles/:id','owner.access','submission_profiles','documents');
route('POST','/api/documents/:id/sign','documents.sign','documents','documents');
route('PUT','/api/documents/:id/approval','owner.record-approval','documents','documents');
for (const p of ['rescind','offer-to-both','missive-draft/retry']) route('POST',`/api/documents/:id/${p}`,'owner.documents','documents','documents');
route('GET','/api/proposals','owner.proposals-view');
route('POST|PUT','/api/proposals/:id','proposals.create','dispensation_proposals','documents');
route('POST','/api/proposals','proposals.create',null,'documents');
route('POST','/api/proposals/:id/preview','owner.proposals-view','dispensation_proposals','documents','standing');
route('POST','/api/proposals/:id/decision','owner.proposals-decide','dispensation_proposals','proposalReview');
route('POST','/api/reports/organize','reports.create',null,'reportGenerator');
route('POST','/api/reports/import-source','reports.create',null,'reportGenerator','standing');
route('GET','/api/generation/status','reports.create',null,'reportGenerator','standing');
route('GET','/api/officer-reports','owner.received-reports');
route('GET','/api/officer-reports/:id/pdf','owner.received-reports','officer_reports','reports');
for (const p of ['/api/reports/handoff','/api/reports/signature','/api/officer-reports','/api/officer-reports/deliver']) route('POST',p,'owner.report-signature',null,'reportGenerator');
route('GET|PUT','/api/profile/signature','signature.manage',null,'profile');
route('POST','/api/tracker/handoff','candidates.view');
route('POST','/api/tracker/permissions','candidates.edit');
for (const p of ['/api/auth/sessions','/api/auth/logout','/api/auth/sessions/revoke-others']) route('GET|POST|DELETE',p,'settings.manage');
route('DELETE','/api/auth/sessions/:id','settings.manage');

export function resolveAssistantAction(method, path) {
  const exactPath = canonicalAssistantPath(path), pathname = exactPath.split('?')[0];
  const verb = String(method || '').toUpperCase();
  for (const item of routes) {
    const match = item.method === verb && pathname.match(item.re);
    if (!match) continue;
    const params = Object.fromEntries(item.keys.map((key, index) => [key, match[index + 1]]));
    const definition = byId.get(item.id);
    return { ...definition, mode: item.mode || definition.mode, method: verb, path: exactPath,
      recordTable: item.table, recordId: params.id || null, params,
      navigation: item.section ? { section: item.section, recordId: params.id || null } : null };
  }
  throw assistantError(403, 'This action is not available to Muse Assistant.');
}

export function isAssistantControlRoute(method, path) {
  const pathname = canonicalAssistantPath(path).split('?')[0];
  return (method === 'GET' && ['/api/assistant/me','/api/assistant/requests','/api/assistant/mcp'].includes(pathname))
    || (method === 'GET' && /^\/api\/assistant\/requests\/[A-Za-z0-9_-]+$/.test(pathname))
    || (method === 'POST' && ['/api/assistant/requests','/api/assistant/mcp'].includes(pathname));
}

const tableExists = async name => Boolean((await dbGet('SELECT to_regclass(?) AS present',[`public.${name}`]))?.present);
const stateColumns = {
  meeting_minutes: 'id,status,created_by_user_id,updated_by_user_id,updated_at,draft_json,submitted_draft_json,preparer_attested_at,master_attested_at,approved_by_lodge_on',
  treasury_reports: 'id,status,revision,preparer_user_id,created_by_user_id,updated_at,deleted_at,draft_json,submitted_json,preparer_attested_at',
  documents: "id,status,updated_at,owner_user_id,parsed_preview,approval_status,encode(sha256(file_bytes),'hex') AS source_hash,encode(sha256(signed_bytes),'hex') AS signed_hash,signing_mode",
  correspondence_drafts: 'id,status,updated_at,prepared_by_user_id,assigned_to_user_id,signing_mode,shared_signer_1_id,shared_signer_2_id,subject,body,signed_at',
  agendas: 'id,revision,status,updated_at,deleted_at,draft_json,created_by_user_id',
  lodge_calendar_events: 'id,revision,updated_at,deleted_at,event_json',
  users: 'id,role,access_revoked_at,permissions_json,roster_id',
  roster: 'id,first_name,last_name,title,prefix,emails,updated_at',
  submission_profiles: 'role,name,address,source_reference,updated_at',
  suggestions: 'id,status,subject,body,owner_response,reviewed_by_user_id,submitted_by_user_id,updated_at',
  dues_adjustments: 'id,roster_id,dues_year,transaction_type,amount_cents,effective_date,reverses_adjustment_id,created_at',
  historical_reports: 'id,original_sha256,rendered_sha256',
  dispensation_proposals: 'id,status,updated_at,proposer_user_id,resulting_document_id,title,request_details,event_date',
  officer_reports: 'id,external_id,received_at',
};

// A fingerprint describes current server authority, never a client-supplied
// revision. Existing handlers retain their own locks, source and office checks.
export async function assistantRecordState(action, ownerId, { checkEligibility = true } = {}) {
  if (!action.recordTable) {
    if (action.id === 'signature.manage') return await dbGet("SELECT user_id,updated_at,encode(sha256(signature_bytes),'hex') AS signature_hash FROM profile_signatures WHERE user_id=?",[ownerId]) || {ownerId,signature:null};
    // Configuration approvals bind all current accounts/invitations, so an
    // approval cannot silently attach to a renamed/reassigned target.
    if (action.id === 'owner.access') {
      const { dbAll } = await import('./db.js');
      return { users: await dbAll('SELECT id,email,name,role,permissions_json,access_revoked_at,roster_id FROM users ORDER BY id'),
        invitations: await dbAll('SELECT id,email,role,permissions_json,expires_at,used_at FROM invitations ORDER BY id'),
        submissionProfiles: await dbAll('SELECT role,name,address,source_reference,updated_at FROM submission_profiles ORDER BY role') };
    }
    return { ownerId, collection: action.id };
  }
  if (action.recordTable === 'building') {
    const {readAssistantBuildingArchive}=await import('./assistant-building.js');
    const archive=await readAssistantBuildingArchive();
    const record = archive.records.find(item => String(item.id) === action.recordId);
    if (!record) throw assistantError(404, 'The requested record was not found.');
    return { revision: archive.revision, digest: digest(stableJson(record)) };
  }
  const columns = stateColumns[action.recordTable];
  if (!columns || !await tableExists(action.recordTable)) throw assistantError(503, 'This record source is unavailable.');
  const row = await dbGet(`SELECT ${columns} FROM ${action.recordTable} WHERE ${action.recordTable==='submission_profiles'?'role':'id'}=?`,[action.recordId]);
  if (!row && action.recordTable==='submission_profiles') return {role:action.recordId,profile:null};
  if (!row || row.deleted_at) throw assistantError(404, 'The requested record was not found.');
  if (checkEligibility && action.id === 'owner.minutes-preparer' && Number(row.created_by_user_id) !== Number(ownerId)) throw assistantError(403, 'Only the actual preparer can attest to this draft.');
  if (checkEligibility && action.id === 'owner.treasury-attest' && Number(row.preparer_user_id) !== Number(ownerId)) throw assistantError(403, 'Only the assigned preparer can attest to this report.');
  if (action.recordTable === 'documents') {
    const { dbAll } = await import('./db.js');
    row.signers = await dbAll('SELECT id,user_id,signer_role,signed_at,superseded_at FROM document_signers WHERE document_id=? ORDER BY id',[row.id]);
    if (checkEligibility && action.id === 'documents.sign' && !row.signers.some(signer => !signer.signed_at && !signer.superseded_at
        && (Number(signer.user_id) === Number(ownerId) || (!signer.user_id && signer.signer_role === 'owner')))) {
      throw assistantError(403, 'This document is not waiting for your signature.');
    }
  }
  return row;
}

const reviewFlags = new Set(['attendanceConfirmed','officersConfirmed','otherBrothersConfirmed','otherBrothersExcusedConfirmed',
  'officerRoll','otherPresent','otherExcused','fundsReviewed','obligationsReviewed','sourceReviewed','activityComplete','postedDateConfirmed']);
const same = (left,right) => stableJson(left ?? null) === stableJson(right ?? null);
const withoutReview = value => Array.isArray(value) ? value.map(withoutReview) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key])=>!reviewFlags.has(key)&&!['fieldReviews','attendanceReview'].includes(key)).map(([key,item])=>[key,withoutReview(item)])) : value;
const fieldValue = (draft,path) => {
  const parts=String(path).replaceAll('[','.').replaceAll(']','').split('.');
  if (parts.some(part=>!part || ['__proto__','constructor','prototype'].includes(part))) return undefined;
  return parts.reduce((value,key)=>value && Object.hasOwn(value,key)?value[key]:undefined,draft);
};
export function assertNoAssistantAttestation(body, { existingDraft = null, kind = null } = {}) {
  const draft=body?.draft && typeof body.draft==='object' ? body.draft : body;
  const unchanged = keys => existingDraft && keys.every(key=>same(withoutReview(existingDraft[key]),withoutReview(draft?.[key])));
  const retainedReview = (key, value, path) => {
    if (!existingDraft || value !== true) return false;
    if (kind === 'minutes' && ['officerRoll','otherPresent','otherExcused'].includes(key)) {
      return existingDraft.attendanceReview?.[key]===true && unchanged(key==='officerRoll'?['officerAttendance']
        : key==='otherPresent'?['present','officerAttendance']:['excused','officerAttendance']);
    }
    if (kind !== 'treasury') return false;
    const period=['periodStart','periodEnd','sourceNames'];
    if (['fundsReviewed','obligationsReviewed','sourceReviewed'].includes(key)) {
      const keys=key==='fundsReviewed'?[...period,'funds']:key==='obligationsReviewed'?[...period,'obligations']
        :[...period,'accounts','transactions','funds','obligations','unmappedLines'];
      return existingDraft[key]===true && unchanged(keys);
    }
    const fieldPath=path.replace(/^draft\./,'');
    if (key==='activityComplete') {
      const match=/^accounts\.(\d+)\.activityComplete$/.exec(fieldPath), index=match&&Number(match[1]);
      const account=match&&draft?.accounts?.[index], old=existingDraft.accounts?.find(item=>item.id===account?.id);
      return !!old?.activityComplete && unchanged(period) && same(withoutReview(old),withoutReview(account))
        && same(withoutReview(existingDraft.transactions?.filter(item=>item.account===account.id)||[]),withoutReview(draft.transactions?.filter(item=>item.account===account.id)||[]));
    }
    if (key==='postedDateConfirmed') {
      const match=/^transactions\.(\d+)\.postedDateConfirmed$/.exec(fieldPath), index=match&&Number(match[1]);
      return !!match && existingDraft.transactions?.[index]?.postedDateConfirmed===true && unchanged(period)
        && same(withoutReview(existingDraft.transactions[index]),withoutReview(draft.transactions?.[index]));
    }
    return false;
  };
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 35) return;
    for (const [key, item] of Object.entries(value)) {
      if ((/(?:signature|attest|consent)/i.test(key) || key==='personalInfoConfirmed')
          && item !== false && item !== null && item !== '') {
        throw assistantError(403, 'Signatures, attestations and personal confirmations require your own review and tap.');
      }
      walk(item, depth + 1);
    }
  };
  walk(body);
  const reviews = (value,path='') => {
    if (!value || typeof value!=='object') return;
    for (const [key,item] of Object.entries(value)) {
      const next=path?`${path}.${key}`:key;
      if (reviewFlags.has(key) && item===true && !retainedReview(key,item,next)) throw assistantError(403,'Personal review confirmations cannot be created or carried across changed facts by Muse Assistant.');
      if (key==='fieldReviews' && item && typeof item==='object') {
        for (const [field,state] of Object.entries(item)) if (['confirmed','corrected'].includes(state)
            && !(kind==='treasury' && existingDraft?.fieldReviews?.[field]===state && unchanged(['periodStart','periodEnd','sourceNames'])
              && fieldValue(existingDraft,field)!==undefined && same(fieldValue(existingDraft,field),fieldValue(draft,field)))) {
          throw assistantError(403,'Only an unchanged saved personal field review can be retained.');
        }
      }
      reviews(item,next);
    }
  };
  reviews(body);
}
