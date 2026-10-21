import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { connect,initSchema,dbRun,dbGet,close,withTransaction } from '../db.js';
import { initDispensationSubmissionSchema } from '../dispensation-submissions.js';
import { initDispensationMissiveDraftSchema,createDispensationMissiveDrafts } from '../dispensation-missive-drafts.js';

assert.equal(process.env.DATABASE_URL || '','','Synthetic draft tests must use isolated in-memory storage.');
assert.equal(process.env.PGLITE_DIR || '','','Synthetic draft tests may not use persistent Lodge storage.');
await connect(); await initSchema(); await initDispensationSubmissionSchema(); await initDispensationMissiveDraftSchema();
const timestamp=new Date().toISOString(); const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const pdf=await PDFDocument.create(); pdf.addPage([612,792]); const signed=Buffer.from(await pdf.save());
const reportPdf=await PDFDocument.create(); reportPdf.addPage([500,700]); const report=Buffer.from(await reportPdf.save());
await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',['owner@example.org','unused','Synthetic Owner','owner',timestamp]);
const owner=await dbGet('SELECT * FROM users WHERE email = ?',['owner@example.org']);
const audits=[]; const creations=[]; const verifications=[]; let mode='valid'; let sequence=0;
const client={configured:true,async createDraft(packet) {
  if(mode==='rejected') throw Object.assign(new Error('Missive refused the draft.'),{ambiguous:false,code:'http_422'});
  if(mode==='unknown') {creations.push(packet);throw Object.assign(new Error('Network ended before confirmation.'),{ambiguous:true,code:'network_outcome_unknown'});}
  creations.push(packet); sequence++; return {draftId:`11111111-1111-4111-8111-${String(sequence).padStart(12,'0')}`,conversationId:'22222222-2222-4222-8222-222222222222'};
},async verifyDraft(receipt,packet) {
  verifications.push(receipt);
  if(mode==='unverified') throw Object.assign(new Error('Cannot read the attachment yet.'),{ambiguous:true,code:'attachment_unverified'});
  return {...receipt,url:`https://mail.missiveapp.com/#inbox/conversations/${receipt.conversationId}`,unsent:true,
    attachments:packet.attachments.map(item=>({filename:item.filename,sha256:item.sha256,size:item.size}))};
}};
const service=createDispensationMissiveDrafts({client,from:'owner@example.org',recipient:{to:'deputy@example.org',name:'District Deputy'},lodgeName:'Synthetic Lodge No. 100',addAudit:async event=>audits.push(event)});
async function make(id,{completed=true,submitted=false,reportPresent=true,role='assistant_secretary',superseded=false}={}) {
  await dbRun(`INSERT INTO documents(id,title,original_name,stored_name,owner_user_id,file_bytes,signed_bytes,status,template_kind,parsed_preview,created_at,updated_at,submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,'Sample community meal','dispensation.pdf','unused.pdf',owner.id,signed,completed?signed:null,completed?'completed':'pending','dispensation_v1','Sample community meal on November 1, 2026.',timestamp,timestamp,submitted?timestamp:null]);
  await dbRun('INSERT INTO document_signers(document_id,signer_role,signer_name,signed_at,superseded_at) VALUES (?,?,?,?,?)',[id,role,'Synthetic Secretary',completed?timestamp:null,superseded?timestamp:null]);
  if(reportPresent) await addReport(id);
}
async function addReport(id,bytes=report) {
  await dbRun(`INSERT INTO dispensation_submissions(document_id,report_bytes,report_filename,report_sha256,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(document_id) DO UPDATE SET report_bytes=excluded.report_bytes,report_sha256=excluded.report_sha256,updated_at=excluded.updated_at`,[id,bytes,'proposal-report.pdf',digest(bytes),timestamp]);
}
try {
  await make('historical',{submitted:true}); await service.enqueue('historical');
  assert.equal(await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ?',['historical']),undefined);
  await make('untouched'); await service.enqueue('untouched',{onlyExisting:true});
  assert.equal((await service.status('untouched',owner)).state,'not_requested');assert.equal((await service.status('historical',owner)).state,'not_requested');
  assert.equal((await service.status('untouched',owner)).body,undefined,'An unrequested historical record cannot advertise nonexistent email attachments.');
  await service.processPending({limit:10}); assert.equal(creations.length,0,'Report attachments and worker scans never backfill old completed records.');
  await assert.rejects(service.status('untouched',{id:owner.id,role:'secretary'}),/Only the document owner/);
  await assert.rejects(service.status('untouched',{id:owner.id+1,role:'owner'}),/Only the document owner/);
  await assert.rejects(service.status('untouched'),/Only the document owner/);
  await make('unsigned',{completed:false}); assert.equal((await service.enqueue('unsigned')).state,'awaiting_signature');
  await service.processPending({limit:10}); assert.equal(creations.length,0);
  await make('no-secretary',{role:'owner'}); assert.equal((await service.enqueue('no-secretary')).state,'awaiting_signature');
  await make('superseded',{superseded:true}); assert.equal((await service.enqueue('superseded')).state,'awaiting_signature');
  await make('late-report',{reportPresent:false}); assert.equal((await service.enqueue('late-report')).state,'awaiting_report');
  assert.equal((await service.status('late-report',owner)).body,undefined,'A missing report has no complete draft overview yet.');
  await dbRun('UPDATE documents SET title=? WHERE id=?',['Dispensation Request: Sample community meal','late-report']);
  await addReport('late-report'); await service.enqueue('late-report',{onlyExisting:true});
  await Promise.all([service.processPending({limit:10}),service.processPending({limit:10}),service.enqueue('late-report')]);
  assert.equal(creations.length,1,'Concurrent workers and final-signature hooks create one draft.');
  const saved=await service.status('late-report',owner); assert.equal(saved.state,'drafted'); assert.equal(saved.automaticSendingEnabled,false);assert.equal(saved.reportLocked,true);assert.match(saved.body,/Request: Sample community meal on November 1, 2026/);assert.match(saved.body,/proposal-report\.pdf/);
  assert.deepEqual(Buffer.from(creations[0].attachments[0].base64,'base64'),signed);
  assert.equal(saved.subject,'Dispensation request: Sample community meal','The existing record title does not duplicate the email subject prefix.');
  assert.deepEqual(Buffer.from(creations[0].attachments[1].base64,'base64'),report);
  assert.ok(saved.createdAt);assert.ok(saved.queuedAt);
  const persisted=await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ?',['late-report']);
  assert.equal(saved.createdAt,persisted.verified_at);
  assert.equal(persisted.payload_sha256,digest(Buffer.from(persisted.snapshot_json))); assert.equal(persisted.signed_sha256,digest(signed));assert.equal(persisted.report_sha256,digest(report));
  assert.equal((await dbGet('SELECT submitted_at FROM documents WHERE id = ?',['late-report'])).submitted_at,null,'Creating a draft is never recorded as email delivery.');
  await service.enqueue('late-report'); await service.processPending({limit:10});assert.equal(creations.length,1);
  await assert.rejects(service.retry('late-report',owner),/cannot be created again safely/);
  await make('not-configured'); client.configured=false;assert.equal((await service.enqueue('not-configured')).state,'not_configured');
  await service.processPending({limit:10});assert.equal(creations.length,1);
  client.configured=true;await service.processPending({limit:10});assert.equal((await service.status('not-configured',owner)).state,'drafted');
  await make('known-refusal');mode='rejected';await service.enqueue('known-refusal');await service.processPending({limit:10});
  assert.equal((await service.status('known-refusal',owner)).state,'failed');assert.equal((await service.status('known-refusal',owner)).canRetry,true);
  mode='valid';await service.processPending({limit:10});assert.equal((await service.status('known-refusal',owner)).state,'failed','A refusal waits for explicit owner retry.');
  assert.equal((await service.retry('known-refusal',owner,{actorUserId:owner.id})).state,'pending');await service.processPending({limit:10});assert.equal((await service.status('known-refusal',owner)).state,'drafted');
  await make('lost-response');mode='unknown';await service.enqueue('lost-response');await service.processPending({limit:10});
  const unknown=await service.status('lost-response',owner);assert.equal(unknown.state,'uncertain');assert.equal(unknown.canRetry,false);
  const before=creations.length;mode='valid';await service.processPending({limit:10});await service.enqueue('lost-response');
  await assert.rejects(service.retry('lost-response',owner),/cannot be created again safely/);assert.equal(creations.length,before,'Unknown accepted outcome can never create a duplicate.');
  await make('verify-retry');mode='unverified';await service.enqueue('verify-retry');await service.processPending({limit:10});
  const readback=await service.status('verify-retry',owner);assert.equal(readback.state,'uncertain');assert.ok(readback.draftId);assert.equal(readback.canRetry,true);
  const count=creations.length;mode='valid';assert.equal((await service.retry('verify-retry',owner)).state,'pending');await service.processPending({limit:10});assert.equal((await service.status('verify-retry',owner)).state,'drafted');assert.equal(creations.length,count,'Known draft retries only read back the same draft.');
  await make('crashed-worker');await service.enqueue('crashed-worker');
  await dbRun(`UPDATE dispensation_missive_drafts SET state='creating',claim_token='crashed',claim_started_at=?,attempted_at=? WHERE document_id=?`,[new Date(Date.now()-600_000).toISOString(),timestamp,'crashed-worker']);
  await service.processPending({limit:10});assert.equal((await service.status('crashed-worker',owner)).state,'uncertain');assert.equal(creations.length,count);
  await make('bad-checksum');await dbRun('UPDATE dispensation_submissions SET report_sha256=? WHERE document_id=?',['0'.repeat(64),'bad-checksum']);
  assert.equal((await service.enqueue('bad-checksum')).state,'failed');assert.equal(creations.length,count);
  await make('transaction-rollback');
  await assert.rejects(withTransaction(async()=>{await service.enqueue('transaction-rollback');throw new Error('rollback');}),/rollback/);
  assert.equal(await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id=?',['transaction-rollback']),undefined,'Outbox participation is atomic with signature transaction.');
  assert.equal(creations.length,count,'Enqueue never performs network work.');
  await dbRun('UPDATE documents SET signed_bytes=? WHERE id=?',[report,'late-report']);
  const stale=await service.status('late-report',owner);assert.equal(stale.state,'uncertain');assert.equal(stale.url,null);assert.equal(stale.canRetry,false);
  await assert.rejects(service.retry('late-report',owner),/cannot be created again safely/);
  await dbRun('UPDATE documents SET status=? WHERE id=?',['rescinded','verify-retry']);
  assert.equal((await service.status('verify-retry',owner)).state,'uncertain');
  await make('known-draft-changed');mode='unverified';await service.enqueue('known-draft-changed');await service.processPending({limit:10});
  const priorCreateCount=creations.length;mode='valid';await service.retry('known-draft-changed',owner);
  await dbRun('UPDATE documents SET signed_bytes=? WHERE id=?',[report,'known-draft-changed']);await service.processPending({limit:10});
  assert.equal((await dbGet('SELECT state FROM dispensation_missive_drafts WHERE document_id=?',['known-draft-changed'])).state,'uncertain');
  assert.equal(creations.length,priorCreateCount,'Changed source with a known receipt remains uncertain and cannot create again.');
  await dbRun("UPDATE dispensation_missive_drafts SET state='failed' WHERE document_id=?",['known-draft-changed']);
  assert.equal((await service.status('known-draft-changed',owner)).canRetry,false,'A known accepted draft can never advertise a new-creation retry.');
  const noChanges=await service.processPending({limit:10});assert.equal(noChanges.changed,0,'Unchanged waiting states do not request UI broadcasts.');
  assert.ok(audits.some(event=>event.action==='dispensation_missive_draft_verified'));
  assert.equal(audits.some(event=>JSON.stringify(event).includes('base64')),false,'Audit trails contain hashes and IDs, never attachment contents.');
  console.log('Dispensation Missive outbox: owner privacy, signature/report waits, atomic queue, immutable PDFs, single creation, unknown outcome protection and verification recovery passed.');
} finally { await close(); }
