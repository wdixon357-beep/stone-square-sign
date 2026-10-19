const origin = 'https://request.stonesquare22pha.org';
const $ = id => document.getElementById(id);
const MAX_SOURCE = 60000;
const MAX_FILE = 12 * 1024 * 1024;
let context = null, account = null, suggestions = null, sourceKey = '', pendingImport = null;
let busy = false, checking = false, authEpoch = 0, sourceRevision = 0, authSerial = 0;
let uploadFocusPending = new URL(window.location.href).searchParams.get('mode') === 'upload';
const status = (text, error = false) => { $('status').textContent = text; $('status').dataset.tone = error ? 'error' : ''; };
const accountKey = user => user ? `${user.id}:${user.email}` : '';
const connected = () => Boolean(context && window.opener && !window.opener.closed);
const currentKey = () => `${authEpoch}:${accountKey(account)}:${context?.accountEmail || ''}`;
const resetSuggestions = () => { suggestions = null; $('suggestions').hidden = true; $('apply').disabled = true; };
const sourceChanged = () => {
  sourceRevision += 1;
  resetSuggestions();
  $('sourceCount').textContent = `${$('source').value.length.toLocaleString()} of 60,000 characters`;
};
const syncControls = () => {
  const ready = Boolean(account && connected() && !checking);
  $('workspace').hidden = !(account && connected());
  $('chooseReport').disabled = !ready || busy;
  $('organize').disabled = !ready || busy;
  $('apply').disabled = !ready || busy || !suggestions || !Object.keys(suggestions.fields).length;
  $('confirmImport').disabled = !ready || busy || !pendingImport;
  $('cancelImport').disabled = busy;
  $('check').disabled = busy || checking;
  $('assistant').setAttribute('aria-busy', String(busy || checking));
};
const api = async (path, body) => {
  const multipart = body instanceof FormData;
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials:'same-origin',
    headers: { 'X-Stone-Square-Client': 'web', ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
  let data;
  try { data = await response.json(); } catch { throw new Error('The request could not be completed. Your notes have not changed.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'The request could not be completed.'), { status: response.status });
  return data;
};
const forgetAccount = () => {
  if (account) authEpoch += 1;
  account = null;
  resetSuggestions();
  pendingImport = null;
  $('pendingImport').hidden = true;
};
async function verifyAccount() {
  const payload = await api('/api/auth/me');
  const user = payload?.user;
  const next = user && Number.isInteger(user.id) && typeof user.email === 'string'
    ? { id: user.id, email: user.email.trim().toLowerCase() } : null;
  if (!next || !Array.isArray(user.permissions) || !user.permissions.includes('reports.create')) {
    forgetAccount();
    throw Object.assign(new Error('Report Generator access is not enabled for this account.'), { status: 403 });
  }
  if (!context || next.email !== context.accountEmail) {
    forgetAccount();
    throw Object.assign(new Error('This assistant belongs to a different Dashboard account. Open it again from your report using the same account.'), { status: 401 });
  }
  if (accountKey(next) !== accountKey(account)) {
    forgetAccount(); account = next; authEpoch += 1;
  }
  $('signin').hidden = true;
  return currentKey();
}
const showError = error => {
  if (error.status === 401 || error.status === 403) { forgetAccount(); $('signin').hidden = false; }
  status(error.message || 'The request could not be completed. Your notes have not changed.', true);
};
async function check() {
  if (busy) return;
  const serial = ++authSerial;
  checking = true; syncControls();
  try {
    await verifyAccount();
    if (serial !== authSerial) return;
    status(connected() ? 'Your report is connected. Upload a document or paste notes to begin.' : 'Open this assistant from the Report Generator.');
  } catch (error) {
    if (serial !== authSerial) return;
    showError(error);
  } finally {
    if (serial === authSerial) {
      checking = false; syncControls();
      if (uploadFocusPending && account && connected()) { uploadFocusPending = false; $('chooseReport').focus(); }
    }
  }
}
window.addEventListener('message', event => {
  if (event.origin !== origin || event.source !== window.opener || event.data?.kind !== 'report-assistant-context' || context) return;
  const value = event.data.context;
  if (!value || !['officer', 'committee', 'event', 'formal'].includes(value.type) || typeof value.master !== 'boolean'
    || typeof value.accountEmail !== 'string' || value.accountEmail.length > 180
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.accountEmail.trim())
    || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)
    || Object.entries(value.fields).some(([key, text]) => !/^[a-zA-Z]{1,20}$/.test(key) || typeof text !== 'string' || text.length > 20000)
    || Object.keys(value.fields).length > 60) return;
  context = { type: value.type, master: value.master, accountEmail: value.accountEmail.trim().toLowerCase(), fields: structuredClone(value.fields) };
  void check();
});
$('check').onclick = check;
window.addEventListener('focus', () => { if (context && !busy) void check(); });
$('source').oninput = sourceChanged;
$('chooseReport').onclick = () => { if (account && connected() && !busy && !checking) $('reportFile').click(); };
const importError = message => { $('importError').textContent = message; $('importError').hidden = false; };
const clearPending = () => { pendingImport = null; $('pendingImport').hidden = true; $('importedPreview').value = ''; syncControls(); };
const showImportMetadata = result => {
  $('importSummary').hidden = false;
  $('importFilename').textContent = `${result.filename} · ${result.characters.toLocaleString()} characters`;
  $('importWarnings').replaceChildren();
  for (const warning of result.warnings) { const item = document.createElement('li'); item.textContent = warning; $('importWarnings').append(item); }
};
const validImport = result => result && typeof result.source === 'string' && Boolean(result.source.trim())
  && result.source.length <= MAX_SOURCE && result.characters === result.source.length
  && typeof result.filename === 'string' && result.filename.length > 0 && result.filename.length <= 255
  && ['docx', 'pdf', 'txt'].includes(result.format) && /^[a-f0-9]{64}$/.test(result.sha256)
  && Array.isArray(result.warnings) && result.warnings.length <= 30
  && result.warnings.every(warning => typeof warning === 'string' && warning.length <= 4000);
function commitImport(result, nextSource) {
  $('source').value = nextSource;
  sourceChanged(); clearPending(); showImportMetadata(result);
  $('importMessage').textContent = 'Document text added. Review it below before organizing your report.';
  status('Review the extracted text, then choose Organize report. Your report fields have not changed.');
  $('source').focus();
}
$('reportFile').onchange = async () => {
  const file = $('reportFile').files?.[0];
  $('reportFile').value = '';
  if (!file || busy || !account || !connected()) return;
  $('importError').hidden = true;
  if (!/\.(docx|pdf|txt)$/i.test(file.name)) return importError('Choose a Word document (.docx), a PDF, or a text file (.txt). Your current notes have not changed.');
  if (file.size > MAX_FILE) return importError('Choose a file no larger than 12 MB. Your current notes have not changed.');
  if (!file.size) return importError('This file is empty. Choose a document that contains report text.');
  busy = true; clearPending(); syncControls();
  $('importMessage').textContent = `Reading ${file.name}…`;
  status('Extracting document text. Your current notes and report fields remain unchanged.');
  try {
    const key = await verifyAccount();
    const fileDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const form = new FormData(); form.append('report', file);
    const result = await api('/api/reports/import-source', form);
    await verifyAccount();
    if (key !== currentKey() || !connected()) throw new Error('The report connection changed. Your notes have not changed. Reopen the assistant from your report.');
    if (!validImport(result) || result.sha256 !== fileDigest) throw new Error('The extracted document could not be verified against the chosen file. Your notes have not changed. Try the upload again.');
    if (!$('source').value.trim()) commitImport(result, result.source);
    else {
      pendingImport = { result, key };
      $('pendingFilename').textContent = result.filename;
      $('importedPreview').value = result.source;
      $('appendImport').checked = true; $('replaceImport').checked = false;
      $('pendingImport').hidden = false;
      $('importMessage').textContent = 'Document text is ready. Choose how to add it to your current notes.';
      $('confirmImport').textContent = 'Add document text';
      status('Your current notes are safe. Append the document text, or explicitly choose to replace your notes.');
      $('pendingHeading').focus();
    }
  } catch (error) {
    importError(error.message || 'The file could not be read. Your current notes have not changed.');
    $('importMessage').textContent = '';
    showError(error);
  } finally { busy = false; syncControls(); }
};
$('replaceImport').onchange = $('appendImport').onchange = () => {
  $('confirmImport').textContent = $('replaceImport').checked ? 'Replace notes with document text' : 'Add document text';
};
$('cancelImport').onclick = () => {
  if (busy) return;
  clearPending(); $('importMessage').textContent = 'Import canceled. Your notes have not changed.';
  status('Your notes have not changed. Upload another document or continue with your current notes.');
};
$('confirmImport').onclick = async () => {
  if (!pendingImport || busy || !account || !connected()) return;
  const pending = pendingImport;
  busy = true; syncControls(); $('importError').hidden = true;
  try {
    await verifyAccount();
    if (pending.key !== currentKey() || pending !== pendingImport || !connected()) throw new Error('The report connection changed. Your notes have not changed. Upload the document again from your report.');
    const replace = $('replaceImport').checked;
    const current = $('source').value;
    if (replace && current.trim() && !window.confirm('Replace all current notes with this document text? Choose Cancel to keep your notes.')) return;
    const next = replace || !current.trim() ? pending.result.source : `${current}\n\n${pending.result.source}`;
    if (next.length > MAX_SOURCE) throw new Error('The combined text exceeds 60,000 characters. Your notes have not changed. Shorten them, or choose Replace my current notes after keeping a copy.');
    commitImport(pending.result, next);
  } catch (error) { importError(error.message); showError(error); }
  finally { busy = false; syncControls(); }
};
$('organize').onclick = async () => {
  if (!context || !account || busy || !connected()) return;
  if (!$('source').value.trim()) return status('Enter your report notes first.', true);
  busy = true; resetSuggestions(); syncControls();
  sourceKey = $('source').value;
  const revision = sourceRevision;
  status('Organizing your notes…');
  try {
    const key = await verifyAccount();
    const result = await api('/api/reports/organize', { type: context.type, master: context.master, fields: context.fields, source: sourceKey });
    await verifyAccount();
    if (key !== currentKey() || !connected()) throw new Error('The report connection changed. No suggestions were applied. Reopen the assistant from your report.');
    if ($('source').value !== sourceKey || sourceRevision !== revision) return status('Your notes changed. Organize them again to use the latest version.');
    if (!result || !result.fields || typeof result.fields !== 'object' || Array.isArray(result.fields)
      || !Array.isArray(result.warnings) || !Array.isArray(result.evidence)) throw new Error('The suggestions could not be verified. Your report has not changed.');
    suggestions = result;
    $('fields').replaceChildren(); $('warnings').replaceChildren();
    for (const warning of result.warnings) { const item = document.createElement('p'); item.textContent = warning; $('warnings').append(item); }
    for (const [field, value] of Object.entries(result.fields)) {
      const block = document.createElement('div'); block.className = 'field';
      const heading = document.createElement('h3'); heading.textContent = result.fieldLabels?.[field] || field.replace(/([A-Z])/g, ' $1').replace(/^./, text => text.toUpperCase());
      const content = document.createElement('p'); content.textContent = value; block.append(heading, content);
      const details = document.createElement('details'), summary = document.createElement('summary'), quote = document.createElement('p');
      summary.textContent = 'Source reference';
      quote.textContent = result.evidence.filter(item => item.field === field).map(item => item.quote).join('\n');
      details.append(summary, quote); block.append(details); $('fields').append(block);
    }
    $('suggestions').hidden = false;
    status('Review these suggestions. Your report has not changed.');
  } catch (error) { showError(error); }
  finally { busy = false; syncControls(); }
};
$('apply').onclick = async () => {
  if (!suggestions || busy || sourceKey !== $('source').value || !account) return;
  if (!connected()) return status('The report window is closed. Your suggestions remain here for review.', true);
  const result = suggestions, key = currentKey();
  busy = true; syncControls();
  try {
    await verifyAccount();
    if (result !== suggestions || key !== currentKey() || sourceKey !== $('source').value || !connected()) throw new Error('The report or account changed. No suggestions were applied. Reopen the assistant from your report.');
    window.opener.postMessage({ kind: 'report-assistant-apply', fields: result.fields }, origin);
    resetSuggestions();
    status('Suggestions sent to your report. Return there to review the entries and prepare the preview.');
  } catch (error) { showError(error); }
  finally { busy = false; syncControls(); }
};
if (window.opener) window.opener.postMessage({ kind: 'report-assistant-ready' }, origin);
else status('Open this assistant from the Report Generator.');
syncControls();
