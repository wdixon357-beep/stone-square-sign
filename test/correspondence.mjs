import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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
  console.log('PASS: private secretary correspondence can be drafted, revised by its preparer or WM, and previewed without signing or sending.');
} finally { server.kill('SIGTERM'); }
