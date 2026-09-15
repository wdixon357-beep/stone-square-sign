import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let log = '';
const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', PGLITE_DIR: '', OWNER_EMAIL: 'reports-owner@example.org', APP_BASE_URL: base, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, token, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, cache: response.headers.get('cache-control') || '' };
}

try {
  for (let index = 0; index < 160; index++) { if (server.exitCode !== null) throw Error(log); try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await pause(100); }
  const owner = (await api('/api/auth/register', null, 'POST', { email: 'reports-owner@example.org', name: 'WM Test', password: 'Owner report password' })).data;
  const invite = await api('/api/officers/invite', owner.token, 'POST', { email: 'reporter@example.org', name: 'Officer Reporter', role: 'officer', sendEmail: false });
  const officer = (await api('/api/auth/register', null, 'POST', { invitationToken: new URL(invite.data.inviteUrl).searchParams.get('invite'), email: 'reporter@example.org', name: 'Officer Reporter', password: 'Officer report password' })).data;
  const pdf = Buffer.from('%PDF-1.4\nTest received report\n%%EOF');
  const submission = { externalId: 'RPT-TEST-1001', clientId: 'client-test-1001', type: 'officer', title: 'Junior Warden Report', filename: 'Junior_Warden_Report.pdf', pdf: pdf.toString('base64'), emailed: true, preparedByOffice: 'Junior Warden' };

  assert.equal((await api('/api/officer-reports')).status, 401);
  assert.equal((await api('/api/officer-reports', officer.token)).status, 403);
  const saved = await api('/api/officer-reports', officer.token, 'POST', submission);
  assert.equal(saved.status, 201);
  assert.equal((await api('/api/officer-reports', officer.token, 'POST', submission)).data.duplicate, true);
  const list = await api('/api/officer-reports', owner.token);
  assert.equal(list.status, 200); assert.match(list.cache, /no-store/); assert.equal(list.data.reports.length, 1);
  assert.equal(list.data.reports[0].preparedBy, 'Officer Reporter'); assert.equal(list.data.reports[0].office, 'Junior Warden');
  const opened = await api(`/api/officer-reports/${list.data.reports[0].id}/pdf`, owner.token);
  assert.equal(opened.status, 200); assert.deepEqual(opened.data, pdf); assert.match(opened.cache, /no-store/);
  assert.equal((await api(`/api/officer-reports/${list.data.reports[0].id}/pdf`, officer.token)).status, 403);
  assert.equal((await api('/api/officer-reports', officer.token, 'POST', { ...submission, externalId: 'RPT-TEST-INVALID', pdf: Buffer.from('not pdf').toString('base64') })).status, 400);
  console.log('PASS: submitted officer reports are captured once, identified by the signed-in officer, and visible only to the Worshipful Master.');
} finally { server.kill('SIGTERM'); }
