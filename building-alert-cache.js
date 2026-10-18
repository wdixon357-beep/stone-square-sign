// Background reminder polls share short authenticated snapshots. Foreground
// queue refreshes and all writes bypass/invalidate them. Errors remain errors.
export function createBuildingAlertCache({ttlMs = 300_000, failureTtlMs = 60_000, maximum = 128, now = Date.now} = {}) {
  const entries = new Map();
  let generation = 0;
  const superseded = Symbol('superseded building snapshot');
  const trim = () => {
    for (const [key, entry] of entries) if (!entry.pending && entry.until <= now()) entries.delete(key);
    while (entries.size > maximum) entries.delete(entries.keys().next().value);
  };
  return {
    clear() { generation += 1; entries.clear(); },
    async read(key, load, {fresh = false} = {}) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        trim();
        let entry = !fresh || attempt ? entries.get(key) : null;
        if (!entry) {
          const observedGeneration = generation;
          entry = {pending: null, until: Infinity};
          entries.set(key, entry);
          entry.pending = Promise.resolve().then(load).then(value => {
            if (observedGeneration !== generation || entries.get(key) !== entry) throw superseded;
            entry.value = structuredClone(value); entry.until = now() + ttlMs;
            delete entry.pending;
            return entry.value;
          }, error => {
            if (observedGeneration !== generation || entries.get(key) !== entry) throw superseded;
            entry.error = error; entry.until = now() + failureTtlMs;
            delete entry.pending;
            throw error;
          });
          trim();
        }
        try {
          if (entry.error) throw entry.error;
          const value = entry.pending ? await entry.pending : entry.value;
          // A mutation can invalidate the entry between the loader finishing
          // and this reader's continuation. Never return that older snapshot.
          if (entries.get(key) !== entry) throw superseded;
          return structuredClone(value);
        } catch (error) {
          if (error !== superseded) throw error;
        }
      }
      throw Object.assign(new Error('Building requests changed while reminders were refreshing. Reload Building Requests.'), {statusCode:409});
    },
  };
}
