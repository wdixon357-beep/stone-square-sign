const endpoint = '/api/assistant/signature-requests';
const labels = {
  pending: 'Awaiting your authorization', processing: 'Application in progress',
  completed: 'Signature applied', declined: 'Declined', expired: 'Expired',
  stale: 'Document or signing requirements changed', uncertain: 'Outcome unverified',
};
export const signatureRequestStatus = status => labels[status] || 'Outcome unverified';
export const validSignatureRequestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const dateText = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not recorded';
};
const node = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = String(value ?? '');
  if (className) element.className = className;
  return element;
};
const button = (label, action, className = 'secondary') => {
  const element = node('button', label, className); element.type = 'button';
  element.dataset.signatureFocus = label;
  element.addEventListener('click', action); return element;
};
const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');

/** Human-session confirmation only. Opening, reading and previewing never authorize a signature. */
export class SignatureAuthorization {
  constructor({ api, user, context, root, onOpen, onClose, now = () => Date.now(), hash = digest, urls = URL, previewFactory = async container => { const { MinutesPreview } = await import('./minutes-preview.js'); return new MinutesPreview(container); } }) {
    Object.assign(this, { api, user, context, root, onOpen, onClose, now, hash, urls, previewFactory });
    this.sequence = 0; this.attempts = new Set(); this.busy = false; this.previewURL = '';
  }
  ownerContext() { return this.user()?.role === 'owner' ? this.context() : null; }
  current(context, sequence) { return context !== null && context === this.ownerContext() && sequence === this.sequence; }
  clearPreview() {
    this.clearRenderer(); this.previewBlob = null;
    if (this.previewURL) this.urls.revokeObjectURL(this.previewURL);
    this.previewURL = ''; this.previewVerified = false;
  }
  clearRenderer() {
    this.previewRenderSequence = (this.previewRenderSequence || 0) + 1;
    this.previewRenderer?.resize?.disconnect();
    void this.previewRenderer?.clear().catch(() => {});
    this.previewRenderer = null; this.previewRendered = false;
  }
  close() {
    this.sequence++; this.clearPreview(); clearTimeout(this.expiryTimer);
    this.request = null; this.root.replaceChildren(); this.onClose();
  }
  dispose() { this.close(); this.attempts.clear(); this.operation = null; this.busy = false; }
  expired(request) { const expiry = Date.parse(request?.expiresAt); return !Number.isFinite(expiry) || expiry <= this.now(); }
  canAuthorize(request) {
    return this.ownerContext() !== null && request?.status === 'pending' && request.ready === true
      && !this.expired(request) && typeof request.fingerprint === 'string' && Boolean(request.fingerprint.trim()) && /^[a-f0-9]{64}$/i.test(request.artifactSHA256 || '')
      && typeof request.statement === 'string' && Boolean(request.statement.trim())
      && Array.isArray(request.effects) && request.effects.length > 0 && this.previewVerified && (!this.previewFactory || this.previewRendered)
      && !this.attempts.has(request.id) && !this.busy;
  }
  shell(title = 'Signature authorization') {
    const focused = document.activeElement;
    const focus = this.root.contains(focused) ? { key: focused?.dataset?.signatureFocus } : null;
    this.root.replaceChildren();
    const body = node('div', undefined, 'modal-body signature-authorization-body');
    const head = node('div', undefined, 'signature-authorization-head');
    const heading = node('h2', title); heading.id = 'signatureAuthorizationTitle';
    head.append(heading, button('Close', () => this.close(), 'secondary modal-close signature-authorization-close')); body.append(head);
    this.message = node('p', '', 'message'); this.message.setAttribute('role', 'status'); this.message.setAttribute('aria-live', 'polite');
    body.append(this.message); this.root.append(body); this.body = body;
    this.restoreFocus(focus);
    return focus;
  }
  restoreFocus(focus) {
    if (!focus) return;
    const controls = [...this.root.querySelectorAll('button, a, summary, [tabindex]')];
    const target = controls.find(control => control.dataset.signatureFocus === focus.key && !control.disabled)
      || controls.find(control => control.dataset.signatureFocus === 'Close');
    target?.focus({ preventScroll: true });
  }
  async open(id) {
    const context = this.ownerContext(), sequence = ++this.sequence;
    this.clearPreview(); clearTimeout(this.expiryTimer); this.request = null;
    this.shell(); this.onOpen();
    if (context === null) { this.message.textContent = 'Sign in with the owner account to open this confirmation. This link does not grant account access.'; return; }
    if (!validSignatureRequestId(id)) { this.message.textContent = 'This signature confirmation link is invalid. Ask Muse for the current request link.'; return; }
    this.message.textContent = 'Loading the exact document and authorization…';
    this.root.setAttribute('aria-busy', 'true');
    try {
      const result = await this.api(`${endpoint}/${encodeURIComponent(id)}`);
      if (!this.current(context, sequence)) return;
      const request = result?.request;
      if (!request || request.id !== id) throw new Error('The requested confirmation could not be verified.');
      this.request = request; this.render(request);
      if (request.status === 'pending' && request.ready === true && !this.expired(request)) {
        this.message.textContent = 'Checking the frozen document preview…';
        try {
          const blob = await this.api(`${endpoint}/${encodeURIComponent(id)}/preview`);
          if (!this.current(context, sequence)) return;
          if (!(blob instanceof Blob) || !/^application\/pdf(?:;|$)/i.test(blob.type)) throw new Error('The frozen PDF preview could not be verified.');
          const actual = await this.hash(blob);
          if (!this.current(context, sequence)) return;
          if (actual !== String(request.artifactSHA256).toLowerCase()) throw new Error('The preview does not match this authorization. Close it and ask Muse for a current request.');
          this.previewURL = this.urls.createObjectURL(blob); this.previewBlob = blob; this.previewVerified = true;
          this.render(request);
        } catch (error) {
          if (!this.current(context, sequence)) return;
          this.previewVerified = false; this.message.textContent = error.message || 'The frozen PDF preview could not load. No signature has been authorized.';
        }
      }
    } catch (error) {
      if (!this.current(context, sequence)) return;
      this.shell(); this.message.textContent = error.status === 403 || error.status === 404
        ? 'This confirmation is not available to the signed-in owner account. Check the request and account with Muse.'
        : error.message || 'This confirmation could not load. No signature has been authorized.';
      this.body.append(button('Check request status', () => this.open(id)));
    } finally { if (this.current(context, sequence)) this.root.removeAttribute('aria-busy'); }
  }
  render(request, message = '', focusAfterAction = null) {
    this.clearRenderer();
    const focus = this.shell(request.title || 'Signature authorization');
    const status = node('p', signatureRequestStatus(request.status), 'signature-authorization-status'); this.body.append(status);
    this.body.append(node('p', `Muse requested this signature. You are signed in as ${this.user()?.name || 'the owner'}.`, 'helper'));
    if (request.reason) this.body.append(node('p', request.reason, 'signature-authorization-reason'));
    const facts = node('dl', undefined, 'signature-authorization-facts');
    const record = request.recordId === 'new-dispensation' && request.actionId === 'owner.dispensation-sign' ? 'New document' : request.recordId || 'Unverified';
    for (const [label, value] of [['Signing as', request.signingRole || 'Unverified'], ['Record', record], ['Expires', dateText(request.expiresAt)]]) {
      facts.append(node('dt', label), node('dd', value));
    }
    this.body.append(facts);
    if (request.statement) this.body.append(node('h3', 'Your exact statement'), node('blockquote', request.statement, 'assistant-attestation-text'));
    if (request.effects?.length) {
      const effects = node('ul', undefined, 'assistant-effects'); for (const effect of request.effects) effects.append(node('li', effect));
      this.body.append(node('h3', 'What this action does'), effects);
    }
    if (this.previewURL) {
      const preview = node('section', undefined, 'signature-authorization-preview'); preview.append(node('h3', 'Exact document'));
      const link = node('a', 'Open exact PDF in another tab', 'text-link'); link.href = this.previewURL; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.dataset.signatureFocus = 'pdf';
      preview.append(link);
      if (this.previewFactory) {
        this.previewContainer = node('div', undefined, 'minutes-pdf-pages signature-frozen-preview'); this.previewContainer.setAttribute('aria-label', 'Frozen document for this signature authorization'); this.previewContainer.setAttribute('role', 'region'); this.previewContainer.tabIndex = 0;
        this.previewContainer.dataset.signatureFocus = 'preview';
        preview.append(this.previewContainer);
      } else {
        const frame = node('iframe', undefined, 'pdf-frame'); frame.title = 'Frozen document for this signature authorization'; frame.src = this.previewURL; preview.append(frame);
      }
      this.body.append(preview);
    }
    if (request.artifactSHA256) {
      const identity = node('details'), summary = node('summary', 'Document verification'); summary.dataset.signatureFocus = 'verification'; identity.append(summary);
      identity.append(node('p', this.previewVerified ? 'The displayed PDF matches the document bound to this authorization.' : 'The frozen PDF has not been verified in this view.', 'helper'));
      identity.append(node('p', `SHA256 ${request.artifactSHA256}`, 'signature-document-digest')); this.body.append(identity);
    }
    if (request.receipt) this.renderReceipt(request.receipt);
    if (request.status === 'pending') {
      if (this.expired(request)) this.body.append(node('p', 'This authorization has expired. Ask Muse for a new request after checking the current document.', 'signature-authorization-reason'));
      else if (this.attempts.has(request.id)) this.body.append(node('p', 'An application attempt has already been made. Check its saved status before any further action. It will not be repeated here.', 'signature-authorization-reason'));
      else this.body.append(node('p', 'By selecting “Authorize and apply signature,” you confirm your statement above and authorize the listed effects for this exact document. The system applies your saved signature and records your authorization.', 'signature-authorization-consent'));
    } else if (['processing', 'uncertain'].includes(request.status) || !Object.hasOwn(labels, request.status)) {
      this.body.append(node('p', 'Do not request another signature for this record while the result is unverified. Check the recorded status and receipt.', 'signature-authorization-reason'));
    }
    const controls = node('div', undefined, 'row-buttons signature-authorization-actions');
    if (request.status === 'pending') {
      this.authorizeButton = button('Authorize and apply signature', () => this.decide('confirm'), 'primary'); this.authorizeButton.disabled = !this.canAuthorize(request);
      const decline = button('Decline', () => this.decide('decline')); decline.disabled = this.busy || this.attempts.has(request.id) || this.expired(request);
      controls.append(this.authorizeButton, decline);
    }
    const refresh = button('Check request status', () => this.open(request.id)); refresh.disabled = this.busy; controls.append(refresh);
    this.body.append(controls, this.message); this.message.textContent = message;
    this.restoreFocus(focus || focusAfterAction);
    if (this.previewURL && this.previewFactory) void this.renderPreview();
    if (request.status === 'pending' && !this.expired(request)) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(() => { if (this.request === request && this.authorizeButton) { this.authorizeButton.disabled = true; this.message.textContent = 'This authorization has expired. No further action can be submitted here.'; } }, Math.min(2147483647, Math.max(1, Date.parse(request.expiresAt) - this.now())));
    }
  }
  async renderPreview() {
    const context = this.ownerContext(), sequence = this.sequence, renderSequence = this.previewRenderSequence, container = this.previewContainer, blob = this.previewBlob;
    const current = () => this.current(context, sequence) && this.previewRenderSequence === renderSequence;
    try {
      const renderer = await this.previewFactory(container);
      if (!current()) { renderer.resize?.disconnect(); await renderer.clear(); return; }
      this.previewRenderer = renderer;
      let renderingFailed = false;
      container.addEventListener('previewerror', () => {
        if (!current()) return;
        renderingFailed = true;
        this.previewRendered = false; if (this.authorizeButton) this.authorizeButton.disabled = true;
        this.message.textContent = 'The document preview could not finish. Check request status to reload it before authorizing.';
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!current()) return;
      await renderer.show(bytes);
      if (!current()) return;
      if (renderingFailed) throw new Error('The frozen document did not finish rendering.');
      this.previewRendered = true;
      if (this.authorizeButton && this.request?.status === 'pending') this.authorizeButton.disabled = !this.canAuthorize(this.request);
    } catch {
      if (!current()) return;
      this.previewRendered = false; if (this.authorizeButton) this.authorizeButton.disabled = true;
      this.message.textContent = 'The document preview could not load. Check request status to reload it before authorizing.';
    }
  }
  renderReceipt(receipt) {
    const section = node('section', undefined, 'signature-authorization-receipt'); section.append(node('h3', 'Recorded outcome'));
    if (receipt.requestedBy?.name) section.append(node('p', `Requested by ${receipt.requestedBy.name}.`));
    const delegated = receipt.authorization?.source === 'owner_delegation';
    if (delegated) {
      section.append(node('p', receipt.executedBy?.type === 'assistant' ? 'Executed by Muse under your saved delegation.' : 'Authorized under your saved delegation. The executor is not recorded.'));
      if (receipt.authorizedBy?.name) section.append(node('p', `Delegation granted by ${receipt.authorizedBy.name}.`));
      section.append(node('p', 'Your instruction was relayed by Muse. No separate Dashboard confirmation is recorded.', 'helper'));
    } else if (receipt.executedBy?.type === 'assistant') section.append(node('p', 'Executed by Muse. The authorization source is unverified.'));
    else if (receipt.authorizedBy?.name) section.append(node('p', `Authorized by ${receipt.authorizedBy.name}.`));
    if (receipt.appliedBy === 'system') section.append(node('p', `Applied by the system${receipt.completedAt ? ` on ${dateText(receipt.completedAt)}` : ''}.`));
    if (receipt.notificationState) section.append(node('p', `Notifications: ${receipt.notificationState}.`));
    for (const warning of receipt.notificationWarnings || []) section.append(node('p', warning, 'signature-authorization-reason'));
    section.append(node('p', 'Muse can read this receipt. Another signature is not automatically attempted.', 'helper')); this.body.append(section);
  }
  async decide(action) {
    if (!['confirm', 'decline'].includes(action)) return;
    const request = this.request, context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy || request?.status !== 'pending' || this.expired(request) || this.attempts.has(request.id)) return;
    if (action === 'confirm' && !this.canAuthorize(request)) return;
    const focused = document.activeElement;
    const actionFocus = this.root.contains(focused) ? { key: focused?.dataset?.signatureFocus } : null;
    const operation = Symbol(); this.operation = operation;
    this.busy = true; this.attempts.add(request.id);
    for (const control of this.body.querySelectorAll('button')) if (control.textContent !== 'Close') control.disabled = true;
    this.message.textContent = action === 'confirm' ? 'Recording your authorization and applying this signature once…' : 'Recording your decision…';
    let saved, outcomeMessage = '';
    try {
      const result = await this.api(`${endpoint}/${encodeURIComponent(request.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'confirm' ? { fingerprint: request.fingerprint, consent: true } : {}) });
      saved = result?.request;
      if (!saved || saved.id !== request.id) throw new Error('The response did not verify this request.');
    } catch (error) {
      if (!this.current(context, sequence)) return;
      outcomeMessage = 'The action response was interrupted. Its saved status was checked without repeating the action.';
      try { saved = (await this.api(`${endpoint}/${encodeURIComponent(request.id)}`))?.request; }
      catch { saved = null; }
      if (!saved || saved.id !== request.id || saved.status === 'pending') {
        saved = { ...request, status: 'uncertain', ready: false };
        outcomeMessage = 'The action outcome is unverified. Check request status; no signature or decision will be retried here.';
      }
    } finally { if (this.operation === operation) this.busy = false; }
    if (!this.current(context, sequence)) return;
    const focusAfterAction = document.activeElement === document.body ? actionFocus : null;
    this.request = saved; this.render(saved, outcomeMessage, focusAfterAction);
  }
}
