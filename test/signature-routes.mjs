import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import bcrypt from 'bcrypt';
import JSZip from 'jszip';
import UPNGModule from '@pdf-lib/upng';
import { buildMinutesPdf } from '../minutes-pdf.js';
import { normalizeMinutesDraft } from '../minutes.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Never connect this route test to a configured database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Never reuse an existing local database.');
const work = await mkdtemp(join(tmpdir(), 'stone-square-signature-routes-'));
const databaseDir = join(work, 'database');
const loaderFile = join(work, 'isolated-server.mjs');
process.env.PGLITE_DIR = databaseDir;
const { connect, initSchema, dbGet, dbAll, dbRun, close } = await import('../db.js');
const { initSignaturePolicySchema, pinApprovedOwnerSignature } = await import('../signature-policy.js');
const { initMinutesSignatureRevisionSchema, createMinutesSignatureRevisions } = await import('../minutes-signature-revisions.js');
const UPNG = UPNGModule.default || UPNGModule;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const password = 'Isolated signature route password';
const ownerEmail = 'signature-owner@example.test';
const secretaryEmail = 'signature-secretary@example.test';
const firstDate = '2026-10-02T01:01:02.123Z';
const masterDate = '2026-10-03T12:46:05.967Z';
const source = 'Private synthetic meeting notes. The committee report was received.';
const stamp = (width, height, color) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba.set(color.map((value, index) => Math.min(255, value + (x * (index + 7) + y * 13) % 25)), offset);
    rgba[offset + 3] = (x * 19 + y * 17) % 7 < 3 ? 255 : (x + y) % 5 === 0 ? 128 : 0;
  }
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
};
const originalSignature = stamp(180, 60, [15, 25, 35]);
const approvedSignature = stamp(220, 65, [0, 70, 220]);
const secretarySignature = stamp(180, 60, [30, 70, 25]);
const alternateSignature = stamp(200, 60, [70, 30, 70]);
for (const image of [approvedSignature, alternateSignature]) {
  assert.ok(image.length >= 600 && `data:image/png;base64,${image.toString('base64')}`.length >= 800, 'Synthetic signatures exercise the actual visible-PNG validation.');
}
let server = null, base = '', connected = false, output = '', passed = 0;
const check = (label, condition) => { assert.ok(condition, label); passed += 1; console.log(`PASS ${label}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = image => ({ signatureData: `data:image/png;base64,${image.toString('base64')}`, signatureType: 'drawn', styleName: 'synthetic-test' });
async function api(path, token, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, headers: response.headers };
}
async function stop() {
  if (!server) return;
  const child = server; server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code, signal] = await ended;
    assert.equal(signal, null, 'The isolated server must close its database cleanly.');
    assert.equal(code, 0, 'The isolated server must exit successfully.');
  } finally { clearTimeout(timeout); }
}
async function start() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  await writeFile(loaderFile, `
import dotenv from ${JSON.stringify(import.meta.resolve('dotenv'))};
import { close } from ${JSON.stringify(new URL('../db.js', import.meta.url).href)};
import nodemailer from ${JSON.stringify(import.meta.resolve('nodemailer'))};
dotenv.config = () => ({ parsed: {} });
globalThis.fetch = async () => { throw new Error('External fetch is disabled in the isolated signature route test.'); };
nodemailer.createTransport = () => { throw new Error('External email is disabled in the isolated signature route test.'); };
process.once('SIGTERM', async () => { await close(); process.exit(0); });
`);
  server = spawn(process.execPath, ['--import', loaderFile, 'server.js'], {
    cwd: new URL('..', import.meta.url),
    // Deliberately do not inherit provider credentials or load the real .env.
    env: { PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', TZ: 'UTC',
      NODE_ENV: 'test', PORT: String(port), DATABASE_URL: '', PGLITE_DIR: databaseDir,
      OWNER_EMAIL: ownerEmail, APP_BASE_URL: base, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '',
      OPENAI_API_KEY: '', ZEFFY_API_KEY: '', ZEFFY_DUES_CAMPAIGN_ID: '', ZEFFY_CUSTOM_DUES_CAMPAIGN_ID: '',
      TRACKER_SSO_SHARED_SECRET: '', LODGE_ACCESS_CODE: '', WARDEN_EMAILS: '', DDGM_EMAIL: '',
      CANDIDATE_TRACKER_URL: base, REPORT_GENERATOR_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', bytes => { output += bytes; }); server.stderr.on('data', bytes => { output += bytes; });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited: ${output.slice(-3000)}`);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await pause(100);
  }
  throw new Error(`Isolated server did not start: ${output.slice(-3000)}`);
}

