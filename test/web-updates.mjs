import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('// Website updates must'), app.indexOf('\nconst apiFetch ='));
function setup(storage = new Map(), brokenStorage = false) {
  let hidden = true, fetches = 0;
  let now = 100000, reloads = 0, confirmCalls = 0, confirmResult = false, version = 'new';
  const events = {}, text = { textContent: '' }, button = { addEventListener: (_, fn) => { events.apply = fn; } };
  const later = { addEventListener: (_, fn) => { events.defer = fn; } };
  const banner = { classList: { toggle: (_, value) => { hidden = value; }, add: () => { hidden = true; } }, querySelector: () => text };
  const ctx = { sessionStorage: { getItem: key => { if(brokenStorage)throw Error('blocked storage');return storage.get(key); }, setItem: (key,value) => { if(brokenStorage)throw Error('blocked storage');storage.set(key,value); } }, CLIENT_BUILD_VERSION: 'old', state: {}, treasuryWorkspace: null, buildingCalendarWorkspace: null, Date: { now: () => now },
    document: { activeElement: null, addEventListener: (kind, fn) => { events[kind] = fn; }, querySelector: () => null, querySelectorAll: () => [] },
    window: { setTimeout() {}, setInterval() {}, location: { reload: () => reloads++ }, confirm: () => { confirmCalls++; return confirmResult; } },
    $: id => id === 'applyWebUpdate' ? button : id === 'deferWebUpdate' ? later : banner,
    fetch: async () => { fetches++;return { ok: true, json: async () => ({ version }) }; } };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, events, text, storage, hidden:()=>hidden, fetches:()=>fetches, check: () => vm.runInContext('checkForWebUpdate()', ctx), tick: () => { now += 31000; },
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
// Later remains usable even when Update is blocked by an open editor.
t = setup(); t.ctx.state.editingMinutesId = 'unsaved'; await t.check(); assert.equal(t.hidden(),false); t.events.apply(); assert.equal(t.reloads(),0); t.events.defer(); assert.equal(t.hidden(),true); t.tick(); await t.check(); await t.check(); assert.equal(t.hidden(),true); assert.equal(t.fetches(),1); assert.equal(t.reloads(),0);
// The same tab session retains dismissal after a new page load.
const deferredStorage=t.storage;t=setup(deferredStorage);t.tick();await t.check();assert.equal(t.hidden(),true);assert.equal(t.fetches(),0);assert.equal(t.reloads(),0);
// Storage denial does not break initialization or closing the banner.
t=setup(new Map(),true);await t.check();t.events.defer();t.tick();await t.check();assert.equal(t.hidden(),true);assert.equal(t.reloads(),0);
// A version response already in flight must not reopen or refresh a deferred page.
t=setup();let finish;t.ctx.fetch=()=>new Promise(resolve=>finish=resolve);t.tick();const checking=t.check();t.events.defer();finish({ok:true,json:async()=>({version:'newer'})});await checking;assert.equal(t.hidden(),true);assert.equal(t.reloads(),0);
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
assert.match(html,/id="deferWebUpdate"[^>]*type="button">Later/);assert.doesNotMatch(css.match(/\.update-banner \{([^}]+)\}/)[1],/position:\s*(?:fixed|sticky)|transform:|z-index:/);assert.match(css,/\.update-banner-actions \{[^}]*flex-wrap: wrap/);assert.match(css,/\.update-banner-actions button \{[^}]*min-height: 44px/);
console.log('PASS website updates: persistent Later dismissal, poll and in-flight race suppression, blocked storage, normal-flow mobile controls, safe idle update and dirty-work guards.');
