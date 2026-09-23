const $ = id => document.getElementById(id);
const message = (value, error = false) => {
  const node = $('correspondenceMessage');
  node.textContent = value;
  node.classList.toggle('error', error);
};

export class CorrespondenceWorkspace {
  constructor({ api, user }) {
    this.api = api;
    this.user = user;
    this.drafts = [];
    this.currentId = null;
    this.pdfUrl = null;
    this.bound = false;
    this.dirty = false;
    this.previewRenderer = null;
    this.signers = [];
    this.currentSignerUserId = null;
    this.savedSignerUserId = null;
    this.currentUpdatedAt = null;
    this.previewRecordRevision = null;
  }
  bind() {
    if (this.bound) return;
    this.bound = true;
    $('correspondenceNew').addEventListener('click', () => this.newLetter());
    $('correspondenceRefresh').addEventListener('click', () => { void this.load(); });
    $('correspondenceSave').addEventListener('click', () => { void this.save(); });
    $('correspondenceSubmit').addEventListener('click', () => { void this.submit(); });
    $('correspondenceReturn').addEventListener('click', () => { void this.returnForCorrection(); });
    $('correspondenceSign').addEventListener('click', () => { void this.sign(); });
    $('correspondenceThomas').addEventListener('click', () => this.demitStarter());
    $('correspondenceOpenPdf').addEventListener('click', () => { if (this.pdfUrl) window.open(this.pdfUrl, '_blank', 'noopener'); });
    $('correspondenceDownload').addEventListener('click', () => {
      if (!this.pdfUrl) return;
      const link = document.createElement('a'); link.href = this.pdfUrl;
      link.download = this.currentStatus === 'signed' ? 'Stone-Square-Signed-Correspondence.pdf' : 'Stone-Square-Correspondence-Draft.pdf';
      link.click();
    });
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody', 'correspondenceSigner']) {
      $(id).addEventListener('input', () => {
        if (id === 'correspondenceSigner') this.currentSignerUserId = Number($(id).value) || null;
        this.dirty = true; this.clearPreview(); message('Changes are not saved yet.');
      });
    }
  }
  renderSigners() {
    const select = $('correspondenceSigner');
    select.replaceChildren();
    const either = document.createElement('option');
    either.value = '';
    either.textContent = 'Either William McDuffie or Adrian Reese';
    select.append(either);
    for (const signer of this.signers) {
      const option = document.createElement('option');
      option.value = String(signer.id);
      option.textContent = `${signer.name}, ${signer.office}`;
      select.append(option);
    }
    if (this.currentSignerUserId && this.signers.some(item => item.id === this.currentSignerUserId)) {
      select.value = String(this.currentSignerUserId);
    } else { this.currentSignerUserId = null; select.value = ''; }
    $('correspondenceSignerWrap').classList.toggle('hidden', this.user()?.role !== 'owner');
    select.disabled = this.currentStatus !== 'draft';
  }
  fields() {
    return {
      matter: $('correspondenceMatter').value,
      recipientLodge: $('correspondenceLodge').value.trim(),
      recipientName: $('correspondenceRecipient').value.trim(),
      subject: $('correspondenceSubject').value.trim(),
      body: $('correspondenceBody').value.trim(),
      ...(this.user()?.role === 'owner' ? { signerUserId: Number($('correspondenceSigner').value) || null } : {}),
    };
  }
  newLetter({ confirmDiscard = true } = {}) {
    if (confirmDiscard && this.dirty && !window.confirm('Discard your unsaved changes and start a new letter?')) return false;
    this.clearPreview();
    this.currentId = null;
    this.currentStatus = 'draft';
    this.currentUpdatedAt = null;
    this.currentSignerUserId = null;
    this.savedSignerUserId = null;
    $('correspondenceMatter').value = 'general';
    for (const id of ['correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).value = '';
    $('correspondenceByline').textContent = `Prepared by ${this.user()?.name || 'the signed-in officer'} on Lodge letterhead.`;
    $('correspondenceSave').disabled = false;
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).disabled = false;
    this.dirty = false;
    this.renderSigners();
    $('correspondencePreviewWrap').classList.add('hidden');
    this.renderHandoff(null);
    message('New draft. Fill in the verified details and save to preview.');
    return true;
  }
  demitStarter() {
    if (!this.newLetter()) return;
    $('correspondenceMatter').value = 'demit';
    $('correspondenceSubject').value = 'Demit inquiry concerning [Brother full name]';
    $('correspondenceBody').value = 'Dear Brother Secretary,\n\nIn response to your correspondence concerning [Brother full name] and his demit request to [Receiving Lodge], Stone Square Lodge No. 22 confirms the following as of [record date]: [verified standing and charges statement].\n\nPlease let us know if you need any further information as the request proceeds through the appropriate channels.';
    this.dirty = true;
    message('General demit reply started. Verify the incoming inquiry, financial standing, and complaint and charge records. Replace every bracketed prompt before saving.');
  }
  async load() {
    this.bind();
    try {
      const available = await this.api('/api/correspondence/signers');
      this.signers = available.signers || [];
      this.renderSigners();
      const response = await this.api('/api/correspondence');
      this.drafts = response.drafts || [];
      this.renderList();
      if (!this.currentId && !this.fields().subject) this.newLetter({ confirmDiscard: false });
    } catch (error) { message(error.message || 'Letters could not be loaded.', true); }
  }
  renderList() {
    const list = $('correspondenceList');
    list.replaceChildren();
    if (!this.drafts.length) { const p = document.createElement('p'); p.className = 'helper'; p.textContent = 'No saved letters yet.'; list.append(p); return; }
    for (const draft of this.drafts) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'correspondence-list-item';
      const title = document.createElement('strong'); title.textContent = draft.subject;
      const meta = document.createElement('small');
      meta.textContent = `${draft.recipientLodge} · ${draft.preparedByName} · ${new Date(draft.updatedAt).toLocaleDateString('en-US')}`;
      const status = document.createElement('small');
      status.textContent = draft.status === 'signed' ? `Signed by ${draft.signedByName}, ready to email` : draft.status === 'awaiting_secretary' ? draft.signingMode === 'either' ? 'Waiting for William McDuffie or Adrian Reese to sign' : `Waiting for ${draft.assignedToName || 'the assigned officer'} to sign` : 'Draft';
      button.append(title, meta, status);
      button.addEventListener('click', () => { void this.open(draft); });
      list.append(button);
    }
  }
  async open(draft) {
    if (this.dirty && !window.confirm('Discard your unsaved changes and open this letter?')) return;
    this.clearPreview();
    this.currentId = draft.id;
    this.currentStatus = draft.status;
    this.currentUpdatedAt = draft.updatedAt;
    this.currentSignerUserId = draft.signingMode === 'either' ? null :
      draft.assignedToUserId || this.signers.find(item => item.name === draft.assignedToName)?.id || null;
    this.savedSignerUserId = this.currentSignerUserId;
    this.renderSigners();
    $('correspondenceMatter').value = draft.matter;
    $('correspondenceLodge').value = draft.recipientLodge;
    $('correspondenceRecipient').value = draft.recipientName;
    $('correspondenceSubject').value = draft.subject;
    $('correspondenceBody').value = draft.body;
    $('correspondenceByline').textContent = `Prepared by ${draft.preparedByName}, ${draft.preparedByOffice}.`;
    const editable = draft.status === 'draft' && (this.user()?.role === 'owner' || draft.preparedByUserId === this.user()?.id);
    $('correspondenceSave').disabled = !editable;
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).disabled = !editable;
    this.dirty = false;
    this.renderHandoff(draft);
    message(draft.returnNote ? `Returned for correction: ${draft.returnNote}` : editable ? 'Draft loaded. Review or update it before use.' : 'Read only. The preparing officer owns edits to this letter.');
    await this.preview(draft.id);
  }
  async save() {
    const fields = this.fields();
    if (!fields.recipientLodge || !fields.recipientName || !fields.subject || !fields.body) {
      message('Complete the receiving Lodge, recipient, subject, and letter.', true); return;
    }
    const button = $('correspondenceSave'); button.disabled = true;
    try {
      const response = await this.api(this.currentId ? `/api/correspondence/${encodeURIComponent(this.currentId)}` : '/api/correspondence', {
        method: this.currentId ? 'PUT' : 'POST', body: JSON.stringify(fields),
      });
      this.currentId = response.draft.id;
      this.currentStatus = response.draft.status;
      this.currentUpdatedAt = response.draft.updatedAt;
      this.currentSignerUserId = response.draft.assignedToUserId;
      this.savedSignerUserId = this.currentSignerUserId;
      this.renderSigners();
      this.dirty = false;
      this.renderHandoff(response.draft);
      message('Draft saved. Review the PDF below. It has not been signed or sent.');
      await this.load();
      await this.preview(this.currentId);
    } catch (error) { message(error.message || 'The draft could not be saved.', true); }
    finally { button.disabled = false; }
  }
  renderHandoff(draft) {
    $('correspondenceHandoff').classList.toggle('hidden', !draft);
    $('correspondenceSubmit').classList.toggle('hidden', !draft || draft.status !== 'draft' || this.user()?.role !== 'owner');
    const sharedEligible = draft?.sharedSignerUserIds?.includes(this.user()?.id);
    const canSign = draft?.status === 'awaiting_secretary' &&
      (draft.assignedToUserId === this.user()?.id || (draft.signingMode === 'either' && sharedEligible));
    $('correspondenceReturn').classList.toggle('hidden', !draft || draft.status !== 'awaiting_secretary' || !(canSign || this.user()?.role === 'owner'));
    $('correspondenceConsentWrap').classList.toggle('hidden', !canSign);
    $('correspondenceSign').classList.toggle('hidden', !canSign);
    $('correspondenceConsent').checked = false;
    $('correspondenceStatus').textContent = !draft ? '' : draft.status === 'signed'
      ? `Signed by ${draft.signedByName}. Download the signed PDF and attach it to the Secretary's email. The dashboard has not sent it.`
      : draft.status === 'awaiting_secretary'
        ? draft.signingMode === 'either'
          ? 'Waiting for William McDuffie or Adrian Reese to sign. The first signature completes the letter.'
          : `Waiting for ${draft.assignedToName || 'the assigned officer'} to sign.`
        : 'Draft only. Review the recipient, signing officer, facts, and complete PDF before assigning it.';
    $('correspondenceSubmit').textContent = `Send to ${draft?.assignedToName || 'William McDuffie or Adrian Reese'} for signature`;
    $('correspondenceSigner').disabled = Boolean(draft && draft.status !== 'draft');
    $('correspondenceDownload').textContent = draft?.status === 'signed' ? 'Download signed PDF for email' : 'Download draft PDF';
  }
  async submit() {
    if (!this.currentId || this.currentStatus !== 'draft' || this.dirty || this.previewRecordId !== this.currentId || this.previewRecordRevision !== this.currentUpdatedAt || !this.pdfUrl || this.savedSignerUserId !== (Number($('correspondenceSigner').value) || null)) { message('Save and review the PDF before assigning this letter for signature.', true); return; }
    const signer = this.signers.find(item => item.id === this.savedSignerUserId);
    const recipient = signer?.name || 'William McDuffie or Adrian Reese';
    if (!window.confirm(`Send this exact letter to ${recipient} for review and signature? It will be locked against further edits.`)) return;
    const button = $('correspondenceSubmit'); button.disabled = true;
    try {
      const response = await this.api(`/api/correspondence/${encodeURIComponent(this.currentId)}/submit`, { method: 'POST', body: JSON.stringify({ signerUserId: signer?.id || null, expectedUpdatedAt: this.currentUpdatedAt }) });
      this.currentStatus = response.draft.status;
      await this.load(); await this.open(response.draft);
      message(`The letter is in ${recipient}’s dashboard signature queue. The first to sign completes it; it has not been emailed.`);
    } catch (error) { message(error.message || 'The letter could not be assigned.', true); }
    finally { button.disabled = false; }
  }
  async sign() {
    if (!this.currentId || this.previewRecordId !== this.currentId || this.previewRecordRevision !== this.currentUpdatedAt || !this.pdfUrl || !$('correspondenceConsent').checked) { message('Review this letter’s current PDF and check the signature authorization box before signing.', true); return; }
    if (!window.confirm('Apply your saved signature to this exact letter? You will still need to email the signed PDF yourself.')) return;
    const button = $('correspondenceSign'); button.disabled = true;
    try {
      const response = await this.api(`/api/correspondence/${encodeURIComponent(this.currentId)}/sign`, { method: 'POST', body: JSON.stringify({ consent: true, expectedUpdatedAt: this.previewRecordRevision }) });
      this.currentStatus = response.draft.status;
      await this.load(); await this.open(response.draft);
      message('Signed PDF ready. Download it and attach it to your email. The dashboard has not emailed the letter.');
    } catch (error) { message(error.message || 'The letter could not be signed.', true); }
    finally { button.disabled = false; }
  }
  async returnForCorrection() {
    if (!this.currentId || this.currentStatus !== 'awaiting_secretary') return;
    const reason = window.prompt('What must be corrected before the assigned officer signs this letter?');
    if (reason === null) return;
    if (!reason.trim()) { message('Enter the correction needed before returning the letter.', true); return; }
    try {
      const response = await this.api(`/api/correspondence/${encodeURIComponent(this.currentId)}/return`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      await this.load(); await this.open(response.draft);
      message('Letter returned to draft for correction. Its prior signature request is closed.');
    } catch (error) { message(error.message || 'The letter could not be returned.', true); }
  }
  clearPreview() {
    if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
    this.pdfUrl = null;
    this.previewRecordId = null;
    this.previewRecordRevision = null;
    this.previewReset = this.previewRenderer?.clear();
    $('correspondencePreviewWrap').classList.add('hidden');
    $('correspondenceOpenPdf').disabled = true;
    $('correspondenceDownload').disabled = true;
    $('correspondenceSign').disabled = true;
  }
  async preview(id) {
    const revision = this.currentUpdatedAt;
    try {
      const pdf = await this.api(`/api/correspondence/${encodeURIComponent(id)}/pdf`);
      if (this.currentId !== id || this.currentUpdatedAt !== revision) return;
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      const { MinutesPreview } = await import('/minutes-preview.js');
      await this.previewReset;
      if (this.currentId !== id || this.currentUpdatedAt !== revision) return;
      this.previewRenderer ||= new MinutesPreview($('correspondencePreview'));
      await this.previewRenderer.show(bytes);
      if (this.currentId !== id || this.currentUpdatedAt !== revision) return;
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      this.pdfUrl = URL.createObjectURL(pdf);
      this.previewRecordId = id;
      this.previewRecordRevision = revision;
      $('correspondencePreviewWrap').classList.remove('hidden');
      $('correspondenceOpenPdf').disabled = false;
      $('correspondenceDownload').disabled = false;
      $('correspondenceSign').disabled = false;
    } catch (error) { message(error.message || 'The preview could not be loaded.', true); }
  }
}
