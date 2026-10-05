import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const start = app.indexOf('const renderMemberAccess = async () => {');
const end = app.indexOf('const duesTodayEastern =', start);
assert.ok(start >= 0 && end > start);
assert.match(html, /id="memberAccessInviteResult"[\s\S]*id="memberAccessInviteUrl"[^>]*readonly/);
assert.match(css, /#memberAccessInviteUrl\s*\{[^}]*max-width:\s*100%/);

class Element {
  constructor() { this.children = []; this.listeners = {}; this.classList = { hidden: true }; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  add(option) { this.children.push(option); if (!this.value) this.value = option.value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
const ids = Object.fromEntries(['memberAccessMessage', 'memberAccessList', 'memberAccessInviteUrl',
  'memberAccessInviteResult', 'memberAccessCopyInvite'].map(id => [id, new Element()]));
let pending = false;
const calls = [];
const privateUrl = 'https://sign.example.invalid/?invite=synthetic-private-token';
const context = {
  $: id => ids[id],
  document: { createElement: () => new Element() },
  Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  navigator: { clipboard: { writeText: async () => { throw Error('Denied'); } } },
  escapeMarkup: value => String(value),
  setMessage: (element, message) => { element.textContent = message; },
  show: element => { element.classList.hidden = false; },
  apiFetch: async (route, init) => {
    calls.push([route, init]);
    if (route === '/api/admin/member-access') return { members: [{ id: 4, prefix: 'Bro.', firstName: 'James', lastName: 'Example',
      emails: ['james@example.invalid'], invitationId: pending ? 7 : null }] };
    assert.equal(route, '/api/admin/member-access/4/invite');
    pending = true;
    return { inviteUrl: privateUrl };
  },
};
vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.testMemberAccess = renderMemberAccess;`, context);
await context.testMemberAccess();
const invite = ids.memberAccessList.children[0].children[2];
await invite.onclick();
assert.equal(calls.filter(([route]) => route === '/api/admin/member-access/4/invite').length, 1);
assert.equal(JSON.parse(calls.find(([route]) => route.endsWith('/invite'))[1].body).sendEmail, false);
assert.equal(ids.memberAccessInviteUrl.value, privateUrl, 'private link remains visible after the roster refresh');
assert.equal(ids.memberAccessInviteResult.classList.hidden, false);
assert.match(ids.memberAccessMessage.textContent, /copy the private activation link/i);
await ids.memberAccessCopyInvite.listeners.click();
assert.equal(ids.memberAccessInviteUrl.focused, true);
assert.equal(ids.memberAccessInviteUrl.selected, true);
assert.match(ids.memberAccessMessage.textContent, /select and copy/i);
let copied = '';
context.navigator.clipboard.writeText = async value => { copied = value; };
await ids.memberAccessCopyInvite.listeners.click();
assert.equal(copied, privateUrl);
assert.match(ids.memberAccessMessage.textContent, /copied/i);
assert.match(app, /const clearMemberAccessInvite = \(\) => \{\s*\$\('memberAccessInviteUrl'\)\.value = '';\s*hide\(\$\('memberAccessInviteResult'\)\)/,
  'the owner invitation helper clears the private token');
assert.match(app, /state\.user = null;\s*clearMemberAccessInvite\(\)/,
  'sign-out and session rejection clear the private token from the page');
console.log('PASS: member invitation stays visible after roster refresh, survives clipboard denial, and clears on sign-out.');
