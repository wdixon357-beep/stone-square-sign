import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDispensationSubmission, safeMissiveDraftURL } from '../public/dispensation-submission.js';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {};
    this.attributes = {}; this.textContent = ''; this.classList = { add() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatchEvent() {}
}
const descend = node => [node, ...node.children.flatMap(descend)];
const text = node => descend(node).map(child => child.textContent).join('\n');
const buttons = node => descend(node).filter(child => child.tagName === 'button');
const draftURL = 'https://mail.missiveapp.com/#inbox/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fixture = {
  automaticDeliveryEnabled: false, state: 'disabled', message: 'Automatic email sending is off.',
  recipient: { name: 'District Deputy Fixture', to: 'deputy@example.invalid' },
  report: { filename: 'Corresponding event proposal fixture.pdf', sha256: 'synthetic-hash' },
  draft: { filename: 'Signed dispensation fixture.pdf' },
};
const originalDocument = globalThis.document;
const originalCustomEvent = globalThis.CustomEvent;
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.CustomEvent = class { constructor(name) { this.type = name; } };

async function render(draft, options = {}) {
  let packet = { ...fixture, ...options.packet, missiveDraft: draft };
  const calls = [];
  const container = new Element('section');
  const apiFetch = async (url, request) => {
    calls.push({ url, request });
    if (request) {
      if (options.retryError) {
        if (options.afterRetry) packet = { ...packet, missiveDraft: options.afterRetry };
        throw new Error('Synthetic lost response');
      }
      packet = { ...packet, missiveDraft: options.afterRetry || { state: 'pending', canRetry: false } };
    }
    return { packet };
  };
  await renderDispensationSubmission(container, {
    document: { id: 'synthetic', status: 'completed' }, apiFetch, previewPdf() {},
  });
  return { container, calls };
}

