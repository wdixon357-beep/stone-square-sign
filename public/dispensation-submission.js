/* The owner-only packet is used by the website and the native Mac app.
 * A saved Missive draft is not a sent message. Historical delivery evidence
 * remains separate from draft preparation. */
export function safeMissiveDraftURL(draft) {
  if (draft?.state !== 'drafted' || typeof draft.url !== 'string') return null;
  try {
    const url = new URL(draft.url);
    return url.protocol === 'https:' && url.hostname === 'mail.missiveapp.com'
      && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

const missiveDraftTitles = {
  not_requested: 'No Missive draft was requested',
  not_configured: 'Missive connection needs attention',
  awaiting_signature: 'Waiting for the secretary signature',
  awaiting_report: 'Attach the corresponding report to prepare the draft',
  pending: 'Missive draft is queued',
  creating: 'Preparing the Missive draft',
  drafted: 'Missive draft saved for your review',
  uncertain: 'Draft creation needs verification',
  failed: 'Missive draft could not be created',
};

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
  const preparesMissiveDraft = packet.missiveDraft && packet.missiveDraft.state !== 'not_requested';
  const draftControls = [];
  status.textContent = packet.message;
  status.dataset.state = packet.state;
  if (!automaticDeliveryEnabled) {
    const notice = element('p', preparesMissiveDraft
      ? 'Automatic District Deputy email sending is off. After the secretary signs and the corresponding report is saved, the dashboard prepares an unsent Missive draft for you to review and send. Saving a supporting report here does not send email.'
      : 'Automatic District Deputy email is turned off. Review the signed dispensation and corresponding event proposal report, download both PDFs, and send them manually from your email client. Saving a supporting report here does not send email.', 'delivery-manual-notice');
    container.append(notice);
  }
  const recoverWrite = async error => {
    // A connection can end after the server accepts an upload or confirmation.
    // Read the shared record before offering the same action again.
    try {
      const latest = (await apiFetch(`/api/documents/${record.id}/submission-packet`)).packet;
      if (latest.state !== packet.state || latest.report?.sha256 !== packet.report?.sha256
          || latest.delivery?.attemptedAt !== packet.delivery?.attemptedAt
          || latest.missiveDraft?.state !== packet.missiveDraft?.state
          || latest.missiveDraft?.draftId !== packet.missiveDraft?.draftId
          || latest.missiveDraft?.updatedAt !== packet.missiveDraft?.updatedAt) {
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
  const dispensationFilename = packet.draft?.filename || record.original_name || record.originalName;
  attachments.append(element('li', `${fullySigned ? 'Fully signed dispensation PDF' : 'Dispensation PDF, awaiting secretary signature'}${dispensationFilename ? `: ${dispensationFilename}` : ''}`));
  attachments.append(element('li', packet.report ? `Supporting report: ${packet.report.filename}` : 'Supporting report: not attached yet'));
  container.append(attachments);
  if (packet.missiveDraft) {
    const draft = packet.missiveDraft;
    const draftPanel = element('section', null, 'missive-draft-status');
    draftPanel.append(element('h4', 'Missive email draft'));
    const draftStatus = element('p', missiveDraftTitles[draft.state] || 'Missive draft status is unavailable', 'delivery-status');
    draftStatus.setAttribute('role', 'status');
    draftStatus.setAttribute('aria-live', 'polite');
    draftStatus.dataset.state = draft.state;
    draftPanel.append(draftStatus);
    if (draft.message) draftPanel.append(element('p', draft.message));
    if (draft.state === 'not_requested') {
      draftPanel.append(element('p', 'This earlier completed dispensation has no automatic draft request. No Missive draft has been created for it.'));
    } else {
      draftPanel.append(element('p', 'This draft is for your review. You choose when to send it in Missive.'));
    }
    if (draft.state === 'uncertain') {
      draftPanel.append(element('p', 'Check Missive before creating another draft. Its creation has not been confirmed.'));
    }
    if (draft.subject || draft.body) {
      const summary = element('details');
      summary.open = true;
      summary.append(element('summary', 'Brief email summary'));
      if (draft.subject) summary.append(element('p', `Subject: ${draft.subject}`));
      if (draft.body) summary.append(element('pre', draft.body));
      draftPanel.append(summary);
    }
    if (draft.state === 'drafted' && draft.createdAt) {
      const created = new Date(draft.createdAt);
      if (Number.isFinite(created.getTime())) {
        draftPanel.append(element('p', `Draft saved: ${created.toLocaleString()}`));
      }
    }
    const missiveURL = safeMissiveDraftURL(draft);
    const draftActions = element('div', null, 'delivery-report-form');
    if (missiveURL) {
      const open = element('a', 'Open Missive draft', 'button-link primary compact');
      open.href = missiveURL;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      draftActions.append(open);
    } else if (draft.state === 'drafted') {
      draftPanel.append(element('p', 'The draft is saved. Open Missive to review it; its direct link is unavailable.'));
    }
    const refresh = element('button', 'Refresh draft status', 'secondary compact');
    refresh.type = 'button';
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf });
    });
    draftActions.append(refresh);
    draftControls.push(refresh);
    const verifyExisting = draft.state === 'uncertain' && draft.canRetry === true
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.draftId || '');
    if ((draft.state === 'failed' && draft.canRetry === true && !draft.draftId) || verifyExisting) {
      const retry = element('button', verifyExisting ? 'Verify existing Missive draft' : 'Try creating the draft again', 'secondary compact');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        refresh.disabled = true;
        container.dataset.preserveRefresh = 'true';
        draftStatus.textContent = verifyExisting ? 'Checking the existing Missive draft…' : 'Preparing the Missive draft…';
        try {
          await apiFetch(`/api/documents/${record.id}/missive-draft/retry`, { method: 'POST', body: '{}' });
          await renderDispensationSubmission(container, { document: record, apiFetch, previewPdf });
          container.dispatchEvent(new CustomEvent('delivery-updated', { bubbles: true }));
        } catch (error) {
          if (!await recoverWrite(error)) {
            draftStatus.textContent = 'Refresh draft status before trying again. A draft may already have been saved.';
            refresh.disabled = false;
            container.dataset.preserveRefresh = 'false';
          }
        }
      });
      draftActions.append(retry);
      draftControls.push(retry);
    }
    draftPanel.append(draftActions);
    container.append(draftPanel);
  }
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
  // An already prepared delivery packet is immutable. A late duplicate upload
  // must not silently replace the report that was emailed.
  // An older server can still auto-send on upload. Require an explicit safe-save
  // capability before presenting an upload as an archive-only action.
  if (packet.automaticDeliveryEnabled === false && !packet.reportLocked && !['sent', 'sending', 'failed', 'uncertain'].includes(packet.state) && !packet.draft?.preparedAt) {
    const form = element('form', null, 'delivery-report-form');
    const label = element('label', packet.report ? 'Replace the supporting report PDF' : 'Attach the corresponding report PDF');
    const file = element('input');
    file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.required = true;
    file.addEventListener('change', () => {
      const hasFile = Boolean(file.files?.length);
      container.dataset.preserveRefresh = String(hasFile);
      for (const control of draftControls) control.disabled = hasFile;
    });
    label.append(file);
    const instructions = element('p', preparesMissiveDraft
      ? 'Save the matching report with this dispensation. Once both documents are ready, an unsent Missive draft can be prepared. Saving a report does not send an email.'
      : 'Save the matching report with this dispensation for review and download. Nothing will be emailed.');
    const source = element('p', 'Choose the matching report from “Stone Square Dispensation Reports” on your Desktop or “Dispensation Reports - Oct 2026” in Dropbox.', 'delivery-source-hint');
    const save = element('button', 'Save supporting report', 'primary compact');
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
}
