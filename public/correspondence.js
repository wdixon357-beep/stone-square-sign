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
    $('correspondenceThomas').addEventListener('click', () => this.thomasStarter());
    $('correspondenceOpenPdf').addEventListener('click', () => { if (this.pdfUrl) window.open(this.pdfUrl, '_blank', 'noopener'); });
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) {
      $(id).addEventListener('input', () => { this.dirty = true; $('correspondencePreviewWrap').classList.add('hidden'); message('Changes are not saved yet.'); });
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
    this.currentId = null;
    $('correspondenceMatter').value = 'general';
    for (const id of ['correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).value = '';
    $('correspondenceByline').textContent = `Prepared by ${this.user()?.name || 'the signed-in officer'} on Lodge letterhead.`;
    $('correspondenceSave').disabled = false;
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).disabled = false;
    this.dirty = false;
    $('correspondencePreviewWrap').classList.add('hidden');
    message('New draft. Fill in the verified details and save to preview.');
    return true;
  }
  thomasStarter() {
    if (!this.newLetter()) return;
    $('correspondenceMatter').value = 'demit';
    $('correspondenceLodge').value = 'Star in the East Lodge';
    $('correspondenceSubject').value = 'PM James R. Thomas II: dues payment and pending demit request';
    $('correspondenceBody').value = 'Brother Secretary,\n\nOur Lodge dues ledger reflects PM James R. Thomas II’s dues as paid in full as of September 23, 2026. We are completing the remaining required review of his demit request. Our office will advise you of the result through the established Lodge-to-Lodge process.\n\nPlease acknowledge receipt of this update.';
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
      button.append(title, meta);
      button.addEventListener('click', () => { void this.open(draft); });
      list.append(button);
    }
  }
  async open(draft) {
    if (this.dirty && !window.confirm('Discard your unsaved changes and open this letter?')) return;
    this.currentId = draft.id;
    $('correspondenceMatter').value = draft.matter;
    $('correspondenceLodge').value = draft.recipientLodge;
    $('correspondenceRecipient').value = draft.recipientName;
    $('correspondenceSubject').value = draft.subject;
    $('correspondenceBody').value = draft.body;
    $('correspondenceByline').textContent = `Prepared by ${draft.preparedByName}, ${draft.preparedByOffice}.`;
    const editable = this.user()?.role === 'owner' || draft.preparedByUserId === this.user()?.id;
    $('correspondenceSave').disabled = !editable;
    for (const id of ['correspondenceMatter', 'correspondenceLodge', 'correspondenceRecipient', 'correspondenceSubject', 'correspondenceBody']) $(id).disabled = !editable;
    this.dirty = false;
    message(editable ? 'Draft loaded. Review or update it before use.' : 'Read only. The preparing officer owns edits to this letter.');
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
      this.dirty = false;
      message('Draft saved. Review the PDF below. It has not been signed or sent.');
      await this.load();
      await this.preview(this.currentId);
    } catch (error) { message(error.message || 'The draft could not be saved.', true); }
    finally { button.disabled = false; }
  }
  async preview(id) {
    try {
      const pdf = await this.api(`/api/correspondence/${encodeURIComponent(id)}/pdf`);
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      this.pdfUrl = URL.createObjectURL(pdf);
      const { MinutesPreview } = await import('/minutes-preview.js');
      this.previewRenderer ||= new MinutesPreview($('correspondencePreview'));
      $('correspondencePreviewWrap').classList.remove('hidden');
      await this.previewRenderer.show(new Uint8Array(await pdf.arrayBuffer()));
    } catch (error) { message(error.message || 'The preview could not be loaded.', true); }
  }
}
