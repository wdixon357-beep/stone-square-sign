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

const usePglite = !process.env.DATABASE_URL;

let query;          // (sql, params) -> { rows, rowCount }
let closeDriver;

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
    // Neon terminates TLS at its proxy with a certificate chain node does not ship.
    ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
  });
  query = (sql, params) => pool.query(sql, params);
  closeDriver = () => pool.end();
  return { driver: 'pg', location: 'DATABASE_URL' };
};

const run = async (sql, params = []) => {
  if (!query) throw new Error('connect() was never called');
  return query(toPgPlaceholders(sql), params);
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
const addColumn = (table, column, type) =>
  run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);

export const initSchema = async () => {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'signer',
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS reset_codes (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code TEXT NOT NULL,
    phone TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'email',
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  )`);
  await run(`CREATE TABLE IF NOT EXISTS documents (
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
  await run(`CREATE TABLE IF NOT EXISTS document_signers (
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
  await run(`CREATE TABLE IF NOT EXISTS profile_signatures (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    signature_bytes BYTEA NOT NULL,
    signature_type TEXT NOT NULL,
    style_name TEXT,
    updated_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    document_id TEXT,
    action TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  )`);

  // carried forward so an existing database picks these up too
  await addColumn('document_signers', 'signed_ip', 'TEXT');
  await addColumn('document_signers', 'signed_user_agent', 'TEXT');
  await addColumn('document_signers', 'consent_text', 'TEXT');
  await addColumn('documents', 'completed_at', 'TEXT');
  await addColumn('reset_codes', 'channel', "TEXT NOT NULL DEFAULT 'email'");

  await run('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');
  await run('CREATE INDEX IF NOT EXISTS idx_signers_document ON document_signers(document_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_events(document_id)');
  await run('DELETE FROM sessions WHERE expires_at < $1', [new Date().toISOString()]);
};
