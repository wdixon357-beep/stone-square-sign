import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('let duesExportBusy = false;'), app.indexOf('const renderDues = async'));

for (const id of ['duesExportPdf', 'duesExportExcel', 'duesExportMessage']) {
  assert.match(html, new RegExp(`id="${id}"`));
}

const elements = Object.fromEntries(['duesExportPdf', 'duesExportExcel', 'duesExportMessage'].map(id => [id, { disabled: false, textContent: '' }]));
const downloads = [];
const calls = [];
let allowed = true;
let reply = async (_path, _init, onResponse) => {
  onResponse({ headers: { get: () => 'attachment; filename="Stone-Square-Dues-2026-09-23T12-34-56Z.pdf"' } });
  return new Blob(['pdf'], { type: 'application/pdf' });
};
const context = {
  $: id => elements[id],
  can: () => allowed,
  state: { authEpoch: 1, user: { id: 22 } },
  Blob,
  Date,
  apiFetch: (...args) => reply(...args),
  renderDues: async force => calls.push(['refresh', force]),
  setMessage: (element, message, error = false) => { element.textContent = message; element.error = error; },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  document: {
    body: { append: () => {} },
    createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }),
  },
  window: { setTimeout: () => {} },
};
vm.runInNewContext(`${source}\nglobalThis.exportDuesLedger = exportDuesLedger;`, context);

await context.exportDuesLedger('pdf');
assert.deepEqual(downloads, ['Stone-Square-Dues-2026-09-23T12-34-56Z.pdf']);
assert.deepEqual(calls, [['refresh', true]]);
assert.match(elements.duesExportMessage.textContent, /Timestamped current ledger snapshot downloaded/);
assert.equal(elements.duesExportPdf.disabled, false);
assert.equal(elements.duesExportExcel.disabled, false);

reply = async () => { throw new Error('Service unavailable'); };
await context.exportDuesLedger('xlsx');
assert.equal(downloads.length, 1);
assert.equal(elements.duesExportMessage.error, true);
assert.equal(elements.duesExportMessage.textContent, 'Service unavailable');

allowed = false;
await context.exportDuesLedger('pdf');
assert.equal(downloads.length, 1);
console.log('PASS: web dues exports use timestamped server filenames, refresh the visible ledger, and report failures.');
