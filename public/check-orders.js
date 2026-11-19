import { easternDateKey, formatEasternTimestamp } from './eastern-time.js';

const endpoint = '/api/check-orders';
const maxDocumentBytes = 2 * 1024 * 1024;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const displayDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? dateLabel.format(new Date(`${value}T12:00:00Z`)) : '';
const statusLabels = {
  awaiting_secretaries: 'Awaiting Secretary certification',
  ready_for_treasurer: 'Ready for Treasurer',
  payment_recorded: 'Payment recorded',
  filed: 'Filed',
  voided: 'Voided',
};
const roleLabels = { secretary: 'Secretary', assistant_secretary: 'Assistant Secretary', treasurer: 'Treasurer', assistant_treasurer: 'Assistant Treasurer' };
const actionLabels = { create: 'Check order signed and available to both Secretaries.', certify: 'Secretary certification recorded.', 'record-payment': 'Check details and Treasurer signature recorded.', file: 'Check order filed.', void: 'Check order voided.' };

function nextStep(order) {
  const { permissions = {} } = order;
  if (permissions.certify) return 'Your certification is needed.';
  if (permissions.recordPayment) return 'Record the issued check and sign.';
  if (permissions.file) return order.status === 'filed' ? 'Record the check delivery date.' : 'Enter the Lodge ledger reference to file this order.';
  if (order.status === 'awaiting_secretaries') {
    const remaining = (order.secretaries || []).filter(officer => !officer.signedAt).map(officer => officer.name);
    return remaining.length ? `Waiting for ${remaining.join(' and ')}.` : 'Waiting for both Secretaries to certify.';
  }
  if (order.status === 'ready_for_treasurer') return 'Either assigned Treasurer can record the issued check and sign.';
  if (order.status === 'payment_recorded') return 'A Secretary can file this order in the Lodge records.';
  return '';
}

const canAct = ({ permissions } = {}) => Boolean(permissions?.certify || permissions?.recordPayment || permissions?.file);

