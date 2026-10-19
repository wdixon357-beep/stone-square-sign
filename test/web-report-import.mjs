import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const html = await readFile(new URL('../public/report-assistant.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/report-assistant.js', import.meta.url), 'utf8');
const origin = 'https://request.stonesquare22pha.org';
const identity = { id: 8, email: 'synthetic-marable@example.invalid', permissions: ['reports.create'] };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks += 1; };

class Element {
  constructor(id, markup = '') {
    this.id = id; this.hidden = /\bhidden\b/.test(markup); this.disabled = /\bdisabled\b/.test(markup);
    this.checked = /\bchecked\b/.test(markup); this.dataset = {}; this.attributes = {}; this.children = [];
    this.value = ''; this.textContent = ''; this.files = []; this.clicks = 0;
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() { if (!this.disabled) this.focused = true; }
  click() { this.clicks += 1; if (!this.disabled) return this.onclick?.(); }
}

function harness({ mode = '', opener = true } = {}) {
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], new Element(match[1], match[0])]));
  const document = { getElementById: id => { assert.ok(nodes.has(id), `Actual markup has #${id}`); return nodes.get(id); }, createElement: tag => new Element(tag) };
  const messages = [], requests = [], listeners = new Map(), confirmations = [], importEntered = deferred();
  const parent = { closed: false, postMessage: (data, target) => messages.push({ data, target }) };
  const state = { user: structuredClone(identity), confirm: true, importResponse: null, importWait: null, organizeWait: null,
    importError: null, authError: null, suggestions: { fields: { title: 'Imported report' }, fieldLabels: { title: 'Report title' }, warnings: ['Review the source.'], evidence: [{ field: 'title', quote: 'Imported report' }] } };
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const window = { opener: opener ? parent : null, location: { href: 'https://stone-square-sign.onrender.com/report-assistant.html' + mode },
    addEventListener: (name, callback) => { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
    confirm: message => { confirmations.push(message); return state.confirm; } };
  const fetcher = async (pathname, options) => {
    requests.push({ pathname, options });
    assert.equal(options.credentials, 'same-origin', 'Every request uses the current secure cookie.');
    if (pathname === '/api/auth/me') return state.authError ? response({ error: 'Sign in again.' }, state.authError) : response({ user: state.user });
    if (pathname === '/api/reports/import-source') {
      importEntered.resolve();
      assert.ok(options.body instanceof FormData); assert.ok(options.body.get('report') instanceof File);
      assert.equal(options.headers['Content-Type'], undefined, 'The browser creates the multipart boundary.');
      if (state.importWait) await state.importWait.promise;
      if (state.importError) return response({ error: state.importError.message }, state.importError.status);
      return response(state.importResponse);
    }
    if (pathname === '/api/reports/organize') {
      assert.equal(options.headers['Content-Type'], 'application/json');
      if (state.organizeWait) await state.organizeWait.promise;
      return response(state.suggestions);
    }
    throw new Error('Unexpected request: ' + pathname);
  };
  vm.runInNewContext(script, { document, window, fetch: fetcher, FormData, File, URL, structuredClone, crypto: webcrypto, console }, { filename: 'actual-report-assistant.js' });
  const element = id => nodes.get(id);
  const context = { type: 'formal', master: false, accountEmail: identity.email, fields: { title: 'Existing report field' } };
  const message = (data = context, source = parent, senderOrigin = origin) => {
    for (const callback of listeners.get('message') || []) callback({ origin: senderOrigin, source, data: { kind: 'report-assistant-context', context: data } });
  };
  const connect = async () => { message(); await tick(); await tick(); };
  const source = value => { element('source').value = value; element('source').oninput(); };
  const importFile = async (file = new File([state.importResponse?.source || 'Synthetic document'], 'Existing_Report.docx')) => { element('reportFile').files = [file]; return element('reportFile').onchange(); };
  const result = (text = 'Imported report\nRecorded information.', patch = {}) => ({ source: text, filename: 'Existing_Report.docx', format: 'docx', characters: text.length,
    sha256: createHash('sha256').update(text).digest('hex'), warnings: [], ...patch });
  return { state, messages, requests, parent, element, message, connect, source, importFile, result, confirmations,
    importStarted: () => importEntered.promise,
    click: id => element(id).click(), counts: path => requests.filter(request => request.pathname === path).length,
    focus: () => { for (const callback of listeners.get('focus') || []) callback(); } };
}

