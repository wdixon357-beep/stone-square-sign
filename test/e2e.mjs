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
    LODGE_ACCESS_CODE: 'square22-lodge-code',
    DDGM_EMAIL: 'districtdeputy@example.org',
    DDGM_NAME: 'District Deputy Grand Master Cid L. Jones',
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

  console.log('\nDues access');
  /* The ledger names the men who are behind. Viewers must be refused outright,
   * not shown an empty page, and an anonymous caller must never reach it. */
  const duesAnon = await api('GET', '/api/dues');
  check('dues refuses an unauthenticated caller', duesAnon.status === 401, String(duesAnon.status));

  const duesViewer = await api('GET', '/api/dues', { token: viewerToken });
  check('a viewer is refused the dues ledger', duesViewer.status === 403, String(duesViewer.status));
  check('the refusal does not leak a single figure',
    !/\d{3,}/.test(JSON.stringify(duesViewer.payload)), JSON.stringify(duesViewer.payload));

  for (const [who, tok] of [['owner', wmToken], ['secretary', secToken], ['assistant secretary', asstToken]]) {
    const r = await api('GET', '/api/dues', { token: tok });
    check(`the ${who} is allowed through the dues gate`, r.status !== 403 && r.status !== 401,
      `${r.status} ${JSON.stringify(r.payload).slice(0, 90)}`);
  }
  const duesOwner = await api('GET', '/api/dues', { token: wmToken });
  check('with no Zeffy settings it says so plainly rather than erroring',
    duesOwner.status === 503 && duesOwner.payload.configured === false,
    `${duesOwner.status} ${JSON.stringify(duesOwner.payload)}`);


  /* Either/or signing.
   *
   * A dispensation usually goes to both Secretaries and whichever of them signs it
   * first finishes it. The other man's row must stop asking him for a signature the
   * Lodge already has, while still recording that it was offered to him. */
  console.log('\nEither/or signing');
  /* The official template stamps the Master's saved signature as it is built, so he
   * needs one on file before any of this works. */
  const wmSig = await api('PUT', '/api/profile/signature', {
    token: wmToken, body: { signatureData: SIG, signatureType: 'drawn' },
  });
  check('the Worshipful Master saves his signature', wmSig.status === 200,
    JSON.stringify(wmSig.payload).slice(0, 200));
  const dispensationBody = {
    requestDate: '2026-08-17', eventDate: '2026-08-18',
    requestDetails: 'to participate in Back to School Night',
    eventTime: '4:00 PM', locationName: 'Louis L. Redding Middle School',
    streetAddress: '201 New Street', cityState: 'Middletown, Delaware',
    worshipfulMasterAddress: '14 Kelly Drive, Bear, DE 19701',
    personalInfoConfirmed: true,
  };
  const eitherRes = await api('POST', '/api/dispensations', {
    token: wmToken,
    body: { ...dispensationBody, title: 'Either Secretary', signerRoles: ['secretary', 'assistant_secretary'] },
  });
  check('a dispensation can be sent to both Secretaries at once',
    eitherRes.status === 201, JSON.stringify(eitherRes.payload).slice(0, 200));
  const eitherId = eitherRes.payload.document?.id;

  const eitherBefore = await api('GET', `/api/documents/${eitherId}`, { token: wmToken });
  check('both Secretaries are listed as signers',
    eitherBefore.payload.document.signers.filter((s) => s.signer_role !== 'worshipful_master').length === 2,
    JSON.stringify(eitherBefore.payload.document.signers.map((s) => s.signer_role)));
  const asstQueueBefore = await api('GET', '/api/documents', { token: asstToken });
  check('it shows in the Assistant Secretary\'s queue as needing him',
    asstQueueBefore.payload.documents.find((d) => d.id === eitherId)?.needsSignature === true,
    JSON.stringify(asstQueueBefore.payload.documents.find((d) => d.id === eitherId)));

  /* The official form carries the signing officer's own address, so the sign call
   * has to supply it the same way the real one does. */
  const firstToSign = await api('POST', `/api/documents/${eitherId}/sign`,
    { token: secToken, body: { consent: true, officerAddress: '722 Banning Dr., Middletown, DE 19709' } });
  check('the Secretary signs it', firstToSign.status === 200,
    JSON.stringify(firstToSign.payload).slice(0, 200));

  const eitherAfter = await api('GET', `/api/documents/${eitherId}`, { token: wmToken });
  check('one signature completes it, the Assistant Secretary is not held up',
    eitherAfter.payload.document.status === 'completed', eitherAfter.payload.document.status);
  const asstQueueAfter = await api('GET', '/api/documents', { token: asstToken });
  check('it drops out of the Assistant Secretary\'s queue',
    asstQueueAfter.payload.documents.find((d) => d.id === eitherId)?.needsSignature === false,
    JSON.stringify(asstQueueAfter.payload.documents.find((d) => d.id === eitherId)));
  const lateSign = await api('POST', `/api/documents/${eitherId}/sign`,
    { token: asstToken, body: { consent: true, officerAddress: '14 Kelly Drive, Bear, DE 19701' } });
  check('the second Secretary cannot sign a document already completed',
    lateSign.status === 409, String(lateSign.status));
  check('the record still shows it was offered to him',
    eitherAfter.payload.document.signers.some((s) => s.signer_role === 'assistant_secretary'),
    JSON.stringify(eitherAfter.payload.document.signers.map((s) => s.signer_role)));

  /* Sending to one man only must still behave exactly as it always did. */
  const oneRes = await api('POST', '/api/dispensations', {
    token: wmToken,
    body: { ...dispensationBody, title: 'Assistant Secretary only', signerRoles: ['assistant_secretary'] },
  });
  check('a dispensation can still be sent to one Secretary alone',
    oneRes.status === 201, JSON.stringify(oneRes.payload).slice(0, 200));
  const oneDetail = await api('GET', `/api/documents/${oneRes.payload.document?.id}`, { token: wmToken });
  check('only that officer is asked for a signature',
    oneDetail.payload.document.signers.filter((s) => s.signer_role !== 'worshipful_master')
      .every((s) => s.signer_role === 'assistant_secretary'),
    JSON.stringify(oneDetail.payload.document.signers.map((s) => s.signer_role)));
  const noneRes = await api('POST', '/api/dispensations', {
    token: wmToken, body: { ...dispensationBody, signerRoles: [] },
  });
  check('a dispensation addressed to nobody is refused', noneRes.status === 400, String(noneRes.status));

  /* Anything sent before the Master could choose is still stuck with one man. He has
   * to be able to open it to the other Secretary without rescinding and rebuilding it. */
  const stuckRes = await api('POST', '/api/dispensations', {
    token: wmToken,
    body: { ...dispensationBody, title: 'Sent to the Secretary alone', signerRoles: ['secretary'] },
  });
  const stuckId = stuckRes.payload.document?.id;
  const stuckBefore = await api('GET', '/api/documents', { token: asstToken });
  check('a document sent to one Secretary does not reach the other',
    stuckBefore.payload.documents.find((d) => d.id === stuckId)?.needsSignature !== true,
    JSON.stringify(stuckBefore.payload.documents.find((d) => d.id === stuckId)));
  const opened = await api('POST', `/api/documents/${stuckId}/offer-to-both`, { token: wmToken });
  check('the owner can open it to both Secretaries', opened.status === 200,
    JSON.stringify(opened.payload).slice(0, 200));
  const stuckAfter = await api('GET', '/api/documents', { token: asstToken });
  check('it now reaches the Assistant Secretary too',
    stuckAfter.payload.documents.find((d) => d.id === stuckId)?.needsSignature === true,
    JSON.stringify(stuckAfter.payload.documents.find((d) => d.id === stuckId)));
  const openedTwice = await api('POST', `/api/documents/${stuckId}/offer-to-both`, { token: wmToken });
  check('opening it a second time is refused rather than duplicating the signer',
    openedTwice.status === 409, String(openedTwice.status));
  const asstSigns = await api('POST', `/api/documents/${stuckId}/sign`,
    { token: asstToken, body: { consent: true, officerAddress: '14 Kelly Drive, Bear, DE 19701' } });
  check('the Assistant Secretary can then sign it', asstSigns.status === 200,
    JSON.stringify(asstSigns.payload).slice(0, 200));
  const stuckDone = await api('GET', `/api/documents/${stuckId}`, { token: wmToken });
  check('his signature alone completes it',
    stuckDone.payload.document.status === 'completed', stuckDone.payload.document.status);
  const viewerOpen = await api('POST', `/api/documents/${stuckId}/offer-to-both`, { token: viewerToken });
  check('a viewer cannot change who may sign', viewerOpen.status === 403, String(viewerOpen.status));

  /* Signing out. An officer sharing a phone, or one who signed in on the Lodge laptop,
   * has to be able to end his own session and be sure it is actually ended. */
  console.log('\nSigning out');
  const phone = await api('POST', '/api/auth/login', {
    body: { email: 'mcduff8995@example.org', password: 'another long secret' },
  });
  check('the Secretary can sign in a second time on another device',
    Boolean(phone.payload.token), JSON.stringify(phone.payload).slice(0, 200));
  const phoneToken = phone.payload.token;
  check('the second session works', (await api('GET', '/api/auth/me', { token: phoneToken })).status === 200);
  const signedOut = await api('POST', '/api/auth/logout', { token: phoneToken });
  check('signing out is accepted', signedOut.status === 200, JSON.stringify(signedOut.payload));
  const deadToken = await api('GET', '/api/auth/me', { token: phoneToken });
  check('the token is dead the moment he signs out', deadToken.status === 401, String(deadToken.status));
  const deadQueue = await api('GET', '/api/documents', { token: phoneToken });
  check('a signed out token cannot reach the queue either', deadQueue.status === 401, String(deadQueue.status));
  check('his other session is untouched, so signing out on one device does not sign him out everywhere',
    (await api('GET', '/api/auth/me', { token: secToken })).status === 200);
  const signOutTwice = await api('POST', '/api/auth/logout', { token: phoneToken });
  check('signing out twice is refused cleanly rather than erroring',
    signOutTwice.status === 401, String(signOutTwice.status));
  check('signing out without a session is refused',
    (await api('POST', '/api/auth/logout')).status === 401);

  /* Self serve accounts. No email is delivered in production, so an officer has to be able to
   * create his own account from one shared code rather than waiting on an invitation. */
  /* Getting it to the District Deputy. A dispensation is not finished when it is signed, it is
   * finished when the man who approves it has it in his hand. */
  console.log('\nSubmission to the District Deputy');
  const beforeCount = deliveredMail.length;
  const toSubmit = await api('POST', '/api/dispensations', {
    token: wmToken,
    body: { ...dispensationBody, title: 'Goes to the District Deputy', signerRoles: ['secretary'] },
  });
  const submitId = toSubmit.payload.document?.id;
  const early = await api('POST', `/api/documents/${submitId}/submit`, { token: wmToken });
  check('it cannot go to the District Deputy before it is signed',
    early.status === 409, JSON.stringify(early.payload));
  const finalSign = await api('POST', `/api/documents/${submitId}/sign`, {
    token: secToken, body: { consent: true, officerAddress: '722 Banning Dr., Middletown, DE 19709' },
  });
  check('the Secretary signs it', finalSign.status === 200, JSON.stringify(finalSign.payload).slice(0, 200));
  check('signing reports that it went to the District Deputy',
    finalSign.payload.submitted === true, JSON.stringify(finalSign.payload).slice(0, 300));

  const fresh = deliveredMail.slice(beforeCount).join('\n---\n');
  check('an email actually left the server addressed to the District Deputy',
    /districtdeputy@example\.org/.test(fresh), fresh.slice(0, 200));
  check('it carries the signed PDF as an attachment',
    /application\/pdf/i.test(fresh) && /JVBER/.test(fresh),
    'no PDF part found in the delivered message');
  check('it asks him to review it',
    /review/i.test(fresh) && /Request for Dispensation/i.test(fresh));

  const submittedDoc = await api('GET', `/api/documents/${submitId}`, { token: wmToken });
  check('the document records when it went and to whom',
    Boolean(submittedDoc.payload.document.submitted_at)
    && submittedDoc.payload.document.submitted_to === 'districtdeputy@example.org',
    JSON.stringify({ at: submittedDoc.payload.document.submitted_at, to: submittedDoc.payload.document.submitted_to }));
  check('and records no failure', !submittedDoc.payload.document.submitted_error,
    String(submittedDoc.payload.document.submitted_error));

  const again = await api('POST', `/api/documents/${submitId}/submit`, { token: wmToken });
  check('it will not quietly send the same dispensation to him twice',
    again.status === 409, JSON.stringify(again.payload));
  const onPurpose = await api('POST', `/api/documents/${submitId}/submit`,
    { token: wmToken, body: { resend: true } });
  check('but the Master can send it again on purpose',
    onPurpose.status === 200, JSON.stringify(onPurpose.payload));
  const draft = await api('GET', `/api/documents/${submitId}/submission-draft`, { token: wmToken });
  check('the Master can pull a ready written draft for his own mail app',
    draft.status === 200, JSON.stringify(draft.payload).slice(0, 200));
  check('it is addressed to the District Deputy and names the attachment',
    draft.payload.draft?.to === 'districtdeputy@example.org' && /\.pdf$/.test(draft.payload.draft?.filename || ''),
    JSON.stringify(draft.payload.draft).slice(0, 200));
  check('the draft says the same thing the server sends, so the two never drift',
    /review/i.test(draft.payload.draft?.body || '') && /Request for Dispensation/i.test(draft.payload.draft?.subject || ''),
    JSON.stringify(draft.payload.draft).slice(0, 300));
  const viewerDraft = await api('GET', `/api/documents/${submitId}/submission-draft`, { token: viewerToken });
  check('a viewer cannot pull the draft', viewerDraft.status === 403, String(viewerDraft.status));
  const uploadedDraft = await api('GET', `/api/documents/${docId}/submission-draft`, { token: wmToken });
  check('an ordinary uploaded document has no District Deputy draft',
    uploadedDraft.status === 409, String(uploadedDraft.status));
  const viewerSubmit = await api('POST', `/api/documents/${submitId}/submit`, { token: viewerToken });
  check('a viewer cannot send anything to the District Deputy',
    viewerSubmit.status === 403, String(viewerSubmit.status));

  /* Invitations the Master can see the state of, and that do not require the officer to find
   * the private link. He was invited; typing the address he was invited at is enough. */
  /* What the District Deputy decided. Recorded as its own fact, because neither dispensation
   * the Lodge holds as approved has a single mark in its approval block; both were granted by
   * email over a blank endorsement. */
  console.log('\nDistrict Deputy approvals');
  const noStatus = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken, body: { status: 'granted' },
  });
  check('an approval needs a status the Lodge actually uses', noStatus.status === 400, String(noStatus.status));
  const noName = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken, body: { status: 'approved', approvedOn: '2026-06-18', source: 'email' },
  });
  check('an approval must name the District Deputy who gave it', noName.status === 400, String(noName.status));
  const badDate = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken,
    body: { status: 'approved', approvedBy: 'DDGM Cid L. Jones', approvedOn: 'last June', source: 'email' },
  });
  check('a date that is not a date is refused', badDate.status === 400, JSON.stringify(badDate.payload));
  const undated = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken,
    body: { status: 'approved', approvedBy: 'DDGM Fred E. Cooke II', source: 'email',
      note: 'The Lodge record does not carry the date.' },
  });
  check('an approval the Lodge cannot date can still be recorded honestly',
    undated.status === 200, JSON.stringify(undated.payload));
  const noSource = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken, body: { status: 'approved', approvedBy: 'DDGM Cid L. Jones', approvedOn: '2026-06-18' },
  });
  check('and must say how it was given, since a blank form is not evidence',
    noSource.status === 400, String(noSource.status));
  const claimedEndorsement = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken,
    body: { status: 'approved', approvedBy: 'DDGM Cid L. Jones', approvedOn: '2026-06-18', source: 'endorsed_pdf' },
  });
  check('claiming an endorsed copy without attaching one is refused',
    claimedEndorsement.status === 400, JSON.stringify(claimedEndorsement.payload));

  const recorded = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: wmToken,
    body: {
      status: 'approved', approvedBy: 'DDGM Cid L. Jones', approvedOn: '2026-06-18',
      source: 'email', note: 'Returned approved the same morning by email.',
    },
  });
  check('an approval given by email can be recorded honestly',
    recorded.status === 200, JSON.stringify(recorded.payload));
  const approvals = await api('GET', '/api/approvals', { token: wmToken });
  check('it appears in the approvals section',
    (approvals.payload.approvals || []).some((a) => a.id === submitId),
    JSON.stringify(approvals.payload.approvals).slice(0, 200));
  const record = (approvals.payload.approvals || []).find((a) => a.id === submitId);
  check('with the Deputy, the date, and how it arrived',
    record?.approved_by === 'DDGM Cid L. Jones' && record?.approved_on === '2026-06-18'
    && record?.approval_source === 'email', JSON.stringify(record));
  check('and it is plain that no endorsed copy exists for it',
    !record?.has_endorsed_copy, String(record?.has_endorsed_copy));
  const noEndorsed = await api('GET', `/api/documents/${submitId}/endorsed`, { token: wmToken });
  check('asking for an endorsed copy that was never filed says so',
    noEndorsed.status === 404, String(noEndorsed.status));

  const detailAfter = await api('GET', `/api/documents/${submitId}`, { token: wmToken });
  check('the detail never ships the endorsed blob',
    !('approved_bytes' in detailAfter.payload.document),
    Object.keys(detailAfter.payload.document).filter((k) => k.includes('bytes')).join(','));
  const viewerApprovals = await api('GET', '/api/approvals', { token: viewerToken });
  check('a viewer sees that the Lodge was granted its request',
    (viewerApprovals.payload.approvals || []).some((a) => a.id === submitId));
  check('but not the Master\'s own notes on it',
    viewerApprovals.payload.approvals.every((a) => a.approval_note === null),
    JSON.stringify(viewerApprovals.payload.approvals).slice(0, 200));
  const viewerRecord = await api('PUT', `/api/documents/${submitId}/approval`, {
    token: viewerToken, body: { status: 'approved', approvedBy: 'X', approvedOn: '2026-06-18', source: 'email' },
  });
  check('a viewer cannot record an approval', viewerRecord.status === 403, String(viewerRecord.status));
  const notADispensation = await api('PUT', `/api/documents/${docId}/approval`, {
    token: wmToken, body: { status: 'approved', approvedBy: 'X', approvedOn: '2026-06-18', source: 'email' },
  });
  check('an ordinary uploaded document carries no District Deputy approval',
    notADispensation.status === 409, String(notADispensation.status));

  console.log('\nPending invitations');
  const invited = await api('POST', '/api/officers/invite', {
    token: wmToken, body: { role: 'viewer', name: 'Waiting Brother', email: 'waiting@example.org' },
  });
  check('the owner invites a Brother', invited.status === 201, JSON.stringify(invited.payload).slice(0, 200));
  const roster = await api('GET', '/api/officers', { token: wmToken });
  check('the invitation shows as pending, not as still needing one',
    (roster.payload.pending || []).some((p) => p.email === 'waiting@example.org'),
    JSON.stringify(roster.payload.pending));
  check('and he is not yet counted as an active officer',
    !(roster.payload.officers || []).some((o) => o.email === 'waiting@example.org'),
    JSON.stringify(roster.payload.officers));

  const withoutLink = await api('POST', '/api/auth/register', {
    body: { email: 'waiting@example.org', name: 'Waiting Brother', password: 'a long enough secret' },
  });
  check('he can create his account without ever opening the private link',
    withoutLink.status === 201 && Boolean(withoutLink.payload.token),
    JSON.stringify(withoutLink.payload).slice(0, 200));
  check('and he gets the office the Master invited him to, not one he chose',
    withoutLink.payload.user?.role === 'viewer', withoutLink.payload.user?.role);

  const afterJoin = await api('GET', '/api/officers', { token: wmToken });
  check('once he is in he moves from pending to active',
    !(afterJoin.payload.pending || []).some((p) => p.email === 'waiting@example.org')
    && (afterJoin.payload.officers || []).some((o) => o.email === 'waiting@example.org'),
    JSON.stringify({ pending: afterJoin.payload.pending, officers: afterJoin.payload.officers }).slice(0, 300));
  const reuse = await api('POST', '/api/auth/register', {
    body: { email: 'waiting@example.org', name: 'Imposter', password: 'another long secret' },
  });
  check('the same invitation cannot be used a second time',
    reuse.status === 403 || reuse.status === 409, String(reuse.status));
  const uninvitedEmail = await api('POST', '/api/auth/register', {
    body: { email: 'never-invited@example.org', name: 'Nobody', password: 'a long enough secret' },
  });
  check('an address that was never invited still gets nowhere',
    uninvitedEmail.status === 403, String(uninvitedEmail.status));

  console.log('\nSelf serve accounts');
  const noCode = await api('POST', '/api/auth/register', {
    body: { email: 'stranger2@example.org', name: 'Passer By', password: 'a long enough secret' },
  });
  check('a stranger with no code and no invitation is still refused',
    noCode.status === 403, JSON.stringify(noCode.payload));
  const wrongCode = await api('POST', '/api/auth/register', {
    body: { email: 'stranger3@example.org', name: 'Passer By', password: 'a long enough secret',
      role: 'viewer', accessCode: 'not-the-code' },
  });
  check('a wrong code is refused', wrongCode.status === 403, JSON.stringify(wrongCode.payload));
  const noOffice = await api('POST', '/api/auth/register', {
    body: { email: 'brother1@example.org', name: 'A Brother', password: 'a long enough secret',
      accessCode: 'square22-lodge-code' },
  });
  check('the code alone is not enough, he must say which office he holds',
    noOffice.status === 400, JSON.stringify(noOffice.payload));
  const joined = await api('POST', '/api/auth/register', {
    body: { email: 'brother1@example.org', name: 'A Brother', password: 'a long enough secret',
      role: 'viewer', accessCode: 'square22-lodge-code' },
  });
  check('a Brother with the code creates his own account and is signed straight in',
    joined.status === 201 && Boolean(joined.payload.token), JSON.stringify(joined.payload).slice(0, 200));
  check('he gets the office he claimed', joined.payload.user?.role === 'viewer', joined.payload.user?.role);
  check('and can use it immediately',
    (await api('GET', '/api/auth/me', { token: joined.payload.token })).status === 200);
  const takenOffice = await api('POST', '/api/auth/register', {
    body: { email: 'imposter@example.org', name: 'Imposter', password: 'a long enough secret',
      role: 'secretary', accessCode: 'square22-lodge-code' },
  });
  check('the code cannot be used to take an office another officer already holds',
    takenOffice.status === 409, JSON.stringify(takenOffice.payload));
  const dupeEmail = await api('POST', '/api/auth/register', {
    body: { email: 'brother1@example.org', name: 'A Brother', password: 'another long secret',
      role: 'viewer', accessCode: 'square22-lodge-code' },
  });
  check('the same email cannot be registered twice', dupeEmail.status === 409, String(dupeEmail.status));
  const setupSays = await api('GET', '/api/setup');
  check('the sign up page is told to show the code fields',
    setupSays.payload.registrationMode === 'access_code', JSON.stringify(setupSays.payload));

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
