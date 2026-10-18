import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('const newIncidentReference ='), app.indexOf("window.addEventListener('online'"));
const backgroundPath = '/api/building/alerts';
const response = (status, payload = {}) => ({ ok: status >= 200 && status < 300, status,
  headers: {get: () => 'application/json'}, json: async () => payload });
function setup() {
  const storage = new Map(), elements = new Map(), calls = [], notices = [], delivered = [], timers = [];
  let reply = async () => response(200), incidentReply = async () => response(201);
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set(id === 'reliabilityNotice' ? ['hidden'] : []);
      elements.set(id, {id, textContent:'', listeners:{}, classList:{
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: (name, value) => { if(value ?? !classes.has(name))classes.add(name);else classes.delete(name); },
      }, addEventListener(type, fn) {this.listeners[type]=fn;} });
    }
    return elements.get(id);
  };
  const state = {user:{id:7},authEpoch:2,activeSection:'minutes',legacyToken:''};
  const context = {state, location:{pathname:'/',origin:'https://dashboard.example.invalid'}, navigator:{onLine:true}, crypto:webcrypto,
    FormData:class {}, localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    $:element, delay:async()=>{}, webUpdateRequests:0,
    window:{clearTimeout:()=>{}, setTimeout:fn=>{timers.push(fn);return timers.length;}},
    show: node => {node.classList.remove('hidden');notices.push({title:element('reliabilityNoticeTitle').textContent,message:element('reliabilityNoticeMessage').textContent});},
    hide: node=>node.classList.add('hidden'),
    fetch:async(path,init={})=>{
      if(path==='/api/activity/incidents'){delivered.push(JSON.parse(init.body));return incidentReply(path,init);}
      calls.push({path,init});return reply(path,init);
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.api = apiFetch;this.flush = flushQueuedIncidents;this.queue = queueIncident;this.pending = () => queuedIncidents();`,context);
  return {context,state,calls,notices,delivered,storage,elements,timers,
    reply:fn=>{reply=fn;}, incidentReply:fn=>{incidentReply=fn;},
    node:element, api:(...args)=>context.api(...args),
    async settle(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));},
    dismiss(){element('dismissReliabilityNotice').listeners.click();},
  };
}
const fails = reference => async () => response(502,{error:'Building storage is unavailable.',incidentReference:reference});
let t = setup();t.reply(fails('SS22-BUILDING1'));
await assert.rejects(t.api(backgroundPath), error=>error.status===502 && error.incidentReference==='SS22-BUILDING1');
await t.settle();
assert.equal(t.calls.length,2,'A passive read still performs its safe retry');
assert.equal(t.notices.length,1,'A failed reminder poll emits one scoped terminal notice');
assert.match(t.notices[0].title,/^Building Requests reminders/);
assert.doesNotMatch(t.notices[0].title,/action|Minutes|dashboard/i);
assert.match(t.notices[0].message,/previously loaded reminders are retained/);
assert.equal(t.delivered[0].area,'building','The incident belongs to its source instead of the page being used');
assert.equal(t.delivered[0].path,backgroundPath);
assert.equal(t.delivered[0].state,'open');
assert.equal(t.calls[0].init.credentials,'same-origin');
assert.equal(t.calls[0].init.headers['X-Stone-Square-Client'],'web');
t.reply(fails('SS22-BUILDING2'));
await assert.rejects(t.api(backgroundPath), error=>error.incidentReference==='SS22-BUILDING1');
await t.settle();
assert.equal(t.notices.length,1,'Repeated polling does not recreate or reannounce the same outage');
assert.ok(t.delivered.filter(incident=>incident.state==='open').every(incident=>incident.reference==='SS22-BUILDING1'));
t.reply(async()=>response(200,{minutes:[]}));
await t.api('/api/minutes');await t.settle();
assert.equal(t.notices.length,1,'An unrelated success cannot claim the reminder outage recovered');
assert.equal(t.delivered.some(incident=>incident.state==='recovered'),false);
t.reply(async()=>response(200,{alerts:[]}));
assert.deepEqual(JSON.parse(JSON.stringify(await t.api(backgroundPath))),{alerts:[]});await t.settle();
assert.equal(t.notices.length,2);
assert.match(t.notices.at(-1).title,/Building Requests reminders are available again/);
assert.equal(t.delivered.at(-1).state,'recovered');
assert.equal(t.delivered.at(-1).reference,'SS22-BUILDING1');
assert.equal(t.delivered.at(-1).area,'building');
t.dismiss();t.reply(fails('SS22-BUILDING3'));
await assert.rejects(t.api(backgroundPath));await t.settle();
assert.equal(t.notices.length,3,'A new outage after recovery gets a new notice');
assert.match(t.notices.at(-1).message,/SS22-BUILDING3/);
t.dismiss();await assert.rejects(t.api(backgroundPath));await t.settle();
assert.equal(t.notices.length,3,'A deliberate dismissal remains dismissed during repeated failure');
t.reply(async()=>response(200,{alerts:[]}));await t.api(backgroundPath);await t.settle();
assert.equal(t.notices.length,3,'Recovery is logged without reopening a deliberately dismissed notice');
assert.equal(t.delivered.at(-1).state,'recovered');

// Passive refresh must preserve the existing last-known reminder cards and fingerprint.
t = setup();t.reply(fails('SS22-LASTKNOWN'));
const alertCard={textContent:'Previously loaded request'};
const container=t.node('buildingAlerts');container.dataset={alerts:'last-known'};container.children=[alertCard];
container.replaceChildren=(...children)=>{container.children=children;};
t.context.can=()=>true;
const refreshSource=app.slice(app.indexOf('const refreshBuildingAlerts ='),app.indexOf("setInterval(() => { if (can('building.view'))"));
vm.runInContext(`${refreshSource}\nthis.refreshBuilding = refreshBuildingAlerts;`,t.context);
await t.context.refreshBuilding();await t.settle();
assert.equal(container.dataset.alerts,'last-known');
assert.equal(container.children[0],alertCard);
assert.equal(container.classList.contains('hidden'),false);
assert.match(t.notices.at(-1).title,/Building Requests/);

// Foreground failure remains a foreground failure and has display priority.
t = setup();t.reply(async()=>response(500,{error:'The requested save failed.',incidentReference:'SS22-SAVE'}));
await assert.rejects(t.api('/api/minutes/example',{method:'PUT',body:'{}'}),error=>error.status===500 && /requested save failed/.test(error.message));
assert.equal(t.calls.length,1,'A write is never automatically repeated');
assert.equal(t.notices.at(-1).title,'This action could not be completed.');
const foregroundNotice=t.notices.at(-1);
t.reply(fails('SS22-BUILDING4'));await assert.rejects(t.api(backgroundPath));await t.settle();
assert.equal(t.notices.at(-1),foregroundNotice,'A passive failure cannot replace a current foreground error');
t.reply(async()=>response(200,{alerts:[]}));await t.api(backgroundPath);await t.settle();
assert.equal(t.notices.at(-1),foregroundNotice,'A passive recovery cannot clear or replace an unrelated foreground error');
assert.ok(t.delivered.some(incident=>incident.reference==='SS22-BUILDING4' && incident.state==='recovered'));

// Offline and transient retries keep incident reporting honest without a blank-success fallback.
t = setup();t.context.navigator.onLine=false;t.reply(async()=>{throw Error('offline');});
await assert.rejects(t.api(backgroundPath),/could not connect/);await t.settle();
assert.equal(t.notices.length,1);assert.match(t.notices[0].title,/Building Requests/);
assert.equal(t.context.pending()[0].category,'offline');
assert.equal(t.context.pending()[0].area,'building');
t.reply(async()=>response(200,{alerts:[]}));t.context.navigator.onLine=true;
await t.api(backgroundPath);await t.settle();
assert.equal(t.delivered.at(-1).state,'recovered');

t=setup();let attempt=0;t.reply(async()=>++attempt===1?response(503,{incidentReference:'SS22-TRANSIENT'}):response(200,{alerts:[]}));
await t.api(backgroundPath);await t.settle();
assert.equal(t.notices.length,0,'A safe retry that immediately succeeds does not leave a failure banner');
assert.equal(t.delivered.at(-1).state,'recovered');

// Unauthorized responses stay errors; they cannot be mislabeled as a successful empty list.
t=setup();t.reply(async()=>response(401,{error:'Sign in again.'}));
await assert.rejects(t.api(backgroundPath),error=>error.status===401 && error.message==='Sign in again.');
assert.equal(t.calls.length,1);assert.equal(t.notices.length,0);

// A changed login removes the previous user's on-screen reminder warning, not its audit history.
t=setup();t.reply(fails('SS22-OLDUSER'));await assert.rejects(t.api(backgroundPath));await t.settle();
assert.equal(t.node('reliabilityNotice').classList.contains('hidden'),false);
t.state.authEpoch++;t.state.user={id:8};t.reply(async()=>response(200,{minutes:[]}));
await t.api('/api/minutes');await t.settle();
assert.equal(t.node('reliabilityNotice').classList.contains('hidden'),true);
assert.equal(t.delivered.filter(incident=>incident.reference==='SS22-OLDUSER' && incident.state==='recovered').length,0,'Account changes clear presentation without inventing recovery');

// Changing login while a background call is in flight cannot show an old user's notice.
t=setup();let finish;t.reply(()=>new Promise(resolve=>{finish=resolve;}));
const stale=t.api(backgroundPath);await Promise.resolve();t.state.authEpoch++;t.state.user={id:8};
finish(response(200,{alerts:[]}));await stale;await t.settle();
assert.equal(t.notices.length,0);assert.equal(t.delivered.length,0);

// A recovery queued during incident delivery must not be erased by the first flush.
t=setup();let finishDelivery;t.incidentReply(()=>new Promise(resolve=>{finishDelivery=resolve;}));
t.context.queue({reference:'SS22-OUTBOX',state:'open',path:backgroundPath});
const flushing=t.context.flush();await Promise.resolve();
t.context.queue({reference:'SS22-OUTBOX',state:'recovered',path:backgroundPath});
finishDelivery(response(201));await flushing;
assert.equal(t.context.pending()[0].state,'recovered','An in-flight earlier delivery cannot discard a newer recovery event');
t.incidentReply(async()=>response(201));await t.context.flush();
assert.equal(t.context.pending().length,0);

// Offline events belong to the originating account and origin, never the next login.
t=setup();t.context.navigator.onLine=false;t.reply(async()=>{throw Error('offline');});
await assert.rejects(t.api(backgroundPath));
const offlineA=JSON.parse(JSON.stringify(t.context.pending()[0]));
assert.equal(offlineA.actorUserId,'7');
assert.equal(offlineA.actorOrigin,'https://dashboard.example.invalid');
t.state.authEpoch++;t.state.user={id:8};t.context.navigator.onLine=true;
await t.context.flush();
assert.equal(t.delivered.length,0,'A new login cannot deliver the previous actor offline event');
assert.equal(t.context.pending()[0].reference,offlineA.reference);
t.context.queue({reference:'SS22-ACTOR-B',path:backgroundPath,state:'open'});
await t.context.flush();
assert.equal(t.delivered.length,1);
assert.equal(t.delivered[0].reference,'SS22-ACTOR-B');
assert.equal(t.delivered[0].actorUserId,'8','The server can verify the originating actor against the actual cookie identity');
assert.equal(Object.hasOwn(t.delivered[0],'actorOrigin'),false,'Origin correlation stays local');
assert.equal(t.context.pending().length,1);
assert.equal(t.context.pending()[0].actorUserId,'7');
t.context.queue({...offlineA,state:'recovered',actorUserId:'8',actorOrigin:'https://other.example.invalid'});
assert.equal(t.context.pending()[0].actorUserId,'7','A retry cannot overwrite the actor');
assert.equal(t.context.pending()[0].actorOrigin,'https://dashboard.example.invalid','A retry cannot overwrite the origin');
await t.context.flush();assert.equal(t.delivered.length,1);
t.state.user={id:7};t.state.authEpoch++;await t.context.flush();
assert.equal(t.delivered.length,2);assert.equal(t.delivered[1].reference,offlineA.reference);
assert.equal(t.delivered[1].state,'recovered');assert.equal(t.context.pending().length,0);

// Unattributed legacy events are retained without guessing who caused them.
t=setup();
const legacy={reference:'SS22-LEGACY',path:backgroundPath,state:'open'};
t.storage.set('ss22-pending-incidents-v1',JSON.stringify([legacy]));
await t.context.flush();assert.equal(t.delivered.length,0);
assert.equal(t.context.pending()[0].reference,'SS22-LEGACY');
t.context.queue({...legacy,state:'recovered'});
assert.equal(t.context.pending()[0].actorUserId,null);
assert.equal(t.context.pending()[0].actorOrigin,null);
await t.context.flush();assert.equal(t.delivered.length,0,'Requeuing a legacy event cannot adopt the current actor');
for(let i=0;i<24;i++)t.context.queue({reference:`SS22-NEW-${i}`,path:backgroundPath,state:'open'});
assert.ok(t.context.pending().some(event=>event.reference==='SS22-LEGACY'),'A full outbox does not discard unattributed legacy evidence');
assert.equal(t.context.pending().length,25);

// Same-user events from another origin remain queued, including after a new login.
t=setup();t.context.queue({reference:'SS22-ORIGIN',path:backgroundPath,state:'open',actorUserId:'7',actorOrigin:'https://old.example.invalid'});
await t.context.flush();assert.equal(t.delivered.length,0);
assert.equal(t.context.pending()[0].reference,'SS22-ORIGIN');

// A cookie changed in another tab is rejected by the server and must remain queued.
t=setup();t.context.queue({reference:'SS22-COOKIE-SWITCH',path:backgroundPath,state:'open'});
const beforeCookieRejection=JSON.stringify(t.context.pending());
t.incidentReply(async()=>response(409,{error:'The incident belongs to another sign-in.'}));
await t.context.flush();
assert.equal(t.delivered[0].actorUserId,'7','Send the original actor for server-side cookie verification');
assert.equal(Object.hasOwn(t.delivered[0],'actorOrigin'),false);
assert.equal(JSON.stringify(t.context.pending()),beforeCookieRejection,'A cross-tab conflict must not remove or reassign the originating incident');
assert.equal(t.notices.length,0,'The rejected background delivery does not claim recovery');

// An API action that finishes after account switching retains its initiating actor.
t=setup();let finishForeground;t.reply(()=>new Promise(resolve=>{finishForeground=resolve;}));
const oldAction=t.api('/api/minutes/example',{method:'PUT',body:'{}'});
await Promise.resolve();t.state.user={id:8};t.state.authEpoch++;
finishForeground(response(503,{error:'Old action failed.',incidentReference:'SS22-INITIATOR'}));
await assert.rejects(oldAction);await t.settle();
assert.equal(t.delivered.length,0,'An old response cannot send an incident under the new credentials');
assert.equal(t.context.pending()[0].actorUserId,'7');
assert.equal(t.context.pending()[0].reference,'SS22-INITIATOR');
console.log('PASS: scoped Building Requests notices, cross-call recovery, same-path deduplication, last-known alerts, foreground priority, authorization and incident outbox preservation');
