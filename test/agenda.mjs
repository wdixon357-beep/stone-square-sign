import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { PDFParse } from 'pdf-parse';

const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let log = '';
const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', PGLITE_DIR: '', OWNER_EMAIL: 'agenda-owner@example.org', APP_BASE_URL: base, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, token, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, cache: response.headers.get('cache-control') || '' };
}
try {
  for (let index = 0; index < 160; index++) { if (server.exitCode !== null) throw Error(log); try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await pause(100); }
  const owner = (await api('/api/auth/register', null, 'POST', { email: 'agenda-owner@example.org', name: 'Agenda WM', password: 'Agenda owner password' })).data;
  const invite = await api('/api/officers/invite', owner.token, 'POST', { email: 'agenda-officer@example.org', name: 'Agenda Officer', role: 'officer', sendEmail: false });
  const officer = (await api('/api/auth/register', null, 'POST', { invitationToken: new URL(invite.data.inviteUrl).searchParams.get('invite'), email: 'agenda-officer@example.org', name: 'Agenda Officer', password: 'Agenda officer password' })).data;
  assert.equal((await api('/api/agendas')).status, 401);
  for (const [path, method, body] of [['/api/agendas', 'GET'], ['/api/agendas', 'POST', {}]]) assert.equal((await api(path, officer.token, method, body)).status, 403, `${method} ${path}`);
  const created = await api('/api/agendas', owner.token, 'POST', {}); assert.equal(created.status, 201); assert.match(created.cache, /no-store/);
  let agenda = created.data.agenda; assert.equal(agenda.draft.sections[0].heading, 'Opening'); assert.ok(agenda.draft.officers.some(item => item.name === 'David Marable' && item.office === 'Assistant Treasurer'));
  for (const suffix of ['', '/preview', '/pdf']) assert.equal((await api(`/api/agendas/${agenda.id}${suffix}`, officer.token, suffix === '/preview' ? 'POST' : 'GET', suffix === '/preview' ? { draft: agenda.draft } : undefined)).status, 403);
  agenda.draft.meetingDate = '2026-09-17'; agenda.draft.subtitle = 'A focused stated communication'; agenda.draft.sections[1].body = 'Brother Example requested the prayers of the Lodge.';
  const saved = await api(`/api/agendas/${agenda.id}`, owner.token, 'PUT', { revision: agenda.revision, draft: agenda.draft }); assert.equal(saved.status, 200); agenda = saved.data.agenda; assert.equal(agenda.revision, 2);
  assert.equal((await api(`/api/agendas/${agenda.id}`, owner.token, 'PUT', { revision: 1, draft: agenda.draft })).status, 409);
  const preview = await api(`/api/agendas/${agenda.id}/preview`, owner.token, 'POST', { draft: agenda.draft }); assert.equal(preview.status, 200); assert.equal(preview.data.subarray(0, 4).toString(), '%PDF');
  const parser = new PDFParse({ data: preview.data }); const extracted = (await parser.getText()).text; await parser.destroy();
  assert.match(extracted, /Stone Square Lodge No\. 22/); assert.match(extracted, /AGENDA, STATED COMMUNICATION/); assert.match(extracted, /Thursday, September 17, 2026/); assert.match(extracted, /Brother Example requested the prayers/);
  assert.equal((await api(`/api/agendas/${agenda.id}`, owner.token, 'DELETE', { revision: agenda.revision })).status, 200);
  assert.equal((await api('/api/agendas', owner.token)).data.agendas.length, 0);
  console.log('Agenda Creator checks passed: owner-only access, template defaults, revision protection, PDF output and deletion.');
} finally { server.kill('SIGTERM'); }
