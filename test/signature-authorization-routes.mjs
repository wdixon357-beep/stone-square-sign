import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import bcrypt from 'bcrypt';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { completeTreasuryFixture } from './treasury.mjs';
import { calculateTreasury,normalizeTreasury } from '../treasury.js';
import { treasuryReportingWindow } from '../treasury-period.js';
import { initTreasurySchema } from '../treasury-routes.js';
import UPNGModule from '@pdf-lib/upng';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { normalizeMinutesDraft } from '../minutes.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Never connect this route test to a configured database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Never reuse an existing local database.');
const work = await mkdtemp(join(tmpdir(), 'stone-square-signature-authorization-routes-'));
const databaseDir = join(work, 'database');
const loaderFile = join(work, 'isolated-server.mjs');
process.env.PGLITE_DIR = databaseDir;
const { connect, initSchema, dbGet, dbAll, dbRun, close } = await import('../db.js');
const { initSignaturePolicySchema, pinApprovedOwnerSignature } = await import('../signature-policy.js');
const { initMinutesSignatureRevisionSchema, createMinutesSignatureRevisions } = await import('../minutes-signature-revisions.js');
const UPNG = UPNGModule.default || UPNGModule;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const password = 'Isolated signature route password';
const ownerEmail = 'signature-owner@example.test';
const secretaryEmail = 'signature-secretary@example.test';
const firstDate = '2026-10-02T01:01:02.123Z';
const masterDate = '2026-10-03T12:46:05.967Z';
const source = 'Private synthetic meeting notes. The committee report was received.';
const stamp = (width, height, color) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba.set(color.map((value, index) => Math.min(255, value + (x * (index + 7) + y * 13) % 25)), offset);
    rgba[offset + 3] = (x * 19 + y * 17) % 7 < 3 ? 255 : (x + y) % 5 === 0 ? 128 : 0;
  }
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
};
const originalSignature = stamp(180, 60, [15, 25, 35]);
const approvedSignature = stamp(220, 65, [0, 70, 220]);
const secretarySignature = stamp(180, 60, [30, 70, 25]);
const alternateSignature = stamp(200, 60, [70, 30, 70]);
for (const image of [approvedSignature, alternateSignature]) {
  assert.ok(image.length >= 600 && `data:image/png;base64,${image.toString('base64')}`.length >= 800, 'Synthetic signatures exercise the actual visible-PNG validation.');
}
let server = null, base = '', connected = false, output = '', passed = 0;
const check = (label, condition) => { assert.ok(condition, label); passed += 1; console.log(`PASS ${label}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = image => ({ signatureData: `data:image/png;base64,${image.toString('base64')}`, signatureType: 'drawn', styleName: 'synthetic-test' });
async function api(path, token, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, headers: response.headers };
}
async function stop() {
  if (!server) return;
  const child = server; server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code, signal] = await ended;
    assert.equal(signal, null, 'The isolated server must close its database cleanly.');
    assert.equal(code, 0, 'The isolated server must exit successfully.');
  } finally { clearTimeout(timeout); }
}
async function start() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  await writeFile(loaderFile, `
import dotenv from ${JSON.stringify(import.meta.resolve('dotenv'))};
import { close } from ${JSON.stringify(new URL('../db.js', import.meta.url).href)};
import nodemailer from ${JSON.stringify(import.meta.resolve('nodemailer'))};
dotenv.config = () => ({ parsed: {} });
globalThis.fetch = async () => { throw new Error('External fetch is disabled in the isolated signature route test.'); };
nodemailer.createTransport = () => { throw new Error('External email is disabled in the isolated signature route test.'); };
process.once('SIGTERM', async () => { await close(); process.exit(0); });
`);
  server = spawn(process.execPath, ['--import', loaderFile, 'server.js'], {
    cwd: new URL('..', import.meta.url),
    // Deliberately do not inherit provider credentials or load the real .env.
    env: { PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', TZ: 'UTC',
      NODE_ENV: 'test', PORT: String(port), DATABASE_URL: '', PGLITE_DIR: databaseDir,
      OWNER_EMAIL: ownerEmail, APP_BASE_URL: base, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '',
      OPENAI_API_KEY: '', ZEFFY_API_KEY: '', ZEFFY_DUES_CAMPAIGN_ID: '', ZEFFY_CUSTOM_DUES_CAMPAIGN_ID: '',
      TRACKER_SSO_SHARED_SECRET: '', LODGE_ACCESS_CODE: '', WARDEN_EMAILS: '', DDGM_EMAIL: '',
      CANDIDATE_TRACKER_URL: base, REPORT_GENERATOR_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', bytes => { output += bytes; }); server.stderr.on('data', bytes => { output += bytes; });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited: ${output.slice(-3000)}`);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await pause(100);
  }
  throw new Error(`Isolated server did not start: ${output.slice(-3000)}`);
}

