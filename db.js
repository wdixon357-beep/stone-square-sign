/* One database adapter, two drivers.
 *
 * Production talks to Neon over `pg`. Local development and the test suite talk to
 * PGlite, which is the same PostgreSQL compiled to WebAssembly, so the SQL proved
 * here is the SQL that runs in production. Nothing has to be installed on the Mac.
 *
 * The app previously ran on SQLite with the PDFs on local disk. A free Render web
 * service cannot attach a persistent disk and wipes its filesystem on every restart,
 * so the documents, the signed copies and the signature images all live in the
 * database now as bytea. At roughly 300 KB a dispensation, Neon's free 0.5 GB holds
 * on the order of 1,600 of them.
 *
 * The dbRun / dbGet / dbAll surface is deliberately unchanged from the SQLite
 * version, including the { lastID, changes } return, so the call sites did not have
 * to be rewritten around a new idiom.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const usePglite = !process.env.DATABASE_URL;

let query;          // (sql, params) -> { rows, rowCount }
let closeDriver;
let beginTransaction;
const transactionQuery = new AsyncLocalStorage();

export const isUniqueViolation = (error) =>
  error?.code === '23505' || /UNIQUE constraint failed/i.test(String(error?.message || ''));

export const postgresTlsOptions = ({
  databaseUrl = process.env.DATABASE_URL || '',
  pgssl = process.env.PGSSL || '',
  ca = process.env.PGSSL_CA || '',
} = {}) => {
  if (String(pgssl).toLowerCase() === 'off') return false;
  let sslMode = '';
  try {
    sslMode = new URL(databaseUrl).searchParams.get('sslmode') || '';
  } catch {
    // pg will provide the useful connection-string error; TLS remains fail-closed.
  }
  if (sslMode.toLowerCase() === 'disable') {
    throw new Error('DATABASE_URL cannot disable TLS. Use a verified managed PostgreSQL connection string.');
  }
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca: ca.replace(/\\n/g, '\n') } : {}),
  };
};

/* `?` is SQLite's placeholder and `$1` is Postgres's. Translate, but never inside a
 * quoted literal, or a question mark in ordinary text would shift every later index. */
export const toPgPlaceholders = (sql) => {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += sql[i + 1]; i += 1; }   // doubled, an escape
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '?') { n += 1; out += `$${n}`; continue; }
    out += ch;
  }
  return out;
};

const isInsert = (sql) => /^\s*insert\s+into/i.test(sql);
const hasReturning = (sql) => /\breturning\b/i.test(sql);

/* Only these carry a generated integer id worth handing back as lastID. `documents`
 * uses a caller-supplied text id and `profile_signatures` is keyed on user_id. */
const IDENTITY_TABLES = new Set([
  'users', 'sessions', 'reset_codes', 'document_signers', 'invitations', 'audit_events',
]);
const insertTarget = (sql) => (sql.match(/^\s*insert\s+into\s+"?([a-z_]+)"?/i)?.[1] || '').toLowerCase();

export const connect = async () => {
  if (usePglite) {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || null;      // null keeps it in memory, for tests
    const db = await PGlite.create(dir ? { dataDir: dir } : {});
    query = (sql, params) => db.query(sql, params);
    beginTransaction = (callback) => db.transaction((tx) =>
      transactionQuery.run((sql, params) => tx.query(sql, params), callback));
    closeDriver = () => db.close();
    return { driver: 'pglite', location: dir || 'memory' };
  }
  const { default: pg } = await import('pg');
  /* node-postgres hands back int8 (which is what COUNT(*) is) as a STRING, because a
   * 64 bit integer does not always survive a JS number. PGlite hands back a number.
   * Left alone, that divergence means `remaining === 0` is true on the local test and
   * false on Neon, and a document would never reach completed in production while
   * every test passed. Counts here are small, so parse them and make the two agree. */
  pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: postgresTlsOptions(),
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
  });
  query = (sql, params) => pool.query(sql, params);
  beginTransaction = async (callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionQuery.run(
        (sql, params) => client.query(sql, params),
        callback,
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  closeDriver = () => pool.end();
  return { driver: 'pg', location: 'DATABASE_URL' };
};

const run = async (sql, params = []) => {
  if (!query) throw new Error('connect() was never called');
  return (transactionQuery.getStore() || query)(toPgPlaceholders(sql), params);
};

export const withTransaction = async (callback) => {
  if (transactionQuery.getStore()) return callback();
  if (!beginTransaction) throw new Error('connect() was never called');
  return beginTransaction(callback);
};

export const dbRun = async (sql, params = []) => {
  let text = sql;
  if (isInsert(sql) && !hasReturning(sql) && IDENTITY_TABLES.has(insertTarget(sql))) {
    text = `${sql.replace(/;\s*$/, '')} RETURNING id`;
  }
  const result = await run(text, params);
  return { lastID: result.rows?.[0]?.id ?? null, changes: result.rowCount ?? 0 };
};

export const dbGet = async (sql, params = []) => (await run(sql, params)).rows[0];
export const dbAll = async (sql, params = []) => (await run(sql, params)).rows;
export const close = async () => { if (closeDriver) await closeDriver(); };

/* Postgres has no ALTER TABLE ... ADD COLUMN unless not exists before 9.6 and no
 * PRAGMA table_info at all, so the SQLite helper is replaced outright. */
const addColumn = (exec, table, column, type) =>
  exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);

