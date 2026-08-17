/* End to end proof against a real server process and a real Postgres.
 *
 * PGlite is PostgreSQL compiled to WebAssembly, so this exercises the same SQL that
 * Neon will run, without installing a database on the machine. Run with:
 *   npm test
 *
 * What it proves, in order: the schema builds, an owner and two officers can be
 * created, a PDF survives the round trip through bytea, signatures accumulate onto
 * the same document rather than replacing each other, the original upload is still
 * retrievable after signing, the document completes only when every signer is done,
 * and no route leaks a blob or serves a document to a stranger.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUniqueViolation, postgresTlsOptions } from '../db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 3517;
const SMTP_PORT = 3518;
const BASE = `http://127.0.0.1:${PORT}`;
const SIG = `data:image/png;base64,${fs.readFileSync(path.join(HERE, 'signature.b64'), 'utf8').trim()}`;
const PDF = fs.readFileSync(path.join(HERE, 'sample-dispensation.pdf'));
const deliveredMail = [];

const smtpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 stone-square-test ESMTP\r\n');
  let buffer = '';
  let collecting = false;
  let message = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\r\n')) {
      const index = buffer.indexOf('\r\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (collecting) {
        if (line === '.') {
          deliveredMail.push(message);
          message = '';
          collecting = false;
          socket.write('250 queued\r\n');
        } else {
          message += `${line}\n`;
        }
      } else if (/^EHLO|^HELO/i.test(line)) socket.write('250-stone-square-test\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH PLAIN/i.test(line)) socket.write('235 authenticated\r\n');
      else if (/^MAIL FROM|^RCPT TO/i.test(line)) socket.write('250 ok\r\n');
      else if (/^DATA/i.test(line)) { collecting = true; socket.write('354 continue\r\n'); }
      else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('250 ok\r\n');
    }
  });
});

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ok    ${name}`); }
  else { failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
};

const api = async (method, route, { token, body, raw } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json')
    ? await res.json()
    : Buffer.from(await res.arrayBuffer());
  return { status: res.status, payload };
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'test',
    DATABASE_URL: '',            // empty forces PGlite
    PGLITE_DIR: '',              // empty keeps it in memory
    OWNER_EMAIL: 'wm@stonesquare22pha.org',
    APP_BASE_URL: BASE,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_SECURE: 'false',
    SMTP_USER: 'test',
    SMTP_PASS: 'test',
    MAIL_FROM: 'Stone Square Sign <test@example.org>',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const waitForBoot = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

try {
  await new Promise((resolve, reject) => smtpServer.listen(SMTP_PORT, '127.0.0.1', resolve).once('error', reject));
  check('PostgreSQL 23505 is recognized as a unique violation', isUniqueViolation({ code: '23505' }));
  check('managed PostgreSQL connections verify TLS certificates',
    postgresTlsOptions({ databaseUrl: 'postgresql://example.invalid/db?sslmode=require' }).rejectUnauthorized === true);
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  check('Docker image includes database adapter and PDF assets',
    /COPY\s+package\.json\s+server\.js\s+db\.js/.test(dockerfile) && /COPY\s+assets\s+\.\/assets/.test(dockerfile));

  const productionFailure = async (overrides) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', PORT: '3519', SMTP_HOST: '', ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    return { code, output };
  };
  const noDatabase = await productionFailure({ DATABASE_URL: '', APP_BASE_URL: 'https://sign.example.org' });
  check('production refuses to start without DATABASE_URL', noDatabase.code !== 0 && /DATABASE_URL is required/.test(noDatabase.output));
  const insecureUrl = await productionFailure({ DATABASE_URL: 'postgresql://example.invalid/db', APP_BASE_URL: 'http://localhost:3000' });
  check('production refuses a non-public or non-HTTPS APP_BASE_URL', insecureUrl.code !== 0 && /public HTTPS URL/.test(insecureUrl.output));

  console.log('\nBooting the server against PGlite');
  if (!await waitForBoot()) throw new Error(`server never came up.\n${serverLog}`);
  check('server boots and answers /api/health', true);
  check('boot log names the driver', /Database: pglite/.test(serverLog), serverLog.slice(0, 300));

  console.log('\nAccounts');
  const wm = await api('POST', '/api/auth/register', {
    body: { email: 'wm@stonesquare22pha.org', name: 'W. Aaron Dixon-Saunders', password: 'correct horse battery' },
  });
  check('owner registers', wm.status === 200 || wm.status === 201, JSON.stringify(wm.payload).slice(0, 200));
  const wmToken = wm.payload.token;
  check('owner is given the owner role', wm.payload.user?.role === 'owner', wm.payload.user?.role);

  const uninvited = await api('POST', '/api/auth/register', {
    body: { email: 'stranger@example.org', name: 'Stranger', password: 'a long enough secret' },
  });
  check('an uninvited stranger cannot register', uninvited.status === 403, String(uninvited.status));

  /* Officers come in by private invitation only, so the test has to go through the
   * same door they will. The invite URL carries the one-time token. */
  const invite = async (email, name, role) => {
    const res = await api('POST', '/api/officers/invite', { token: wmToken, body: { email, name, role } });
    check(`owner invites the ${role}`, res.status === 201, JSON.stringify(res.payload).slice(0, 200));
    if (role !== 'viewer') {
      const duplicate = await api('POST', '/api/officers/invite', {
        token: wmToken,
        body: { email: `second-${email}`, name: `Second ${name}`, role },
      });
      check(`a second pending ${role} invitation is rejected`, duplicate.status === 409, String(duplicate.status));
    }
    const token = new URL(res.payload.inviteUrl).searchParams.get('invite');
    const reg = await api('POST', '/api/auth/register', {
      body: { email, name, password: 'another long secret', invitationToken: token },
    });
    check(`${role} accepts the invitation`, Boolean(reg.payload.token), JSON.stringify(reg.payload).slice(0, 200));
    check(`${role} is given the right office`, reg.payload.user?.role === role, reg.payload.user?.role);
    return reg.payload.token;
  };
  const secToken = await invite('mcduff8995@example.org', 'William M. McDuffie', 'secretary');
  const asstToken = await invite('adrianreese22@example.org', 'Adrian Reese', 'assistant_secretary');
  const viewerToken = await invite('viewer22@example.org', 'Lodge Viewer', 'viewer');

  const replay = await api('POST', '/api/auth/register', {
    body: { email: 'mcduff8995@example.org', name: 'William M. McDuffie', password: 'yet another secret' },
  });
  check('an invitation cannot be reused', replay.status === 403, String(replay.status));

  console.log('\nSignature setup');
  const noSig = await api('GET', '/api/profile/signature', { token: secToken });
  check('no signature yet returns 404', noSig.status === 404, String(noSig.status));
  const saved = await api('PUT', '/api/profile/signature', {
    token: secToken, body: { signatureData: SIG, signatureType: 'drawn' },
  });
  check('signature saves', saved.status === 200, JSON.stringify(saved.payload).slice(0, 200));
  const gotSig = await api('GET', '/api/profile/signature', { token: secToken });
  check('signature comes back as a PNG from the database',
    gotSig.status === 200 && Buffer.isBuffer(gotSig.payload) && gotSig.payload.subarray(1, 4).toString() === 'PNG',
    `status ${gotSig.status}`);

  await api('PUT', '/api/profile/signature', { token: asstToken, body: { signatureData: SIG, signatureType: 'typed', styleName: 'Formal' } });

  console.log('\nUpload');
  const form = new FormData();
  form.append('document', new Blob([PDF], { type: 'application/pdf' }), 'dispensation.pdf');
  form.append('title', 'Back to School Night dispensation');
  const uploadRes = await fetch(`${BASE}/api/documents`, {
    method: 'POST', headers: { Authorization: `Bearer ${wmToken}` }, body: form,
  });
  const uploaded = await uploadRes.json();
  check('owner uploads a PDF', uploadRes.status === 201, JSON.stringify(uploaded).slice(0, 300));
  const docId = uploaded.document?.id;
  check('signers were detected', (uploaded.document?.signers?.length || 0) > 0,
    JSON.stringify(uploaded.document?.signers));

  const outsider = await api('GET', `/api/documents/${docId}/file`, { token: '' });
  check('an unauthenticated request cannot fetch the file', outsider.status === 401, String(outsider.status));

  const detail = await api('GET', `/api/documents/${docId}`, { token: wmToken });
  check('detail never ships the blobs',
    !('file_bytes' in detail.payload.document) && !('signed_bytes' in detail.payload.document),
    Object.keys(detail.payload.document || {}).join(','));

  const original = await api('GET', `/api/documents/${docId}/file`, { token: wmToken });
  check('the uploaded PDF round-trips through bytea byte for byte',
    Buffer.isBuffer(original.payload) && original.payload.equals(PDF),
    `${original.payload?.length} vs ${PDF.length}`);

  console.log('\nViewer status-only access');
  const viewerList = await api('GET', '/api/documents', { token: viewerToken });
  const viewerDocument = viewerList.payload.documents?.find((document) => document.id === docId);
  check('viewer can list document metadata and status',
    viewerList.status === 200 && viewerDocument?.status === 'pending',
    `${viewerList.status} ${viewerDocument?.status}`);
  check('viewer list omits owner email and signer identifiers',
    viewerDocument && !('owner_email' in viewerDocument)
      && viewerDocument.signers.every((signer) => !('id' in signer) && !('user_id' in signer) && !('signed_at' in signer)),
    JSON.stringify(viewerDocument).slice(0, 300));
  check('viewer list exposes only boolean signer completion status',
    viewerDocument?.signers.every((signer) => typeof signer.signed === 'boolean'),
    JSON.stringify(viewerDocument?.signers));
  const viewerDetail = await api('GET', `/api/documents/${docId}`, { token: viewerToken });
  const viewerCurrent = await api('GET', `/api/documents/${docId}/file`, { token: viewerToken });
  const viewerOriginal = await api('GET', `/api/documents/${docId}/original`, { token: viewerToken });
  const viewerAudit = await api('GET', `/api/documents/${docId}/audit`, { token: viewerToken });
  check('viewer cannot access document detail, current PDF, original PDF, or audit',
    [viewerDetail, viewerCurrent, viewerOriginal, viewerAudit].every((result) => result.status === 403),
    [viewerDetail, viewerCurrent, viewerOriginal, viewerAudit].map((result) => result.status).join(','));
  const viewerSignature = await api('GET', '/api/profile/signature', { token: viewerToken });
  const viewerSignatureSave = await api('PUT', '/api/profile/signature', {
    token: viewerToken,
    body: { signatureData: SIG, signatureType: 'drawn' },
  });
  check('viewer cannot access or save signature details',
    viewerSignature.status === 403 && viewerSignatureSave.status === 403,
    `${viewerSignature.status},${viewerSignatureSave.status}`);
  const viewerSign = await api('POST', `/api/documents/${docId}/sign`, {
    token: viewerToken,
    body: { consent: true },
  });
  check('viewer cannot sign documents', viewerSign.status === 403, String(viewerSign.status));
  const viewerUploadForm = new FormData();
  viewerUploadForm.append('document', new Blob([PDF], { type: 'application/pdf' }), 'viewer-upload.pdf');
  const viewerUpload = await fetch(`${BASE}/api/documents`, {
    method: 'POST', headers: { Authorization: `Bearer ${viewerToken}` }, body: viewerUploadForm,
  });
  const viewerCreate = await api('POST', '/api/dispensations', { token: viewerToken, body: {} });
  check('viewer cannot upload or create documents',
    viewerUpload.status === 403 && viewerCreate.status === 403,
    `${viewerUpload.status},${viewerCreate.status}`);

  console.log('\nSigning');
  const unauth = await api('POST', `/api/documents/${docId}/sign`, { body: { consent: true } });
  check('signing without a session is refused', unauth.status === 401, String(unauth.status));
  const noConsent = await api('POST', `/api/documents/${docId}/sign`, { token: wmToken, body: { consent: false } });
  check('signing without consent is refused', noConsent.status === 400, String(noConsent.status));

  const ownerSign = await api('POST', `/api/documents/${docId}/sign`, { token: wmToken, body: { consent: true } });
  check('the owner is not himself a signer', ownerSign.status === 409, String(ownerSign.status));

  const concurrentSignatures = await Promise.all([
    api('POST', `/api/documents/${docId}/sign`, { token: secToken, body: { consent: true } }),
    api('POST', `/api/documents/${docId}/sign`, { token: secToken, body: { consent: true } }),
  ]);
  check('exactly one concurrent Secretary signature is accepted',
    concurrentSignatures.filter((result) => result.status === 200).length === 1,
    concurrentSignatures.map((result) => result.status).join(','));
  check('the duplicate concurrent Secretary signature is rejected',
    concurrentSignatures.filter((result) => result.status === 409).length === 1,
    concurrentSignatures.map((result) => result.status).join(','));

  const afterOne = await api('GET', `/api/documents/${docId}/file`, { token: wmToken });
  check('the served copy is now the stamped one, not the original',
    Buffer.isBuffer(afterOne.payload) && !afterOne.payload.equals(PDF), 'bytes unchanged after signing');

  const detailOne = await api('GET', `/api/documents/${docId}`, { token: wmToken });
  let remaining = detailOne.payload.document.signers.filter((s) => !s.signed_at).length;
  check('status reflects how many signatures are outstanding',
    detailOne.payload.document.status === (remaining ? 'partially_signed' : 'completed'),
    `${detailOne.payload.document.status} with ${remaining} remaining`);

  /* Whichever officers this particular document named, drive it all the way to
   * completed. That is the path that matters and it must never be skipped just
   * because a given form happens to name only one of them. */
  const tokenForRole = { secretary: secToken, assistant_secretary: asstToken };
  let lastLength = afterOne.payload.length;
  let guard = 0;
  while (remaining > 0 && guard < 5) {
    guard += 1;
    const pending = (await api('GET', `/api/documents/${docId}`, { token: wmToken }))
      .payload.document.signers.find((s) => !s.signed_at);
    const res = await api('POST', `/api/documents/${docId}/sign`, {
      token: tokenForRole[pending.signer_role], body: { consent: true },
    });
    check(`the ${pending.signer_role.replace('_', ' ')} signs`, res.status === 200,
      JSON.stringify(res.payload).slice(0, 200));
    const grown = await api('GET', `/api/documents/${docId}/file`, { token: wmToken });
    check('each signature is added to the same PDF rather than replacing it',
      grown.payload.length > lastLength, `${lastLength} -> ${grown.payload.length}`);
    lastLength = grown.payload.length;
    remaining = (await api('GET', `/api/documents/${docId}`, { token: wmToken }))
      .payload.document.signers.filter((s) => !s.signed_at).length;
  }

  const finished = await api('GET', `/api/documents/${docId}`, { token: wmToken });
  check('the document reaches completed', finished.payload.document.status === 'completed',
    finished.payload.document.status);
  check('completion is timestamped', Boolean(finished.payload.document.completed_at));
  check('every signer has a signature and a consent record on file',
    finished.payload.document.signers.every((s) => s.signed_at),
    JSON.stringify(finished.payload.document.signers));
  const asUploaded = await api('GET', `/api/documents/${docId}/original`, { token: wmToken });
  check('the original upload is still retrievable after signing, byte for byte',
    Buffer.isBuffer(asUploaded.payload) && asUploaded.payload.equals(PDF),
    `status ${asUploaded.status}, ${asUploaded.payload?.length} vs ${PDF.length}`);
  const completionMails = deliveredMail.filter((message) => /Completed Lodge document/i.test(message));
  check('a record copy is mailed to the owner and to every signer', completionMails.length >= 2,
    `${completionMails.length} delivered`);

  console.log('\nAudit and reset');
  const audit = await api('GET', `/api/documents/${docId}/audit`, { token: wmToken });
  const actions = (audit.payload.events || []).map((e) => e.action);
  check('audit trail records upload and signing',
    actions.includes('document_uploaded') && actions.includes('document_signed'), actions.join(','));
  check('concurrent signing creates exactly one Secretary signing audit event',
    actions.filter((action) => action === 'document_signed').length >= 1);

  const rescind = await api('POST', `/api/documents/${docId}/rescind`, {
    token: wmToken,
    body: { reason: 'Launch-readiness regression test' },
  });
  check('owner can rescind a document without deleting its history', rescind.status === 200 && rescind.payload.status === 'rescinded');
  const afterRescind = await api('GET', `/api/documents/${docId}`, { token: wmToken });
  check('rescission preserves completed signer history',
    afterRescind.payload.document.status === 'rescinded'
      && afterRescind.payload.document.signers.every((signer) => signer.signed_at));
  const signAfterRescind = await api('POST', `/api/documents/${docId}/sign`, { token: secToken, body: { consent: true } });
  check('a rescinded document cannot be signed later', signAfterRescind.status === 409, String(signAfterRescind.status));
  const rescindAudit = await api('GET', `/api/documents/${docId}/audit`, { token: wmToken });
  check('rescission is added to the audit history',
    rescindAudit.payload.events.some((event) => event.action === 'document_rescinded'));
  const viewerRescind = await api('POST', `/api/documents/${docId}/rescind`, {
    token: viewerToken,
    body: { reason: 'Viewer should not be allowed' },
  });
  check('viewer cannot rescind documents', viewerRescind.status === 403, String(viewerRescind.status));

  const byEmail = await api('POST', '/api/auth/forgot-password', { body: { email: 'mcduff8995@example.org' } });
  check('reset can be requested by email address', byEmail.status === 200,
    `${byEmail.status} ${JSON.stringify(byEmail.payload)}`);
  check('the reset code is delivered by email',
    deliveredMail.some((message) => /password reset code/i.test(message)),
    `${deliveredMail.length} messages delivered`);
  const resetMessage = deliveredMail.findLast((message) => /password reset code/i.test(message));
  const resetCode = resetMessage?.match(/reset code:\s*(\d{6})/i)?.[1];
  const resets = await Promise.all([
    api('POST', '/api/auth/reset-password', {
      body: { email: 'mcduff8995@example.org', code: resetCode, newPassword: 'replacement secret one' },
    }),
    api('POST', '/api/auth/reset-password', {
      body: { email: 'mcduff8995@example.org', code: resetCode, newPassword: 'replacement secret two' },
    }),
  ]);
  check('a reset code is consumed atomically',
    resets.filter((result) => result.status === 200).length === 1
      && resets.filter((result) => result.status === 400).length === 1,
    resets.map((result) => result.status).join(','));
  const oldSession = await api('GET', '/api/auth/me', { token: secToken });
  check('password reset invalidates existing sessions', oldSession.status === 401, String(oldSession.status));
  const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.org' } });
  check('an unknown account gets the same answer, so the form cannot be used to enumerate officers',
    unknown.status === 200 && unknown.payload.message === byEmail.payload.message,
    JSON.stringify(unknown.payload));
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`\nFAILED: ${error.message}`);
} finally {
  server.kill();
  smtpServer.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All checks passed.\n');
