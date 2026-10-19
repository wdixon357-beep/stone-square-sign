import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (process.argv.includes('--synthetic-pool-child')) {
  // Exercise the installed pg-pool's real idle/acquire/release behavior while
  // replacing only its socket-owning Client. No credential or network is used.
  const realPool = pg.Pool;
  const clients = [], queries = [];
  let pool, commitDisconnect = false, lateCommitDisconnect = false, rollbackFailure = false;
  const queryError = new Error('ACTIVE_QUERY_SYNTHETIC_SECRET');
  const activeEventError = new Error('ACTIVE_EVENT_SYNTHETIC_SECRET');
  const transactionError = new Error('TRANSACTION_SYNTHETIC_SECRET');
  const backgroundError = new Error('BACKGROUND_SYNTHETIC_SECRET');
  const commitError = new Error('COMMIT_SYNTHETIC_SECRET');
  const rollbackError = new Error('ROLLBACK_SYNTHETIC_SECRET');
  class SyntheticClient extends EventEmitter {
    constructor(options) {
      super(); this.id = clients.length + 1; this._queryable = true; this._ending = false;
      this.privateClientField = 'CLIENT_SYNTHETIC_SECRET'; clients.push(this);
      assert.equal(options.ssl.rejectUnauthorized, true, 'Production TLS verification remains enabled.');
    }
    connect(callback) { queueMicrotask(() => callback(null)); }
    query(text, values, callback) {
      if (typeof values === 'function') { callback = values; values = undefined; }
      const execute = () => {
        queries.push({ client: this.id, text, values });
        if (text === 'ACTIVE_QUERY_FAILURE') throw queryError;
        if (text === 'ACTIVE_EVENT_FAILURE') {
          this._queryable = false; this.emit('error', activeEventError); throw activeEventError;
        }
        if (text === 'TRANSACTION_QUERY_FAILURE') throw transactionError;
        if (text === 'COMMIT' && commitDisconnect) {
          this._queryable = false; this.emit('error', commitError); throw commitError;
        }
        if (text === 'COMMIT' && lateCommitDisconnect) {
          // Fire after checkedQuery's own post-await check, before its caller
          // resumes. The outer transaction must still reject uncertain success.
          queueMicrotask(() => queueMicrotask(() => { this._queryable = false; this.emit('error', commitError); }));
        }
        if (text === 'ROLLBACK' && (rollbackFailure || !this._queryable)) throw rollbackError;
        return { rows: [{ value: this.id }], rowCount: 1 };
      };
      if (callback) {
        queueMicrotask(() => { try { callback(null, execute()); } catch (error) { callback(error); } });
        return;
      }
      return Promise.resolve().then(execute);
    }
    end(callback) { this._ending = true; this.ended = true; queueMicrotask(() => { this.emit('end'); callback?.(); }); }
    ref() {}
    unref() {}
  }
  pg.Pool = class extends realPool {
    constructor(options) {
      assert.equal(options.idleTimeoutMillis, 30_000);
      assert.equal(options.max, 2);
      super({ ...options, Client: SyntheticClient, idleTimeoutMillis: 0 }); pool = this;
    }
    query(...args) { assert.equal(this.listenerCount('error'), 1, 'Pool observer exists before the first query.'); return super.query(...args); }
    connect(...args) { assert.equal(this.listenerCount('error'), 1, 'Pool observer exists before the first connection.'); return super.connect(...args); }
  };
  const db = await import('../db.js');
  assert.equal((await db.connect()).driver, 'pg');
  const first = await db.dbGet('SELECT ? AS synthetic', ['first']);
  const firstClient = clients.find(client => client.id === first.value);
  assert.equal(pool.idleCount, 1);
  const idleError = new Error('postgresql://user:IDLE_SYNTHETIC_SECRET@private.invalid/database');
  idleError.code = 'CODE_SYNTHETIC_SECRET';
  firstClient.emit('error', idleError);
  assert.equal(pool.totalCount, 0, 'pg removes the dead idle client through its real idleListener.');
  const second = await db.dbGet('SELECT ? AS synthetic', ['second']);
  assert.notEqual(second.value, first.value, 'A later request receives a new connection.');
  const secondClient = clients.find(client => client.id === second.value);
  secondClient.emit('error', new Error('SECOND_IDLE_SYNTHETIC_SECRET'));
  await assert.rejects(db.dbGet('ACTIVE_QUERY_FAILURE'), error => error === queryError);
  assert.equal(queries.filter(query => query.text === 'ACTIVE_QUERY_FAILURE').length, 1, 'An active query failure is never retried.');
  await assert.rejects(db.dbGet('ACTIVE_EVENT_FAILURE'), error => error === activeEventError);
  assert.equal(queries.filter(query => query.text === 'ACTIVE_EVENT_FAILURE').length, 1);

  let start = queries.length;
  await assert.rejects(db.withTransaction(async () => {
    await db.dbRun('TRANSACTION_QUERY_FAILURE');
  }), error => error === transactionError);
  assert.deepEqual(queries.slice(start).map(query => query.text), ['BEGIN', 'TRANSACTION_QUERY_FAILURE', 'ROLLBACK']);
  const healthyTransactionClient = clients.at(-1);
  assert.equal(healthyTransactionClient.ended, undefined, 'A successful rollback can return its healthy connection to the pool.');
  assert.equal(healthyTransactionClient.listenerCount('error'), 1, 'Only the pool idle listener remains after transaction cleanup.');

  start = queries.length;
  rollbackFailure = true;
  await assert.rejects(db.withTransaction(async () => { throw transactionError; }), error => error === transactionError,
    'A failed rollback never replaces the original transaction error.');
  rollbackFailure = false;
  assert.deepEqual(queries.slice(start).map(query => query.text), ['BEGIN', 'ROLLBACK']);
  assert.equal(healthyTransactionClient.ended, true, 'A client whose rollback failed is discarded.');

  start = queries.length;
  let backgroundClient;
  await assert.rejects(db.withTransaction(async () => {
    await db.dbGet('SELECT transaction_started');
    backgroundClient = clients.at(-1);
    await new Promise(resolve => setImmediate(() => {
      backgroundClient._queryable = false;
      backgroundClient.emit('error', backgroundError);
      resolve();
    }));
    // A caller cannot swallow the observed connection error and report success.
    await assert.rejects(db.dbGet('SELECT must_not_be_dispatched'), error => error === backgroundError);
    return 'must not commit';
  }), error => error === backgroundError);
  assert.deepEqual(queries.slice(start).map(query => query.text), ['BEGIN', 'SELECT transaction_started', 'ROLLBACK']);
  assert.equal(backgroundClient.ended, true);
  assert.ok(!backgroundClient.listeners('error').some(listener => listener.name === 'onConnectionError'), 'The scoped transaction observer is removed.');

  start = queries.length;
  commitDisconnect = true;
  await assert.rejects(db.withTransaction(async () => { await db.dbRun('UPDATE synthetic_account SET value = ?', [1]); return 'not-success'; }), error => error === commitError);
  commitDisconnect = false;
  assert.deepEqual(queries.slice(start).map(query => query.text), ['BEGIN', 'UPDATE synthetic_account SET value = $1', 'COMMIT', 'ROLLBACK']);
  assert.equal(queries.filter(query => query.text.startsWith('UPDATE synthetic_account')).length, 1, 'An uncertain COMMIT never replays a write.');
  assert.equal(clients.at(-1).ended, true, 'The lost commit connection is discarded.');

  start = queries.length;
  lateCommitDisconnect = true;
  await assert.rejects(db.withTransaction(async () => 'late-commit-must-not-succeed'), error => error === commitError);
  lateCommitDisconnect = false;
  assert.deepEqual(queries.slice(start).map(query => query.text), ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(clients.at(-1).ended, true, 'A disconnect at the final promise boundary is not returned as success.');

  const subsequent = await db.dbGet('SELECT recovered');
  assert.ok(subsequent.value > first.value);
  start = queries.length;
  assert.equal(await db.withTransaction(async () => { await db.dbRun('UPDATE synthetic_account SET value = ?', [2]); return 'committed'; }), 'committed');
  assert.deepEqual(queries.slice(start).map(query => query.text), ['BEGIN', 'UPDATE synthetic_account SET value = $1', 'COMMIT']);
  await db.close();
  assert.equal(pool.ended, true); assert.equal(pool.totalCount, 0);
  assert.ok(clients.every(client => client.ended), 'Closing the driver closes all synthetic connections.');
  await assert.rejects(db.dbGet('SELECT after_close'), /Cannot use a pool after calling end/);
  console.log(JSON.stringify({ actualPoolSubprocess: 'PASS', noNetwork: true, idleRecovery: true,
    activeFailuresPreserved: true, transactionDisconnectRejected: true, originalRollbackCausePreserved: true,
    uncertainCommitNotRetried: true, tlsVerified: true, closeVerified: true }));
} else {
  assert.equal(process.env.DATABASE_URL || '', '', 'The parent test must not use a configured database.');
  const { observePostgresPoolErrors } = await import('../db.js');
  const emitter = new EventEmitter(), logs = [];
  let time = 0;
  const secret = new Error('SANITIZE_SYNTHETIC_SECRET'); secret.client = { secret: 'CLIENT_SYNTHETIC_SECRET' };
  observePostgresPoolErrors(emitter, { warn: message => logs.push(message), now: () => time });
  observePostgresPoolErrors(emitter, { warn: () => { throw Error('Duplicate observer'); } });
  assert.equal(emitter.listenerCount('error'), 1, 'The same pool is observed only once.');
  emitter.emit('error', secret, secret.client);
  for (let count = 0; count < 100; count += 1) emitter.emit('error', secret, secret.client);
  assert.equal(logs.length, 1, 'A burst produces at most one sanitized log.');
  time = 59_999; emitter.emit('error', secret); assert.equal(logs.length, 1);
  time = 60_000; emitter.emit('error', secret); assert.equal(logs.length, 2, 'A later interval may record another bounded notice.');
  assert.ok(logs.every(message => typeof message === 'string' && message.length < 160 && !message.includes('SYNTHETIC_SECRET')));
  const brokenLogger = new EventEmitter();
  observePostgresPoolErrors(brokenLogger, { warn: () => { throw new Error('Logger unavailable'); }, now: () => 0 });
  assert.doesNotThrow(() => brokenLogger.emit('error', secret), 'Diagnostics cannot turn a handled idle event into a process exception.');
  const brokenClock = new EventEmitter();
  observePostgresPoolErrors(brokenClock, { now: () => { throw new Error('Clock unavailable'); } });
  assert.doesNotThrow(() => brokenClock.emit('error', secret));
  assert.throws(() => new EventEmitter().emit('error', new Error('Unrelated failure')), /Unrelated failure/, 'Unrelated exceptions are not globally swallowed.');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--synthetic-pool-child'], {
    cwd: new URL('..', import.meta.url), timeout: 15000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://synthetic:SYNTHETIC_URL_SECRET@no-network.invalid/synthetic?sslmode=verify-full',
      PG_POOL_MAX: '2', PGSSL: '', PGSSL_CA: '', PGLITE_DIR: '' },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `Pool error must not kill the subprocess: ${child.stderr}`);
  assert.equal(child.status, 0, `Actual pool adapter subprocess failed: ${child.stdout}\n${child.stderr}`);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.actualPoolSubprocess, 'PASS');
  assert.doesNotMatch(child.stderr, /SYNTHETIC_SECRET|SYNTHETIC_URL_SECRET|private\.invalid|no-network\.invalid|password|postgresql:\/\//i);
  assert.equal(child.stderr.trim().split('\n').length, 1, 'Repeated real idle failures are rate-limited to one log.');
  assert.ok(child.stderr.trim().length < 160);
  console.log('Postgres pool checks passed: actual idle-disconnect subprocess survives and reconnects, active/transaction failures remain rejected, original rollback cause and uncertain commits preserved, no write retries, scoped cleanup, verified TLS, bounded redacted logs, no global swallowing, clean close.');
}
