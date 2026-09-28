import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('let duesSubmissionId = null;');
const end = app.indexOf("$('suggestionForm').addEventListener", start);
assert.ok(start >= 0 && end > start, 'the dues entry handlers must be present');

const storage = new Map();
const postCalls = [];
let uuidCalls = 0;
let readbackSucceeds = false;
let rejectNext = false;
let confirmRetry = false;
const confirmations = [];

const createPage = () => {
  const handlers = {};
  const messages = [];
  const elements = Object.fromEntries([
    'duesAdjustmentForm', 'duesStartNewEntry', 'duesAdjustmentBrother', 'duesAdjustmentType',
    'duesAdjustmentAmount', 'duesAdjustmentDate', 'duesAdjustmentMethod',
    'duesAdjustmentReference', 'duesAdjustmentNote', 'duesAssistText', 'duesAssistReview',
    'duesAssistMessage', 'duesAdjustmentMessage',
  ].map(id => [id, {
    value: '',
    addEventListener(type, handler) { handlers[`${id}:${type}`] = handler; },
    reset() { this.resetCount = (this.resetCount || 0) + 1; },
    classList: { add() {} },
    replaceChildren() {},
  }]));
  Object.assign(elements.duesAdjustmentBrother, { value: '1' });
  Object.assign(elements.duesAdjustmentType, { value: 'payment' });
  Object.assign(elements.duesAdjustmentAmount, { value: '100.00' });
  Object.assign(elements.duesAdjustmentDate, { value: '2026-09-18' });
  Object.assign(elements.duesAdjustmentMethod, { value: 'Check' });
  const state = { user: { id: 7 }, duesLoaded: true, duesLedger: { rows: [{ rosterId: 1, payments: [] }] } };
  const context = {
    $: id => elements[id],
    window: { crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCalls).padStart(12, '0')}` }, confirm: message => { confirmations.push(message); return confirmRetry; } },
    state,
    duesAssistProposal: null,
    duesTodayEastern: () => '2026-09-28',
    draftStorageKey: name => `user-7:${name}`,
    clearSessionDraft: name => storage.delete(`user-7:${name}`),
    sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) || null },
    canManageDues: () => true,
    setMessage: (element, value, error) => messages.push({ element, value, error }),
    apiFetch: async (_path, options) => {
      postCalls.push(JSON.parse(options.body));
      if (rejectNext) { rejectNext = false; throw Object.assign(new Error('Invalid amount.'), { status: 400 }); }
      if (postCalls.length === 1) throw new Error('Connection interrupted');
      return { id: 42, replayed: true };
    },
    renderDues: async () => {
      state.duesLedger = { rows: [{ rosterId: 1, payments: readbackSucceeds ? [{ adjustmentId: 42 }] : [] }] };
      state.duesLoaded = true;
    },
  };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.restoreDuesEntryDraftForTest = restoreDuesEntryDraft;`, context);
  const submit = async () => handlers['duesAdjustmentForm:submit']({
    preventDefault() {}, submitter: { disabled: false },
  });
  const startNew = async () => handlers['duesStartNewEntry:click']({ currentTarget: elements.duesStartNewEntry });
  return { elements, messages, context, submit, startNew };
};

let page = createPage();
await page.submit();
assert.equal(page.elements.duesAdjustmentForm.resetCount || 0, 0, 'uncertain write must preserve the form');
assert.ok(storage.has('user-7:dues-entry'), 'uncertain write must survive a page reload');
const firstId = postCalls[0].clientSubmissionId;

await page.startNew();
assert.equal(postCalls.length, 1, 'declining the explicit retry cannot record another payment');
assert.match(confirmations.at(-1), /may record that payment now/);
confirmRetry = true;
await page.startNew();
assert.equal(postCalls[1].clientSubmissionId, firstId, 'Start New Entry must replay the prior submission ID');
assert.equal(page.elements.duesAdjustmentForm.resetCount || 0, 0, 'failed readback must block a new entry');
assert.ok(storage.has('user-7:dues-entry'), 'failed readback must keep the pending submission');

page = createPage();
page.context.restoreDuesEntryDraftForTest();
assert.equal(page.elements.duesAdjustmentAmount.value, '100.00', 'reload must restore the exact payment details');
assert.match(page.messages.at(-1).value, /previous payment needs confirmation/);
readbackSucceeds = true;
await page.startNew();
assert.equal(postCalls[2].clientSubmissionId, firstId, 'reload must replay the original submission ID');
assert.equal(page.elements.duesAdjustmentForm.resetCount, 1, 'confirmed entry may finally reset the form');
assert.equal(storage.has('user-7:dues-entry'), false, 'confirmed entry must clear the pending submission');

await page.submit();
assert.notEqual(postCalls[3].clientSubmissionId, firstId, 'a verified new entry must have a fresh submission ID');

const invalid = createPage();
rejectNext = true;
await invalid.submit();
assert.equal(storage.has('user-7:dues-entry'), false, 'a definitive validation rejection must unlock corrected details');
assert.match(invalid.messages.at(-1).value, /Correct the details and try again/);
console.log('Web Dues Submission: uncertain response, Start New Entry gate, reload replay, and validation recovery passed.');