try {
  await connect(); connected = true; await initSchema(); await initSignaturePolicySchema(); await initMinutesSignatureRevisionSchema();
  const passwordHash = await bcrypt.hash(password, 4);
  for (const [email, name, role] of [[ownerEmail, 'Synthetic Worshipful Master', 'owner'], [secretaryEmail, 'Synthetic Assistant Secretary', 'assistant_secretary']]) {
    await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)', [email, passwordHash, name, role, firstDate]);
  }
  const owner = await dbGet('SELECT * FROM users WHERE email=?', [ownerEmail]);
  const secretary = await dbGet('SELECT * FROM users WHERE email=?', [secretaryEmail]);
  for (const [userId, image] of [[owner.id, approvedSignature], [secretary.id, secretarySignature]]) {
    await dbRun('INSERT INTO profile_signatures(user_id,signature_bytes,signature_type,style_name,updated_at) VALUES (?,?,?,?,?)', [userId, image, 'drawn', 'synthetic-original', firstDate]);
  }
  await pinApprovedOwnerSignature({ ownerUserId: owner.id, expectedProfileSha256: sha(approvedSignature), authorizationNote: 'Synthetic owner explicitly approved this inspected blue-like image for this isolated test only.' });
  const draft = normalizeMinutesDraft({ meetingDate: '2026-10-01', degree: 'Third degree', meetingType: 'Stated Communication',
    openingTime: '7:30 PM', closingTime: '9:00 PM', presiding: 'Synthetic Worshipful Master',
    sections: [{ heading: 'New Business', body: '- The committee report was received.' }] });
  const draftJson = JSON.stringify(draft), originals = new Map(), corrected = new Map();
  const revisions = createMinutesSignatureRevisions({ buildOriginalPdf: async ({ row }) => originals.get(row.id) });
  for (const id of ['signature-finalized', 'signature-stale']) {
    await dbRun(`INSERT INTO meeting_minutes
      (id,meeting_date,source_name,transcript_text,draft_json,status,created_by_user_id,updated_by_user_id,created_at,updated_at,
       submitted_for_review_at,preparer_attested_at,master_attested_by_user_id,master_attested_at,authorized_by_user_id,authorized_at,
       submitted_draft_json,master_changes_json,preparer_signature_bytes,master_signature_bytes)
      VALUES (?,?,?,?,?,'ready_for_distribution',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, '2026-10-01', 'Synthetic notes', source, draftJson, secretary.id, owner.id, firstDate, masterDate, firstDate, firstDate,
      owner.id, masterDate, owner.id, masterDate, draftJson, '[]', secretarySignature, originalSignature]);
    await dbRun('UPDATE meeting_minutes SET source_uploaded_by_user_id=?,preparer_user_id=? WHERE id=?', [secretary.id, secretary.id, id]);
    await dbRun('INSERT INTO meeting_minutes_attestations(id,minutes_id,user_id,phase,draft_json,signature_bytes,created_at) VALUES (?,?,?,?,?,?,?)',
      [`${id}-preparer`, id, secretary.id, 'preparer', draftJson, secretarySignature, firstDate]);
    await dbRun('INSERT INTO meeting_minutes_attestations(id,minutes_id,user_id,phase,draft_json,signature_bytes,created_at) VALUES (?,?,?,?,?,?,?)',
      [`${id}-master`, id, owner.id, 'master', draftJson, originalSignature, masterDate]);
    for (const userId of [owner.id, secretary.id]) {
      await dbRun('INSERT INTO minutes_distribution_alerts(minutes_id,user_id,created_at,seen_at) VALUES (?,?,?,?)', [id, userId, masterDate, firstDate]);
    }
    const original = Buffer.from(await buildMinutesPdf({ draft, status: 'ready_for_distribution', preparedBy: secretary.name,
      preparerRole: secretary.role, preparedSignature: secretarySignature, preparerAttestedAt: firstDate,
      masterName: owner.name, masterSignature: originalSignature, masterAttestedAt: masterDate }));
    originals.set(id, original);
    const result = await revisions.apply({ ownerUserId: owner.id, minutesId: id, replacementSignaturePng: approvedSignature,
      expectedPdfSha256: sha(original), expectedSignatureSha256: sha(originalSignature),
      authorizationNote: 'Synthetic owner authorized only this isolated visual signature correction, preserving the original record and attestations.' });
    corrected.set(id, result.afterPdfSha256);
  }
  await dbRun('UPDATE meeting_minutes_attestations SET draft_json=? WHERE id=?', [JSON.stringify({ ...draft, closingTime: '9:15 PM' }), 'signature-stale-master']);
  const before = {
    records: await dbAll('SELECT * FROM meeting_minutes ORDER BY id'),
    attestations: await dbAll('SELECT * FROM meeting_minutes_attestations ORDER BY id'),
    alerts: await dbAll('SELECT * FROM minutes_distribution_alerts ORDER BY minutes_id,user_id'),
    revisions: await dbAll('SELECT * FROM minutes_signature_revisions ORDER BY id'),
    ownerProfile: await dbGet('SELECT * FROM profile_signatures WHERE user_id=?', [owner.id]),
    ownerProfileAudits: await dbAll("SELECT * FROM audit_events WHERE user_id=? AND action='profile_signature_saved' ORDER BY id", [owner.id]),
  };
  await close(); connected = false;
  await start();
  const ownerLogin = await api('/api/auth/login', null, 'POST', { email: ownerEmail, password });
  check('Actual owner login succeeds with the approved signature locked', ownerLogin.status === 200 && ownerLogin.data.user.signatureProfileLocked === true);
  const ownerToken = ownerLogin.data.token;
  const ownerMe = await api('/api/auth/me', ownerToken);
  check('Remembered owner policy is locked without exposing the private image hash', ownerMe.status === 200 && ownerMe.data.user.signatureProfileLocked === true && !JSON.stringify(ownerMe.data).includes(sha(approvedSignature)));
  const savedOwner = await api('/api/profile/signature', ownerToken);
  check('Actual owner profile returns only the approved PNG', savedOwner.status === 200 && sha(savedOwner.data) === sha(approvedSignature));
  const blocked = await api('/api/profile/signature', ownerToken, 'PUT', payload(alternateSignature));
  check('Another visible owner signature is rejected by the actual endpoint', blocked.status === 409 && /approved/i.test(blocked.data.error));
  const same = await api('/api/profile/signature', ownerToken, 'PUT', { ...payload(approvedSignature), signatureType: 'typed', styleName: 'must-not-rewrite' });
  check('Resaving approved pixels is an idempotent no-op even with different style labels', same.status === 200 && same.data.user.signatureProfileLocked === true);
  const secretaryLogin = await api('/api/auth/login', null, 'POST', { email: secretaryEmail, password });
  check('Actual assistant secretary login remains unlocked', secretaryLogin.status === 200 && secretaryLogin.data.user.signatureProfileLocked === false);
  const secretaryToken = secretaryLogin.data.token;
  const secretaryMe = await api('/api/auth/me', secretaryToken);
  check('Remembered secretary policy remains editable', secretaryMe.status === 200 && secretaryMe.data.user.signatureProfileLocked === false);
  const secretarySave = await api('/api/profile/signature', secretaryToken, 'PUT', payload(alternateSignature));
  check('The assistant secretary can change his own future-use signature', secretarySave.status === 200 && secretarySave.data.user.signatureProfileLocked === false);
  const secretarySaved = await api('/api/profile/signature', secretaryToken);
  check('The secretary profile change persists independently of the owner policy', secretarySaved.status === 200 && sha(secretarySaved.data) === sha(alternateSignature));

  const signedPdf = await api('/api/minutes/signature-finalized/pdf', ownerToken);
  check('Finalized PDF serves the exact verified retained correction', signedPdf.status === 200 && sha(signedPdf.data) === corrected.get('signature-finalized'));
  check('Finalized PDF remains private and cannot be cached as an old signature', /no-store/.test(signedPdf.headers.get('cache-control')));
  const secretaryPdf = await api('/api/minutes/signature-finalized/pdf?download=1', secretaryToken);
  check('The preparing officer downloads the same corrected signed PDF', secretaryPdf.status === 200 && sha(secretaryPdf.data) === corrected.get('signature-finalized') && /attachment/.test(secretaryPdf.headers.get('content-disposition')));
  const preview = await api('/api/minutes/signature-finalized/preview', ownerToken, 'POST', { draft: { sections: [{ heading: 'New Business', body: 'Must not replace the signed snapshot.' }] } });
  check('Finalized preview uses the same corrected captured snapshot and ignores supplied working edits', preview.status === 200 && sha(preview.data) === corrected.get('signature-finalized'));
  const docx = await api('/api/minutes/signature-finalized/docx', ownerToken);
  check('Finalized Word export succeeds with private cache headers', docx.status === 200 && /no-store/.test(docx.headers.get('cache-control')));
  const zip = await JSZip.loadAsync(docx.data);
  const imageHashes = await Promise.all(Object.values(zip.files).filter(file => !file.dir && /^word\/media\//.test(file.name)).map(async file => sha(await file.async('nodebuffer'))));
  check('Word contains the approved owner signature instead of the original incorrect image', imageHashes.includes(sha(approvedSignature)) && !imageHashes.includes(sha(originalSignature)));
  check('Word retains the original preparing officer signature after his profile change', imageHashes.includes(sha(secretarySignature)) && !imageHashes.includes(sha(alternateSignature)));
  const stalePdf = await api('/api/minutes/signature-stale/pdf', ownerToken);
  check('Stale published evidence is rejected without a fallback PDF', stalePdf.status === 409 && /changed/i.test(stalePdf.data.error));
  const staleDocx = await api('/api/minutes/signature-stale/docx', ownerToken);
  check('Word likewise rejects a revision tied to a changed attestation', staleDocx.status === 409 && /changed/i.test(staleDocx.data.error));
  await stop();
  await connect(); connected = true;
  assert.deepEqual(await dbAll('SELECT * FROM meeting_minutes ORDER BY id'), before.records);
  check('Actual HTTP paths preserve all minutes source, content, status and dates', true);
  assert.deepEqual(await dbAll('SELECT * FROM meeting_minutes_attestations ORDER BY id'), before.attestations);
  check('Original WM and preparer attestation rows and signatures are unchanged', true);
  assert.deepEqual(await dbAll('SELECT * FROM minutes_distribution_alerts ORDER BY minutes_id,user_id'), before.alerts);
  check('Viewing, previewing and exporting do not alter or create distribution alerts', true);
  assert.deepEqual(await dbAll('SELECT * FROM minutes_signature_revisions ORDER BY id'), before.revisions);
  check('Retrieval retains both original and corrected PDF archives without duplicating revisions', true);
  assert.deepEqual(await dbGet('SELECT * FROM profile_signatures WHERE user_id=?', [owner.id]), before.ownerProfile);
  assert.deepEqual(await dbAll("SELECT * FROM audit_events WHERE user_id=? AND action='profile_signature_saved' ORDER BY id", [owner.id]), before.ownerProfileAudits);
  check('Rejected and identical owner saves leave original profile bytes, metadata, date and audit untouched', true);
  const secretaryProfile = await dbGet('SELECT * FROM profile_signatures WHERE user_id=?', [secretary.id]);
  check('Only the explicitly edited secretary profile changes', sha(secretaryProfile.signature_bytes) === sha(alternateSignature));
  const viewed = await dbAll("SELECT * FROM audit_events WHERE action='minutes_signed_pdf_viewed'");
  check('Finalized PDF reads retain their normal audit events', viewed.length === 2);
  check('Server made no outbound fetch or email attempt', !/External (?:fetch|email) is disabled/.test(output));
  console.log(`${passed} isolated signature HTTP checks passed; no live data, paid API calls or notifications.`);
} finally {
  await stop();
  if (connected) await close();
  process.env.PGLITE_DIR = '';
  await rm(work, { recursive: true, force: true });
}
