import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { easternDate } from '../treasury-period.js';

const origin = 'http://127.0.0.1:3667';
const ownerEmail = 'synthetic-check-owner@example.invalid';
const password = 'Password for isolated check order test';
const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env, PORT: '3667', NODE_ENV: 'test', APP_BASE_URL: origin,
    DATABASE_URL: '', PGLITE_DIR: '', OWNER_EMAIL: ownerEmail,
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', LODGE_ACCESS_CODE: '', DDGM_EMAIL: 'unused@example.invalid',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let startupErrors = '';
server.stderr.on('data', data => { startupErrors = (startupErrors + data).slice(-4000); });

async function request(path, token, method = 'GET', body) {
  const response = await fetch(origin + path, {
    method, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, headers: response.headers };
}

async function orderRequest(token, method = 'GET', suffix = '', body) {
  return request('/api/check-orders' + suffix, token, method, body);
}

async function expectStatus(promise, expected) {
  const response = await promise;
  assert.equal(response.status, expected, JSON.stringify(response.data));
  return response.data;
}

const sign = (token, order, action, details = {}) => orderRequest(token, 'POST', '/' + order.id + '/' + action,
  { revision: order.revision, consent: true, ...details });
const date = easternDate();

try {
  let healthy = false;
  for (let attempt = 0; attempt < 100 && !healthy; attempt++) {
    try { healthy = (await fetch(origin + '/api/health')).ok; } catch {}
    if (!healthy) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy, startupErrors);
  const { token: owner } = await expectStatus(request('/api/auth/register', null, 'POST',
    { email: ownerEmail, name: 'Test Worshipful Master', password }), 201);
  async function invite(role, name) {
    const email = role + '@example.invalid';
    const invitation = await expectStatus(request('/api/officers/invite', owner, 'POST', { email, name, role }), 201);
    const account = await expectStatus(request('/api/auth/register', null, 'POST',
      { email, name, password, invitationToken: new URL(invitation.inviteUrl).searchParams.get('invite') }), 201);
    return account.token;
  }
  const secretary = await invite('secretary', 'Test Secretary');
  const assistantSecretary = await invite('assistant_secretary', 'Test Assistant Secretary');
  const treasurer = await invite('treasurer', 'Test Treasurer');
  const assistantTreasurer = await invite('assistant_treasurer', 'Test Assistant Treasurer');
  const unrelated = await invite('treasury_preparer', 'Test Treasury Preparer');

  const signature = (await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim();
  for (const token of [owner, secretary, assistantSecretary, treasurer, assistantTreasurer]) {
    await expectStatus(request('/api/profile/signature', token, 'PUT',
      { signatureType: 'drawn', signatureData: 'data:image/png;base64,' + signature }), 200);
  }
  const supporting = await PDFDocument.create();
  supporting.addPage().drawText('Synthetic supporting document');
  const bytes = Buffer.from(await supporting.save());
  const body = {
    clientRequestId: randomUUID(), payee: 'Synthetic Lodge Vendor', amount: '216.07',
    reason: 'Reimbursement for synthetic event supplies.', category: 'Event supplies',
    authorizationReference: 'Synthetic meeting record, motion 11', supportingReference: 'Invoice TEST-01', consent: true,
    supportingDocument: { name: 'Synthetic invoice.pdf', base64: bytes.toString('base64') },
  };

  await expectStatus(orderRequest(null), 401);
  await expectStatus(orderRequest(unrelated), 403);
  await expectStatus(orderRequest(secretary, 'POST', '', body), 403);
  await expectStatus(orderRequest(owner, 'POST', '', { ...body, authorizationReference: '' }), 400);
  await expectStatus(orderRequest(owner, 'POST', '', { ...body, consent: false }), 400);
  await expectStatus(orderRequest(owner, 'POST', '', { ...body, amount: '12.345' }), 400);
  await expectStatus(orderRequest(owner, 'POST', '', { ...body,
    supportingDocument: { name: 'not-a-pdf.pdf', base64: 'QUJD' } }), 400);

  const created = await expectStatus(orderRequest(owner, 'POST', '', body), 201);
  const order = created.order;
  assert.equal(order.amount, '216.07');
  assert.deepEqual(order.secretaries.map(({ name }) => name), ['Test Secretary', 'Test Assistant Secretary']);
  assert.equal(order.status, 'awaiting_secretaries');
  assert.equal(order.requestedBy, 'Test Worshipful Master');
  assert.equal(order.authorizationReference, body.authorizationReference);
  assert.equal(order.permissions.void, true);
  assert.equal(order.permissions.certify, false);
  assert.deepEqual((await expectStatus(orderRequest(owner, 'POST', '', body), 200)).order, order);
  await expectStatus(orderRequest(owner, 'POST', '', { ...body, amount: '216.08' }), 409);
  assert.equal((await expectStatus(orderRequest(owner), 200)).orders.length, 1);
  const secretaryList = await expectStatus(orderRequest(secretary), 200);
  assert.equal(secretaryList.orders[0].permissions.certify, true);
  assert.equal(secretaryList.orders[0].permissions.recordPayment, false);
  assert.doesNotMatch(JSON.stringify(secretaryList), /signature_bytes|consent_text|supporting_pdf/);

  const supportPath = '/' + order.id + '/supporting-document';
  await expectStatus(orderRequest(unrelated, 'GET', supportPath), 403);
  assert.deepEqual(await expectStatus(orderRequest(assistantTreasurer, 'GET', supportPath), 200), bytes);
  await expectStatus(sign(treasurer, order, 'record-payment', { checkNumber: 'TEST-100', issuedOn: date }), 409);
  await expectStatus(sign(owner, order, 'certify'), 403);
  await expectStatus(sign(secretary, order, 'certify', { consent: false }), 400);
  await expectStatus(sign(secretary, order, 'certify', { revision: 0 }), 409);
  const certifications = await Promise.all([
    expectStatus(sign(secretary, order, 'certify'), 200),
    expectStatus(sign(assistantSecretary, order, 'certify'), 200),
  ]);
  const ready = certifications.find(result => result.order.status === 'ready_for_treasurer').order;
  assert.equal(ready.revision, 3);
  assert.ok(ready.secretaries.every(item => item.signedAt));
  assert.equal((await expectStatus(sign(secretary, order, 'certify'), 200)).order.revision, 3);
  const pendingPdf = await expectStatus(orderRequest(treasurer, 'GET', '/' + order.id + '/pdf'), 200);
  const pendingParser = new PDFParse({ data: pendingPdf });
  const pendingText = (await pendingParser.getText()).text;
  await pendingParser.destroy();
  assert.match(pendingText, /Ready for the Treasurer/);
  assert.match(pendingText, /No check has been recorded/);

  await expectStatus(sign(treasurer, ready, 'record-payment', { checkNumber: 'TEST-100', issuedOn: '2000-01-01' }), 400);
  await expectStatus(sign(treasurer, ready, 'record-payment', { checkNumber: 'TEST-100', issuedOn: date, revision: 2 }), 409);
  const officers = [
    { token: treasurer, name: 'Test Treasurer', number: 'TEST-100' },
    { token: assistantTreasurer, name: 'Test Assistant Treasurer', number: 'TEST-101' },
  ];
  const competing = await Promise.all(officers.map(officer => sign(officer.token, ready, 'record-payment',
    { checkNumber: officer.number, issuedOn: date })));
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  const paid = competing.find(result => result.status === 200).data.order;
  const signedBy = officers.find(officer => officer.name === paid.paidBy);
  assert.equal(paid.status, 'payment_recorded');
  assert.equal(paid.checkNumber, signedBy.number);
  assert.equal(paid.treasurers.filter(item => item.signedAt).length, 1);
  assert.equal((await expectStatus(sign(signedBy.token, ready, 'record-payment',
    { checkNumber: signedBy.number, issuedOn: date }), 200)).order.revision, paid.revision);

  const ledger = { ledgerReference: 'LEDGER-TEST-01', filingNotes: 'Synthetic filing only.' };
  await expectStatus(sign(owner, paid, 'void', { reason: 'This check should not be changed.' }), 409);
  await expectStatus(sign(treasurer, paid, 'file', ledger), 403);
  const filed = (await expectStatus(sign(assistantSecretary, paid, 'file', ledger), 200)).order;
  assert.equal(filed.status, 'filed');
  assert.equal(filed.deliveredOn, null);
  await expectStatus(sign(secretary, filed, 'file', { ledgerReference: 'Different ledger', deliveredOn: date, filingNotes: ledger.filingNotes }), 409);
  const delivered = (await expectStatus(sign(secretary, filed, 'file', { ...ledger, deliveredOn: date }), 200)).order;
  assert.equal(delivered.deliveredOn, date);
  assert.equal(delivered.filedBy, 'Test Assistant Secretary');
  assert.equal(delivered.deliveryRecordedBy, 'Test Secretary');
  assert.equal(delivered.permissions.file, false);
  await expectStatus(sign(secretary, delivered, 'file', { ...ledger, deliveredOn: date }), 409);

  const finalPdf = await expectStatus(orderRequest(owner, 'GET', '/' + order.id + '/pdf'), 200);
  const parser = new PDFParse({ data: finalPdf });
  const { text } = await parser.getText();
  await parser.destroy();
  for (const phrase of ['Filed in Lodge records', 'Synthetic Lodge Vendor', '$216.07', 'Two hundred sixteen dollars and 07/100',
    'Synthetic meeting record, motion 11', 'Test Worshipful Master', 'Test Secretary', 'Test Assistant Secretary', signedBy.name,
    signedBy.number, ledger.ledgerReference]) assert.ok(text.includes(phrase), phrase);
  if (process.env.CHECK_ORDERS_TEST_PDF) await writeFile(process.env.CHECK_ORDERS_TEST_PDF, finalPdf, { mode: 0o600 });

  // The Treasurer who did not record the first check can record another after
  // both signatures. One authorized office does not substitute for the other.
  const alternative = (await expectStatus(orderRequest(owner, 'POST', '', { ...body,
    clientRequestId: randomUUID(), supportingDocument: null,
  }), 201)).order;
  const oneSigned = (await expectStatus(sign(assistantSecretary, alternative, 'certify'), 200)).order;
  assert.equal(oneSigned.status, 'awaiting_secretaries');
  await expectStatus(sign(assistantTreasurer, oneSigned, 'record-payment', { checkNumber: 'TEST-102', issuedOn: date }), 409);
  const bothSigned = (await expectStatus(sign(secretary, oneSigned, 'certify'), 200)).order;
  const otherOfficer = officers.find(officer => officer.name !== signedBy.name);
  const alternativePaid = (await expectStatus(sign(otherOfficer.token, bothSigned, 'record-payment',
    { checkNumber: 'TEST-103', issuedOn: date }), 200)).order;
  assert.equal(alternativePaid.paidBy, otherOfficer.name);

  const erroneous = (await expectStatus(orderRequest(owner, 'POST', '', { ...body, clientRequestId: randomUUID() }), 201)).order;
  const signedOnce = (await expectStatus(sign(secretary, erroneous, 'certify'), 200)).order;
  assert.equal((await expectStatus(sign(owner, signedOnce, 'void', { reason: 'Synthetic corrected payee' }), 200)).order.status, 'voided');
  await expectStatus(sign(assistantSecretary, signedOnce, 'certify'), 409);
  await expectStatus(sign(assistantTreasurer, signedOnce, 'record-payment', { checkNumber: 'TEST-104', issuedOn: date }), 409);
  const audit = await expectStatus(request('/api/admin/activity?days=1', owner), 200);
  const actions = audit.events.filter(event => event.action.startsWith('check_order_')).map(event => event.action);
  assert.equal(actions.filter(action => action === 'check_order_payment_recorded').length, 2);
  assert.equal(actions.filter(action => action === 'check_order_filed').length, 1);
  assert.equal(actions.filter(action => action === 'check_order_delivery_recorded').length, 1);
  assert.equal(actions.filter(action => action === 'check_order_voided').length, 1);
  console.log('Check Orders passed across owner, both Secretaries, either Treasurer, exact USD amount, attachment visibility, filing, voiding, and concurrent signatures.');
} finally {
  server.kill('SIGTERM');
}