const readSupportingDocument = async file => {
  if (!file) return undefined;
  if (!/\.pdf$/i.test(file.name) || file.size > maxDocumentBytes || !file.size) throw new Error('Choose a PDF that is 2 MB or smaller.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { name: file.name, base64: btoa(binary) };
};

const detailField = (label, value) => value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '';
const orderPath = (order, action) => `${endpoint}/${encodeURIComponent(order.id)}/${action}`;

export class CheckOrdersWorkspace {
  constructor({ api, user, root = document.getElementById('checkOrdersSection') }) {
    this.api = api;
    this.user = user;
    this.root = root;
    this.epoch = 0;
    this.root.addEventListener('click', event => {
      const control = event.target.closest('[data-check-orders]');
      if (control) void this.handleClick(control);
    });
    this.root.addEventListener('submit', event => {
      const form = event.target.closest('[data-check-order-form]');
      if (!form) return;
      event.preventDefault();
      void this.submit(form);
    });
    const markDirty = event => {
      if (event.target.closest('[data-check-order-form]')) this.dirty = true;
    };
    this.root.addEventListener('input', markDirty);
    this.root.addEventListener('change', markDirty);
    this.dispose();
  }

  dispose() {
    this.epoch += 1;
    this.orders = [];
    this.view = 'list';
    this.dirty = false;
    this.busy = false;
    this.loading = false;
    this.loaded = false;
    this.loadFailed = false;
    this.refreshPending = false;
    this.replaceDetailOnRefresh = false;
    this.order = null;
    this.createAttempt = null;
    this.root.replaceChildren();
  }

  initialize() {
    if (this.root.children.length) return;
    const isOwner = this.user()?.role === 'owner';
    this.root.innerHTML = `<div class="check-order-toolbar"><button type="button" class="secondary" data-check-orders="list" hidden>All check orders</button>
      <div class="check-order-actions"><button type="button" class="secondary" data-check-orders="refresh">Refresh</button>
      ${isOwner ? '<button type="button" class="primary" data-check-orders="new">New check order</button>' : ''}</div></div>
      <p class="message check-order-message" role="status" aria-live="polite"></p>
      <div data-check-order-content></div>`;
    this.renderList();
  }

  content() { return this.root.querySelector('[data-check-order-content]'); }

  message(text = '', error = false) {
    const container = this.root.querySelector('.check-order-message');
    if (!container) return;
    container.textContent = text;
    container.classList.toggle('error', error);
    container.classList.toggle('success', Boolean(text) && !error);
  }

  async open() {
    this.initialize();
    await this.load();
  }

  async load({ replaceDetail = false } = {}) {
    if (this.busy || this.loading) {
      this.replaceDetailOnRefresh ||= replaceDetail;
      this.refreshPending = true;
      return;
    }
    if (!this.content()) return;
    this.loading = true;
    const epoch = this.epoch;
    try {
      const { orders } = await this.api(endpoint, { cache: 'no-store' });
      if (epoch !== this.epoch) return;
      this.loaded = true;
      this.loadFailed = false;
      this.orders = orders;
      if (this.view === 'list') this.renderList();
      if (this.view !== 'detail' || (this.dirty && !replaceDetail)) return;
      const current = orders.find(order => order.id === this.order.id);
      if (!current) {
        this.renderList({ focus: true });
        this.message('This check order is no longer available to your account.', true);
      } else if (replaceDetail || current.revision !== this.order.revision) {
        this.renderOrder(current, { focus: this.content().contains(document.activeElement) });
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.loadFailed = true;
        if (this.view === 'list') this.renderList();
        this.message(error.message || 'Check orders could not be loaded.', true);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
        this.consumeRefresh();
      }
    }
  }

  consumeRefresh() {
    if (this.refreshPending && !this.busy && !this.loading) {
      const replaceDetail = this.replaceDetailOnRefresh;
      this.refreshPending = false;
      this.replaceDetailOnRefresh = false;
      void this.load({ replaceDetail });
    }
  }

  requestLiveRefresh() {
    this.refreshPending = true;
    this.consumeRefresh();
  }

  showContent(view, markup, focus) {
    this.view = view;
    this.dirty = false;
    const create = this.root.querySelector('[data-check-orders="new"]');
    if (create) create.hidden = view !== 'list';
    this.root.querySelector('[data-check-orders="refresh"]').hidden = view === 'create';
    this.root.querySelector('[data-check-orders="list"]').hidden = view === 'list';
    const content = this.content();
    content.innerHTML = markup;
    if (focus) {
      this.root.closest('.content')?.scrollTo?.({ top: 0 });
      content.querySelector('[data-check-order-focus]')?.focus();
    }
  }

  renderList({ focus = false } = {}) {
    this.order = null;
    const orders = [...this.orders].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const toDo = orders.filter(canAct);
    const otherOrders = orders.filter(order => !canAct(order));
    const focusedId = this.content()?.contains(document.activeElement) && document.activeElement?.dataset?.id;
    const rows = items => items.map(order => `<article class="panel check-order-row"><div class="check-order-row-copy">
      <h2>${esc(order.payee)}</h2><p><strong>${esc(currency.format(Number(order.amount)))}</strong><span class="check-order-status${canAct(order) ? ' is-actionable' : ''}">${esc(statusLabels[order.status])}</span></p>
      <p class="helper">${esc(nextStep(order) || formatEasternTimestamp(order.requestedAt))}</p></div>
      <button type="button" class="secondary" data-check-orders="open" data-id="${esc(order.id)}" aria-label="Review check order for ${esc(order.payee)}">Review</button></article>`).join('');
    const heading = (text, primary = false) => `<h2 class="check-order-list-heading" ${primary ? 'data-check-order-focus tabindex="-1"' : ''}>${text}</h2>`;
    const emptyText = this.loadFailed ? 'Use Refresh to load check orders.' : this.loaded ? 'No check orders are available.' : 'Loading check orders…';
    const empty = orders.length ? '' : `<p class="check-order-empty">${emptyText}</p>`;
    const outstanding = toDo.length ? `${heading('Needs your action', true)}${rows(toDo)}` : '';
    const remaining = otherOrders.length || !toDo.length ? `${heading(toDo.length ? 'Other requests' : 'Requests', !toDo.length)}${rows(otherOrders)}${empty}` : '';
    this.showContent('list', outstanding + remaining, focus);
    if (!focus && focusedId) [...this.content().querySelectorAll('[data-check-orders="open"]')].find(button => button.dataset.id === focusedId)?.focus({ preventScroll: true });
  }

  showCreate() {
    if (this.user()?.role !== 'owner' || this.view === 'create') return;
    this.order = null;
    this.showContent('create', `<section class="panel check-order-panel"><h2 data-check-order-focus tabindex="-1">New check order</h2>
      <form data-check-order-form="create"><fieldset class="check-order-fields">
        <label>Payee<input name="payee" maxlength="160" required></label>
        <label>Amount in dollars<input name="amount" inputmode="decimal" placeholder="0.00" pattern="[0-9]{1,9}([.][0-9]{1,2})?" maxlength="12" required></label>
        <label class="check-order-wide">Reason for payment<textarea name="reason" rows="4" maxlength="1200" required></textarea></label>
        <label class="check-order-wide">Lodge authorization reference<input name="authorizationReference" maxlength="240" placeholder="Meeting date and motion or document reference" required></label>
        <label>Account category <span>(optional)</span><input name="category" maxlength="150"></label>
        <label>Supporting reference <span>(optional)</span><input name="supportingReference" maxlength="240"></label>
        <label class="check-order-wide">Supporting PDF <span>(optional, up to 2 MB)</span><input type="file" name="supportingDocument" accept="application/pdf,.pdf"></label>
        <div class="check-order-actions check-order-wide"><button type="submit" class="primary">Sign and request</button></div>
      </fieldset></form></section>`, true);
  }

  renderOrder(order, { focus = false } = {}) {
    this.order = order;
    const { permissions = {} } = order;
    const officers = (list, alternative) => (list || []).map(officer => {
      const detail = officer.signedAt ? `Signed ${formatEasternTimestamp(officer.signedAt)}` : alternative;
      return `<li><strong>${esc(officer.name)}</strong>${roleLabels[officer.role] ? `<small>${roleLabels[officer.role]}</small>` : ''}<span>${esc(detail)}</span></li>`;
    }).join('');
    const secretarySignatures = officers(order.secretaries, order.status === 'voided' ? 'Voided' : 'Certification pending');
    const treasurerStatus = { awaiting_secretaries: 'Awaiting certification', ready_for_treasurer: 'Available to sign', voided: 'Voided' };
    const treasurerSignatures = officers(order.treasurers, treasurerStatus[order.status] || 'Alternate signer');
    const checkDetails = order.paidAt ? `<section><h3>Issued check</h3><dl class="check-order-facts">
        ${detailField('Check number', order.checkNumber)}${detailField('Date issued', displayDate(order.issuedOn))}
        ${detailField('Recorded by', order.paidBy)}${detailField('Signed', formatEasternTimestamp(order.paidAt))}</dl></section>` : '';
    const filing = order.filedAt ? `<section><h3>Lodge records</h3><dl class="check-order-facts">
        ${detailField('Ledger reference', order.ledgerReference)}${detailField('Date delivered', displayDate(order.deliveredOn))}
        ${detailField('Filed by', order.filedBy)}${detailField('Filed', formatEasternTimestamp(order.filedAt))}
        ${detailField('Delivery recorded by', order.deliveryRecordedBy)}
        ${detailField('Delivery recorded', order.deliveryRecordedAt && formatEasternTimestamp(order.deliveryRecordedAt))}
        ${detailField('Notes', order.filingNotes)}</dl></section>` : '';
    const attachmentAction = order.supportingDocumentName
      ? `<button type="button" class="secondary" data-check-orders="supporting-document">Download supporting PDF</button>` : '';
    this.showContent('detail', `<article class="panel check-order-panel"><header class="check-order-detail-header"><div>
        <h2 data-check-order-focus tabindex="-1">${esc(order.payee)}</h2><p class="check-order-amount">${esc(currency.format(Number(order.amount)))}</p>
        </div><span class="check-order-status${canAct(order) ? ' is-actionable' : ''}">${esc(statusLabels[order.status])}</span></header>
        <dl class="check-order-facts">
          ${detailField('Requested by', order.requestedBy)}${detailField('Signed', formatEasternTimestamp(order.requestedAt))}
          ${detailField('Payment reason', order.reason)}${detailField('Lodge authorization reference', order.authorizationReference)}
          ${detailField('Account category', order.category)}
          ${detailField('Supporting reference', order.supportingReference)}${detailField('Supporting PDF', order.supportingDocumentName)}
          ${detailField('Reason voided', order.voidReason)}</dl>
        <div class="check-order-actions"><button type="button" class="secondary" data-check-orders="pdf">Download check order PDF</button>${attachmentAction}</div>
        <div class="check-order-routing">
          <section><h3>Secretary certification</h3><ul>${secretarySignatures}</ul></section>
          <section><h3>Treasurer signature</h3><ul>${treasurerSignatures}</ul></section></div>
        ${checkDetails}${filing}
      </article>
      ${this.actionMarkup(order)}
      ${permissions.void ? `<details class="panel check-order-panel check-order-void"><summary>Void check order</summary>
        <form data-check-order-form="void"><fieldset class="check-order-fields">
          <label class="check-order-wide">Reason for voiding<textarea name="reason" rows="2" maxlength="600" required></textarea></label>
          <div class="check-order-actions check-order-wide"><button type="submit" class="secondary danger-text">Void check order</button></div>
        </fieldset></form></details>` : ''}`, focus);
  }

  actionMarkup(order) {
    const { permissions = {} } = order;
    if (permissions.certify) return `<section class="panel check-order-panel"><h2>Certify check order</h2>
      <p class="helper">Confirm you received and recorded this request for the Treasurer.</p>
      <form data-check-order-form="certify"><fieldset class="check-order-fields"><div class="check-order-actions"><button type="submit" class="primary">Certify and sign</button></div></fieldset></form></section>`;
    if (permissions.recordPayment) {
      const certifiedAt = (order.secretaries || []).map(officer => officer.signedAt).filter(Boolean).sort().at(-1);
      const earliestDate = certifiedAt ? easternDateKey(new Date(certifiedAt)) : '';
      return `<section class="panel check-order-panel"><h2>Record an issued check</h2>
      <p class="helper">Enter the check details after it has been issued. Your signature records the payment in the dashboard.</p>
      <form data-check-order-form="record-payment"><fieldset class="check-order-fields">
        <label>Check number<input name="checkNumber" maxlength="60" required></label>
        <label>Date check issued<input name="issuedOn" type="date" min="${esc(earliestDate)}" max="${esc(easternDateKey())}" required></label>
        <div class="check-order-actions check-order-wide"><button type="submit" class="primary">Record payment and sign</button></div>
      </fieldset></form></section>`;
    }
    if (permissions.file) {
      const recordingDelivery = order.status === 'filed';
      return `<section class="panel check-order-panel"><h2>${recordingDelivery ? 'Record check delivery' : 'File in Lodge records'}</h2>
        <form data-check-order-form="file"><fieldset class="check-order-fields">
          <label>Ledger reference<input name="ledgerReference" value="${esc(order.ledgerReference)}" maxlength="120" required ${recordingDelivery ? 'readonly' : ''}></label>
          <label>Date check delivered ${recordingDelivery ? '' : '<span>(optional)</span>'}<input name="deliveredOn" type="date" min="${esc(order.issuedOn)}" max="${esc(easternDateKey())}" ${recordingDelivery ? 'required' : ''}></label>
          <label class="check-order-wide">Filing notes <span>(optional)</span><textarea name="filingNotes" maxlength="600" rows="3" ${recordingDelivery ? 'readonly' : ''}>${esc(order.filingNotes)}</textarea></label>
          <div class="check-order-actions check-order-wide"><button type="submit" class="primary">${recordingDelivery ? 'Record delivery' : 'File check order'}</button></div>
        </fieldset></form></section>`;
    }
    const step = nextStep(order);
    return step ? `<p class="helper check-order-next">${esc(step)}</p>` : '';
  }

  async handleClick(control) {
    if (this.busy) return;
    const action = control.dataset.checkOrders;
    if (action === 'new' && this.view === 'create') return;
    if (this.dirty && this.view === 'create' && action === 'refresh') return this.load();
    if (['list', 'new', 'refresh'].includes(action) && this.dirty && !window.confirm('Discard the unsaved entries on this screen?')) return;
    if (action === 'refresh') {
      this.message();
      return this.load({ replaceDetail: true });
    }
    if (action === 'list') {
      this.message();
      return this.renderList({ focus: true });
    }
    if (action === 'new') {
      this.message();
      return this.showCreate();
    }
    if (action === 'open') {
      const order = this.orders.find(item => item.id === control.dataset.id);
      if (order) {
        this.message();
        this.renderOrder(order, { focus: true });
      }
      return;
    }
    if (['pdf', 'supporting-document'].includes(action) && this.order) await this.download(this.order, action, control);
  }

  async download(order, action, control) {
    const epoch = this.epoch;
    control.disabled = true;
    try {
      const blob = await this.api(orderPath(order, action));
      if (epoch !== this.epoch) return;
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = action === 'pdf' ? `Stone_Square_Check_Order_${order.id}.pdf` : order.supportingDocumentName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (epoch === this.epoch) this.message(error.message || 'The PDF could not be downloaded.', true);
    } finally {
      control.disabled = false;
    }
  }

  confirmation(action, order, fields) {
    const money = currency.format(Number(fields.amount || order?.amount));
    const payee = fields.payee || order?.payee;
    if (action === 'create') return `Confirm the Lodge authorized a check for ${money} payable to ${payee}, as recorded in ${fields.authorizationReference}. Apply your saved signature and request the check? Both Secretaries must certify.`;
    if (action === 'certify') return `Confirm you reviewed the ${money} check order payable to ${payee}, its Lodge authorization, and any supporting record. Apply your saved signature to certify?`;
    if (action === 'record-payment') return `Confirm check ${fields.checkNumber} was already issued on ${displayDate(fields.issuedOn)} for ${money} payable to ${payee}. Apply your saved signature to record it?`;
    if (action === 'void') return `Void the ${money} check order payable to ${payee}? Use this only before any check has been issued for the order.`;
    return '';
  }

  async submit(form) {
    if (this.busy) return;
    const action = form.dataset.checkOrderForm;
    const order = this.order;
    if (action !== 'create' && !order) return;
    if (action === 'create' && this.user()?.role !== 'owner') return;
    const formData = new FormData(form);
    const attachment = formData.get('supportingDocument');
    formData.delete('supportingDocument');
    const fields = Object.fromEntries([...formData].map(([key, value]) => [key, value.trim()]));
    if ([...form.querySelectorAll('[required]')].some(input => !fields[input.name])) return this.message('Complete all required fields first.', true);
    if (action === 'create' && !(Number(fields.amount) > 0)) return this.message('Enter a check amount greater than zero.', true);
    const prompt = this.confirmation(action, order, fields);
    if (prompt && !window.confirm(prompt)) return;

    const epoch = this.epoch;
    this.busy = true;
    const fieldset = form.querySelector('fieldset');
    fieldset.disabled = true;
    this.message();
    try {
      let body = { ...fields, revision: order?.revision };
      if (['create', 'certify', 'record-payment'].includes(action)) body.consent = true;
      if (action === 'create') {
        const supportingDocument = await readSupportingDocument(attachment?.name ? attachment : null);
        if (epoch !== this.epoch) return;
        if (supportingDocument) body.supportingDocument = supportingDocument;
        const snapshot = JSON.stringify(body);
        if (snapshot !== this.createAttempt?.snapshot) this.createAttempt = { snapshot, id: crypto.randomUUID() };
        body = { ...body, clientRequestId: this.createAttempt.id };
      }
      const path = action === 'create' ? endpoint : orderPath(order, action);
      const { order: updated } = await this.api(path, { method: 'POST', body: JSON.stringify(body) });
      if (epoch !== this.epoch) return;
      if (action === 'create') this.createAttempt = null;
      this.orders = [updated, ...this.orders.filter(item => item.id !== updated.id)];
      this.renderOrder(updated, { focus: true });
      this.message(action === 'file' && order.status === 'filed' ? 'Check delivery recorded.' : actionLabels[action]);
    } catch (error) {
      if (epoch === this.epoch) {
        const explanation = error.status === 409 ? ' Refresh the order to see its current status.' : '';
        this.message(`${error.message || 'The check order could not be saved.'}${explanation}`, true);
      }
    } finally {
      if (epoch === this.epoch) {
        fieldset.disabled = false;
        this.busy = false;
        this.consumeRefresh();
      }
    }
  }
}
