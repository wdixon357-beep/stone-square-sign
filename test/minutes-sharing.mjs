import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const prepareSignedMinutesFile =');
const end = source.indexOf('const setMinutesMeetingType =', start);
assert.ok(start >= 0 && end > start, 'signed-minutes sharing helpers exist');

const messages = [];
let fetches = 0;
const context = {
  File: class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; } },
  apiFetch: async () => { fetches += 1; return new Blob(['signed PDF'], { type: 'application/pdf' }); },
  minutesDocumentTitle: () => 'Meeting Minutes, September 3, 2026',
  setMessage: (_element, message, isError) => messages.push({ message, isError }),
  $: () => ({}),
  navigator: {},
  Promise,
  Blob,
};
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.helpers = { prepareSignedMinutesFile, shareSignedMinutesFile };', context);
const { prepareSignedMinutesFile, shareSignedMinutesFile } = context.helpers;
const item = { id: 'signed-minutes' };
const file = await prepareSignedMinutesFile(item);
assert.equal(file.name, 'Meeting Minutes, September 3, 2026.pdf');
assert.equal(file.type, 'application/pdf');
assert.equal(fetches, 1);

let shareCalls = 0;
context.navigator.canShare = ({ files }) => files[0] === file;
context.navigator.share = ({ files }) => {
  shareCalls += 1;
  assert.equal(files[0], file);
  assert.equal(fetches, 1, 'the PDF must already be loaded before the share click');
  return Promise.resolve();
};
shareSignedMinutesFile(item, file);
assert.equal(shareCalls, 1, 'the share sheet must open synchronously in the click task');

context.navigator.share = () => Promise.reject(Object.assign(new Error('mail unavailable'), { name: 'NotAllowedError' }));
shareSignedMinutesFile(item, file);
await new Promise(resolve => setImmediate(resolve));
assert.match(messages.at(-1).message, /download the signed PDF/i);

context.navigator.canShare = () => false;
shareSignedMinutesFile(item, file);
assert.match(messages.at(-1).message, /cannot share a PDF attachment/i);
assert.match(source, /if \(preparedFile\) \{ shareSignedMinutesFile\(item, preparedFile, reportShareStatus\); return; \}/, 'prepared PDF is shared without another await');
assert.match(source, /actions\.append\(share, download, distributed\)/, 'a direct download remains available if the mail extension stalls');
assert.match(source, /download\.href = `\/api\/minutes\/\$\{encodeURIComponent\(item\.id\)\}\/pdf\?download=1`/, 'download uses a direct, authenticated URL in the tap event');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(server, /req\.query\.download === '1' \? 'attachment' : 'inline'/, 'download URL is served as an attachment');
console.log('PASS: signed-minutes PDF preparation, synchronous share activation, error feedback and direct download.');
