import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('// Website updates must'), app.indexOf('\nconst apiFetch ='));
function setup() {
  let now = 100000, reloads = 0, confirmCalls = 0, confirmResult = false, version = 'new';
  const events = {}, text = { textContent: '' }, button = { addEventListener: (_, fn) => { events.apply = fn; } };
  const banner = { classList: { toggle: () => {} }, querySelector: () => text };
  const ctx = { CLIENT_BUILD_VERSION: 'old', state: {}, treasuryWorkspace: null, buildingCalendarWorkspace: null, Date: { now: () => now },
    document: { activeElement: null, addEventListener: (kind, fn) => { events[kind] = fn; }, querySelector: () => null, querySelectorAll: () => [] },
    window: { setTimeout() {}, setInterval() {}, location: { reload: () => reloads++ }, confirm: () => { confirmCalls++; return confirmResult; } },
    $: id => id === 'applyWebUpdate' ? button : banner,
    fetch: async () => ({ ok: true, json: async () => ({ version }) }) };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, events, text, check: () => vm.runInContext('checkForWebUpdate()', ctx), tick: () => { now += 31000; },
    reloads: () => reloads, confirms: () => confirmCalls, accept: () => { confirmResult = true; }, current: () => { version = 'old'; } };
}
let t = setup(); await t.check(); assert.equal(t.reloads(), 0); t.tick(); await t.check(); assert.equal(t.reloads(), 1);
t = setup(); t.events.input(); t.tick(); await t.check(); assert.equal(t.reloads(), 0); assert.match(t.text.textContent, /Save it/); t.events.apply(); assert.equal(t.confirms(), 1); assert.equal(t.reloads(), 0); t.accept(); t.events.apply(); assert.equal(t.reloads(), 1);
t = setup(); t.events.change(); t.tick(); await t.check(); assert.equal(t.reloads(), 0);
t = setup(); t.events.pointerdown({ target: { closest: () => true } }); t.tick(); await t.check(); assert.equal(t.reloads(), 0);
t = setup(); t.ctx.state.editingMinutesId = 'draft'; t.tick(); await t.check(); t.events.apply(); assert.equal(t.reloads(), 0);
t = setup(); vm.runInContext('webUpdateRequests = 1', t.ctx); t.tick(); await t.check(); t.events.apply(); assert.equal(t.reloads(), 0);
t = setup(); t.ctx.document.activeElement = { matches: () => true }; t.tick(); await t.check(); assert.equal(t.reloads(), 0);
t = setup(); t.current(); t.tick(); await t.check(); assert.equal(t.reloads(), 0);
t = setup(); t.ctx.fetch = async () => { throw Error('offline'); }; t.tick(); await t.check(); assert.equal(t.reloads(), 0);
console.log('PASS website updates: idle refresh, entered text/files/signatures protected, explicit discard, editor/request/focus guards, current version, offline.');
