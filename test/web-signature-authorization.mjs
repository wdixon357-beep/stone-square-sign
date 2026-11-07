import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { SignatureAuthorization } from '../public/signature-authorization.js';
import { AssistantWorkspace } from '../public/assistant-access.js';
import { assistantFixture } from './fixtures/assistant-workspace.mjs';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.className = ''; this.ownText = ''; this.disabled = false;
    this.classList = { add: name => { this.className += ` ${name}`; } };
  }
  set innerHTML(_) { throw new Error('HTML injection is forbidden'); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  append(...children) { for (const child of children) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child); child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { if (this.contains(document.activeElement)) document.activeElement = document.body; this.children = []; this.ownText = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, action) { (this.listeners[name] ||= []).push(action); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  focus() { document.activeElement = this; }
  getClientRects() { return [{}]; }
  querySelectorAll(selector) { const tags = selector.split(',').map(item => item.trim().toUpperCase()); return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
}
globalThis.document = { createElement: tag => new Element(tag), body: new Element('body'), activeElement: null };
const clone = value => structuredClone(value);
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pdf = new Blob(['%PDF-1.7\nSynthetic frozen document.\n%%EOF'], { type: 'application/pdf' });
const sha = createHash('sha256').update(Buffer.from(await pdf.arrayBuffer())).digest('hex');
const fixture = {
  id: 'signature-demo', actionId: 'minutes.master', recordId: 'minutes-demo', title: 'Synthetic stated meeting, October 15, 2026',
  kind: 'minutes-master', status: 'pending', createdAt: '2026-10-31T12:00:00Z', expiresAt: '2026-10-31T13:00:00Z',
  artifactSHA256: sha, fingerprint: 'frozen-synthetic-fingerprint', statement: 'I reviewed this exact synthetic document and attest to its accuracy.',
  effects: ['Applies the saved signature.', 'Files this record and creates internal officer alerts. Distribution is separate.'],
  signingRole: 'Worshipful Master', ready: true,
};
const findButton = (root, label) => root.querySelectorAll('button').find(item => item.textContent === label);
const instances = [];
const setup = (overrides = {}) => {
  let user = { id: 1, name: 'Synthetic Owner', role: 'owner' }, epoch = 1, now = Date.parse('2026-10-31T12:15:00Z');
  let request = { ...clone(fixture), ...overrides }, calls = [], preview = pdf, handler;
  const root = new Element('section'), created = [], revoked = [];
  const api = async (path, options = {}) => {
    const call = { path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) }; calls.push(call);
    if (handler) return handler(call);
    if (path.endsWith('/preview')) return preview;
    if (call.method === 'POST') { request = { ...request, status: path.endsWith('/decline') ? 'declined' : 'completed', ready: false, receipt: { authorizedBy: { name: user.name }, requestedBy: { name: 'Muse' }, appliedBy: 'system', completedAt: '2026-10-31T12:16:00Z', notificationState: 'queued', automaticRetryAllowed: false, privateSignature: 'MUST-NOT-RENDER' } }; }
    return { request: clone(request) };
  };
  const view = new SignatureAuthorization({ api, root, user: () => user, context: () => `${user?.id}:${epoch}`, now: () => now, previewFactory: null, onOpen() {}, onClose() {}, urls: { createObjectURL: blob => { created.push(blob); return 'blob:synthetic-preview'; }, revokeObjectURL: value => revoked.push(value) } }); instances.push(view);
  return { view, root, calls, created, revoked, get request() { return request; }, set request(value) { request = value; }, set user(value) { user = value; }, set epoch(value) { epoch = value; }, set now(value) { now = value; }, set preview(value) { preview = value; }, set handler(value) { handler = value; } };
};

const normal = setup(); await normal.view.open(fixture.id);
assert.equal(normal.calls.length, 2); assert.ok(normal.calls.every(call => call.method === 'GET'), 'Opening only reads');
assert.equal(findButton(normal.root, 'Authorize and apply signature').disabled, false);
assert.equal(normal.root.querySelectorAll('iframe')[0].src, 'blob:synthetic-preview');
assert.match(normal.root.textContent, /Your exact statement/); assert.match(normal.root.textContent, /Distribution is separate/);
await normal.view.decide('confirm');
assert.deepEqual(normal.calls.find(call => call.method === 'POST').body, { fingerprint: fixture.fingerprint, consent: true });
assert.match(normal.root.textContent, /Authorized by Synthetic Owner/); assert.match(normal.root.textContent, /Applied by the system/);
assert.doesNotMatch(normal.root.textContent, /MUST-NOT-RENDER/); assert.equal(findButton(normal.root, 'Authorize and apply signature'), undefined);
normal.view.close(); assert.deepEqual(normal.revoked, ['blob:synthetic-preview']);
const delegated = setup({status:'completed',ready:false,receipt:{authorizedBy:{name:'Synthetic Owner'},requestedBy:{name:'Muse'},appliedBy:'system',authorization:{source:'owner_delegation'},executedBy:{type:'assistant',assistantId:'synthetic-muse'}}});
await delegated.view.open(fixture.id);
assert.match(delegated.root.textContent, /Executed by Muse under your saved delegation/);
assert.match(delegated.root.textContent, /Delegation granted by Synthetic Owner/);
assert.match(delegated.root.textContent, /No separate Dashboard confirmation is recorded/);
assert.doesNotMatch(delegated.root.textContent, /Authorized by Synthetic Owner/);
assert.equal(delegated.calls.filter(call => call.method === 'POST').length, 0, 'Reading a delegated receipt cannot confirm another signature');

// Slow reads replace the initial shell after it has focus. Keep focus inside the new shell.
const focusing = setup(), focusRead = defer();
focusing.handler = call => call.path.endsWith('/preview') ? pdf : focusRead.promise;
const focusedOpening = focusing.view.open(fixture.id);
const initialClose = findButton(focusing.root, 'Close'); initialClose.focus();
focusRead.resolve({ request: clone(fixture) }); await focusedOpening;
assert.equal(focusing.root.contains(document.activeElement), true, 'Async render must restore focus after replacing controls');
assert.equal(document.activeElement.textContent, 'Close'); assert.notEqual(document.activeElement, initialClose);
findButton(focusing.root, 'Check request status').focus(); focusing.view.render(focusing.view.request);
assert.equal(document.activeElement.textContent, 'Check request status', 'The equivalent enabled control retains focus');
findButton(focusing.root, 'Authorize and apply signature').focus(); focusing.view.render({ ...clone(fixture), status: 'completed', ready: false });
assert.equal(document.activeElement.textContent, 'Close', 'Completion returns focus to a safe control when the action disappears');
assert.equal(focusing.calls.filter(call => call.method === 'POST').length, 0, 'Focusing controls never submits them');
const creating = setup({ recordId: 'new-dispensation', actionId: 'owner.dispensation-sign', kind: 'dispensation' }); await creating.view.open(fixture.id);
assert.match(creating.root.textContent, /New document/);

for (const status of ['processing', 'completed', 'declined', 'expired', 'stale', 'uncertain', 'unknown', 'unexpected']) {
  const test = setup({ status }); await test.view.open(fixture.id); await test.view.decide('confirm');
  assert.equal(test.calls.length, 1, `${status} does not fetch a new preview or write`);
  assert.equal(findButton(test.root, 'Authorize and apply signature'), undefined);
}
for (const fields of [{ ready: false }, { expiresAt: '2026-10-31T12:00:00Z' }, { expiresAt: null }, { statement: '' }, { effects: [] }, { artifactSHA256: 'invalid' }, { fingerprint: '' }]) {
  const test = setup(fields); await test.view.open(fixture.id); await test.view.decide('confirm');
  assert.equal(findButton(test.root, 'Authorize and apply signature').disabled, true);
  assert.equal(test.calls.filter(call => call.method === 'POST').length, 0);
}
const mismatch = setup({ artifactSHA256: '0'.repeat(64) }); await mismatch.view.open(fixture.id); assert.equal(mismatch.created.length, 0);
assert.equal(findButton(mismatch.root, 'Authorize and apply signature').disabled, true); assert.match(mismatch.root.textContent, /does not match/);
const wrongType = setup(); wrongType.preview = new Blob(['not a PDF'], { type: 'text/html' }); await wrongType.view.open(fixture.id);
assert.equal(findButton(wrongType.root, 'Authorize and apply signature').disabled, true); assert.equal(wrongType.created.length, 0);
const decoding = setup(), renderReady = defer();
decoding.view.previewFactory = async () => ({ show: () => renderReady.promise, clear: async () => {}, resize: { disconnect() {} } });
await decoding.view.open(fixture.id); await decoding.view.decide('confirm');
assert.equal(findButton(decoding.root, 'Authorize and apply signature').disabled, true, 'Hash verification alone cannot enable an unrendered preview');
assert.equal(decoding.calls.filter(call => call.method === 'POST').length, 0);
renderReady.resolve(1); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(findButton(decoding.root, 'Authorize and apply signature').disabled, false);
const decodingFailure = setup(); decodingFailure.view.previewFactory = async () => { throw new Error('decoder unavailable'); };
await decodingFailure.view.open(fixture.id); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(findButton(decodingFailure.root, 'Authorize and apply signature').disabled, true); assert.match(decodingFailure.root.textContent, /preview could not load/);
const invalid = setup(); await invalid.view.open('../secret'); assert.equal(invalid.calls.length, 0);
const other = setup(); other.user = { id: 2, role: 'secretary' }; await other.view.open(fixture.id); await other.view.decide('confirm'); assert.equal(other.calls.length, 0);
const denied = setup(); denied.handler = () => { throw Object.assign(new Error('private details'), { status: 403 }); }; await denied.view.open(fixture.id);
assert.match(denied.root.textContent, /not available to the signed-in owner account/); assert.doesNotMatch(denied.root.textContent, /private details/);

const duplicate = setup(); await duplicate.view.open(fixture.id); const pendingPost = defer();
duplicate.handler = call => call.method === 'POST' ? pendingPost.promise : { request: clone(duplicate.request) };
const first = duplicate.view.decide('confirm'); await duplicate.view.decide('confirm');
assert.equal(duplicate.calls.filter(call => call.method === 'POST').length, 1, 'Double activation applies at most once');
pendingPost.resolve({ request: { ...clone(fixture), status: 'completed', ready: false } }); await first;
const submissionFocus = setup(); await submissionFocus.view.open(fixture.id); const focusedPost = defer();
submissionFocus.handler = () => focusedPost.promise;
findButton(submissionFocus.root, 'Authorize and apply signature').focus();
const submitting = submissionFocus.view.decide('confirm'); document.body.focus(); // Browsers may blur a newly disabled submit control.
focusedPost.resolve({ request: { ...clone(fixture), status: 'completed', ready: false } }); await submitting;
assert.equal(document.activeElement.textContent, 'Close'); assert.equal(submissionFocus.root.contains(document.activeElement), true);

const lost = setup(); await lost.view.open(fixture.id);
lost.handler = call => { if (call.method === 'POST') throw new Error('response lost'); return { request: { ...clone(fixture), status: 'completed', ready: false } }; };
await lost.view.decide('confirm'); assert.equal(lost.calls.filter(call => call.method === 'POST').length, 1); assert.equal(lost.view.request.status, 'completed');
const uncertain = setup(); await uncertain.view.open(fixture.id);
uncertain.handler = call => { if (call.method === 'POST') throw new Error('response lost'); return call.path.endsWith('/preview') ? pdf : { request: clone(fixture) }; };
await uncertain.view.decide('confirm'); assert.equal(uncertain.view.request.status, 'uncertain');
await uncertain.view.open(fixture.id); await uncertain.view.decide('confirm'); assert.equal(uncertain.calls.filter(call => call.method === 'POST').length, 1, 'Pending readback cannot renew an ambiguous write');
assert.equal(findButton(uncertain.root, 'Authorize and apply signature').disabled, true);

const switched = setup(); const pendingRead = defer(); switched.handler = () => pendingRead.promise;
const opening = switched.view.open(fixture.id); switched.user = { id: 9, name: 'Other owner', role: 'owner' }; switched.epoch = 2; switched.view.dispose();
pendingRead.resolve({ request: clone(fixture) }); await opening; assert.equal(switched.root.textContent, ''); assert.equal(switched.created.length, 0);
const previewSwitch = setup(); const pendingPreview = defer(); previewSwitch.handler = call => call.path.endsWith('/preview') ? pendingPreview.promise : { request: clone(fixture) };
const loading = previewSwitch.view.open(fixture.id); await new Promise(resolve => setTimeout(resolve, 0)); previewSwitch.epoch = 2; previewSwitch.view.dispose();
pendingPreview.resolve(pdf); await loading; assert.equal(previewSwitch.root.textContent, ''); assert.equal(previewSwitch.created.length, 0);
const expiry = setup(); await expiry.view.open(fixture.id); expiry.now = Date.parse(fixture.expiresAt); await expiry.view.decide('confirm');
assert.equal(expiry.calls.filter(call => call.method === 'POST').length, 0, 'Expiry is rechecked on the actual action');
const decline = setup(); await decline.view.open(fixture.id); await decline.view.decide('decline');
assert.equal(decline.calls.filter(call => call.method === 'POST')[0].path, '/api/assistant/signature-requests/signature-demo/decline');
assert.equal(decline.view.request.status, 'declined');

// Both owner views read the same request model. Failure is distinct from an empty list.
const accessRoot = new Element('section'), attestationsRoot = new Element('section'), listCalls = [], opened = [];
let listFailure = false;
const workspace = new AssistantWorkspace({ api: async path => { listCalls.push(path); if (path === '/api/assistant/signature-requests') { if (listFailure) throw new Error('read failed'); return { requests: [clone(fixture)] }; } return path.endsWith('/attestations') ? { attestations: [] } : clone(assistantFixture); }, user: () => ({ id: 1, role: 'owner' }), context: () => '1:1', accessRoot, attestationsRoot, openSignatureRequest: id => opened.push(id), openReview() {}, confirm: () => true });
await workspace.show('access'); assert.match(accessRoot.textContent, /Signature confirmations from Muse/);
assert.match(accessRoot.textContent, /Other officers' authority and document checks still apply/);
findButton(accessRoot, 'Open signature confirmation').listeners.click[0](); assert.deepEqual(opened, [fixture.id]);
await workspace.show('attestations'); assert.match(attestationsRoot.textContent, /Signature confirmations from Muse/);
listFailure = true; await workspace.show('attestations'); assert.match(attestationsRoot.textContent, /Signature requests could not load/);
assert.doesNotMatch(attestationsRoot.textContent, /No Muse signature requests are recorded/);

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const keyboardSource = app.slice(app.indexOf("document.addEventListener('keydown', event => {"), app.indexOf('// Website updates must never'));
const earlierModal = new Element('section'), topModal = new Element('section'), firstControl = new Element('button'), lastControl = new Element('button'), outside = new Element('input');
topModal.append(firstControl, lastControl); let topControls = [firstControl, lastControl], keydown;
topModal.querySelectorAll = () => topControls;
const keyboardDocument = { querySelectorAll: () => [earlierModal, topModal], get activeElement() { return document.activeElement; }, addEventListener: (name, action) => { assert.equal(name, 'keydown'); keydown = action; } };
vm.runInNewContext(keyboardSource, { document: keyboardDocument, modalFocusSelector: 'synthetic-focusable' });
const tab = shiftKey => { let prevented = false; keydown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } }); return prevented; };
outside.focus(); assert.equal(tab(false), true); assert.equal(document.activeElement, firstControl, 'Forward Tab from outside enters the top modal');
outside.focus(); assert.equal(tab(true), true); assert.equal(document.activeElement, lastControl, 'Reverse Tab from outside enters the top modal');
lastControl.focus(); assert.equal(tab(false), true); assert.equal(document.activeElement, firstControl);
firstControl.focus(); assert.equal(tab(true), true); assert.equal(document.activeElement, lastControl);
topControls = []; outside.focus(); assert.equal(tab(false), true); assert.equal(document.activeElement, topModal, 'A temporary empty shell cannot leak Tab to underlying forms');
assert.match(app, /pendingSignatureRequest = new URLSearchParams\(window\.location\.search\)\.get\('signatureRequest'\)/);
const enter = app.slice(app.indexOf('const enterWorkspace ='), app.indexOf('// Refresh access without'));
assert.ok(enter.indexOf('restoreWebDrafts()') < enter.indexOf('openSignatureAuthorization(id)'), 'Deep link opens after drafts/session restoration');
assert.match(app, /signatureAuthorization\?\.dispose\(\)/);
const dispatch = app.slice(app.indexOf('const openSignatureAuthorization ='), app.indexOf('const MINUTES_STATUS ='));
assert.doesNotMatch(dispatch, /showWorkspaceSection\(|resetMinutes|method:\s*['"]POST/, 'Opening confirmation preserves other forms and never signs');
for (const view of instances) view.dispose(); workspace.dispose();
console.log('PASS: exact frozen-PDF verification, one owner action, status and receipt parity, no auto-sign or write retry, expiry and account isolation, safe rendering, and deep-link draft preservation.');