{
  const h = harness({ mode: '?mode=upload' });
  check('No report context means upload and organization stay disabled', h.element('chooseReport').disabled && h.element('workspace').hidden);
  h.message(undefined, {}, origin); h.message(undefined, h.parent, 'https://untrusted.invalid'); await tick();
  check('Untrusted source/origin cannot connect or start any request', h.requests.length === 0);
  await h.connect();
  check('Matching account connects and upload entry receives usable keyboard focus', !h.element('workspace').hidden && !h.element('chooseReport').disabled && h.element('chooseReport').focused);
  h.click('chooseReport'); check('The file picker opens only from its explicit button click', h.element('reportFile').clicks === 1);
}
{
  const h = harness(); await h.connect();
  h.state.importResponse = h.result('Imported report\nComplete document text.', { warnings: ['An embedded image was not transcribed.'] });
  await h.importFile();
  check('Successful extraction fills empty source with exact complete text', h.element('source').value === h.state.importResponse.source);
  check('Import shows filename and actionable warnings as text', h.element('importFilename').textContent.includes('Existing_Report.docx') && h.element('importWarnings').children[0].textContent.includes('image'));
  check('Extraction alone never calls organization or applies fields', h.counts('/api/reports/organize') === 0 && h.messages.every(message => message.data.kind !== 'report-assistant-apply'));
  check('Import request is multipart and contains the original file', h.counts('/api/reports/import-source') === 1);
  check('Source remains editable and upload controls recover after extraction', !h.element('chooseReport').disabled && h.element('source').focused && h.element('assistant').attributes['aria-busy'] === 'false');
}
{
  const h = harness(); await h.connect(); h.source('Original notes'); h.state.importResponse = h.result('Imported report');
  await h.importFile();
  check('Nonempty notes are unchanged until a separate import choice', h.element('source').value === 'Original notes' && !h.element('pendingImport').hidden);
  check('Append is the default and extracted text is fully visible', h.element('appendImport').checked && !h.element('replaceImport').checked && h.element('importedPreview').value === 'Imported report');
  h.source('Original notes with later edit'); await h.click('confirmImport');
  check('Append keeps edits made while the extracted text is waiting', h.element('source').value === 'Original notes with later edit\n\nImported report');
  check('Append never asks to replace or applies report fields', h.confirmations.length === 0 && h.messages.every(message => message.data.kind !== 'report-assistant-apply'));
}
{
  const h = harness(); await h.connect(); h.source('Keep this original'); h.state.importResponse = h.result('Replacement text'); await h.importFile();
  h.element('replaceImport').checked = true; h.element('appendImport').checked = false; h.element('replaceImport').onchange();
  h.state.confirm = false; await h.click('confirmImport');
  check('Declining explicit replacement leaves all original text and pending import intact', h.element('source').value === 'Keep this original' && !h.element('pendingImport').hidden);
  h.state.confirm = true; await h.click('confirmImport');
  check('Explicit confirmed replacement uses exact imported text', h.element('source').value === 'Replacement text' && h.confirmations.length === 2 && h.element('pendingImport').hidden);
  h.source('Notes to retain'); await h.importFile(); await h.click('cancelImport');
  check('Cancel import keeps existing notes and clears pending extracted text', h.element('source').value === 'Notes to retain' && h.element('pendingImport').hidden && h.element('importedPreview').value === '');
}
{
  const h = harness(); await h.connect(); h.source('No truncation');
  for (const file of [new File(['image'], 'Report.png'), new File([], 'Empty.txt'), { name: 'Large.pdf', size: 12 * 1024 * 1024 + 1 }]) {
    await h.importFile(file);
    check('Invalid type, empty or oversized file is explained without an upload', !h.element('importError').hidden && h.element('source').value === 'No truncation' && h.counts('/api/reports/import-source') === 0);
  }
  h.state.importError = { status: 422, message: 'This PDF contains no selectable text. Upload the Word document instead.' };
  await h.importFile(new File(['scan'], 'Scan.pdf'));
  check('Scanned PDF error keeps notes and restores controls', h.element('source').value === 'No truncation' && h.element('importError').textContent.includes('Word') && !h.element('chooseReport').disabled);
}
{
  const h = harness(); await h.connect(); h.source('N'.repeat(59999)); h.state.importResponse = h.result('Extra text'); await h.importFile(); await h.click('confirmImport');
  check('Combined source beyond limit is rejected without silent truncation', h.element('source').value.length === 59999 && h.element('importError').textContent.includes('60,000') && !h.element('pendingImport').hidden);
}
{
  const h = harness(); await h.connect(); h.source('Original account notes'); h.state.importResponse = h.result(); h.state.importWait = deferred();
  const pending = h.importFile(); await h.importStarted();
  check('Upload exposes loading state and suppresses duplicate file actions', h.element('chooseReport').disabled && h.element('organize').disabled && h.element('assistant').attributes['aria-busy'] === 'true');
  await h.importFile(); check('A second selection does not dispatch a duplicate import', h.counts('/api/reports/import-source') === 1);
  h.state.user = { ...identity, id: 99, email: 'different@example.invalid' }; h.state.importWait.resolve(); await pending;
  check('Account change during import cannot commit extracted text or expose old workspace', h.element('source').value === 'Original account notes' && h.element('workspace').hidden && !h.element('signin').hidden);
  check('Account failure never posts fields to the report', h.messages.every(message => message.data.kind !== 'report-assistant-apply'));
}
{
  const h = harness(); await h.connect(); h.source('Keep on disconnect'); h.state.importResponse = h.result(); h.state.importWait = deferred();
  const pending = h.importFile(); await h.importStarted(); h.parent.closed = true; h.state.importWait.resolve(); await pending;
  check('Closed report window rejects a late import without altering notes', h.element('source').value === 'Keep on disconnect' && h.element('pendingImport').hidden);
}
{
  const h = harness(); await h.connect(); h.source('Imported report'); h.state.organizeWait = deferred();
  const pending = h.click('organize'); await tick(); h.source('Changed notes'); h.state.organizeWait.resolve(); await pending;
  check('Organization results from older source cannot become applicable', h.element('suggestions').hidden && h.element('apply').disabled && h.element('status').textContent.includes('notes changed'));
  h.state.organizeWait = null; h.source('Imported report'); await h.click('organize');
  check('Verified suggestions are displayed with source reference before Apply', !h.element('suggestions').hidden && h.element('fields').children.length === 1 && !h.element('apply').disabled);
  check('Organization does not itself apply or send anything', h.messages.every(message => message.data.kind !== 'report-assistant-apply'));
  await h.click('apply');
  const applied = h.messages.filter(message => message.data.kind === 'report-assistant-apply');
  check('Apply is a separate explicit action bound to the original opener and origin', applied.length === 1 && applied[0].target === origin && applied[0].data.fields.title === 'Imported report');
  check('Applying clears reusable suggestions without signing or sending', h.element('apply').disabled && h.messages.length === 2);
}
{
  const h = harness(); await h.connect(); h.source('Imported report'); await h.click('organize'); h.state.authError = 401; await h.click('apply');
  check('Expired account at Apply keeps source and blocks field transfer', h.element('source').value === 'Imported report' && h.element('workspace').hidden && h.messages.length === 1);
}
{
  const h = harness(); await h.connect(); h.source('Retain exact original');
  for (const patch of [{ characters: 999 }, { source: 'X'.repeat(60001), characters: 60001 }, { sha256: 'not-a-digest' }, { sha256: '0'.repeat(64) }, { warnings: [42] }]) {
    h.state.importResponse = h.result('Document source', patch); await h.importFile();
    check('Malformed or oversized extractor result never replaces notes', h.element('source').value === 'Retain exact original' && h.element('pendingImport').hidden && !h.element('importError').hidden);
  }
}
console.log(`PASS ${checks} report upload browser behavior checks using actual markup and script. No live upload, generation, signature or mail.`);
