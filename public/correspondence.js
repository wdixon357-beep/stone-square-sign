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
    $('correspondenceThomas').addEventListener('click', () => this.thomasStarter());
    $('correspondenceOpenPdf').addEventListener('click', () => { if (this.pdfUrl) window.open(this.pdfUrl, '_blank', 'noopener'); });
    $('correspondenceDownload').addEventListener('click', () => {
      if (!this.pdfUrl) return;
      const link = document.createElement('a'); link.href = this.pdfUrl;
      link.download = this.currentStatus === 'signed' ? 'Stone-Square-Signed-Correspondence.pdf' : 'Stone-Square-Correspondence-Draft.pdf';
      link.click();
    });
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) {
      $(id).addEventListener('input', () => { this.dirty = true; this.clearPreview(); message('Changes are not saved yet.'); });
    }
  }
  fields() {
    return {
      matter: $('correspondenceMatter').value,
      recipientLodge: $('correspondenceLodge').value.trim(),
      recipientName: $('correspondenceRecipient').value.trim(),
      subject: $('correspondenceSubject').value.trim(),
      body: $('correspondenceBody').value.trim(),
    };
  }
  newLetter({ confirmDiscard = true } = {}) {
    if (confirmDiscard && this.dirty && !window.confirm('Discard your unsaved changes and start a new letter?')) return false;
    this.clearPreview();
    this.currentId = null;
    this.currentStatus = 'draft';
    $('correspondenceMatter').value = 'general';
    for (const id of ['correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).value = '';
    $('correspondenceByline').textContent = `Prepared by ${this.user()?.name || 'the signed-in officer'} on Lodge letterhead.`;
    $('correspondenceSave').disabled = false;
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).disabled = false;
    this.dirty = false;
    $('correspondencePreviewWrap').classList.add('hidden');
    this.renderHandoff(null);
    message('New draft. Fill in the verified details and save to preview.');
    return true;
  }
  thomasStarter() {
    if (!this.newLetter()) return;
    $('correspondenceMatter').value = 'demit';
    $('correspondenceLodge').value = 'Star in the East Lodge';
    $('correspondenceSubject').value = 'PM James R. Thomas II: dues payment and pending demit request';
    $('correspondenceBody').value = 'Brother Secretary,\n\nStone Square Lodge No. 22’s dues ledger shows that PM James R. Thomas II’s dues were paid in full as of September 23, 2026. His demit request remains under review. We will provide an update when that review is complete.\n\nPlease confirm receipt of this letter.';
    this.dirty = true;
    message('Starter added. Verify the Lodge name, recipient spelling, dues record, and procedural checks before saving.');
  }
  async load() {
    this.bind();
    try {
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
      status.textContent = draft.status === 'signed' ? 'Signed, ready for Secretary to email' : draft.status === 'awaiting_secretary' ? `Awaiting ${draft.assignedToName || 'Secretary'} signature` : 'Draft';
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
    const canSign = draft?.status === 'awaiting_secretary' && draft.assignedToUserId === this.user()?.id && this.user()?.role === 'secretary';
    $('correspondenceReturn').classList.toggle('hidden', !draft || draft.status !== 'awaiting_secretary' || !(canSign || this.user()?.role === 'owner'));
    $('correspondenceConsentWrap').classList.toggle('hidden', !canSign);
    $('correspondenceSign').classList.toggle('hidden', !canSign);
    $('correspondenceConsent').checked = false;
    $('correspondenceStatus').textContent = !draft ? '' : draft.status === 'signed'
      ? `Signed by ${draft.signedByName}. Download the signed PDF and attach it to the Secretary's email. The dashboard has not sent it.`
      : draft.status === 'awaiting_secretary'
        ? `Assigned to ${draft.assignedToName} for review and signature. The letter is locked while awaiting signature.`
        : 'Draft only. Review the recipient, facts, and complete PDF before sending it to McDuffie.';
    $('correspondenceDownload').textContent = draft?.status === 'signed' ? 'Download signed PDF for email' : 'Download draft PDF';
  }
  async submit() {
    if (!this.currentId || this.currentStatus !== 'draft' || this.dirty || this.previewRecordId !== this.currentId || !this.pdfUrl) { message('Save and review this letter’s PDF before sending it to McDuffie.', true); return; }
    if (!window.confirm('Send this exact letter to McDuffie for his review and signature? It will be locked against further edits.')) return;
    const button = $('correspondenceSubmit'); button.disabled = true;
    try {
      const response = await this.api(`/api/correspondence/${encodeURIComponent(this.currentId)}/submit`, { method: 'POST' });
      this.currentStatus = response.draft.status;
      await this.load(); await this.open(response.draft);
      message('The letter is in McDuffie’s dashboard signature queue. He must review and sign it; it has not been emailed.');
    } catch (error) { message(error.message || 'The letter could not be assigned.', true); }
    finally { button.disabled = false; }
  }
  async sign() {
    if (!this.currentId || this.previewRecordId !== this.currentId || !this.pdfUrl || !$('correspondenceConsent').checked) { message('Review this letter’s complete PDF and check the signature authorization box before signing.', true); return; }
    if (!window.confirm('Apply your saved signature to this exact letter? You will still need to email the signed PDF yourself.')) return;
    const button = $('correspondenceSign'); button.disabled = true;
    try {
      const response = await this.api(`/api/correspondence/${encodeURIComponent(this.currentId)}/sign`, { method: 'POST', body: JSON.stringify({ consent: true }) });
      this.currentStatus = response.draft.status;
      await this.load(); await this.open(response.draft);
      message('Signed PDF ready. Download it and attach it to your email. The dashboard has not emailed the letter.');
    } catch (error) { message(error.message || 'The letter could not be signed.', true); }
    finally { button.disabled = false; }
  }
  async returnForCorrection() {
    if (!this.currentId || this.currentStatus !== 'awaiting_secretary') return;
    const reason = window.prompt('What must be corrected before McDuffie signs this letter?');
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
    this.previewReset = this.previewRenderer?.clear();
    $('correspondencePreviewWrap').classList.add('hidden');
    $('correspondenceOpenPdf').disabled = true;
    $('correspondenceDownload').disabled = true;
    $('correspondenceSign').disabled = true;
  }
  async preview(id) {
    try {
      const pdf = await this.api(`/api/correspondence/${encodeURIComponent(id)}/pdf`);
      if (this.currentId !== id) return;
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      const { MinutesPreview } = await import('/minutes-preview.js');
      await this.previewReset;
      if (this.currentId !== id) return;
      this.previewRenderer ||= new MinutesPreview($('correspondencePreview'));
      await this.previewRenderer.show(bytes);
      if (this.currentId !== id) return;
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      this.pdfUrl = URL.createObjectURL(pdf);
      this.previewRecordId = id;
      $('correspondencePreviewWrap').classList.remove('hidden');
      $('correspondenceOpenPdf').disabled = false;
      $('correspondenceDownload').disabled = false;
      $('correspondenceSign').disabled = false;
    } catch (error) { message(error.message || 'The preview could not be loaded.', true); }
  }
}
