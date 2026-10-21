import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { connect, initSchema, dbRun, dbGet, close } from '../db.js';
import { initDispensationSubmissionSchema, createDispensationSubmissions } from '../dispensation-submissions.js';
import { initDispensationMissiveDraftSchema } from '../dispensation-missive-drafts.js';

assert.equal(process.env.DATABASE_URL || '', '', 'In-memory synthetic storage only');
assert.equal(process.env.PGLITE_DIR || '', '', 'No persistent Lodge storage');
import { createDispensationMissiveDrafts } from '../dispensation-missive-drafts.js';
const originalQuery = PGlite.prototype.query;
let capture = null;
const valueBytes = value => {
  if (value == null) return {raw:0,text:0};
  if (value instanceof Uint8Array) return {raw:value.byteLength,text:value.byteLength * 2 + 2};
  const n=Buffer.byteLength(typeof value === 'string' ? value : String(value));
  return {raw:n,text:n};
};
PGlite.prototype.query = async function(sql,...args) {
  const result = await originalQuery.call(this,sql,...args);
  if (capture && /^\s*SELECT\b/i.test(sql)) {
    capture.queryCount++;
    for (const row of result.rows || []) {
      capture.rowCount++;
      for (const [key,value] of Object.entries(row)) {
        const size=valueBytes(value);
        capture.returnedValueBytes += size.raw;
        capture.estimatedTextProtocolValueBytes += size.text;
        if (value instanceof Uint8Array) capture.binaryColumns.push({name:key,bytes:value.byteLength});
        if (key === 'snapshot_json') capture.snapshotJsonBytes += size.raw;
      }
    }
  }
  return result;
};
await connect(); await initSchema(); await initDispensationSubmissionSchema(); await initDispensationMissiveDraftSchema();
const at=new Date().toISOString();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const pdf=await PDFDocument.create();
pdf.addPage([612,792]);
pdf.context.register(pdf.context.stream(new Uint8Array(2 * 1024 * 1024),{}));
const signed=Buffer.from(await pdf.save({useObjectStreams:false}));
const report=Buffer.from(signed);
await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',['fixture-owner@example.invalid','unused','Fixture Owner','owner',at]);
const owner=await dbGet('SELECT id,name,email,role FROM users WHERE email=?',['fixture-owner@example.invalid']);
const client={configured:true,createDraft(){throw Error('No network allowed');},verifyDraft(){throw Error('No network allowed');}};
const service=createDispensationMissiveDrafts({client,from:'fixture-owner@example.invalid',recipient:{to:'fixture-deputy@example.invalid'}});
async function make(id) {
  await dbRun('INSERT INTO documents(id,title,original_name,stored_name,owner_user_id,file_bytes,signed_bytes,approved_bytes,status,template_kind,parsed_preview,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id,'Synthetic event','fixture.pdf','unused',owner.id,signed,signed,signed,'completed','dispensation_v1','Synthetic event report.',at,at]);
  await dbRun('INSERT INTO document_signers(document_id,signer_role,signer_name,signed_at) VALUES (?,?,?,?)',[id,'secretary','Fixture Secretary',at]);
  await dbRun('INSERT INTO dispensation_submissions(document_id,report_bytes,report_filename,report_sha256,updated_at) VALUES (?,?,?,?,?)',[id,report,'fixture-report.pdf',hash(report),at]);
}
const packets=createDispensationSubmissions({ sendEmail:()=>{throw Error('No SMTP allowed');}, addAudit:async()=>{}, recipient:{to:'fixture-deputy@example.invalid'}, missiveDraftStatus:(id,user)=>service.status(id,user) });
async function measure(label,id,packet=false) {
  capture={label,queryCount:0,rowCount:0,returnedValueBytes:0,estimatedTextProtocolValueBytes:0,binaryColumns:[],snapshotJsonBytes:0};
  const status=packet ? (await packets.packet(id,owner)).missiveDraft : await service.status(id,owner);
  const result={...capture,state:status.state};capture=null;return result;
}
const checks=[];
try {
  await make('history'); await make('drafted');
  await service.enqueue('drafted');
  await dbRun("UPDATE dispensation_missive_drafts SET state='drafted',attempted_at=?,verified_at=?,draft_id=?,conversation_id=?,draft_url=? WHERE document_id='drafted'",
    [at,at,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','https://mail.missiveapp.com/#inbox/conversations/22222222-2222-4222-8222-222222222222']);
  checks.push(await measure('completed historical, no outbox','history'));
  checks.push(await measure('attempted verified synthetic draft','drafted'));

  await dbRun("UPDATE dispensation_submissions SET message_json=? WHERE document_id='drafted'",[JSON.stringify({to:'fixture-deputy@example.invalid',name:'Fixture Deputy',filename:'fixture.pdf',reportFilename:'fixture-report.pdf',subject:'Synthetic recorded email',body:'Synthetic message metadata only.',unusedHistoricalAttachment:report.toString('base64')})]);
  checks.push(await measure('owner submission packet with unused large legacy metadata','drafted',true));
  assert.equal(checks[0].state,'not_requested');assert.equal(checks[1].state,'drafted');
  const rejection = async label => {
    const state=await service.status('drafted',owner);
    assert.equal(state.state,'uncertain',label);assert.equal(state.url,null,label);assert.equal(state.canRetry,false,label);
  };
  const tampered=Buffer.from(report);tampered[tampered.length-1]^=1;
  await dbRun("UPDATE documents SET signed_bytes=? WHERE id='drafted'",[tampered]);await rejection('changed signed bytes');await dbRun("UPDATE documents SET signed_bytes=? WHERE id='drafted'",[signed]);
  await dbRun("UPDATE dispensation_submissions SET report_bytes=? WHERE document_id='drafted'",[tampered]);await rejection('changed report bytes with unchanged recorded checksum');await dbRun("UPDATE dispensation_submissions SET report_bytes=? WHERE document_id='drafted'",[report]);
  await dbRun("UPDATE dispensation_submissions SET report_sha256=? WHERE document_id='drafted'",['0'.repeat(64)]);await rejection('changed recorded report checksum');await dbRun("UPDATE dispensation_submissions SET report_sha256=? WHERE document_id='drafted'",[hash(report)]);
  await dbRun("UPDATE document_signers SET superseded_at=? WHERE document_id='drafted'",[at]);await rejection('superseded secretary');await dbRun("UPDATE document_signers SET superseded_at=NULL WHERE document_id='drafted'");
  await dbRun("INSERT INTO document_signers(document_id,signer_role,signer_name) VALUES ('drafted','owner','Fixture required signer')");await rejection('new unsigned active signer');await dbRun("DELETE FROM document_signers WHERE document_id='drafted' AND signed_at IS NULL");
  await assert.rejects(service.status('drafted',{...owner,id:owner.id+1}),/Only the document owner/);
  await assert.rejects(service.status('drafted',{...owner,role:'secretary'}),/Only the document owner/);
  assert.equal((await service.status('drafted',owner)).state,'drafted');
  const originalSnapshot=(await dbGet("SELECT snapshot_json FROM dispensation_missive_drafts WHERE document_id='drafted'")).snapshot_json;
  const changedSnapshot=JSON.parse(originalSnapshot);changedSnapshot.body='Changed synthetic summary, exact same attachment hashes.';
  await dbRun("UPDATE dispensation_missive_drafts SET snapshot_json=? WHERE document_id='drafted'",[JSON.stringify(changedSnapshot)]);
  await rejection('changed snapshot text with unchanged payload checksum');
  const stale=await service.status('drafted',owner);assert.equal(stale.subject,undefined);assert.equal(stale.body,undefined);
  await dbRun("UPDATE dispensation_missive_drafts SET snapshot_json=? WHERE document_id='drafted'",[originalSnapshot]);
  assert.equal((await service.status('drafted',owner)).state,'drafted');
  for (const row of checks) {
    assert.equal(row.binaryColumns.length,0,'Status returns no binary columns from database');
    assert.equal(row.snapshotJsonBytes,0,'Status returns no snapshot with embedded base64');
    assert.ok(row.returnedValueBytes < 16 * 1024,'Status metadata is bounded independently of PDF size');
  }
  console.log('PASS: bounded metadata status and submission packet reads with zero binary/base64 snapshot transfers, actual-byte and recorded-checksum parity, active-signature checks, snapshot tamper rejection and owner-only authorization.');
} finally {capture=null;await close();PGlite.prototype.query=originalQuery;}
