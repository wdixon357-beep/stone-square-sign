import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';
import { buildCorrespondencePdf, sharedSigningOfficers } from '../correspondence.js';

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
  assert.equal((await api('/api/correspondence', owner.token, 'POST', {
    ...letter, subject: 'Demit inquiry concerning [Brother full name]',
  })).status, 400, 'An unresolved general demit template cannot become an official draft.');
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
  const wmDraft = await api('/api/correspondence', owner.token, 'POST', { ...letter, subject: 'WM prepared for Secretary signature', signerUserId: secretary.user.id });
  assert.equal(wmDraft.status, 201);
  assert.equal(wmDraft.data.draft.assignedToName, 'William McDuffie');
  assert.equal(wmDraft.data.draft.assignedToOffice, 'Secretary');
  const wmId = wmDraft.data.draft.id;
  const signers = await api('/api/correspondence/signers', owner.token);
  assert.equal(signers.status, 200);
  assert.deepEqual(signers.data.signers.map(item => item.name), ['William McDuffie', 'Adrian Reese']);
  const access = await api('/api/admin/access', owner.token);
  const mcduffie = access.data.accounts.find(account => account.id === secretary.user.id && !account.pending);
  assert.ok(mcduffie);
  assert.equal((await api('/api/admin/access', owner.token, 'PUT', {
    key: mcduffie.key, permissions: mcduffie.permissions.filter(permission => permission !== 'reports.create'),
  })).status, 200);
  assert.equal((await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST', { expectedUpdatedAt: wmDraft.data.draft.updatedAt })).status, 409);
  assert.equal((await api('/api/admin/access', owner.token, 'PUT', {
    key: mcduffie.key, permissions: mcduffie.permissions,
  })).status, 200);
  assert.equal((await api(`/api/correspondence/${wmId}/submit`, assistant.token, 'POST', { expectedUpdatedAt: wmDraft.data.draft.updatedAt })).status, 403);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true })).status, 403);
  const submitted = await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST', { expectedUpdatedAt: wmDraft.data.draft.updatedAt });
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
  const resubmitted = await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST', { expectedUpdatedAt: returned.data.draft.updatedAt });
  assert.equal(resubmitted.status, 200);
  assert.equal(resubmitted.data.draft.returnNote, null);
  assert.equal((await api(`/api/correspondence/${wmId}`, owner.token, 'PUT', letter)).status, 409);
  assert.equal((await api(`/api/correspondence/${wmId}/submit`, owner.token, 'POST', { expectedUpdatedAt: returned.data.draft.updatedAt })).status, 409);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, assistant.token, 'POST', { consent: true })).status, 403);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: false, expectedUpdatedAt: resubmitted.data.draft.updatedAt })).status, 400);
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true, expectedUpdatedAt: resubmitted.data.draft.updatedAt })).status, 409);
  const signatureData = `data:image/png;base64,${(await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim()}`;
  assert.equal((await api('/api/profile/signature', secretary.token, 'PUT', { signatureData, signatureType: 'drawn' })).status, 200);
  const signed = await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true, expectedUpdatedAt: resubmitted.data.draft.updatedAt });
  assert.equal(signed.status, 200);
  assert.equal(signed.data.draft.status, 'signed');
  assert.equal(signed.data.draft.signedByName, 'William McDuffie');
  assert.equal((await api(`/api/correspondence/${wmId}/sign`, secretary.token, 'POST', { consent: true })).status, 403);
  const signedPdf = await api(`/api/correspondence/${wmId}/pdf`, secretary.token);
  const signedDocument = await getDocument({ data: new Uint8Array(signedPdf.data), useSystemFonts: true }).promise;
  const signedText = (await (await signedDocument.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  assert.match(signedText, /SIGNED - DELIVERY BY THE SIGNING OFFICER PENDING/);
  assert.match(signedText, /Secretary William McDuffie/);
  await signedDocument.destroy();
  const defaultDraft = await api('/api/correspondence', owner.token, 'POST', {
    ...letter, subject: 'Assistant Secretary correspondence', signerUserId: secretary.user.id,
  });
  assert.equal(defaultDraft.status, 201);
  const adrianDraft = await api(`/api/correspondence/${defaultDraft.data.draft.id}`, owner.token, 'PUT', {
    ...letter, subject: 'Assistant Secretary correspondence', signerUserId: assistant.user.id,
  });
  assert.equal(adrianDraft.status, 200);
  assert.equal(adrianDraft.data.draft.assignedToName, 'Adrian Reese');
  assert.equal(adrianDraft.data.draft.assignedToOffice, 'Assistant Secretary');
  const adrianId = adrianDraft.data.draft.id;
  const assistantPdf = await api(`/api/correspondence/${adrianId}/pdf`, owner.token);
  const assistantDocument = await getDocument({ data: new Uint8Array(assistantPdf.data), useSystemFonts: true }).promise;
  const assistantPage = await assistantDocument.getPage(1);
  const assistantItems = (await assistantPage.getTextContent()).items;
  assert.match(assistantItems.map(item => item.str).join(' '), /Assistant Secretary Adrian Reese/);
  const fraternally = assistantItems.find(item => item.str === 'Fraternally,');
  const signatory = assistantItems.filter(item => item.str === 'Adrian Reese')
    .sort((left, right) => left.transform[5] - right.transform[5])[0];
  assert.ok(fraternally && signatory && fraternally.transform[5] - signatory.transform[5] >= 70,
    'The unsigned PDF reserves a full signature area above the officer name.');
  await assistantDocument.destroy();
  assert.equal((await api(`/api/correspondence/${adrianId}/submit`, owner.token, 'POST', { signerUserId: assistant.user.id, expectedUpdatedAt: defaultDraft.data.draft.updatedAt })).status, 409,
    'A draft changed after preview cannot be assigned using the stale revision.');
  assert.equal((await api(`/api/correspondence/${adrianId}/submit`, owner.token, 'POST', { signerUserId: secretary.user.id, expectedUpdatedAt: adrianDraft.data.draft.updatedAt })).status, 409);
  const adrianAssigned = await api(`/api/correspondence/${adrianId}/submit`, owner.token, 'POST', { signerUserId: assistant.user.id, expectedUpdatedAt: adrianDraft.data.draft.updatedAt });
  assert.equal(adrianAssigned.status, 200);
  assert.equal(adrianAssigned.data.draft.assignedToUserId, assistant.user.id);
  assert.equal((await api('/api/correspondence/alerts', assistant.token)).data.alerts[0].id, adrianId);
  assert.equal((await api(`/api/correspondence/${adrianId}/sign`, secretary.token, 'POST', { consent: true })).status, 403);
  assert.equal((await api('/api/profile/signature', assistant.token, 'PUT', { signatureData, signatureType: 'drawn' })).status, 200);
  const adrianSigned = await api(`/api/correspondence/${adrianId}/sign`, assistant.token, 'POST', { consent: true, expectedUpdatedAt: adrianAssigned.data.draft.updatedAt });
  assert.equal(adrianSigned.status, 200);
  assert.equal(adrianSigned.data.draft.signedByName, 'Adrian Reese');
  const sharedDraft = await api('/api/correspondence', owner.token, 'POST', {
    ...letter, subject: 'Shared standing response', signerUserId: null,
  });
  assert.equal(sharedDraft.status, 201);
  assert.equal(sharedDraft.data.draft.signingMode, 'either');
  assert.equal(sharedDraft.data.draft.assignedToUserId, null);
  assert.equal(sharedDraft.data.draft.assignedToName, 'William McDuffie or Adrian Reese');
  const sharedId = sharedDraft.data.draft.id;
  const sharedSubmitted = await api(`/api/correspondence/${sharedId}/submit`, owner.token, 'POST', {
    signerUserId: null, expectedUpdatedAt: sharedDraft.data.draft.updatedAt,
  });
  assert.equal(sharedSubmitted.status, 200);
  assert.equal(sharedSubmitted.data.draft.status, 'awaiting_secretary');
  assert.ok((await api('/api/correspondence/alerts', secretary.token)).data.alerts.some(item => item.id === sharedId));
  assert.ok((await api('/api/correspondence/alerts', assistant.token)).data.alerts.some(item => item.id === sharedId));
  const sharedUnsignedPdf = await api(`/api/correspondence/${sharedId}/pdf`, owner.token);
  const sharedUnsignedDocument = await getDocument({ data: new Uint8Array(sharedUnsignedPdf.data), useSystemFonts: true }).promise;
  const sharedUnsignedText = (await (await sharedUnsignedDocument.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  assert.match(sharedUnsignedText, /Secretary or Assistant Secretary/);
  assert.doesNotMatch(sharedUnsignedText, /Secretary William McDuffie/);
  await sharedUnsignedDocument.destroy();
  const sharedSigned = await api(`/api/correspondence/${sharedId}/sign`, assistant.token, 'POST', { consent: true, expectedUpdatedAt: sharedSubmitted.data.draft.updatedAt });
  assert.equal(sharedSigned.status, 200);
  assert.equal(sharedSigned.data.draft.signedByUserId, assistant.user.id);
  assert.equal(sharedSigned.data.draft.assignedToName, 'Adrian Reese');
  assert.equal(sharedSigned.data.draft.assignedToOffice, 'Assistant Secretary');
  assert.equal((await api(`/api/correspondence/${sharedId}/sign`, secretary.token, 'POST', { consent: true })).status, 403);
  const sharedSignedPdf = await api(`/api/correspondence/${sharedId}/pdf`, owner.token);
  const sharedSignedDocument = await getDocument({ data: new Uint8Array(sharedSignedPdf.data), useSystemFonts: true }).promise;
  const sharedSignedText = (await (await sharedSignedDocument.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  assert.match(sharedSignedText, /Assistant Secretary Adrian Reese/);
  await sharedSignedDocument.destroy();
  const staleDraft = await api('/api/correspondence', owner.token, 'POST', {
    ...letter, subject: 'Original shared text', signerUserId: null,
  });
  const staleId = staleDraft.data.draft.id;
  const staleSubmitted = await api(`/api/correspondence/${staleId}/submit`, owner.token, 'POST', {
    expectedUpdatedAt: staleDraft.data.draft.updatedAt,
  });
  const stalePreviewRevision = staleSubmitted.data.draft.updatedAt;
  const staleReturned = await api(`/api/correspondence/${staleId}/return`, owner.token, 'POST', { reason: 'Revise text' });
  assert.equal(staleReturned.status, 200);
  const staleRevised = await api(`/api/correspondence/${staleId}`, owner.token, 'PUT', {
    ...letter, subject: 'Revised shared text', signerUserId: null,
  });
  const staleResubmitted = await api(`/api/correspondence/${staleId}/submit`, owner.token, 'POST', {
    expectedUpdatedAt: staleRevised.data.draft.updatedAt,
  });
  assert.equal(staleResubmitted.status, 200);
  assert.equal((await api(`/api/correspondence/${staleId}/sign`, secretary.token, 'POST', {
    consent: true, expectedUpdatedAt: stalePreviewRevision,
  })).status, 409, 'An officer cannot sign revised text using an earlier PDF preview.');
  const freshSigned = await api(`/api/correspondence/${staleId}/sign`, secretary.token, 'POST', {
    consent: true, expectedUpdatedAt: staleResubmitted.data.draft.updatedAt,
  });
  assert.equal(freshSigned.status, 200);
  const longBody = Array.from({ length: 18 }, (_, index) =>
    `Paragraph ${index + 1}. This sample checks a formal letter that extends beyond one page. The final paragraph and complete signature block must stay together.`).join('\n\n');
  const longRow = { recipient_name: 'Secretary', recipient_lodge: 'Example Lodge', subject: 'Pagination check',
    body: longBody, assigned_to_name: 'Adrian Reese', assigned_to_office: 'Assistant Secretary',
    submitted_at: '2026-09-23T14:29:00.000Z' };
  const longDraft = await getDocument({ data: new Uint8Array(await buildCorrespondencePdf({ ...longRow, status: 'awaiting_secretary' })), useSystemFonts: true }).promise;
  const longSigned = await getDocument({ data: new Uint8Array(await buildCorrespondencePdf({ ...longRow, status: 'signed', signed_signature_bytes: Buffer.from(signatureData.split(',')[1], 'base64'), signed_at: '2026-09-23T15:00:00.000Z' })), useSystemFonts: true }).promise;
  assert.equal(longDraft.numPages, longSigned.numPages, 'Applying a signature must not change pagination.');
  const lastPage = await longSigned.getPage(longSigned.numPages);
  const lastText = (await lastPage.getTextContent()).items.map(item => item.str).join(' ');
  for (const value of ['Paragraph 18.', 'Fraternally,', 'Adrian Reese', 'Assistant Secretary', 'Signed September 23, 2026'])
    assert.ok(lastText.includes(value), `The complete closing block and final paragraph must share the last page: ${value}`);
  await longDraft.destroy(); await longSigned.destroy();
  const approvedPair = [
    { id: secretary.user.id, name: 'William McDuffie', role: 'secretary' },
    { id: assistant.user.id, name: 'Adrian Reese', role: 'assistant_secretary' },
  ];
  assert.deepEqual(sharedSigningOfficers([...approvedPair, { id: 999, name: 'William A. McDuffie', role: 'secretary' }]).map(user => user.id),
    [secretary.user.id, assistant.user.id], 'A similarly named account is not a shared signer.');
  assert.equal(sharedSigningOfficers([...approvedPair, { id: 1000, name: 'Adrian Reese', role: 'assistant_secretary' }]).length,
    0, 'A duplicate exact-name account makes the shared signing group ambiguous.');
  console.log('PASS: WM can choose McDuffie or Reese for a private letter; only the assigned officer can sign with a reserved signature space and download the PDF for manual email.');
} finally { server.kill('SIGTERM'); }
