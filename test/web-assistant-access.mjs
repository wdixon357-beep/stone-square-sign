import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AssistantWorkspace } from '../public/assistant-access.js';
import { assistantFixture } from './fixtures/assistant-workspace.mjs';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.className = ''; this.ownText = ''; this.value = ''; this.disabled = false; this.checked = false; this.parentElement = null;
    this.classList = { add: name => { this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); }, contains: name => this.className.split(/\s+/).includes(name) };
  }
  set innerHTML(_) { throw new Error('Unsafe HTML construction'); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.ownText = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async emit(name) { for (const callback of this.listeners[name] || []) await callback({ preventDefault() {}, target: this }); }
  querySelectorAll(selector) { const tags = selector.split(',').map(item => item.trim().toUpperCase()); return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
  reportValidity() { return true; }
}
globalThis.document = { createElement: tag => new Element(tag) };
const clone = value => structuredClone(value);
const findButton = (root, label) => root.querySelectorAll('button').find(item => item.textContent === label);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

let currentUser = { id: 1, role: 'owner' }, epoch = 1, data = clone(assistantFixture), calls = [], opened = [], copied = [], decisionError = false, unknownReadback = false, pendingWorkspace;
const api = async (path, options = {}) => {
  calls.push({ path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
  if (path === '/api/assistant/workspace') return pendingWorkspace ? pendingWorkspace.promise : clone(data);
  if (path === '/api/assistant/attestations') return { attestations: clone(data.attestations) };
  if (path === '/api/assistant/access/token') return { assistant: data.assistant, token: 'synthetic-private-token' };
  if (path === '/api/assistant/access' && options.method === 'PUT') { const input = JSON.parse(options.body); data.assistant = { ...data.assistant, ...input, expiresAt: new Date(Date.now() + input.expiresInDays * 86400000).toISOString() }; return { assistant: data.assistant }; }
  if (path === '/api/assistant/access' && options.method === 'DELETE') { data.assistant = null; return { ok: true }; }
  if (path.endsWith('/decision')) { if (decisionError) throw new Error('Response interrupted'); const request = data.requests.find(item => path.includes(item.id)); request.status = JSON.parse(options.body).decision === 'approve' ? 'approved' : 'declined'; return { request: clone(request) }; }
  if (path.startsWith('/api/assistant/requests/')) { if (unknownReadback) throw new Error('Read unavailable'); return { request: { ...data.requests[0], status: 'approved' } }; }
  throw new Error(`Unexpected route ${path}`);
};
const accessRoot = new Element('section'), attestationsRoot = new Element('section');
const workspace = new AssistantWorkspace({ api, user: () => currentUser, context: () => `${currentUser?.id}:${epoch}`, accessRoot, attestationsRoot, confirm: () => true, clipboard: () => ({ writeText: async value => copied.push(value) }), openReview: async item => opened.push(item) });
await workspace.show('access');
assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET', 'Opening access only reads');
const policyInput = name => accessRoot.querySelectorAll('input').find(input => input.name === name);
assert.equal(policyInput('commandExecution').checked, false, 'Older saved settings default to separate approval');
assert.equal(policyInput('signatureExecution').checked, false, 'Older saved settings never enable instructed signatures');
assert.match(accessRoot.textContent, /My own action/); assert.match(accessRoot.textContent, /Grand View account work/);
assert.equal(accessRoot.querySelectorAll('input').filter(input => ['minutes.master', 'building.approve', 'external.members'].includes(input.value)).length, 0, 'Personal and unavailable actions never become grant inputs');
assert.equal(findButton(accessRoot, 'Approve this change') !== undefined, true);
assert.equal(accessRoot.querySelectorAll('button').filter(item => item.textContent === 'Approve this change').length, 1, 'Only a pending, non-signature approval has a decision control');
await findButton(accessRoot, 'Create or replace token').emit('click');
assert.equal(workspace.token, 'synthetic-private-token'); assert.equal(copied.length, 0, 'No automatic token copying');
await findButton(accessRoot, 'Copy private token').emit('click'); assert.deepEqual(copied, ['synthetic-private-token']);
workspace.leave(); assert.equal(workspace.token, ''); assert.equal(workspace.tokenOutput, null); assert.doesNotMatch(accessRoot.textContent, /synthetic-private-token/);

await workspace.show('access');
const name = accessRoot.querySelectorAll('input').find(item => item.type === 'text'); name.value = 'Muse Lodge helper';
const permissions = accessRoot.querySelectorAll('input').filter(item => item.type === 'checkbox' && item.value); permissions.find(item => item.value === 'minutes.prepare').checked = true;
policyInput('commandExecution').checked = true; policyInput('signatureExecution').checked = true;
await accessRoot.querySelectorAll('form')[0].emit('change'); assert.equal(workspace.dirty, true);
await findButton(accessRoot, 'Create or replace token').emit('click'); assert.match(workspace.message.textContent, /Save or reload/);
await accessRoot.querySelectorAll('form')[0].emit('submit'); await settle();
const saved = calls.find(call => call.method === 'PUT'); assert.equal(saved.body.expiresInDays, 7); assert.ok(saved.body.permissions.includes('minutes.prepare')); assert.ok(!saved.body.permissions.includes('minutes.master'));
assert.equal(saved.body.commandExecution, true); assert.equal(saved.body.signatureExecution, true);
assert.equal(policyInput('commandExecution').checked, true); assert.equal(policyInput('signatureExecution').checked, true);
assert.match(accessRoot.textContent, /Runs on your instruction when granted/);
assert.equal(calls.filter(call => call.path.endsWith('/token')).length, 1, 'Saving permissions never issues a token');
const annualAccess = { name: 'Muse Lodge helper', permissions: ['minutes.prepare'], expiresInDays: 365, enabled: true };
await workspace.saveAccess(annualAccess);
assert.equal(calls.filter(call => call.method === 'PUT').at(-1).body.expiresInDays, 365);
assert.equal(accessRoot.querySelectorAll('select')[0].value, '365', 'Reloading annual access must not silently shorten it to seven days');
assert.equal(policyInput('commandExecution').checked, true, 'Omitted policy fields preserve the saved value');
const accessSaves = calls.filter(call => call.method === 'PUT').length;
await workspace.saveAccess({ ...annualAccess, expiresInDays: 366 });
assert.equal(calls.filter(call => call.method === 'PUT').length, accessSaves, 'More than 365 days is rejected before saving');
assert.equal(calls.filter(call => call.path.endsWith('/token')).length, 1, 'Extending access preserves the existing credential');
const savedRequestStatus = data.requests[0].status; data.requests[0].status = 'authorized'; data.requests[0].authorization = {source:'owner_delegation',actorType:'assistant',instruction:'Correct this event time.'}; await workspace.show('access');
assert.match(accessRoot.textContent, /Authorized through Muse, awaiting execution/);
assert.match(accessRoot.textContent, /owner_delegation/); assert.match(accessRoot.textContent, /Correct this event time\./);
assert.equal(findButton(accessRoot, 'Approve this change'), undefined, 'An instruction authorization is not awaiting another human approval');
await findButton(accessRoot, 'Decline').emit('click'); assert.equal(data.requests[0].status, 'declined', 'The owner can cancel an instructed action before execution');
data.requests[0].status = savedRequestStatus; await workspace.show('access');
await findButton(accessRoot, 'Approve this change').emit('click'); assert.match(accessRoot.textContent, /not yet recorded as executed/);
assert.equal(calls.find(call => call.path.endsWith('/decision')).body.fingerprint, 'synthetic-fingerprint');

await workspace.show('attestations'); assert.equal(opened.length, 0, 'Rendering a personal queue cannot open or sign');
await findButton(attestationsRoot, 'Review minutes').emit('click'); assert.equal(opened.length, 1); assert.equal(opened[0].recordId, 'demo-minutes');
assert.ok(calls.every(call => !call.path.endsWith('/master-attest') && !call.path.endsWith('/sign')), 'Queue has no signing request');
await workspace.show('attestations'); data.attestations[0].revision = 'revision-changed';
await findButton(attestationsRoot, 'Review minutes').emit('click'); assert.equal(opened.length, 1); assert.match(workspace.message.textContent, /record changed/);

// A lost decision response is reconciled with a read, never a repeated mutation.
data = clone(assistantFixture); decisionError = true; await workspace.show('access');
const beforeDecision = calls.filter(call => call.path.endsWith('/decision')).length;
await findButton(accessRoot, 'Approve this change').emit('click'); assert.equal(calls.filter(call => call.path.endsWith('/decision')).length, beforeDecision + 1); assert.match(accessRoot.textContent, /Saved request: Approved/);
unknownReadback = true; await workspace.show('access'); await findButton(accessRoot, 'Approve this change').emit('click'); assert.match(accessRoot.textContent, /outcome is unverified/);
assert.equal(findButton(accessRoot, 'Approve this change').disabled, true, 'An unverified outcome cannot be blindly retried');

// Late responses, saved tokens, and owner-only content cannot cross account epochs.
pendingWorkspace = deferred(); const late = workspace.show('access');
currentUser = { id: 8, role: 'assistant_treasurer' }; epoch++; workspace.dispose(); pendingWorkspace.resolve(clone(assistantFixture)); await late;
assert.equal(accessRoot.childElementCount, 0); assert.equal(attestationsRoot.childElementCount, 0);
const beforeNonowner = calls.length; await workspace.show('access'); await workspace.issueToken(); assert.equal(calls.length, beforeNonowner);
currentUser = { id: 1, role: 'owner' }; epoch++; pendingWorkspace = null; decisionError = false;
data = clone(assistantFixture); data.requests[0].body.title = '<img src=x onerror=steal()>'; await workspace.show('access'); assert.match(accessRoot.textContent, /<img src=x onerror=steal\(\)>/); assert.equal(accessRoot.querySelectorAll('img').length, 0, 'Exact imported content is rendered only as text');
await findButton(accessRoot, 'Revoke assistant access').emit('click'); assert.equal(data.assistant, null); assert.match(accessRoot.textContent, /Assistant access revoked/);

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
for (const id of ['assistantNav', 'attestationsNav', 'assistantMenuCard', 'attestationsMenuCard']) assert.match(html, new RegExp(`id="${id}"[^>]*owner-only`));
for (const section of ['assistant', 'attestations']) assert.ok(app.includes(`'${section}'`));
const navigation = app.slice(app.indexOf('const openAssistantReview ='), app.indexOf('const renderAssistantWorkspace ='));
for (const section of ['minutes', 'documents', 'treasury', 'building', 'correspondence', 'profile']) assert.ok(navigation.includes(`'${section}'`));
assert.doesNotMatch(navigation, /method:\s*['"](?:POST|PUT|PATCH|DELETE)|\.click\(|\.sign\(/, 'Review navigation never submits business actions');
assert.match(navigation, /state\.authEpoch === epoch/);
assert.match(app, /assistantWorkspace\?\.dispose\(\)/);
// Execute the actual app review dispatcher against isolated records and existing-flow stubs.
const reviewCalls = [], reviewState = { user: { id: 1, role: 'owner' }, authEpoch: 1, minutes: [], minutesEditorDirty: false };
const ctx = {
  state: reviewState, showWorkspaceSection: (section, options) => { reviewCalls.push(['section', section, options]); return true; },
  apiFetch: async path => {
    reviewCalls.push(['read', path]);
    if (path === '/api/minutes') return { minutes: [{ id: 'm1' }] };
    if (path === '/api/treasury') return { reports: [{ id: 't1', draft: {} }] };
    if (path === '/api/correspondence') return { drafts: [{ id: 'c1' }] };
    if (path === '/api/correspondence/signers') return { signers: [] };
    return { document: { id: 'd1', title: 'Demo document', status: 'pending', signers: [{ user_id: 1 }] } };
  },
  minutesDatesReady: Promise.resolve(), minutesAttendanceReady: Promise.resolve(), minutesMeetingDetailsReady: Promise.resolve(),
  openMinutesEditor: id => reviewCalls.push(['minutes', id]), openSignerModal: async id => reviewCalls.push(['document', id]),
  treasuryWorkspace: { open: record => reviewCalls.push(['treasury', record.id]) },
  correspondenceWorkspace: { bind() {}, open: async record => reviewCalls.push(['correspondence', record.id]) },
  openSignatureSetup: async required => reviewCalls.push(['profile', required]),
  buildingCalendarWorkspace: { building: async () => reviewCalls.push(['building-read']) },
  $: () => ({ querySelectorAll: () => [{ dataset: { id: 'b1' }, closest: () => ({ focus: () => reviewCalls.push(['building-focus']), scrollIntoView() {} }) }] }),
};
vm.runInNewContext(`${navigation}\nglobalThis.run = openAssistantReview;`, ctx);
for (const [section, recordId] of [['minutes','m1'],['documents','d1'],['treasury','t1'],['correspondence','c1'],['building','b1'],['profile',null]]) await ctx.run({ section, recordId });
for (const expected of ['minutes','document','treasury','correspondence','building-focus','profile']) assert.ok(reviewCalls.some(call => call[0] === expected), expected);
assert.equal(reviewCalls.find(call => call[0] === 'profile')[1], false, 'A profile item with no record ID opens the existing optional review');
let resolveRecord; ctx.apiFetch = () => new Promise(resolve => { resolveRecord = resolve; }); const lateReview = ctx.run({ section: 'minutes', recordId: 'm1' });
const priorOpenCount = reviewCalls.filter(call => call[0] === 'minutes').length; reviewState.authEpoch++; resolveRecord({ minutes: [{ id: 'm1' }] }); await lateReview;
assert.equal(reviewCalls.filter(call => call[0] === 'minutes').length, priorOpenCount, 'A late record read cannot open a review in a later account epoch');
const lateNavigation = ctx.run({section:'minutes',recordId:'m1'});
reviewState.assistantReviewEpoch++; resolveRecord({minutes:[{id:'m1'}]}); await lateNavigation;
assert.equal(reviewCalls.filter(call=>call[0]==='minutes').length,priorOpenCount,'A newer navigation cancels an older review read');
ctx.treasuryWorkspace.dirty=true;
await assert.rejects(ctx.run({section:'treasury',recordId:'t1'}),/banking work/);
ctx.treasuryWorkspace.dirty=false;reviewState.minutesSourceDirty=true;
await assert.rejects(ctx.run({section:'minutes',recordId:'m1'}),/meeting source/);
reviewState.minutesSourceDirty=false;
const editDuringRead = ctx.run({section:'treasury',recordId:'t1'});
ctx.treasuryWorkspace.dirty=true;resolveRecord({reports:[{id:'t1'}]});
await assert.rejects(editDuringRead,/banking work/);
console.log('PASS: owner-only Muse scopes, once-only token controls, exact approvals, uncertain outcome reconciliation, personal review-only navigation, changed-record refresh, safe text, and account-epoch isolation.');
