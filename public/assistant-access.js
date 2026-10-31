const MODE_LABELS = {
  standing: 'Standing permission', approval: 'Ask me first',
  personal: 'My own action', unavailable: 'Unavailable',
};
const STATUS_LABELS = {
  pending: 'Awaiting your decision', approved: 'Approved, awaiting execution',
  executing: 'Execution in progress', completed: 'Completed', declined: 'Declined',
  stale: 'Changed, review again', expired: 'Expired', revoked: 'Access revoked',
  failed: 'Failed', unknown: 'Outcome unverified', uncertain: 'Outcome unverified',
  queued: 'Awaiting your review', personal: 'Requires your own action',
};
const text = value => String(value ?? '');
const dateText = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not recorded';
};
const node = (tag, content, className) => {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = text(content);
  if (className) element.className = className;
  return element;
};
const button = (label, handler, className = 'secondary') => {
  const element = node('button', label, className); element.type = 'button';
  element.addEventListener('click', handler); return element;
};
const notice = () => { const element = node('p', '', 'message'); element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite'); return element; };
const effectsList = effects => {
  const list = node('ul', undefined, 'assistant-effects');
  for (const effect of Array.isArray(effects) ? effects : []) list.append(node('li', effect));
  return list;
};
const statusText = status => STATUS_LABELS[status] || text(status || 'Unverified').replaceAll('_', ' ');

/** An owner-only workspace. All signing remains in the existing human review flows. */
export class AssistantWorkspace {
  constructor({ api, user, context, accessRoot, attestationsRoot, openReview, confirm = message => window.confirm(message), clipboard = () => navigator.clipboard }) {
    Object.assign(this, { api, user, context, accessRoot, attestationsRoot, openReview, confirm, clipboard });
    this.sequence = 0; this.mode = null; this.dirty = false; this.busy = false; this.token = '';
  }
  ownerContext() { return this.user()?.role === 'owner' ? this.context() : null; }
  current(context, sequence = this.sequence) { return context !== null && context === this.ownerContext() && sequence === this.sequence; }
  clearToken() {
    this.token = '';
    if (this.tokenOutput) this.tokenOutput.value = '';
    this.tokenRegion?.replaceChildren(); this.tokenOutput = null;
  }
  leave() { this.sequence++; this.mode = null; this.clearToken(); }
  dispose() {
    this.leave(); this.dirty = false; this.busy = false; this.data = null;
    this.accessRoot.replaceChildren(); this.attestationsRoot.replaceChildren();
  }
  async show(mode) {
    if (this.ownerContext() === null) { this.dispose(); return; }
    if (this.mode !== mode) this.clearToken();
    this.mode = mode;
    if (mode === 'access' && this.dirty && this.accessRoot.childElementCount) return;
    await this.load();
  }
  async load({ message = '' } = {}) {
    const context = this.ownerContext(), sequence = ++this.sequence, mode = this.mode;
    if (context === null || !mode) return;
    const root = mode === 'access' ? this.accessRoot : this.attestationsRoot;
    root.setAttribute('aria-busy', 'true');
    const loading = notice(); loading.textContent = 'Loading current records…'; root.replaceChildren(loading);
    try {
      const data = await this.api(mode === 'access' ? '/api/assistant/workspace' : '/api/assistant/attestations');
      if (!this.current(context, sequence) || this.mode !== mode) return;
      if (mode === 'access') { this.data = data; this.renderAccess(data); }
      else this.renderAttestations(data.attestations || []);
      if (message) this.message.textContent = message;
    } catch (error) {
      if (!this.current(context, sequence)) return;
      root.replaceChildren(); const errorMessage = notice(); errorMessage.classList.add('error');
      errorMessage.textContent = error.message || 'The current records could not load.';
      root.append(errorMessage, button('Try loading again', () => this.load()));
    } finally { if (this.current(context, sequence)) root.removeAttribute('aria-busy'); }
  }
  heading(root, title, description) {
    const head = node('div', undefined, 'content-head'); const copy = node('div');
    copy.append(node('h1', title), node('p', description));
    const refresh = button('Refresh', () => {
      if (this.dirty && !this.confirm('Discard your unsaved Muse access changes and reload the saved settings?')) return;
      this.dirty = false; this.clearToken(); void this.load();
    });
    head.append(copy, refresh); root.append(head); this.message = notice(); root.append(this.message);
  }
  renderAccess(data) {
    const root = this.accessRoot; this.clearToken(); root.replaceChildren(); this.dirty = false;
    this.heading(root, 'Muse Assistant', 'Choose what Muse can prepare, review requests, and keep your signatures and attestations in your own hands.');
    const boundary = node('div', undefined, 'assistant-boundary');
    boundary.append(node('strong', 'Your own tap is always required'), node('p', 'Muse uses separate access. It cannot sign, attest, apply your saved signature, or take over your account. Your existing officer and record safeguards still apply.'));
    root.append(boundary);
    const assistant = data.assistant;
    const form = node('form', undefined, 'assistant-access-form');
    const settings = node('section', undefined, 'assistant-settings'); settings.append(node('h2', 'Access settings'));
    const nameLabel = node('label', 'Assistant name'); const name = node('input'); name.type = 'text'; name.maxLength = 80; name.required = true; name.value = assistant?.name || 'Muse'; nameLabel.append(name);
    const expiryLabel = node('label', 'Access expires after'); const expiry = node('select');
    for (let day = 1; day <= 30; day++) { const option = node('option', `${day} ${day === 1 ? 'day' : 'days'}`); option.value = String(day); expiry.append(option); }
    expiry.value = '7'; expiryLabel.append(expiry);
    const enabledLabel = node('label', undefined, 'assistant-check'); const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(assistant?.enabled); enabledLabel.append(enabled, node('span', 'Enable this assistant access'));
    settings.append(nameLabel, expiryLabel, enabledLabel);
    settings.append(node('p', assistant ? `Saved access: ${assistant.enabled ? 'enabled' : 'disabled'}. Expires ${dateText(assistant.expiresAt)}.` : 'No assistant access has been saved.', 'helper'));
    settings.append(node('p', 'Saving starts a new expiration period. Token creation is a separate action. Neither step proves that Muse has connected.', 'helper'));
    const catalog = node('section', undefined, 'assistant-catalog'); catalog.append(node('h2', 'Worshipful Master capabilities'));
    catalog.append(node('p', 'Select standing work Muse may do and changes it may ask you to approve. Personal actions remain available to you in My Attestations.'));
    const selected = new Set(assistant?.permissions || []), groups = new Map();
    for (const capability of data.capabilities || []) {
      const group = capability.group || 'Other capabilities';
      if (!groups.has(group)) groups.set(group, []); groups.get(group).push(capability);
    }
    const permissionInputs = [];
    for (const [group, capabilities] of groups) {
      const details = node('details', undefined, 'assistant-capability-group'); details.open = true;
      details.append(node('summary', `${group} (${capabilities.length})`));
      for (const capability of capabilities) {
        const row = node('div', undefined, 'assistant-capability'); const label = node('label', undefined, 'assistant-check');
        const copy = node('span'); copy.append(node('strong', capability.label || capability.id), node('span', MODE_LABELS[capability.mode] || 'Unavailable', `assistant-mode assistant-mode-${capability.mode}`));
        if (['standing', 'approval'].includes(capability.mode)) {
          const input = node('input'); input.type = 'checkbox'; input.value = capability.id; input.checked = selected.has(capability.id); permissionInputs.push(input); label.append(input);
        } else label.classList.add('assistant-personal-capability');
        label.append(copy); row.append(label);
        if (capability.description) row.append(node('p', capability.description, 'helper'));
        if (capability.effects?.length) row.append(effectsList(capability.effects));
        details.append(row);
      }
      catalog.append(details);
    }
    const save = node('button', 'Save assistant access', 'primary'); save.type = 'submit';
    form.append(settings, catalog, save);
    form.addEventListener('input', () => { this.dirty = true; }); form.addEventListener('change', () => { this.dirty = true; });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.busy || this.ownerContext() === null || !name.value.trim() || !form.reportValidity()) return;
      void this.saveAccess({ name: name.value.trim(), permissions: permissionInputs.filter(input => input.checked).map(input => input.value), expiresInDays: Number(expiry.value), enabled: enabled.checked });
    });
    root.append(form);
    const connection = node('section', undefined, 'assistant-connection'); connection.append(node('h2', 'Connect Muse'));
    connection.append(node('p', 'Create a private access token only when you are ready to connect Muse. It appears once and stays out of browser storage. Creating a replacement immediately invalidates the previous token.'));
    const actions = node('div', undefined, 'row-buttons');
    const issue = button('Create or replace token', () => this.issueToken(), 'secondary'); issue.disabled = !assistant?.enabled;
    const revoke = button('Revoke assistant access', () => this.revokeAccess(), 'secondary danger-text'); revoke.disabled = !assistant;
    actions.append(issue, revoke); connection.append(actions);
    this.tokenRegion = node('div', undefined, 'assistant-token-region'); connection.append(this.tokenRegion);
    const instructions = node('details'); instructions.append(node('summary', 'Connection instructions'));
    instructions.append(node('p', 'For a compatible remote MCP client, use https://stone-square-sign.onrender.com/api/assistant/mcp with Streamable HTTP and Bearer authentication. Confirm Muse supports this connection method before entering the token in its secure setup. The separate /api/assistant/me address is a REST identity check. A successful authenticated read from Muse verifies the connection.'));
    instructions.append(node('p', 'Muse submits exact proposed changes for your approval. It must wait for its recorded approval and use a stable request key. An uncertain outcome needs verification before another attempt.'));
    connection.append(instructions); root.append(connection);
    this.renderRequests(root, data.requests || [], data.capabilities || []);
    const activity = node('section', undefined, 'assistant-activity'); activity.append(node('h2', 'Recent assistant activity'));
    if (!(data.activity || []).length) activity.append(node('p', 'No assistant activity is recorded here. A saved token alone does not verify a connection.', 'helper'));
    for (const item of data.activity || []) {
      const row = node('article', undefined, 'assistant-activity-row'); row.append(node('strong', item.title || item.action || item.actionId || 'Assistant activity'));
      row.append(node('p', [statusText(item.status || item.outcome), dateText(item.createdAt || item.at)].filter(Boolean).join(' · '), 'helper'));
      if (item.message) row.append(node('p', item.message)); activity.append(row);
    }
    root.append(activity);
  }
  async saveAccess(body) {
    if (!Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 30) return;
    const context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy) return;
    this.busy = true; this.setBusy(true); this.message.textContent = 'Saving assistant access…';
    try {
      await this.api('/api/assistant/access', { method: 'PUT', body: JSON.stringify(body) });
      if (!this.current(context, sequence)) return;
      this.dirty = false; await this.load({ message: 'Assistant access saved. No token was created by this save.' });
    } catch (error) { if (this.current(context, sequence)) this.message.textContent = `${error.message || 'Access could not be saved.'} Reload saved settings to verify the outcome before trying again.`; }
    finally { this.busy = false; if (this.current(context)) this.setBusy(false); }
  }
  setBusy(busy) {
    const root = this.mode === 'access' ? this.accessRoot : this.attestationsRoot;
    root.setAttribute('aria-busy', String(busy));
    for (const control of root.querySelectorAll('button, input, select')) {
      if (busy) { control.dataset.assistantWasDisabled = String(control.disabled); control.disabled = true; }
      else if (control.dataset.assistantWasDisabled !== undefined) { control.disabled = control.dataset.assistantWasDisabled === 'true'; delete control.dataset.assistantWasDisabled; }
    }
  }
  async issueToken() {
    const context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy) return;
    if (this.dirty) { this.message.textContent = 'Save or reload your access changes before creating a token.'; return; }
    if (!this.confirm('Create a new private Muse token? Any previous token will stop working immediately.')) return;
    this.clearToken(); this.busy = true; this.setBusy(true); this.message.textContent = 'Creating a private token…';
    try {
      const result = await this.api('/api/assistant/access/token', { method: 'POST' });
      if (!this.current(context, sequence) || this.mode !== 'access') return;
      if (!result.token) throw new Error('No token was returned.');
      this.token = result.token;
      const label = node('label', 'Private token, shown once'); const output = node('textarea'); output.rows = 3; output.readOnly = true; output.value = this.token; output.setAttribute('autocomplete', 'off'); output.setAttribute('spellcheck', 'false'); label.append(output); this.tokenOutput = output;
      const copyMessage = notice();
      const copy = button('Copy private token', async () => {
        if (!this.current(context, sequence) || !this.token) return;
        try { await this.clipboard().writeText(this.token); if (this.current(context, sequence)) copyMessage.textContent = 'Token copied. Keep it private.'; }
        catch { if (this.current(context, sequence)) copyMessage.textContent = 'Copy is unavailable. Select the token and copy it yourself.'; }
      });
      this.tokenRegion.replaceChildren(label, node('p', 'Copy it now. Leaving this screen removes the token from this page. A token is configuration; the connection is still unverified until Muse makes a successful read.', 'helper'), copy, button('Hide token', () => this.clearToken()), copyMessage);
      this.message.textContent = 'A new token was created. Any previous token is invalid.';
    } catch (error) { if (this.current(context, sequence)) this.message.textContent = `${error.message || 'The token could not be created.'} Its creation outcome is unverified. Do not reuse an old token without checking.`; }
    finally { this.busy = false; if (this.current(context)) this.setBusy(false); }
  }
  async revokeAccess() {
    const context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy || !this.confirm('Revoke Muse access now? Muse will lose access and pending approvals cannot authorize further work.')) return;
    this.busy = true; this.setBusy(true); this.clearToken();
    try {
      await this.api('/api/assistant/access', { method: 'DELETE' });
      if (!this.current(context, sequence)) return;
      this.dirty = false; await this.load({ message: 'Assistant access revoked.' });
    } catch (error) { if (this.current(context, sequence)) this.message.textContent = `${error.message || 'Revocation could not be confirmed.'} Refresh saved access to verify the outcome.`; }
    finally { this.busy = false; if (this.current(context)) this.setBusy(false); }
  }
  renderRequests(root, requests, capabilities) {
    const section = node('section', undefined, 'assistant-requests'); section.append(node('h2', 'Requests for your decision'));
    if (!requests.length) section.append(node('p', 'No assistant requests are recorded here.', 'helper'));
    const catalog = new Map(capabilities.map(capability => [capability.id, capability]));
    for (const request of requests) {
      const capability = catalog.get(request.actionId), personal = capability?.mode === 'personal';
      const article = node('article', undefined, 'assistant-request'); article.append(node('h3', request.title || capability?.label || 'Assistant request'));
      article.append(node('p', `${statusText(request.status)} · Requested ${dateText(request.createdAt)}`, 'assistant-record-status'));
      if (request.expiresAt) article.append(node('p', `Expires ${dateText(request.expiresAt)}`, 'helper'));
      if (request.effects?.length) { article.append(node('strong', 'What this action changes'), effectsList(request.effects)); }
      const details = node('details'); details.append(node('summary', 'Exact proposed change'));
      details.append(node('p', `${text(request.method)} ${text(request.path)}`, 'assistant-route'));
      details.append(node('pre', JSON.stringify(request.body ?? {}, null, 2), 'assistant-change')); article.append(details);
      if (request.decisionNote) article.append(node('p', `Decision note: ${request.decisionNote}`));
      if (request.receipt) { const receipt = node('details'); receipt.append(node('summary', 'Recorded outcome'), node('pre', JSON.stringify(request.receipt, null, 2), 'assistant-change')); article.append(receipt); }
      const message = notice(); const controls = node('div', undefined, 'row-buttons');
      if (personal) {
        article.append(node('p', 'This requires your own review and tap. Approval cannot authorize Muse to sign or attest.', 'helper'));
        controls.append(button('Open my review', () => this.openPersonalRequest(request, message)));
      } else if (capability?.mode === 'approval' && request.status === 'pending') {
        controls.append(button('Approve this change', () => this.decide(request, 'approve', message, controls), 'primary'), button('Decline', () => this.decide(request, 'decline', message, controls)));
      }
      article.append(controls, message); section.append(article);
    }
    root.append(section);
  }
  async decide(request, decision, message, controls) {
    const context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy || request.status !== 'pending' || !request.fingerprint || !this.data?.capabilities?.some(capability => capability.id === request.actionId && capability.mode === 'approval')) return;
    const effects = (request.effects || []).map(effect => `• ${effect}`).join('\n');
    if (!this.confirm(decision === 'approve' ? `Approve this exact change: ${request.title || request.actionId}?\n${effects}\nThis approval is for the unchanged record and request only.` : `Decline ${request.title || request.actionId}?`)) return;
    this.busy = true; for (const control of controls.querySelectorAll('button')) control.disabled = true;
    message.textContent = decision === 'approve' ? 'Recording your approval…' : 'Recording your decision…';
    try {
      const result = await this.api(`/api/assistant/requests/${encodeURIComponent(request.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision, fingerprint: request.fingerprint }) });
      if (!this.current(context, sequence)) return;
      request.status = result.request?.status || 'unknown'; message.textContent = statusText(request.status);
      if (request.status === 'approved') message.textContent += '. The change is not yet recorded as executed.';
      if (request.status === 'completed') message.textContent += '. Review the recorded outcome after refresh.';
    } catch (error) {
      if (!this.current(context, sequence)) return;
      message.textContent = `${error.message || 'The decision response was interrupted.'} Checking the saved request without repeating the decision…`;
      try {
        const result = await this.api(`/api/assistant/requests/${encodeURIComponent(request.id)}`);
        if (!this.current(context, sequence)) return;
        request.status = result.request?.status || 'unknown'; message.textContent = `Saved request: ${statusText(request.status)}. Refresh to review its current details.`;
      } catch { if (this.current(context, sequence)) { request.status = 'unknown'; message.textContent = 'The decision outcome is unverified. Refresh the request before taking another action. The decision was not repeated.'; } }
    } finally { this.busy = false; }
  }
  renderAttestations(attestations) {
    const root = this.attestationsRoot; root.replaceChildren();
    this.heading(root, 'My Attestations', 'Review each document and its effects. Signing and personal confirmations happen only when you act in the document’s own review.');
    if (!attestations.length) root.append(node('p', 'No personal signatures or attestations are currently waiting for you.', 'assistant-empty'));
    for (const item of attestations) {
      const article = node('article', undefined, 'assistant-attestation'); article.append(node('h2', item.title || 'Personal review'));
      article.append(node('p', `${item.ready ? 'Ready for your review' : 'Review requirements'} · ${statusText(item.status)}`, 'assistant-record-status'));
      article.append(node('p', `Record ${text(item.recordId)} · Revision ${text(item.revision || 'unverified')}`, 'helper'));
      if (item.reason) article.append(node('p', item.reason, 'assistant-review-reason'));
      if (item.reviewGuidance) article.append(node('p', item.reviewGuidance, 'helper'));
      if (item.attestationText) { article.append(node('h3', item.consentTextSource === 'existing_action_label' ? 'Action to review' : 'Your attestation'), node('blockquote', item.attestationText, 'assistant-attestation-text')); }
      if (item.effects?.length) article.append(node('h3', 'What your action does'), effectsList(item.effects));
      const message = notice();
      article.append(button(item.ready ? (item.actionLabel || 'Open document review') : 'Review requirements', () => this.openAttestation(item, message), 'primary'), message); root.append(article);
    }
  }
  async openAttestation(item, message) {
    const context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy) return;
    this.busy = true; message.textContent = 'Checking the current record before opening your review…';
    try {
      const result = await this.api('/api/assistant/attestations');
      if (!this.current(context, sequence)) return;
      const current = result.attestations?.find(entry => entry.id === item.id);
      if (!current) { message.textContent = 'This item is no longer in your queue. Refresh to see the current work.'; return; }
      if (text(current.revision) !== text(item.revision) || current.attestationText !== item.attestationText || JSON.stringify(current.effects) !== JSON.stringify(item.effects)) {
        this.renderAttestations(result.attestations); this.message.textContent = 'This record changed. Review the current wording and effects before opening it.'; return;
      }
      await this.openReview(current);
      if (this.current(context, sequence)) message.textContent = 'Review opened. No signature or attestation has been submitted.';
    } catch (error) { if (this.current(context, sequence)) message.textContent = error.message || 'The current review could not be opened.'; }
    finally { this.busy = false; }
  }
  async openPersonalRequest(request, message) {
    const context = this.ownerContext(), sequence = this.sequence;
    if (context === null || this.busy) return;
    this.busy = true;
    try {
      const result = await this.api('/api/assistant/attestations');
      if (!this.current(context, sequence)) return;
      const item = result.attestations?.find(entry => entry.requestId === request.id || (entry.recordId === request.navigation?.recordId && entry.section === request.navigation?.section));
      if (!item) { message.textContent = 'No current personal review is available for this request. Refresh My Attestations to check its state.'; return; }
      await this.openReview(item);
    } catch (error) { if (this.current(context, sequence)) message.textContent = error.message || 'The personal review could not open.'; }
    finally { this.busy = false; }
  }
}
