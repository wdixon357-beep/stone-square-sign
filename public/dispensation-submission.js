/* The same packet is used by the website and the native Mac app.
 * Saving a corresponding report is separate from sending an email. The shared
 * service must explicitly enable delivery before any sending controls appear. */
export async function renderDispensationSubmission(container, { document: record, apiFetch, previewPdf }) {
  container.replaceChildren();
  container.className = 'dispensation-delivery';
  container.dataset.preserveRefresh = 'false';
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const heading = element('h4', 'District Deputy submission');
  const status = element('p', 'Loading delivery details…', 'delivery-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  container.append(heading, status);
  let packet;
  try {
    ({ packet } = await apiFetch(`/api/documents/${record.id}/submission-packet`));
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
    return;
  }
  const automaticDeliveryEnabled = packet.automaticDeliveryEnabled === true;
  const fullySigned = record.status === 'completed';
  status.textContent = packet.message;
  status.dataset.state = packet.state;
  if (!automaticDeliveryEnabled) {
    const notice = element('p', 'Automatic District Deputy email is turned off. Review the signed dispensation and corresponding event proposal report, download both PDFs, and send them manually from your email client. Saving a supporting report here does not send email.', 'delivery-manual-notice');
    container.append(notice);
  }
  const recoverWrite = async error => {
    // A connection can end after the server accepts an upload or confirmation.
    // Read the shared record before offering the same action again.
    try {
      const latest = (await apiFetch(`/api/documents/${record.id}/submission-packet`)).packet;
      if (latest.state !== packet.state || latest.report?.sha256 !== packet.report?.sha256
          || latest.delivery?.attemptedAt !== packet.delivery?.attemptedAt) {
        await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf });
        container.dispatchEvent(new CustomEvent('delivery-updated', { bubbles: true }));
        return true;
      }
    } catch { /* Preserve the original failure if the readback is unavailable. */ }
    status.textContent = error.message;
    return false;
  };
  if (packet.recipient?.to || packet.draft?.to || packet.delivery?.to) {
    container.append(element('p', `Recipient: ${packet.recipient?.name || packet.draft?.name || 'District Deputy'} <${packet.recipient?.to || packet.draft?.to || packet.delivery.to}>`));
  }
  const attachments = element('ul', null, 'delivery-attachments');
  attachments.append(element('li', fullySigned ? 'Fully signed dispensation PDF' : 'Dispensation PDF, awaiting secretary signature'));
  attachments.append(element('li', packet.report ? `Supporting report: ${packet.report.filename}` : 'Supporting report: not attached yet'));
  container.append(attachments);
  if (packet.report) {
    const view = element('button', 'View supporting report', 'secondary compact');
    view.type = 'button';
    view.addEventListener('click', async () => {
      view.disabled = true;
      try { previewPdf(await apiFetch(`/api/documents/${record.id}/supporting-report`), packet.report.filename); }
      catch (error) { status.textContent = error.message; }
      finally { view.disabled = false; }
    });
    container.append(view);
  }
  if (automaticDeliveryEnabled && packet.draft?.body) {
    const details = element('details');
    details.append(element('summary', 'Email summary and attachments'));
    details.append(element('p', packet.draft.subject), element('pre', packet.draft.body));
    container.append(details);
  }
  // An already prepared delivery packet is immutable. A late duplicate upload
  // must not silently replace the report that was emailed.
  // An older server can still auto-send on upload. Require an explicit safe-save
  // capability before presenting an upload as an archive-only action.
  if (packet.automaticDeliveryEnabled === false && !packet.reportLocked && !['sent', 'sending', 'failed', 'uncertain'].includes(packet.state) && !packet.draft?.preparedAt) {
    const form = element('form', null, 'delivery-report-form');
    const label = element('label', packet.report ? 'Replace the supporting report PDF' : 'Attach the corresponding report PDF');
    const file = element('input');
    file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.required = true;
    file.addEventListener('change', () => { container.dataset.preserveRefresh = String(Boolean(file.files?.length)); });
    label.append(file);
    const instructions = element('p', !automaticDeliveryEnabled
      ? 'Save the matching report with this dispensation for review and download. Nothing will be emailed.'
      : fullySigned
      ? 'This dispensation is signed. Attaching its report will automatically email both PDFs to the District Deputy.'
      : 'Once Adrian Reese or William McDuffie signs, both PDFs will be emailed automatically to the District Deputy.');
    const source = element('p', 'Choose the matching report from “Stone Square Dispensation Reports” on your Desktop or “Dispensation Reports - Oct 2026” in Dropbox.', 'delivery-source-hint');
    const save = element('button', automaticDeliveryEnabled && fullySigned ? 'Attach report and email both PDFs' : 'Save supporting report', 'primary compact');
    save.type = 'submit';
    form.append(label, source, instructions, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!file.files?.[0]) return;
      if (file.files[0].size > 12 * 1024 * 1024) {
        status.textContent = 'Choose a PDF smaller than 12 MB.';
        return;
      }
      save.disabled = true; file.disabled = true;
      container.dataset.preserveRefresh = 'true';
      status.textContent = 'Saving the supporting report…';
      const data = new FormData();
      data.append('report', file.files[0]); data.append('sourceLabel', 'Dashboard file selection');
      try {
        await apiFetch(`/api/documents/${record.id}/supporting-report`, { method: 'PUT', body: data });
        await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf });
        container.dispatchEvent(new CustomEvent('delivery-updated', { bubbles: true }));
      } catch (error) {
        if (!await recoverWrite(error)) { save.disabled = false; file.disabled = false; }
      }
    });
    container.append(form);
  }
  if (automaticDeliveryEnabled && packet.state === 'failed') {
    const retry = element('button', 'Retry delivery of both PDFs', 'primary compact');
    retry.type = 'button';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        await apiFetch(`/api/documents/${record.id}/submit`, { method: 'POST', body: '{}' });
        await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf });
        container.dispatchEvent(new CustomEvent('delivery-updated', { bubbles: true }));
      } catch (error) { if (!await recoverWrite(error)) retry.disabled = false; }
    });
    container.append(retry);
  }
  if (automaticDeliveryEnabled && packet.state === 'uncertain') {
    const form = element('form', null, 'delivery-report-form');
    const instruction = element('p', 'Check with the District Deputy before resolving this delivery. Record what you confirmed below. A retry is permitted only after you confirm the email was not received.');
    const label = element('label', 'Delivery confirmation note');
    const note = element('textarea');
    note.required = true; note.minLength = 10; note.maxLength = 600; note.rows = 3;
    note.addEventListener('input', () => { container.dataset.preserveRefresh = String(Boolean(note.value)); });
    label.append(note);
    const delivered = element('button', 'Confirm already delivered', 'secondary compact');
    delivered.type = 'submit'; delivered.dataset.outcome = 'delivered';
    const notDelivered = element('button', 'Confirmed not delivered; retry email', 'primary compact');
    notDelivered.type = 'submit'; notDelivered.dataset.outcome = 'not_delivered';
    form.append(instruction, label, delivered, notDelivered);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const outcome = event.submitter?.dataset.outcome;
      if (!outcome || note.value.trim().length < 10) return;
      delivered.disabled = true; notDelivered.disabled = true;
      container.dataset.preserveRefresh = 'true';
      try {
        await apiFetch(`/api/documents/${record.id}/submission-resolution`, {
          method: 'POST', body: JSON.stringify({ outcome, note: note.value.trim(), expectedAttemptedAt: packet.delivery?.attemptedAt }),
        });
        await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf });
        container.dispatchEvent(new CustomEvent('delivery-updated', { bubbles: true }));
      } catch (error) {
        if (!await recoverWrite(error)) { delivered.disabled = false; notDelivered.disabled = false; }
      }
    });
    container.append(form);
  }
}