try {
  for (const state of ['not_requested', 'not_configured', 'awaiting_signature', 'awaiting_report', 'pending', 'creating', 'uncertain', 'failed', 'unknown']) {
    const { container, calls } = await render({ state, url: draftURL, canRetry: true });
    assert.ok(!descend(container).some(node => node.tagName === 'a'), `${state} must never claim a saved draft is available.`);
    assert.doesNotMatch(text(container), /Missive draft saved for your review/);
    assert.equal(buttons(container).some(node => node.textContent === 'Try creating the draft again'), state === 'failed');
    assert.ok(calls.every(call => !call.request), 'Viewing draft state is read only.');
    assert.ok(!buttons(container).some(node => /^send\b|retry delivery|email both/i.test(node.textContent)), 'No send controls are shown.');
  }

  const historical = await render({ state: 'not_requested', canRetry: false });
  assert.match(text(historical.container), /No Missive draft was requested/);
  assert.match(text(historical.container), /This earlier completed dispensation has no automatic draft request/);
  assert.doesNotMatch(text(historical.container), /prepares an unsent Missive draft|This draft is for your review|Once both documents are ready/);
  assert.ok(!buttons(historical.container).some(node => /creat|retry/i.test(node.textContent)), 'Earlier records cannot initiate a backfill draft.');

  const ready = await render({
    state: 'drafted', url: draftURL, draftId: 'fixture-draft', canRetry: false,
    subject: 'Dispensation and corresponding event proposal',
    body: 'Please review the attached dispensation and corresponding report.\nThank you.',
    createdAt: '2026-10-21T18:20:00Z',
  });
  assert.match(text(ready.container), /Missive draft saved for your review/);
  assert.match(text(ready.container), /You choose when to send it in Missive/);
  assert.match(text(ready.container), /Subject: Dispensation and corresponding event proposal/);
  assert.match(text(ready.container), /Please review the attached/);
  assert.match(text(ready.container), /Corresponding event proposal fixture.pdf/);
  assert.match(text(ready.container), /Signed dispensation fixture.pdf/);
  const open = descend(ready.container).find(node => node.tagName === 'a');
  assert.equal(open.href, draftURL);
  assert.equal(open.rel, 'noopener noreferrer');
  assert.equal(open.target, '_blank');
  assert.ok(!buttons(ready.container).some(node => node.textContent.includes('Try creating')));
  const selectedFile = descend(ready.container).find(node => node.tagName === 'input');
  selectedFile.files = [{ name: 'Selected report fixture.pdf', size: 128 }];
  selectedFile.listeners.change();
  assert.equal(buttons(ready.container).find(node => node.textContent === 'Refresh draft status').disabled, true,
    'A status refresh cannot discard a selected report.');
  selectedFile.files = [];
  selectedFile.listeners.change();
  assert.equal(buttons(ready.container).find(node => node.textContent === 'Refresh draft status').disabled, false);

  for (const state of ['failed', 'uncertain', 'sent']) {
    const staleSend = await render({ state: 'not_configured' }, { packet: { state, automaticDeliveryEnabled: true } });
    assert.ok(!buttons(staleSend.container).some(node => /send|delivery|delivered|email both/i.test(node.textContent)),
      'A stale enabled-delivery response cannot restore sending controls.');
    assert.ok(!descend(staleSend.container).some(node => node.tagName === 'form'));
  }

  for (const url of [
    'http://mail.missiveapp.com/', 'javascript:alert(1)', '//mail.missiveapp.com/',
    'https://mail.missiveapp.com.evil.invalid/', 'https://evil.invalid/?next=mail.missiveapp.com',
    'https://username:password@mail.missiveapp.com/', 'https://mail.missiveapp.com:444/',
    'https://missiveapp.com/', 'not a URL', '',
  ]) {
    assert.equal(safeMissiveDraftURL({ state: 'drafted', url }), null, `Reject untrusted draft URL ${url}`);
  }
  assert.equal(safeMissiveDraftURL({ state: 'pending', url: draftURL }), null);
  assert.equal(safeMissiveDraftURL({ state: 'drafted', url: draftURL }), draftURL);
  const noLink = await render({ state: 'drafted', url: 'https://evil.invalid/' });
  assert.match(text(noLink.container), /its direct link is unavailable/);
  assert.ok(!descend(noLink.container).some(node => node.tagName === 'a'));

  const retry = await render({ state: 'failed', canRetry: true });
  await buttons(retry.container).find(node => node.textContent === 'Try creating the draft again').listeners.click();
  assert.deepEqual(retry.calls.filter(call => call.request), [{
    url: '/api/documents/synthetic/missive-draft/retry', request: { method: 'POST', body: '{}' },
  }]);
  assert.match(text(retry.container), /Missive draft is queued/);

  const verify = await render({ state: 'uncertain', canRetry: true, draftId: '11111111-1111-4111-8111-111111111111' });
  const verifyButton = buttons(verify.container).find(node => node.textContent === 'Verify existing Missive draft');
  assert.ok(verifyButton, 'A known draft can be checked without creating a replacement.');
  assert.ok(!buttons(verify.container).some(node => node.textContent === 'Try creating the draft again'));
  await verifyButton.listeners.click();
  assert.equal(verify.calls.filter(call => call.request).length, 1);
  assert.match(verify.calls.find(call => call.request).url, /missive-draft\/retry$/);
  const noReceipt = await render({ state: 'uncertain', canRetry: true });
  assert.ok(!buttons(noReceipt.container).some(node => /Verify existing|Try creating/.test(node.textContent)));
  const staleFailure = await render({ state: 'failed', canRetry: true, draftId: '11111111-1111-4111-8111-111111111111' });
  assert.ok(!buttons(staleFailure.container).some(node => /Try creating/.test(node.textContent)));

  const uncertain = await render({ state: 'failed', canRetry: true }, {
    retryError: true, afterRetry: { state: 'uncertain', canRetry: false },
  });
  await buttons(uncertain.container).find(node => node.textContent === 'Try creating the draft again').listeners.click();
  assert.match(text(uncertain.container), /Draft creation needs verification/);
  assert.ok(!buttons(uncertain.container).some(node => node.textContent.includes('Try creating')));
  const lost = await render({ state: 'failed', canRetry: true }, { retryError: true });
  const attempt = buttons(lost.container).find(node => node.textContent === 'Try creating the draft again');
  await attempt.listeners.click();
  assert.equal(attempt.disabled, true, 'An ambiguous response cannot enable a blind second creation.');
  assert.match(text(lost.container), /Refresh draft status before trying again/);

  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf("if (state.user?.role === 'owner' && doc.status !== 'rescinded'");
  const end = app.indexOf('/* Only worth offering', start);
  assert.ok(start >= 0 && app.slice(start, end).includes('renderDispensationSubmission'), 'The packet entry remains owner only.');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dispensation-delivery pre \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.button-link \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.dispensation-delivery \{[^}]*min-width: 0;/);
  console.log('PASS: owner Missive draft states, read-only rendering, link validation, duplicate prevention, and wrapping rules.');
} finally {
  globalThis.document = originalDocument;
  globalThis.CustomEvent = originalCustomEvent;
}
