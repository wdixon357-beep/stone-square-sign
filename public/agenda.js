import { MinutesPreview } from './minutes-preview.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const clone = value => structuredClone(value);

export class AgendaWorkspace {
  constructor({ api, user }) {
    this.api = api; this.user = user; this.root = document.getElementById('agendaSection'); this.sequence = 0;
    this.root.addEventListener('click', event => { const button = event.target.closest('[data-agenda]'); if (button) void this.run(button.dataset.agenda, button); });
    this.root.addEventListener('input', event => this.changed(event));
    this.root.addEventListener('change', event => this.changed(event));
  }
  message(value, error = false) { const element = this.root.querySelector('#agendaMessage'); if (element) { element.textContent = value || ''; element.classList.toggle('error', error); } }
  top() { this.root.closest?.('.content')?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' }); }
  savedLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Saved draft' : `Last saved ${date.toLocaleString()}`; }
  saveState(value) { const element = this.root.querySelector('#agendaSaveState'); if (element) element.textContent = value; }
  changed(event) {
    if (!this.draft || !event.target.dataset.field) return;
    const field = event.target.dataset.field;
    if (field.startsWith('section.')) {
      const [, index, key] = field.split('.'); this.draft.sections[Number(index)][key] = event.target.value;
    } else if (field.startsWith('officer.')) {
      const [, index, key] = field.split('.'); this.draft.officers[Number(index)][key] = event.target.value;
    } else this.draft[field] = event.target.value;
    this.dirty = true; this.saveState('Unsaved changes'); this.schedule();
  }
  async run(action, button) {
    if (this.busy) return;
    try {
      if (action === 'new') { this.busy = true; const { agenda } = await this.api('/api/agendas', { method: 'POST', body: JSON.stringify({}) }); this.open(agenda); this.message('Draft created and saved. You can return to it from any signed-in device.'); return; }
      if (action === 'open') { const agenda = this.records.find(item => item.id === button.dataset.id); if (agenda) this.open(agenda); return; }
      if (action === 'back') { if (this.dirty && !confirm('Leave these unsaved agenda changes?')) return; await this.list(); return; }
      if (action === 'add-section') { this.draft.sections.push({ id: crypto.randomUUID(), heading: 'New Agenda Section', scheduledTime: '', body: '' }); this.dirty = true; this.renderEditor(); this.saveState('Unsaved changes'); this.schedule(); return; }
      if (action === 'remove-section') { this.draft.sections.splice(Number(button.dataset.index), 1); this.dirty = true; this.renderEditor(); this.saveState('Unsaved changes'); this.schedule(); return; }
      if (action === 'move-up' || action === 'move-down') {
        const from = Number(button.dataset.index), to = from + (action === 'move-up' ? -1 : 1);
        if (to < 0 || to >= this.draft.sections.length) return;
        [this.draft.sections[from], this.draft.sections[to]] = [this.draft.sections[to], this.draft.sections[from]];
        this.dirty = true; this.renderEditor(); this.saveState('Unsaved changes'); this.schedule(); return;
      }
      this.busy = true; button.disabled = true;
      if (action === 'save') { await this.save(); this.message('Draft saved. You can safely leave and continue later.'); }
      if (action === 'delete') {
        if (!confirm('Delete this agenda draft?')) return;
        await this.api(`/api/agendas/${button.dataset.id}`, { method: 'DELETE', body: JSON.stringify({ revision: Number(button.dataset.revision) }) }); await this.list();
      }
    } catch (error) { this.message(error.message, true); }
    finally { this.busy = false; if (button.isConnected) button.disabled = false; }
  }
  async list() {
    this.top();
    clearTimeout(this.timer); this.sequence += 1; await this.preview?.clear(); this.preview = null; if (this.url) URL.revokeObjectURL(this.url);
    this.record = null; this.draft = null; this.dirty = false;
    this.root.innerHTML = `<div class="content-head"><div><p class="eyebrow">WORSHIPFUL MASTER</p><h1>Agenda Creator</h1><p>Start an agenda, save the draft, and return whenever you are ready to finish it.</p></div><button class="primary" data-agenda="new" type="button">Create agenda draft</button></div><p id="agendaMessage" class="message" role="status"></p><div id="agendaList" class="agenda-list"></div>`;
    try {
      this.records = (await this.api('/api/agendas')).agendas;
      this.root.querySelector('#agendaList').innerHTML = this.records.length ? this.records.map(item => `<article class="agenda-record"><div><h2>${esc(this.dateLabel(item.draft.meetingDate))}</h2><p>Draft · ${esc(item.draft.meetingType)} · ${esc(this.savedLabel(item.updatedAt))}</p></div><div class="row-buttons"><button class="secondary" data-agenda="open" data-id="${esc(item.id)}">Resume Draft</button><button class="secondary danger-text" data-agenda="delete" data-id="${esc(item.id)}" data-revision="${item.revision}">Delete Draft</button></div></article>`).join('') : '<div class="empty-state"><h2>No agenda drafts yet</h2><p>Create a draft and save your progress as you build the meeting order.</p></div>';
    } catch (error) { this.message(error.message, true); }
  }
  dateLabel(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return 'Meeting date needs review';
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  }
  open(record) { this.top(); this.record = record; this.draft = clone(record.draft); this.dirty = false; this.renderEditor(); this.saveState(this.savedLabel(record.updatedAt)); this.schedule(); }
  section(section, index) {
    return `<article class="agenda-section-card"><div class="agenda-section-head"><strong>Section ${index + 1}</strong><div class="row-buttons"><button class="secondary compact" data-agenda="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move section ${index + 1} up">Up</button><button class="secondary compact" data-agenda="move-down" data-index="${index}" ${index === this.draft.sections.length - 1 ? 'disabled' : ''} aria-label="Move section ${index + 1} down">Down</button><button class="text-button danger-text" data-agenda="remove-section" data-index="${index}">Remove</button></div></div><div class="agenda-section-fields"><label>Heading<input data-field="section.${index}.heading" value="${esc(section.heading)}"></label><label>Target time<input data-field="section.${index}.scheduledTime" value="${esc(section.scheduledTime)}" placeholder="8:15 PM"></label></div><label>Agenda details<textarea data-field="section.${index}.body" rows="5" placeholder="Enter the details for this item. Put separate items on separate lines.">${esc(section.body)}</textarea></label></article>`;
  }
  renderEditor() {
    const d = this.draft;
    this.preview?.clear(); if (this.url) URL.revokeObjectURL(this.url);
    this.root.innerHTML = `<div class="content-head"><div><p class="eyebrow">OWNER ONLY</p><h1>Agenda Creator</h1><p>Build the agenda in stages. Save the draft before leaving and resume it later from any signed-in device.</p><p id="agendaSaveState" class="helper" role="status"></p></div><div class="row-buttons"><button class="secondary" data-agenda="back">All Agenda Drafts</button><button class="primary" data-agenda="save">Save Draft</button></div></div><p id="agendaMessage" class="message" role="status"></p><div class="agenda-workspace"><form class="agenda-editor" onsubmit="return false"><section class="panel"><h2>Meeting details</h2><div class="agenda-details-grid"><label>Meeting date<input type="date" data-field="meetingDate" value="${esc(d.meetingDate)}"></label><label>Meeting type<select data-field="meetingType"><option ${d.meetingType === 'Stated Communication' ? 'selected' : ''}>Stated Communication</option><option ${d.meetingType === 'Special Communication' ? 'selected' : ''}>Special Communication</option></select></label><label>Start time<input data-field="startTime" value="${esc(d.startTime)}" placeholder="7:30 PM"></label><label>Dress<input data-field="dress" value="${esc(d.dress)}"></label></div><label>Optional note below the title<textarea data-field="subtitle" rows="2" placeholder="Leave blank when no introductory note is needed.">${esc(d.subtitle)}</textarea></label></section><section class="panel"><div class="panel-title"><div><h2>Order of business</h2><p>Move sections into the order they will appear.</p></div><button class="secondary" data-agenda="add-section">Add section</button></div>${d.sections.map((section, index) => this.section(section, index)).join('')}</section><details class="panel"><summary>Officer rail</summary><p class="helper">These names appear on the left side of every page. Review them when Lodge offices change.</p>${d.officers.map((officer, index) => `<div class="agenda-officer-row"><input aria-label="Officer ${index + 1} office" data-field="officer.${index}.office" value="${esc(officer.office)}"><input aria-label="Officer ${index + 1} name" data-field="officer.${index}.name" value="${esc(officer.name)}"></div>`).join('')}</details></form><aside class="agenda-preview"><div class="panel-title"><div><h2>Document preview</h2><p id="agendaPreviewState" role="status">Updating preview…</p></div><a id="agendaDownload" class="secondary hidden" download="Stone Square Agenda.pdf">Download PDF</a></div><div id="agendaPreviewPages" class="minutes-pdf-pages"></div></aside></div>`;
    this.preview = new MinutesPreview(this.root.querySelector('#agendaPreviewPages'));
  }
  schedule() {
    clearTimeout(this.timer); this.sequence += 1; const link = this.root.querySelector('#agendaDownload'); link?.classList.add('hidden');
    const status = this.root.querySelector('#agendaPreviewState'); if (status) status.textContent = 'Updating preview…';
    this.timer = setTimeout(() => void this.updatePreview(), 700);
  }
  async updatePreview() {
    if (!this.record) return; const sequence = ++this.sequence;
    try {
      const blob = await this.api(`/api/agendas/${this.record.id}/preview`, { method: 'POST', body: JSON.stringify({ draft: this.draft }) });
      if (sequence !== this.sequence) return; if (this.url) URL.revokeObjectURL(this.url); this.url = URL.createObjectURL(blob);
      await this.preview.show(new Uint8Array(await blob.arrayBuffer())); if (sequence !== this.sequence) return;
      const link = this.root.querySelector('#agendaDownload'); link.href = this.url; link.download = `Stone_Square_22_Agenda_${this.draft.meetingDate || 'Draft'}.pdf`; link.classList.remove('hidden');
      this.root.querySelector('#agendaPreviewState').textContent = 'Preview matches the current fields.';
    } catch (error) { if (sequence === this.sequence) { this.root.querySelector('#agendaPreviewState').textContent = error.message; } }
  }
  async save() {
    const { agenda } = await this.api(`/api/agendas/${this.record.id}`, { method: 'PUT', body: JSON.stringify({ revision: this.record.revision, draft: this.draft }) });
    this.record = agenda; this.draft = clone(agenda.draft); this.dirty = false;
    this.saveState(this.savedLabel(agenda.updatedAt));
  }
}
