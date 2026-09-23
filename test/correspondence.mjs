import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';

const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let log = '';
const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', PGLITE_DIR: '',
    OWNER_EMAIL: 'correspondence-owner@example.org', APP_BASE_URL: base,
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, token, method = 'GET', body) {
  const response = await fetch(base + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: response.headers.get('content-type')?.includes('json')
    ? await response.json() : Buffer.from(await response.arrayBuffer()), cache: response.headers.get('cache-control') || '' };
}
try {
  for (let index = 0; index < 160; index++) { if (server.exitCode !== null) throw Error(log); try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await pause(100); }
  const owner = (await api('/api/auth/register', null, 'POST', { email: 'correspondence-owner@example.org', name: 'WM Test', password: 'Owner password sample' })).data;
  async function invite(role, email, name) {
    const invited = await api('/api/officers/invite', owner.token, 'POST', { role, email, name, sendEmail: false });
    assert.equal(invited.status, 201);
    return (await api('/api/auth/register', null, 'POST', { invitationToken: new URL(invited.data.inviteUrl).searchParams.get('invite'), email, name, password: 'Officer password sample' })).data;
  }
  const secretary = await invite('secretary', 'secretary@example.org', 'William McDuffie');
  const assistant = await invite('assistant_secretary', 'assistant@example.org', 'Adrian Reese');
  const officer = await invite('officer', 'officer@example.org', 'Other Officer');
  const letter = { matter: 'demit', recipientLodge: 'Star in the East Lodge No. 1', recipientName: 'Secretary',
    subject: 'PM James Thomas dues update', body: 'Dues were paid. Remaining procedure is under review.' };
  assert.equal((await api('/api/correspondence')).status, 401);
  assert.equal((await api('/api/correspondence', officer.token)).status, 403);
  assert.equal((await api('/api/correspondence', officer.token, 'POST', letter)).status, 403);
  assert.equal((await api('/api/correspondence', secretary.token, 'POST', { ...letter, body: '' })).status, 400);
  const saved = await api('/api/correspondence', secretary.token, 'POST', letter);
  assert.equal(saved.status, 201); assert.equal(saved.data.draft.preparedByName, 'William McDuffie');
  assert.equal(saved.data.draft.preparedByOffice, 'Secretary'); assert.equal(saved.data.draft.status, 'draft');
  const id = saved.data.draft.id;
  const list = await api('/api/correspondence', assistant.token);
  assert.equal(list.status, 200); assert.match(list.cache, /no-store/); assert.equal(list.data.drafts[0].id, id);
  assert.equal((await api(`/api/correspondence/${id}`, assistant.token, 'PUT', { ...letter, subject: 'Changed' })).status, 403);
  const pdf = await api(`/api/correspondence/${id}/pdf`, assistant.token);
  assert.equal(pdf.status, 200); assert.match(pdf.cache, /no-store/);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  const rendered = await getDocument({ data: new Uint8Array(pdf.data), useSystemFonts: true }).promise;
  const page = await rendered.getPage(1);
  const printed = (await page.getTextContent()).items.map(item => item.str).join(' ');
  assert.match(printed, /Stone Square Lodge No\. 22/);
  assert.match(printed, /OFFICERS/);
  assert.match(printed, /Secretary William McDuffie/);
  assert.match(printed, /DRAFT - NOT SIGNED OR SENT/);
  await rendered.destroy();
  const edited = await api(`/api/correspondence/${id}`, owner.token, 'PUT', { ...letter, subject: 'Dues payment acknowledged' });
  assert.equal(edited.status, 200); assert.equal(edited.data.draft.subject, 'Dues payment acknowledged');
  assert.equal(edited.data.draft.preparedByName, 'William McDuffie');
  assert.equal((await api('/api/correspondence', owner.token)).data.drafts[0].status, 'draft');
  const wmDraft = await api('/api/correspondence', owner.token, 'POST', { ...letter, subject: 'WM prepared for Secretary signature' });
  assert.equal(wmDraft.status, 201);
  assert.equal(wmDraft.data.draft.assignedToName, 'William McDuffie');
  const wmId = wmDraft.data.draft.id;
  const access = await api('/api/admin/access', owner.token);
  const mcduffie = access.data.accounts.find(account => account.id === secretary.user.id && !account.pending);
  assert.ok(mcduffie);
  assert.equal((await api('/api/admin/access', owner.token, 'PUT', {
    key: mcduffie.key, permissions: mcduffie.permissions.filter(permission => permission !== 'reports.create'),
  })).status, 200);
  assert.equal((await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST')).status, 409);
  assert.equal((await api('/api/admin/access', owner.token, 'PUT', {
    key: mcduffie.key, permissions: mcduffie.permissions,
  })).status, 200);
  assert.equal((await api(`/api/correspondence/${wmId}/submit`, assistant.token, 'POST')).status, 403);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true })).status, 403);
  const submitted = await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST');
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.draft.status, 'awaiting_secretary');
  assert.equal(submitted.data.draft.assignedToUserId, secretary.user.id);
  const secretaryAlerts = await api('/api/correspondence/alerts', secretary.token);
  assert.equal(secretaryAlerts.status, 200);
  assert.match(secretaryAlerts.cache, /no-store/);
  assert.equal(secretaryAlerts.data.alerts[0].id, wmId);
  assert.equal((await api(`/api/correspondence/${wmId}/return`, assistant.token, 'POST', { reason: 'Correction' })).status, 403);
  assert.equal((await api(`/api/correspondence/${wmId}/return`, secretary.token, 'POST', { reason: '' })).status, 400);
  const returned = await api(`/api/correspondence/${wmId}/return`, secretary.token, 'POST', { reason: 'Check the date.' });
  assert.equal(returned.status, 200);
  assert.equal(returned.data.draft.status, 'draft');
  assert.equal(returned.data.draft.returnNote, 'Check the date.');
  assert.equal((await api('/api/correspondence/alerts', owner.token)).data.alerts[0].id, wmId);
  assert.equal((await api('/api/correspondence/alerts', secretary.token)).data.alerts.length, 0);
  const resubmitted = await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST');
  assert.equal(resubmitted.status, 200);
  assert.equal(resubmitted.data.draft.returnNote, null);
  assert.equal((await api(`/api/correspondence/${wmId}`, owner.token, 'PUT', letter)).status, 409);
  assert.equal((await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST')).status, 409);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, assistant.token, 'POST', { consent: true })).status, 403);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: false })).status, 400);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true })).status, 409);
  const signatureData = `data:image/png;base64,${(await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim()}`;
  assert.equal((await api('/api/profile/signature', secretary.token, 'PUT', { signatureData, signatureType: 'drawn' })).status, 200);
  const signed = await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true });
  assert.equal(signed.status, 200);
  assert.equal(signed.data.draft.status, 'signed');
  assert.equal(signed.data.draft.signedByName, 'William McDuffie');
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true })).status, 403);
  const signedPdf = await api(`/api/correspondence/${wmId}/pdf`, secretary.token);
  const signedDocument = await getDocument({ data: new Uint8Array(signedPdf.data), useSystemFonts: true }).promise;
  const signedText = (await (await signedDocument.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  assert.match(signedText, /SIGNED - DELIVERY BY THE SECRETARY PENDING/);
  assert.match(signedText, /Secretary William McDuffie/);
  await signedDocument.destroy();
  console.log('PASS: WM can assign a private letter to McDuffie; only he can consent, sign with his saved signature, and download the signed PDF for manual email.');
} finally { server.kill('SIGTERM'); }
