import assert from 'node:assert/strict';
import { createMissiveDraftWorker } from '../dispensation-missive-drafts.js';

// Timers and queue reads are local fakes. No provider, database or Lodge record
// is accessed. The real outbox's transaction/receipt safety has separate tests.
function harness(results = []) {
  const reads = [], timers = new Map(), changed = [], errors = [];
  let serial = 0, now = 1000;
  const worker = createMissiveDraftWorker({
    processPending: async options => { reads.push(options); const result = results.shift(); if (result instanceof Error) throw result; return result || { checked: 0, changed: 0, hasMore: false }; },
    onChanged: result => changed.push(result), onError: error => errors.push(error),
    clock: () => now, schedule: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; }, cancel: id => timers.delete(id),
  });
  return { worker, reads, timers, changed, errors, results, fire: async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); now += timer.delay; timer.fn(); await worker.idle(); } };
}

{
  const h = harness();
  assert.equal(h.reads.length, 0, 'Constructing a worker never queries storage.');
  await h.worker.start(); await h.worker.start();
  assert.equal(h.reads.length, 1, 'Startup scans the durable queue only once.');
  assert.equal(h.reads[0].includeWaiting, true);
  assert.equal(h.timers.size, 0, 'An empty or waiting-only queue schedules no database poll.');
  await h.worker.wake();
  assert.equal(h.reads.length, 2); assert.equal(h.reads[1].includeWaiting, false);
  assert.equal(h.timers.size, 0, 'A completed event wake also returns to zero idle timers.');
  h.worker.stop(); await h.worker.wake(); assert.equal(h.reads.length, 2);
}
{
  const h = harness([
    { checked: 3, changed: 1, hasMore: true, cursor: 'c' },
    { checked: 3, changed: 2, hasMore: true, cursor: 'f' },
    { checked: 1, changed: 0, hasMore: false, cursor: 'g' },
  ]);
  await h.worker.start();
  assert.deepEqual(h.reads.map(x => x.afterId), ['', 'c', 'f'], 'A single wake drains all bounded batches without revisiting waiting entries.');
  assert.equal(h.changed.length, 2); assert.equal(h.timers.size, 0);
}
{
  const h = harness([{ checked: 1, changed: 0, hasMore: false, nextWakeAt: 31000 }, { checked: 1, changed: 1, hasMore: false }]);
  await h.worker.start();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 30000);
  await h.fire();
  assert.equal(h.reads.length, 2); assert.equal(h.reads[1].includeWaiting, false);
  assert.equal(h.timers.size, 0, 'An interrupted claim is checked once at lease expiry and then stops.');
}
{
  const h = harness([Object.assign(new Error('Synthetic hard quota'), { code: '53000' })]);
  await h.worker.start();
  assert.equal(h.errors.length, 1); assert.equal(h.timers.size, 0, 'A hard quota does not create a retry loop.');
  await h.worker.wake(); assert.equal(h.reads.length, 2, 'A later authorized real event can wake recovery.');
}
{
  const h = harness(Array.from({ length: 4 }, () => new Error('Synthetic temporary disconnection')));
  await h.worker.start();
  for (const delay of [60000, 300000, 900000]) { assert.equal([...h.timers.values()][0].delay, delay); await h.fire(); }
  assert.equal(h.reads.length, 4); assert.equal(h.timers.size, 0, 'Transient errors have finite backoff and eventually stop.');
  assert.ok(h.reads.every(x => x.includeWaiting), 'Startup recovery scope survives finite transient retries.');
}
{
  let resolve, calls = 0;
  const worker = createMissiveDraftWorker({ processPending: async () => { calls++; if (calls === 1) await new Promise(r => { resolve = r; }); return { hasMore: false }; } });
  const first = worker.start(); worker.wake(); worker.wake(); resolve(); await first; await worker.idle();
  assert.equal(calls, 2, 'Concurrent committed events coalesce, but an event arriving during a drain is not lost.');
  worker.stop();
}
console.log('PASS: event-driven Missive worker, zero idle polling, cursor draining, committed-event coalescing, one-shot lease recovery, finite transient backoff and hard-quota stop.');