/* Takes an optional runner so the migration tool can build this same schema on a
 * target it already holds open, without db.js opening a second connection to it. */
export const initSchema = async (exec = run) => {
  await exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'signer',
    created_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS reset_codes (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'email',
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    owner_email TEXT,
    file_bytes BYTEA NOT NULL,
    signed_bytes BYTEA,
    status TEXT NOT NULL DEFAULT 'pending',
    parsed_preview TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS document_signers (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    signer_role TEXT NOT NULL,
    signer_name TEXT NOT NULL,
    signed_at TEXT,
    signature_bytes BYTEA,
    signed_ip TEXT,
    signed_user_agent TEXT,
    consent_text TEXT
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS profile_signatures (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    signature_bytes BYTEA NOT NULL,
    signature_type TEXT NOT NULL,
    style_name TEXT,
    updated_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS submission_profiles (
    role TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    source_reference TEXT,
    updated_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    document_id TEXT,
    action TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS office_slots (
    role TEXT PRIMARY KEY
  )`);
  await exec("INSERT INTO office_slots (role) VALUES ('secretary') ON CONFLICT (role) DO NOTHING");
  await exec("INSERT INTO office_slots (role) VALUES ('assistant_secretary') ON CONFLICT (role) DO NOTHING");
  await exec('ALTER TABLE users DROP COLUMN IF EXISTS phone');
  await exec('ALTER TABLE reset_codes DROP COLUMN IF EXISTS phone');
  await exec('ALTER TABLE invitations DROP COLUMN IF EXISTS phone');

  /* The Lodge roster. It lives here rather than in source because this repository
   * is public and these are 46 Brothers' names and email addresses. Seeded once by
   * scripts/seed-roster.mjs and used to match Zeffy payments to the right man. */
  await exec(`CREATE TABLE IF NOT EXISTS roster (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    title TEXT,
    prefix TEXT,
    emails TEXT[] NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    UNIQUE (first_name, last_name)
  )`);

  // carried forward so an existing database picks these up too
  await addColumn(exec, 'document_signers', 'signed_ip', 'TEXT');
  await addColumn(exec, 'document_signers', 'signed_user_agent', 'TEXT');
  await addColumn(exec, 'document_signers', 'consent_text', 'TEXT');
  /* 'all' means every assigned officer must sign, which is the original behaviour.
   * 'any' means the document goes to both Secretaries and the first one to sign
   * completes it; the other's row is superseded rather than left hanging in his queue. */
  await addColumn(exec, 'documents', 'signing_mode', "TEXT NOT NULL DEFAULT 'all'");
  await addColumn(exec, 'document_signers', 'superseded_at', 'TEXT');
  await addColumn(exec, 'documents', 'completed_at', 'TEXT');
  await addColumn(exec, 'documents', 'template_kind', 'TEXT');
  await addColumn(exec, 'reset_codes', 'channel', "TEXT NOT NULL DEFAULT 'email'");
  await addColumn(exec, 'users', 'access_revoked_at', 'TEXT');

  await exec('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');
  await exec('CREATE INDEX IF NOT EXISTS idx_signers_document ON document_signers(document_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_events(document_id)');
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_office
    ON users(role) WHERE role IN ('secretary', 'assistant_secretary')
    AND access_revoked_at IS NULL AND email NOT LIKE '%.local'`);
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_office_invitation
    ON invitations(role) WHERE role IN ('secretary', 'assistant_secretary') AND used_at IS NULL`);
  await exec('DELETE FROM sessions WHERE expires_at < $1', [new Date().toISOString()]);
};
