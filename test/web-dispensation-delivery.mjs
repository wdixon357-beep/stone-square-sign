import assert from 'node:assert/strict';
import { renderDispensationSubmission } from '../public/dispensation-submission.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.classList = { add() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatchEvent() {}
}
const descend = node => [node, ...node.children.flatMap(descend)];
const text = node => descend(node).map(child => child.textContent).join('\n');
const originalDocument = globalThis.document;
const originalCustomEvent = globalThis.CustomEvent;
const originalFormData = globalThis.FormData;
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.CustomEvent = class { constructor(name) { this.type = name; } };
globalThis.FormData = class { constructor() { this.fields = []; } append(...field) { this.fields.push(field); } };

async function render(overrides = {}, record = { id: 'synthetic-document', status: 'completed' }) {
  const packet = { automaticDeliveryEnabled: false, state: 'disabled', message: 'Automatic email is disabled.', report: null, draft: null, ...overrides };
  const container = new Element('section');
  const calls = [];
  const previews = [];
  const apiFetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/submission-packet') ? { packet } : { saved: true };
  };
  await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf: (...args) => previews.push(args) });
  return { container, calls, previews };
}

try {
  for (const state of ['disabled', 'failed', 'uncertain', 'sent', 'sending', 'awaiting_signature', 'awaiting_report', 'ready']) {
    const { container, calls } = await render({ state, report: { filename: 'event-proposal.pdf' }, draft: { body: 'Old automatic email draft.', preparedAt: '2026-10-16T13:00:00Z' } });
    assert.match(text(container), /Automatic District Deputy email is turned off/);
    assert.match(text(container), /send them manually from your email client/);
    assert.match(text(container), /Saving a supporting report here does not send email/);
    const buttons = descend(container).filter(node => node.tagName === 'button').map(node => node.textContent);
    assert.ok(buttons.includes('View supporting report'), `Keep the report accessible in ${state}.`);
    assert.ok(!buttons.some(label => /retry|delivered|email both|Confirm already/i.test(label)), `Disabled ${state} must have no send, retry, or delivery confirmation controls.`);
    assert.doesNotMatch(text(container), /will automatically email|will be emailed automatically|Old automatic email draft/);
    assert.ok(calls.every(call => !call.options), 'Rendering never mutates or sends a record.');
  }
  const disabled = await render();
  assert.match(text(disabled.container), /Fully signed dispensation PDF/);
  const save = descend(disabled.container).find(node => node.tagName === 'button' && node.textContent === 'Save supporting report');
  assert.ok(save, 'An unsent disabled packet can retain a supporting report for manual submission.');
  const file = descend(disabled.container).find(node => node.tagName === 'input' && node.type === 'file');
  file.files = [{ name: 'event-proposal.pdf', size: 128 }];
  const form = descend(disabled.container).find(node => node.tagName === 'form');
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(disabled.calls.filter(call => call.options).map(call => [call.url, call.options.method]), [['/api/documents/synthetic-document/supporting-report', 'PUT']], 'Saving a report only saves that report; no submit or resolution call is made.');

  const unsigned = await render({}, { id: 'unsigned', status: 'pending' });
  assert.match(text(unsigned.container), /awaiting secretary signature/);
  assert.doesNotMatch(text(unsigned.container), /Fully signed dispensation PDF/);

  const stale = await render({ automaticDeliveryEnabled: undefined, state: 'failed' });
  assert.match(text(stale.container), /Automatic District Deputy email is turned off/, 'A missing capability flag fails closed.');
  assert.ok(!descend(stale.container).some(node => node.textContent === 'Retry delivery of both PDFs'));
  for (const state of ['disabled', 'awaiting_signature', 'awaiting_report', 'ready']) {
    const oldBackend = await render({ automaticDeliveryEnabled: undefined, state });
    assert.ok(!descend(oldBackend.container).some(node => node.tagName === 'form'), 'An older server must not auto-send through an upload presented as saving.');
  }
  const locked = await render({ reportLocked: true });
  assert.ok(!descend(locked.container).some(node => node.tagName === 'form'), 'A previously prepared packet remains immutable while email is off.');

  const historical = await render({ state: 'sent', report: { filename: 'event-proposal.pdf' } });
  const view = descend(historical.container).find(node => node.tagName === 'button' && node.textContent === 'View supporting report');
  await view.listeners.click();
  assert.equal(historical.previews.length, 1, 'A historical supporting report still opens for download and review.');
  assert.equal(historical.previews[0][1], 'event-proposal.pdf');
  assert.ok(!descend(historical.container).some(node => node.tagName === 'form'), 'Historical submitted reports remain immutable.');
  console.log('Web dispensation delivery checks passed: disabled controls, manual instructions, report saving, historical access, signature labels, and fail-closed capability.');
} finally {
  globalThis.document = originalDocument;
  globalThis.CustomEvent = originalCustomEvent;
  globalThis.FormData = originalFormData;
}