try {
  await connect();connected=true;await initSchema();await initSignaturePolicySchema();await initTreasurySchema();
  const passwordHash=await bcrypt.hash(password,4);
  for(const [email,name,role] of [[ownerEmail,'Synthetic Worshipful Master','owner'],[secretaryEmail,'Synthetic Secretary','secretary']])await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',[email,passwordHash,name,role,firstDate]);
  const owner=await dbGet('SELECT * FROM users WHERE email=?',[ownerEmail]),secretary=await dbGet('SELECT * FROM users WHERE email=?',[secretaryEmail]);
  for(const [id,image] of [[owner.id,approvedSignature],[secretary.id,secretarySignature]])await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,updated_at) VALUES (?,?,?,?)',[id,image,'drawn',firstDate]);
  await pinApprovedOwnerSignature({ownerUserId:owner.id,expectedProfileSha256:sha(approvedSignature),authorizationNote:'Synthetic owner approved this inspected fixture for isolated tests only.'});
  const draft=normalizeMinutesDraft({officerAttendanceVersion:2,closingFormatVersion:3,meetingDate:'2026-10-15',meetingType:'Stated Communication',degree:'Third Degree',openingTime:'7:30 PM',closingTime:'9:00 PM',presiding:'Synthetic Worshipful Master',quorum:'Yes',nextMeeting:'2026-11-05',closingPrayerGiven:true,sections:[{heading:'New Business',body:'- The synthetic committee report was received.'}]});
  draft.officerAttendance.forEach(row=>Object.assign(row,{status:'present'}));draft.attendanceReview={officerRoll:true,otherPresent:true,otherExcused:true};
  for(const [id,preparer] of [['synthetic-minutes',owner.id],['synthetic-directed-minutes',owner.id],['synthetic-other-minutes',secretary.id]])await dbRun("INSERT INTO meeting_minutes(id,meeting_date,source_name,transcript_text,draft_json,status,created_by_user_id,updated_by_user_id,preparer_user_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)",[id,draft.meetingDate,'Synthetic notes',source,JSON.stringify(draft),preparer,preparer,preparer,firstDate,firstDate]);
  const document=await PDFDocument.create();document.addPage().drawText('Synthetic document for isolated signature authorization checks.');const artifact=Buffer.from(await document.save());
  for(const [id,signer] of [['synthetic-document',owner],['synthetic-directed-document',owner],['synthetic-stale-document',owner],['synthetic-other-document',secretary]]){
    await dbRun("INSERT INTO documents(id,title,original_name,stored_name,owner_user_id,owner_email,file_bytes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)",[id,'Synthetic unsigned document','synthetic.pdf',id+'.pdf',owner.id,owner.email,artifact,firstDate,firstDate]);
    await dbRun('INSERT INTO document_signers(document_id,user_id,signer_role,signer_name) VALUES (?,?,?,?)',[id,signer.id,signer.role,signer.name]);
  }
  await dbRun("UPDATE documents SET template_kind='dispensation_v1',file_bytes=? WHERE id='synthetic-directed-document'",[await readFile(new URL('../assets/grand-lodge-dispensation-template.pdf',import.meta.url))]);
  await dbRun("INSERT INTO submission_profiles(role,name,address,updated_at) VALUES ('owner',?,?,?)",[owner.name,'1 Synthetic Street, Example, DE 19709',firstDate]);
  const treasury=structuredClone(completeTreasuryFixture),cycle=treasuryReportingWindow('2026-10-31');
  Object.assign(treasury,{previousMeetingDate:cycle.previousMeeting,periodStart:cycle.periodStart,periodEnd:cycle.periodEnd});treasury.transactions.forEach(row=>row.date=cycle.periodStart);
  check('Synthetic treasury fixture remains complete',calculateTreasury(normalizeTreasury(treasury)).ready);
  for(const [id,preparer] of [['synthetic-treasury',owner],['synthetic-directed-treasury',owner],['synthetic-other-treasury',secretary]])await dbRun("INSERT INTO treasury_reports(id,draft_json,source_text,status,revision,created_by_user_id,preparer_user_id,preparer_name,preparer_role,uploader_name,created_at,updated_at) VALUES (?,?,?,'draft',1,?,?,?,?,?,?,?)",[id,JSON.stringify(treasury),'Synthetic banking source, no real funds.',preparer.id,preparer.id,preparer.name,preparer.role,preparer.name,firstDate,firstDate]);
  const directedTreasuryDraft=structuredClone(treasury),directedCycle=treasuryReportingWindow('2026-10-15');
  Object.assign(directedTreasuryDraft,{previousMeetingDate:directedCycle.previousMeeting,periodStart:directedCycle.periodStart,periodEnd:directedCycle.periodEnd});directedTreasuryDraft.transactions.forEach(row=>row.date=directedCycle.periodStart);
  await dbRun("UPDATE treasury_reports SET draft_json=? WHERE id='synthetic-directed-treasury'",[JSON.stringify(directedTreasuryDraft)]);
  const beforeSource=(await dbGet("SELECT transcript_text,draft_json FROM meeting_minutes WHERE id='synthetic-minutes'"));
  await close();connected=false;await start();
  const ownerToken=(await api('/api/auth/login',null,'POST',{email:ownerEmail,password})).data.token;
  const secretaryToken=(await api('/api/auth/login',null,'POST',{email:secretaryEmail,password})).data.token;
  check('Synthetic owner logs in',Boolean(ownerToken));
  check('Save separate Muse access',(await api('/api/assistant/access',ownerToken,'PUT',{name:'Synthetic Muse',permissions:[],enabled:true,expiresInDays:1})).status===200);
  const muse=(await api('/api/assistant/access/token',ownerToken,'POST',{})).data.token;
  const propose=async(actionId,path,body={},key=path)=>{
    const r=await api('/api/assistant/signature-requests',muse,'POST',{actionId,method:'POST',path,body,requestKey:'test-'+sha(key).slice(0,20)});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.request;
  };
  const confirm=async request=>{const r=await api(`/api/assistant/signature-requests/${request.id}/confirm`,ownerToken,'POST',{fingerprint:request.fingerprint,consent:true});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.request;};
  check('Human cannot manufacture a Muse request',(await api('/api/assistant/signature-requests',ownerToken,'POST',{})).status===403);
  for(const [actionId,path,body] of [['owner.minutes-preparer','/api/minutes/synthetic-other-minutes/preparer-attest',{}],['owner.treasury-attest','/api/treasury/synthetic-other-treasury/preparer-attest',{revision:1}],['documents.sign','/api/documents/synthetic-other-document/sign',{}]])check('Cannot queue another officer signature '+actionId,(await api('/api/assistant/signature-requests',muse,'POST',{actionId,method:'POST',path,body,requestKey:'other-'+sha(path).slice(0,20)})).status===403);
  const assigned=await propose('documents.sign','/api/documents/synthetic-document/sign');
  check('Assistant can read its pending request',(await api(`/api/assistant/signature-requests/${assigned.id}`,muse)).data.request.status==='pending');
  check('Assistant cannot read reusable frozen PDF',(await api(`/api/assistant/signature-requests/${assigned.id}/preview`,muse)).status===403);
  check('Anonymous cannot open confirmation',(await api(`/api/assistant/signature-requests/${assigned.id}`)).status===401);
  check('Another officer cannot read owner request',(await api(`/api/assistant/signature-requests/${assigned.id}`,secretaryToken)).status===403);
  check('Assistant cannot confirm',(await api(`/api/assistant/signature-requests/${assigned.id}/confirm`,muse,'POST',{fingerprint:assigned.fingerprint,consent:true})).status===403);
  check('Instruction endpoint defaults off',(await api(`/api/assistant/signature-requests/${assigned.id}/instruction`,muse,'POST',{fingerprint:assigned.fingerprint,instruction:'Sign this synthetic document.'})).status===403);
  check('Human cannot impersonate a relayed instruction',(await api(`/api/assistant/signature-requests/${assigned.id}/instruction`,ownerToken,'POST',{fingerprint:assigned.fingerprint,instruction:'Sign this synthetic document.'})).status===403);
  check('Assistant still cannot sign directly',(await api('/api/documents/synthetic-document/sign',muse,'POST',{consent:true})).status===403);
  const frozen=await api(`/api/assistant/signature-requests/${assigned.id}/preview`,ownerToken);
  check('Frozen preview hash is exact and private',frozen.status===200&&sha(frozen.data)===assigned.artifactSHA256&&frozen.headers.get('cache-control').includes('no-store'));
  const completed=await confirm(assigned);
  check('Assigned document signature completes through owner confirmation',completed.status==='completed'&&completed.receipt.appliedBy==='system');
  check('Failed completion notices remain explicit',completed.receipt.notificationState==='warnings'&&completed.receipt.notificationWarnings.length>0);
  check('Completed confirmation is receipt-only',(await confirm(assigned)).receipt.completedAt===completed.receipt.completedAt);
  const preparer=await propose('owner.minutes-preparer','/api/minutes/synthetic-minutes/preparer-attest');
  check('Minutes preparer statement includes exact review and effects',/actual preparer/.test(preparer.statement)&&preparer.effects.length===3);
  check('Minutes preparer confirmation completes',(await confirm(preparer)).status==='completed');
  const master=await propose('owner.minutes-master','/api/minutes/synthetic-minutes/master-attest');
  check('Master statement explicitly authorizes internal publication',/publish/.test(master.statement)&&master.effects.some(value=>value.includes('does not record Lodge approval')));
  check('Master confirmation completes',(await confirm(master)).status==='completed');
  const treasurer=await propose('owner.treasury-attest','/api/treasury/synthetic-treasury/preparer-attest',{revision:1});
  check('Treasury confirmation retains financial review statement',/source records, financial entries/.test(treasurer.statement));
  check('Treasury confirmation completes',(await confirm(treasurer)).status==='completed');
  for(const body of [{title:{nested:'not text'}},{requestDetails:'x'.repeat(601)}])check('Signature request rejects nested or oversized document metadata',(await api('/api/assistant/signature-requests',muse,'POST',{actionId:'owner.dispensation-sign',method:'POST',path:'/api/dispensations',body,requestKey:'invalid-body-input'})).status===400);
  check('Signature request rejects noninteger treasury revision',(await api('/api/assistant/signature-requests',muse,'POST',{actionId:'owner.treasury-attest',method:'POST',path:'/api/treasury/synthetic-treasury/preparer-attest',body:{revision:'1'},requestKey:'invalid-revision-input'})).status===400);
  const creation=await propose('owner.dispensation-sign','/api/dispensations',{requestDate:'2026-10-31',eventDate:'2026-11-14',requestDetails:'Synthetic additional communication for isolated verification only.',eventTime:'7:00 PM',locationName:'Synthetic Hall',streetAddress:'1 Example Street',cityState:'Example, DE 19709',worshipfulMasterAddress:'2 Example Street',title:'Synthetic authorization dispensation'});
  check('New dispensation request has stable explicit pending record ID',creation.recordId==='new-dispensation'&&creation.kind==='dispensation');
  const created=await confirm(creation);
  check('Dispensation creation receipt has actual persisted document ID',created.status==='completed'&&typeof created.receipt.recordId==='string'&&created.receipt.recordId!=='new-dispensation');
  const stale=await propose('documents.sign','/api/documents/synthetic-stale-document/sign');
  check('Ordinary human signing stays available',(await api('/api/documents/synthetic-stale-document/sign',ownerToken,'POST',{consent:true})).status===200);
  check('Competing completed signature invalidates old request',(await api(`/api/assistant/signature-requests/${stale.id}/confirm`,ownerToken,'POST',{fingerprint:stale.fingerprint,consent:true})).status===409);
  check('Stale request is nonready',(await api(`/api/assistant/signature-requests/${stale.id}`,muse)).data.request.ready===false);
  check('External Building signature contract remains unsupported',(await api('/api/assistant/signature-requests',muse,'POST',{actionId:'building.decide',method:'POST',path:'/api/building/requests/synthetic/decision',body:{},requestKey:'external-building'})).status===403);
  check('Owner enables instructed signatures',(await api('/api/assistant/access',ownerToken,'PUT',{name:'Synthetic Muse',permissions:[],enabled:true,expiresInDays:1,signatureExecution:true})).status===200);
  const instruct=async request=>{
    const r=await api(`/api/assistant/signature-requests/${request.id}/instruction`,muse,'POST',{fingerprint:request.fingerprint,instruction:'I reviewed this exact synthetic document and its listed effects. Apply my signature.',instructionReference:'synthetic-review-'+request.id});
    assert.equal(r.status,200,JSON.stringify(r.data));return r.data.request;
  };
  const directed=await propose('documents.sign','/api/documents/synthetic-directed-document/sign');
  check('Frozen effects accurately exclude legacy mail drafts',directed.effects.some(value=>value.includes('Spark'))&&!directed.effects.some(value=>value.includes('Missive')));
  const directedResult=await instruct(directed);
  assert.equal(directedResult.status,'completed',JSON.stringify(directedResult));
  check('Instructed assigned signature records delegation',directedResult.status==='completed'&&directedResult.receipt.authorization.source==='owner_delegation'&&directedResult.receipt.executedBy.type==='assistant');
  check('Instructed signature retry reads receipt only',(await instruct(directed)).receipt.completedAt===directedResult.receipt.completedAt);
  const directedPreparer=await propose('owner.minutes-preparer','/api/minutes/synthetic-directed-minutes/preparer-attest');
  check('Instructed actual-preparer minutes signature completes',(await instruct(directedPreparer)).status==='completed');
  const directedMaster=await propose('owner.minutes-master','/api/minutes/synthetic-directed-minutes/master-attest');
  check('Instructed Master minutes signature completes',(await instruct(directedMaster)).status==='completed');
  const directedTreasury=await propose('owner.treasury-attest','/api/treasury/synthetic-directed-treasury/preparer-attest',{revision:1});
  check('Instructed assigned-preparer treasury signature completes',(await instruct(directedTreasury)).status==='completed');
  const directedCreation=await propose('owner.dispensation-sign','/api/dispensations',{requestDate:'2026-10-31',eventDate:'2026-11-15',requestDetails:'Synthetic instructed creation only.',eventTime:'7:00 PM',locationName:'Synthetic Hall',streetAddress:'1 Example Street',cityState:'Example, DE 19709',worshipfulMasterAddress:'2 Example Street',title:'Synthetic instructed dispensation'},'instructed-creation');
  const directedCreated=await instruct(directedCreation);
  check('Instructed dispensation creation returns actual record',directedCreated.status==='completed'&&directedCreated.receipt.recordId!=='new-dispensation');
  await stop();await connect();connected=true;
  const rows=await dbAll('SELECT id,status,receipt_json FROM assistant_signature_requests ORDER BY created_at');
  check('All supported confirmations and instructions persisted receipts',rows.filter(row=>row.status==='completed').length===10);
  check('No duplicate actual document signature',(await dbGet("SELECT COUNT(*) AS total FROM document_signers WHERE document_id='synthetic-document' AND signed_at IS NOT NULL")).total===1);
  const saved=await dbGet("SELECT * FROM meeting_minutes WHERE id='synthetic-minutes'");
  check('Minutes source and submitted snapshot preserved',saved.transcript_text===beforeSource.transcript_text&&saved.submitted_draft_json&&saved.status==='ready_for_distribution');
  check('No fabricated Lodge approval or distribution',saved.approved_by_lodge_on===null&&saved.distributed_at===null);
  check('Separate preparer and Master attestations retained',(await dbGet("SELECT COUNT(*) AS total FROM meeting_minutes_attestations WHERE minutes_id='synthetic-minutes'")).total===2);
  check('Treasury assigned owner signature retained',(await dbGet("SELECT user_id FROM treasury_attestations WHERE report_id='synthetic-treasury'")).user_id===owner.id);
  const createdDocument=await dbGet('SELECT status,owner_user_id FROM documents WHERE id=?',[created.receipt.recordId]);
  check('Created dispensation preserves Secretary signing duty',createdDocument.status==='partially_signed'&&createdDocument.owner_user_id===owner.id&&(await dbGet('SELECT COUNT(*) AS total FROM document_signers WHERE document_id=? AND signed_at IS NULL',[created.receipt.recordId])).total===2);
  check('No other officer signatures changed',(await dbGet("SELECT signed_at FROM document_signers WHERE document_id='synthetic-other-document'")).signed_at===null);
  check('Instructed signature never queues a Missive draft',!(await dbGet("SELECT document_id FROM dispensation_missive_drafts WHERE document_id='synthetic-directed-document'")));
  check('Instructed minutes preserve required source and Lodge state',(await dbGet("SELECT transcript_text FROM meeting_minutes WHERE id='synthetic-directed-minutes'")).transcript_text===source&&(await dbGet("SELECT approved_by_lodge_on,distributed_at FROM meeting_minutes WHERE id='synthetic-directed-minutes'")).approved_by_lodge_on===null);
  check('Instructed creation leaves Secretary signatures pending',(await dbGet('SELECT COUNT(*) AS total FROM document_signers WHERE document_id=? AND signed_at IS NULL',[directedCreated.receipt.recordId])).total===2);
  const applied=await dbAll("SELECT * FROM audit_events WHERE action='signature_authorization_applied'");
  const humanApplied=applied.filter(row=>row.actor_type==='human'),delegatedApplied=applied.filter(row=>row.actor_type==='assistant');
  check('Human confirmation audits remain unchanged',humanApplied.length===5&&humanApplied.every(row=>row.user_id===owner.id&&JSON.parse(row.details_json).applicationActor==='system'));
  check('Delegated application audits identify Muse separately',delegatedApplied.length===5&&delegatedApplied.every(row=>row.user_id===owner.id&&row.on_behalf_of_user_id===owner.id&&JSON.parse(row.details_json).authorizationSource==='owner_delegation'));
  check('No outbound fetch or email attempted',!output.includes('External fetch')&&!output.includes('External email'));
  console.log(`${passed} isolated signature confirmation HTTP and business-operation checks passed.`);
} finally {await stop();if(connected)await close();process.env.PGLITE_DIR='';await rm(work,{recursive:true,force:true});}
