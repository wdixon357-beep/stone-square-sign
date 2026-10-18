import assert from 'node:assert/strict';
import {createBuildingAlertCache} from '../building-alert-cache.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let time=1000,calls=0;
const cache=createBuildingAlertCache({now:()=>time,ttlMs:300_000,failureTtlMs:60_000});
const fetchSnapshot=async()=>{calls++;return{revision:'v1',rows:[{id:'one'}]};};
const replies=await Promise.all(Array.from({length:12},()=>cache.read('owner',fetchSnapshot)));
assert.equal(calls,1,'Concurrent polls share one upstream read');
replies[0].rows[0].id='edited locally';
assert.equal((await cache.read('owner',fetchSnapshot)).rows[0].id,'one','No caller can mutate shared cache');
await cache.read('secretary',fetchSnapshot);assert.equal(calls,2,'Different authorized scopes never share snapshots');
time+=299_999;await cache.read('owner',fetchSnapshot);assert.equal(calls,2);
time+=1;await cache.read('owner',fetchSnapshot);assert.equal(calls,3,'Passive snapshots expire after five minutes');
await cache.read('owner',fetchSnapshot,{fresh:true});assert.equal(calls,4,'Foreground refresh always checks the portal');
cache.clear();
const unavailable=Object.assign(new Error('Provider unavailable'),{statusCode:503});let failures=0;
for(let i=0;i<4;i++)await assert.rejects(cache.read('owner',async()=>{failures++;throw unavailable;}),error=>error===unavailable);
assert.equal(failures,1,'Repeated polls back off without an empty-success response');
time+=60_000;assert.equal((await cache.read('owner',fetchSnapshot)).revision,'v1');assert.equal(calls,5);

for(const fresh of [false,true]){
 cache.clear();const old=deferred();let oldCalls=0;
 const staleRead=cache.read('owner',async()=>{oldCalls++;return old.promise;},{fresh});
 await Promise.resolve();cache.clear();
 await cache.read('owner',async()=>({revision:'v2',rows:[]}));
 old.resolve({revision:'v1',rows:[]});
 assert.equal((await staleRead).revision,'v2',`${fresh?'Foreground':'Background'} work invalidated during loading cannot return the old snapshot`);
 assert.equal(oldCalls,1);assert.equal((await cache.read('owner',fetchSnapshot)).revision,'v2');
}
cache.clear();const oldFailure=deferred();
const pending=cache.read('owner',()=>oldFailure.promise);await Promise.resolve();cache.clear();
await cache.read('owner',async()=>({revision:'after-write'}));oldFailure.reject(unavailable);
assert.equal((await pending).revision,'after-write','An invalidated failure cannot poison a refreshed snapshot');
console.log('PASS: per-user reminder caching, concurrent reads, expiry, error backoff, foreground refresh and invalidation races.');
