import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { PDFDocument } from 'pdf-lib';

assert(!process.env.DATABASE_URL && !process.env.PGLITE_DIR, 'Run only without a configured database.');
const work = await mkdtemp(join(tmpdir(), 'ss22-dispensation-routing-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const loader = join(work, 'isolation.mjs');
await writeFile(loader, `import dotenv from ${JSON.stringify(import.meta.resolve('dotenv'))};
import nodemailer from ${JSON.stringify(import.meta.resolve('nodemailer'))};
dotenv.config=()=>({parsed:{}});
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{if(new URL(url).origin!==${JSON.stringify(base)})throw new Error('External network disabled in isolated test.');return originalFetch(url,options)};
nodemailer.createTransport=()=>{throw new Error('External email disabled in isolated test.')};`);
const server = spawn(process.execPath, ['--import', loader, 'server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: '', PGLITE_DIR: '',
    OWNER_EMAIL: 'routing-owner@example.invalid', APP_BASE_URL: base, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
    OPENAI_API_KEY: '', MISSIVE_API_TOKEN: '', ZEFFY_API_KEY: '', TRACKER_SSO_SHARED_SECRET: '', LODGE_ACCESS_CODE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', value => logs += value);
server.stderr.on('data', value => logs += value);
async function api(path, { method = 'GET', token, body, form } = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: response.headers.get('content-type')?.includes('json')
    ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
let muse;
async function mcp(name, args) {
  const response = await api('/api/assistant/mcp', { method: 'POST', token: muse,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.result;
}
const value = result => { assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
async function pdf(text) {
  const document = await PDFDocument.create();
  document.addPage().drawText(text);
  return Buffer.from(await document.save());
}
const ordinaryBytes = await pdf('Synthetic Lodge document. Secretary. The dispensation was approved.');
const dispensationBytes = await pdf('REQUEST FOR DISPENSATION. William McDuffie, Secretary.');
async function instructedUpload({ bytes = ordinaryBytes, filename = 'document.pdf', title = 'Lodge document', key }) {
  const file = { fieldname: 'document', originalname: filename, mimetype: 'application/pdf', data: bytes.toString('base64') };
  const request = value(await mcp('request_upload', { actionId: 'owner.documents', method: 'POST', path: '/api/documents',
    body: { title }, requestKey: key, files: [file] })).request;
  value(await mcp('authorize_instruction', { requestId: request.id, fingerprint: request.fingerprint,
    instruction: 'Upload this exact synthetic document for the isolated routing test.' }));
  return mcp('execute', { requestId: request.id, files: [file] });
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, logs);
  const registration = await api('/api/auth/register', { method: 'POST',
    body: { email: 'routing-owner@example.invalid', name: 'Synthetic Owner', password: 'Isolated example passphrase' } });
  assert.equal(registration.status, 201, JSON.stringify(registration.data));
  const owner = registration.data.token;
  const workspace = await api('/api/assistant/workspace', { token: owner });
  const permissions = workspace.data.capabilities.filter(item => ['standing', 'approval'].includes(item.mode)).map(item => item.id);
  assert.equal((await api('/api/assistant/access', { token: owner, method: 'PUT',
    body: { name: 'Synthetic Muse', permissions, expiresInDays: 365, enabled: true, commandExecution: true } })).status, 200);
  muse = (await api('/api/assistant/access/token', { token: owner, method: 'POST', body: {} })).data.token;
  const baseline = (await api('/api/documents', { token: owner })).data.documents;
  for (const input of [
    { title: 'Fellowcraft Degree Work - Dispensation', key: 'dispensation-title' },
    { filename: 'Fellowcraft_DISPENSATION.pdf', key: 'dispensation-filename' },
    { bytes: dispensationBytes, key: 'dispensation-text' },
  ]) {
    const rejected = await instructedUpload(input);
    assert.equal(rejected.isError, true, JSON.stringify(rejected));
    const message = rejected.content.map(item => item.text || '').join(' ');
    assert.match(message, /owner\.dispensation-sign/);
    assert.match(message, /request_signature/);
    assert.match(message, /cannot safely replace preprinted Secretary information/);
    assert.match(message, /No document was created/);
    assert.deepEqual((await api('/api/documents', { token: owner })).data.documents, baseline,
      'A rejected delegated dispensation must not create a signing record.');
  }
  const ordinary = value(await instructedUpload({ key: 'ordinary-upload' }));
  assert(ordinary.document?.id, 'An ordinary document that mentions a dispensation must remain uploadable: ' + JSON.stringify(ordinary));
  const stored = (await api(`/api/documents/${ordinary.document.id}`, { token: owner })).data.document;
  assert.equal(stored.template_kind, null, 'Ordinary uploads remain generic.');
  assert.equal(stored.signers.length, 1, 'Ordinary signer detection is unchanged.');
  assert.equal(stored.signers[0].signer_role, 'secretary');
  const form = new FormData();
  form.set('title', 'Owner-supplied historical dispensation');
  form.set('document', new Blob([dispensationBytes], { type: 'application/pdf' }), 'dispensation.pdf');
  const ownerUpload = await api('/api/documents', { token: owner, method: 'POST', form });
  assert.equal(ownerUpload.status, 201, JSON.stringify(ownerUpload.data));
  const ownerRecord = (await api(`/api/documents/${ownerUpload.data.document.id}`, { token: owner })).data.document;
  assert.equal(ownerRecord.template_kind, null, 'Owner generic uploads are not silently converted into official templates.');
  const fields = { requestDate: '2026-11-17', eventDate: '2027-01-21', requestDetails: 'Synthetic degree work',
    eventTime: '7:30 PM', locationName: 'Synthetic Lodge Hall', streetAddress: '123 Example Street',
    cityState: 'Example, DE 19709', worshipfulMasterAddress: '456 Sample Street, Example, DE 19709' };
  for (const choice of [{}, { signerRole: 'secretary' }, { signerRoles: ['assistant_secretary'] }]) {
    const preview = await api('/api/dispensations/preview', { method: 'POST', token: muse, body: { ...fields, ...choice } });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.subarray(0, 5).toString(), '%PDF-');
  }
  const signatureData = `data:image/png;base64,${(await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim()}`;
  async function officer(role, name) {
    const email = `${role}@example.invalid`;
    const invitation = await api('/api/officers/invite', { token: owner, method: 'POST',
      body: { email, name, role, sendEmail: false } });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
    const invited = await api('/api/auth/register', { method: 'POST', body: { email, name,
      password: 'Another isolated passphrase', invitationToken: new URL(invitation.data.inviteUrl).searchParams.get('invite') } });
    assert.equal(invited.status, 201, JSON.stringify(invited.data));
    return invited.data.token;
  }
  const secretary = await officer('secretary', 'Synthetic Secretary');
  const assistantSecretary = await officer('assistant_secretary', 'Synthetic Assistant');
  for (const token of [owner, secretary, assistantSecretary]) {
    assert.equal((await api('/api/profile/signature', { token, method: 'PUT',
      body: { signatureData, signatureType: 'drawn' } })).status, 200);
  }
  for (const [role, name, address] of [
    ['secretary', 'Synthetic Secretary Profile', '111 Secretary Road, Dover, DE 19901'],
    ['assistant_secretary', 'Synthetic Assistant Profile', '222 Assistant Road, Dover, DE 19901'],
  ]) {
    assert.equal((await api(`/api/submission-profiles/${role}`, { token: owner, method: 'PUT',
      body: { name, address } })).status, 200);
  }
  const official = await api('/api/dispensations', { token: owner, method: 'POST',
    body: { ...fields, title: 'Synthetic either Secretary dispensation', personalInfoConfirmed: true,
      signerRoles: ['secretary'] } });
  assert.equal(official.status, 201, JSON.stringify(official.data));
  const officialId = official.data.document.id;
  const beforeSigning = (await api(`/api/documents/${officialId}`, { token: owner })).data.document;
  assert.equal(beforeSigning.template_kind, 'dispensation_v1');
  assert.equal(beforeSigning.signing_mode, 'any');
  assert.deepEqual(beforeSigning.signers.filter(signer => !signer.signed_at).map(signer => signer.signer_role).sort(),
    ['assistant_secretary', 'secretary'], 'Legacy single-role input cannot restrict the official template.');
  const assistantQueue = (await api('/api/documents', { token: assistantSecretary })).data.documents;
  assert.equal(assistantQueue.find(document => document.id === officialId)?.needsSignature, true);
  const signed = await api(`/api/documents/${officialId}/sign`, { token: assistantSecretary, method: 'POST',
    body: { consent: true, officerName: 'Wrong client name', officerAddress: 'Wrong client address' } });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.equal(signed.data.status, 'completed');
  const afterSigning = (await api(`/api/documents/${officialId}`, { token: owner })).data.document;
  const actualSigner = afterSigning.signers.find(signer => signer.signer_role === 'assistant_secretary');
  const otherSigner = afterSigning.signers.find(signer => signer.signer_role === 'secretary');
  assert(actualSigner.signed_at);
  assert.equal(actualSigner.signer_name, 'Synthetic Assistant Profile');
  assert(otherSigner.superseded_at);
  assert.equal(otherSigner.signed_at, null);
  const signedPdf = (await api(`/api/documents/${officialId}/file`, { token: owner })).data;
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: signedPdf });
  const signedText = (await parser.getText()).text;
  await parser.destroy();
  assert.match(signedText, /Synthetic Assistant Profile/);
  assert.match(signedText, /222 Assistant Road, Dover, DE 19901/);
  assert.doesNotMatch(signedText, /Synthetic Secretary Profile|111 Secretary Road|Wrong client|McDuffie/);
  const finalPdf = await PDFDocument.load(signedPdf);
  assert(!finalPdf.getForm().getFields().some(field => ['Secretary', 'Address_2'].includes(field.getName())),
    'Blank widgets cannot obscure the actual signer information.');
  const secondSignature = await api(`/api/documents/${officialId}/sign`, { token: secretary, method: 'POST',
    body: { consent: true } });
  assert.equal(secondSignature.status, 409, 'The other Secretary cannot sign after completion.');
  assert.deepEqual((await api(`/api/documents/${officialId}/file`, { token: owner })).data, signedPdf,
    'Rejected second signature leaves the completed PDF unchanged.');
  const activity = (await api('/api/admin/activity', { token: owner })).data.events;
  assert.equal(activity.filter(event => event.action === 'document_uploaded').length, 2,
    'Only the ordinary assistant upload and owner upload create document upload events.');
  console.log('PASS: delegated dispensation uploads rejected by title, filename and PDF text without records; ordinary and owner uploads preserved; official preview accepts no choice and legacy single choices; Assistant Secretary signs first with his saved profile and excludes the other signer.');
} finally {
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  await rm(work, { recursive: true, force: true });
}
