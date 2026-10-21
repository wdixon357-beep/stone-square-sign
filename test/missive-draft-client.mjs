import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { buildMissiveDraftRequest, createMissiveDraftClient, safeAttachmentUrl, MISSIVE_MAX_PAYLOAD_BYTES } from '../missive-draft-client.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pdf = await PDFDocument.create(); pdf.addPage([612,792]); const signed = Buffer.from(await pdf.save());
const other = await PDFDocument.create(); other.addPage([500,700]); const report = Buffer.from(await other.save());
const draftId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const snapshot = { from: { address: 'owner@example.org' }, to: { address: 'deputy@example.org', name: 'District Deputy' }, subject: 'Dispensation request: Sample community event',
  body: 'Attached are the fully signed dispensation and corresponding report. Please review the request and supporting details.',
  attachments: [{ filename: 'signed-dispensation.pdf', base64: signed.toString('base64'), sha256: digest(signed), size: signed.length },
    { filename: 'corresponding-report.pdf', base64: report.toString('base64'), sha256: digest(report), size: report.length }] };
const payload = buildMissiveDraftRequest({ ...snapshot, send: true, send_at: 12345, conversation: 'should-never-leak' });
assert.equal(payload.drafts.send, false); assert.equal(payload.drafts.add_default_signature, true);
for (const key of ['send_at','auto_followup','references','conversation','add_users','organization','add_to_inbox']) assert.equal(key in payload.drafts, false, key);
assert.equal(payload.drafts.quote_previous_message, false);
assert.deepEqual(Object.keys(payload).sort(), ['drafts']);
assert.deepEqual(Buffer.from(payload.drafts.attachments[0].base64_data,'base64'), signed);
assert.deepEqual(Buffer.from(payload.drafts.attachments[1].base64_data,'base64'), report);
for (const url of ['http://cdn.example.org/x','https://localhost/x','https://127.0.0.1/x','https://169.254.169.254/x','https://example.internal/x','https://user:pass@cdn.example.org/x','https://cdn.example.org:444/x','https://[::ffff:127.0.0.1]/x']) assert.throws(() => safeAttachmentUrl(url), /unsafe/);
assert.equal(safeAttachmentUrl('https://cdn.example.org/file.pdf?signature=opaque').hostname, 'cdn.example.org');
assert.throws(() => buildMissiveDraftRequest({ ...snapshot, attachments: [snapshot.attachments[0],snapshot.attachments[0]] }), /PDFs/);
const oversized = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(Math.floor(MISSIVE_MAX_PAYLOAD_BYTES*0.8))]);
assert.throws(() => buildMissiveDraftRequest({ ...snapshot, attachments: [{ filename:'large.pdf', base64: oversized.toString('base64'), size: oversized.length, sha256:digest(oversized) },snapshot.attachments[1]] }), /10 MB/);

const calls = []; const downloads = []; let behavior = 'valid';
const resultMessage = () => ({ id: draftId, draft:true, type:'email', delivered_at:null, subject:snapshot.subject,
  from_field:snapshot.from, to_fields:[snapshot.to], cc_fields:[], bcc_fields:[],
  body:`<div>${snapshot.body}</div><div><br></div><div>Configured account signature</div>`,
  attachments:snapshot.attachments.map((item,index) => ({ id:`pdf-${index}`, filename:item.filename, extension:'pdf', media_type:'application', sub_type:'pdf', size:item.size, url:`https://cdn.example.org/${index}.pdf` })),
  conversation:{ id:conversationId } });
const fetchImpl = async (url, options) => {
  calls.push({ url, options });
  assert.equal(new URL(url).origin, 'https://public.missiveapp.com');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-only');
  assert.equal(options.redirect, 'error');
  if (url.endsWith('/drafts') && options.method === 'POST') {
    if (behavior === 'timeout') throw new Error('socket lost');
    if (behavior === 'rejected') return new Response('{}',{status:422});
    if (behavior === 'server-error') return new Response('{}',{status:500});
    if (behavior === 'no-receipt') return new Response('{}',{status:201});
    const sent = JSON.parse(options.body); assert.equal(sent.drafts.send, false);
    return new Response(JSON.stringify({drafts:{id:draftId,conversation:{id:conversationId}}}),{status:201});
  }
  if (url.endsWith(`/messages/${draftId}`)) {
    const message = resultMessage();
    if (behavior === 'wrong-sender') message.from_field={address:'other@example.org'};
    if (behavior === 'wrong-body') message.body='<div>A different message</div>';
    if (behavior === 'sent') message.delivered_at=1234;
    if (behavior === 'extra-recipient') message.bcc_fields=[{address:'unexpected@example.org'}];
    if (behavior === 'unsafe-download') message.attachments[0].url='https://127.0.0.1/secret';
    if (behavior === 'unexpected-attachment') message.attachments.push({id:'extra',filename:'extra.pdf',size:123,url:'https://cdn.example.org/extra.pdf'});
    if (behavior === 'signature-image') { message.body+='<img data-missive-attachment-id="signature-image">'; message.attachments.push({id:'signature-image',filename:'signature.png',media_type:'image',size:10,url:'https://cdn.example.org/signature.png'}); }
    return new Response(JSON.stringify({messages:message}));
  }
  if (url.endsWith(`/conversations/${conversationId}/drafts`)) return new Response(JSON.stringify({drafts:behavior === 'not-a-draft' ? [] : [{id:draftId,draft:true,delivered_at:null}]}));
  throw new Error('Unexpected request');
};
const client = createMissiveDraftClient({ token:'synthetic-only',fetchImpl, downloadImpl:async (url,options) => { downloads.push({url,options}); if (behavior === 'wrong-hash') return signed; return url.includes('/0.pdf') ? signed : report; } });
assert.equal(client.configured,true);
const receipt = await client.createDraft(snapshot);
assert.deepEqual(receipt,{draftId,conversationId});
const verified = await client.verifyDraft(receipt,snapshot);
assert.equal(verified.unsent,true); assert.equal(verified.url,`https://mail.missiveapp.com/#inbox/conversations/${conversationId}`);
assert.deepEqual(verified.attachments.map(item => item.sha256),snapshot.attachments.map(item => item.sha256));
assert.equal(downloads.length,2); assert.equal('headers' in downloads[0].options,false, 'No bearer token goes to attachment hosts.');
behavior='signature-image'; assert.equal((await client.verifyDraft(receipt,snapshot)).unsent,true);
for (const scenario of ['wrong-sender','wrong-body','sent','extra-recipient','unsafe-download','unexpected-attachment','wrong-hash','not-a-draft']) {
  behavior=scenario; await assert.rejects(client.verifyDraft(receipt,snapshot), error => error.ambiguous === true || error.code === 'unsafe_attachment_url',scenario);
}
for (const scenario of ['timeout','server-error','no-receipt']) {
  behavior=scenario; await assert.rejects(client.createDraft(snapshot), error => error.ambiguous === true,scenario);
}
behavior='rejected'; await assert.rejects(client.createDraft(snapshot),error => error.ambiguous === false);
const absent=createMissiveDraftClient({token:'',fetchImpl:async()=>{throw new Error('No network permitted');}});
assert.equal(absent.configured,false); await assert.rejects(absent.createDraft(snapshot),/Connect/);
assert.equal(calls.some(item => item.options.method !== 'POST' && item.options.method !== 'GET'),false);
console.log('Missive draft client: hard-disabled sending, exact PDFs, safe downloads, unsent readback, refusal and unknown outcomes passed.');
