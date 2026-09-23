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
  'dues_adjustments', 'suggestions',
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
  await exec(`CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at TEXT NOT NULL
  )`);
  await exec('CREATE INDEX IF NOT EXISTS rate_limits_reset ON rate_limits(reset_at)');
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
  /* Plaud transcripts and the minutes built from them remain private officer records.
   * Nothing in this table is exposed to viewers or Wardens. Authorization to circulate
   * a draft is separate from the Lodge's later approval of the official minutes. */
  await exec(`CREATE TABLE IF NOT EXISTS meeting_minutes (
    id TEXT PRIMARY KEY,
    meeting_date TEXT,
    source_name TEXT NOT NULL,
    transcript_text TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    updated_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_for_review_at TEXT,
    preparer_attested_at TEXT,
    master_attested_by_user_id INTEGER REFERENCES users(id),
    master_attested_at TEXT,
    preparer_review_seen_at TEXT,
    authorized_by_user_id INTEGER REFERENCES users(id),
    authorized_at TEXT,
    distributed_by_user_id INTEGER REFERENCES users(id),
    distributed_at TEXT,
    approved_by_lodge_on TEXT,
    approval_note TEXT
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS meeting_minutes_attestations (
    id TEXT PRIMARY KEY,
    minutes_id TEXT NOT NULL REFERENCES meeting_minutes(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    phase TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    signature_bytes BYTEA NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS minutes_distribution_alerts (
    minutes_id TEXT NOT NULL REFERENCES meeting_minutes(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    seen_at TEXT,
    PRIMARY KEY (minutes_id, user_id)
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_minutes_distribution_alerts_user
    ON minutes_distribution_alerts(user_id, seen_at, created_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_meeting_minutes_date
    ON meeting_minutes(meeting_date, created_at)`);
  /* Read only records imported from the Lodge's historical archive. These are
   * deliberately separate from current workflows so an old file is never
   * assigned a modern approval, attestation, or distribution status. */
  await exec(`CREATE TABLE IF NOT EXISTS historical_reports (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('minutes', 'treasury')),
    title TEXT NOT NULL,
    record_date TEXT,
    original_name TEXT NOT NULL,
    original_mime TEXT NOT NULL,
    original_bytes BYTEA NOT NULL,
    rendered_pdf_bytes BYTEA NOT NULL,
    original_sha256 TEXT NOT NULL,
    rendered_sha256 TEXT NOT NULL,
    source_label TEXT NOT NULL,
    evidence_status TEXT NOT NULL DEFAULT 'historical_archive',
    imported_at TEXT NOT NULL,
    UNIQUE (kind, original_sha256)
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_historical_reports_kind_date
    ON historical_reports(kind, record_date DESC, title)`);
  /* Signed officer reports are retained in the Dashboard for the Worshipful Master.
   * The generator may be embedded in the website or native on the Mac, so the
   * external receipt is the idempotency key and the final PDF is the record. */
  await exec(`CREATE TABLE IF NOT EXISTS officer_reports (
    id TEXT PRIMARY KEY,
    external_id TEXT UNIQUE NOT NULL,
    client_id TEXT,
    report_type TEXT NOT NULL,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    pdf_bytes BYTEA NOT NULL,
    prepared_by_user_id INTEGER REFERENCES users(id),
    prepared_by_name TEXT NOT NULL,
    prepared_by_office TEXT NOT NULL,
    prepared_by_email TEXT,
    emailed BOOLEAN NOT NULL DEFAULT FALSE,
    source_label TEXT NOT NULL DEFAULT 'Lodge Report Generator',
    submitted_at TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_officer_reports_submitted
    ON officer_reports(submitted_at DESC, title)`);
  /* Official correspondence is saved as a private draft. A PDF preview is
   * generated from these fields; saving never signs or sends a letter. */
  await exec(`CREATE TABLE IF NOT EXISTS correspondence_drafts (
    id TEXT PRIMARY KEY,
    matter TEXT NOT NULL,
    recipient_lodge TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    prepared_by_user_id INTEGER NOT NULL REFERENCES users(id),
    prepared_by_name TEXT NOT NULL,
    prepared_by_office TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_correspondence_drafts_updated
    ON correspondence_drafts(updated_at DESC)`);
  await addColumn(exec, 'correspondence_drafts', 'assigned_to_user_id', 'INTEGER REFERENCES users(id)');
  await addColumn(exec, 'correspondence_drafts', 'assigned_to_name', 'TEXT');
  await addColumn(exec, 'correspondence_drafts', 'assigned_to_office', 'TEXT');
  await addColumn(exec, 'correspondence_drafts', 'submitted_at', 'TEXT');
  await addColumn(exec, 'correspondence_drafts', 'signed_by_user_id', 'INTEGER REFERENCES users(id)');
  await addColumn(exec, 'correspondence_drafts', 'signed_by_name', 'TEXT');
  await addColumn(exec, 'correspondence_drafts', 'signed_at', 'TEXT');
  await addColumn(exec, 'correspondence_drafts', 'signed_signature_bytes', 'BYTEA');
  await addColumn(exec, 'correspondence_drafts', 'return_note', 'TEXT');
  await addColumn(exec, 'correspondence_drafts', 'signing_mode', "TEXT NOT NULL DEFAULT 'single'");
  await addColumn(exec, 'correspondence_drafts', 'shared_signer_1_id', 'INTEGER REFERENCES users(id)');
  await addColumn(exec, 'correspondence_drafts', 'shared_signer_2_id', 'INTEGER REFERENCES users(id)');
  /* Agendas are private working documents created only by the Lodge owner. */
  await exec(`CREATE TABLE IF NOT EXISTS agendas (
    id TEXT PRIMARY KEY,
    meeting_date TEXT,
    draft_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    revision INTEGER NOT NULL DEFAULT 1,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    updated_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_agendas_date
    ON agendas(meeting_date, updated_at)`);
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
  await exec(`CREATE TABLE IF NOT EXISTS dispensation_proposals (
    id TEXT PRIMARY KEY,
    proposer_user_id INTEGER NOT NULL REFERENCES users(id),
    proposer_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    request_date TEXT,
    event_date TEXT,
    request_details TEXT,
    event_time TEXT,
    location_name TEXT,
    street_address TEXT,
    city_state TEXT,
    title TEXT,
    proposer_note TEXT,
    wm_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by INTEGER REFERENCES users(id),
    resulting_document_id TEXT REFERENCES documents(id)
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_proposals_status
    ON dispensation_proposals(status)`);
  /* The cap on Wardens is the WARDEN_EMAILS allowlist in server.js, enforced at invite
   * time and again on every request. A unique index on email would add nothing, since
   * users.email is already unique. This index just makes the seat cheap to look up. */
  await exec(`CREATE INDEX IF NOT EXISTS idx_users_warden
    ON users(role) WHERE role = 'warden'`);

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

  await exec(`CREATE TABLE IF NOT EXISTS dues_adjustments (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    roster_id INTEGER NOT NULL REFERENCES roster(id),
    dues_year TEXT NOT NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('payment','credit','refund','chargeback','correction','reversal')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
    effective_date TEXT NOT NULL,
    payment_method TEXT,
    source_reference TEXT,
    note TEXT,
    entered_by_user_id INTEGER NOT NULL REFERENCES users(id),
    reverses_adjustment_id INTEGER REFERENCES dues_adjustments(id),
    created_at TEXT NOT NULL
  )`);
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dues_adjustment_reversal
    ON dues_adjustments(reverses_adjustment_id) WHERE reverses_adjustment_id IS NOT NULL`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_dues_adjustments_roster_year
    ON dues_adjustments(roster_id, dues_year, effective_date)`);
  await exec(`CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference_code TEXT UNIQUE NOT NULL,
    submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Received' CHECK (status IN ('Received','Under Review','Responded','Closed')),
    owner_response TEXT,
    reviewed_by_user_id INTEGER REFERENCES users(id),
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_submitter
    ON suggestions(submitted_by_user_id, submitted_at)`);

  // carried forward so an existing database picks these up too
  await addColumn(exec, 'document_signers', 'signed_ip', 'TEXT');
  await addColumn(exec, 'document_signers', 'signed_user_agent', 'TEXT');
  await addColumn(exec, 'document_signers', 'consent_text', 'TEXT');
  /* 'all' means every assigned officer must sign, which is the original behaviour.
   * 'any' means the document goes to both Secretaries and the first one to sign
   * completes it; the other's row is superseded rather than left hanging in his queue. */
  await addColumn(exec, 'documents', 'signing_mode', "TEXT NOT NULL DEFAULT 'all'");
  await addColumn(exec, 'document_signers', 'superseded_at', 'TEXT');
  /* Submission to the District Deputy. Recorded on the document rather than inferred, so the
   * Master can see at a glance what actually left the building and what only looked like it did.
   * submitted_error holds the reason when it failed, because a silent failure is how a
   * dispensation misses its date. */
  await addColumn(exec, 'documents', 'submitted_at', 'TEXT');
  await addColumn(exec, 'documents', 'submitted_to', 'TEXT');
  await addColumn(exec, 'documents', 'submitted_error', 'TEXT');
  /* What the District Deputy decided, and the proof of it.
   *
   * Neither dispensation the Lodge holds as "approved" has anything written in the approval
   * block: no tick, no date, no signature, no title. Both were approved by email instead. So the
   * decision has to be recorded as its own fact with its own evidence, rather than inferred from
   * a form that was never endorsed. approved_bytes holds the returned endorsed copy on the day
   * one finally comes back. */
  await addColumn(exec, 'documents', 'approval_status', 'TEXT');
  await addColumn(exec, 'documents', 'approved_by', 'TEXT');
  await addColumn(exec, 'documents', 'approved_on', 'TEXT');
  await addColumn(exec, 'documents', 'approval_source', 'TEXT');
  await addColumn(exec, 'documents', 'approval_note', 'TEXT');
  await addColumn(exec, 'documents', 'approved_bytes', 'BYTEA');
  await addColumn(exec, 'documents', 'approval_recorded_at', 'TEXT');
  await addColumn(exec, 'documents', 'completed_at', 'TEXT');
  await addColumn(exec, 'documents', 'template_kind', 'TEXT');
  await addColumn(exec, 'reset_codes', 'channel', "TEXT NOT NULL DEFAULT 'email'");
  await addColumn(exec, 'users', 'access_revoked_at', 'TEXT');
  await addColumn(exec, 'users', 'permissions_json', 'TEXT');
  await addColumn(exec, 'users', 'roster_id', 'INTEGER REFERENCES roster(id)');
  await addColumn(exec, 'invitations', 'permissions_json', 'TEXT');
  await addColumn(exec, 'invitations', 'roster_id', 'INTEGER REFERENCES roster(id)');
  await exec(`UPDATE users u SET roster_id=r.id FROM roster r
    WHERE u.roster_id IS NULL AND EXISTS (SELECT 1 FROM unnest(r.emails) e WHERE lower(e)=lower(u.email))
      AND NOT EXISTS (SELECT 1 FROM users linked WHERE linked.roster_id=r.id AND linked.id<>u.id)`);
  await exec(`UPDATE invitations i SET roster_id=r.id FROM roster r
    WHERE i.roster_id IS NULL AND i.used_at IS NULL
      AND EXISTS (SELECT 1 FROM unnest(r.emails) e WHERE lower(e)=lower(i.email))
      AND NOT EXISTS (SELECT 1 FROM invitations linked WHERE linked.roster_id=r.id AND linked.id<>i.id AND linked.used_at IS NULL)`);
  await addColumn(exec, 'sessions', 'created_at', 'TEXT');
  await addColumn(exec, 'sessions', 'last_seen_at', 'TEXT');
  await addColumn(exec, 'sessions', 'client_label', 'TEXT');
  await addColumn(exec, 'sessions', 'user_agent', 'TEXT');
  await addColumn(exec, 'meeting_minutes', 'preparer_attested_at', 'TEXT');
  await addColumn(exec, 'meeting_minutes', 'master_attested_by_user_id', 'INTEGER REFERENCES users(id)');
  await addColumn(exec, 'meeting_minutes', 'master_attested_at', 'TEXT');
  await addColumn(exec, 'meeting_minutes', 'preparer_review_seen_at', 'TEXT');
  await addColumn(exec, 'meeting_minutes', 'submitted_draft_json', 'TEXT');
  await addColumn(exec, 'meeting_minutes', 'preparer_signature_bytes', 'BYTEA');
  await addColumn(exec, 'meeting_minutes', 'master_signature_bytes', 'BYTEA');
  await addColumn(exec, 'meeting_minutes', 'master_changes_json', 'TEXT');
  await addColumn(exec, 'meeting_minutes', 'source_uploaded_by_user_id', 'INTEGER REFERENCES users(id)');
  await addColumn(exec, 'meeting_minutes', 'preparer_user_id', 'INTEGER REFERENCES users(id)');
  await addColumn(exec, 'meeting_minutes', 'claimed_at', 'TEXT');
  await exec(`UPDATE meeting_minutes SET source_uploaded_by_user_id = created_by_user_id
    WHERE source_uploaded_by_user_id IS NULL`);
  await exec(`UPDATE meeting_minutes SET preparer_user_id = created_by_user_id
    WHERE preparer_user_id IS NULL AND status <> 'awaiting_preparer'`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_meeting_minutes_handoff
    ON meeting_minutes(status, preparer_user_id, created_at DESC)`);

  /* Seed signed-minutes notices for every active Dashboard account. The API still
   * enforces minutes.view before returning a notice or the signed record. */
  await exec(`INSERT INTO minutes_distribution_alerts (minutes_id, user_id, created_at)
    SELECT m.id, u.id, COALESCE(m.master_attested_at, m.updated_at)
    FROM meeting_minutes m CROSS JOIN users u
    WHERE m.status IN ('ready_for_distribution', 'distributed', 'approved_by_lodge')
      AND m.master_attested_at IS NOT NULL AND u.access_revoked_at IS NULL
    ON CONFLICT (minutes_id, user_id) DO NOTHING`);

  await exec('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');
  await exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_roster_id ON users(roster_id) WHERE roster_id IS NOT NULL');
  await exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_active_invitation_roster_id ON invitations(roster_id) WHERE roster_id IS NOT NULL AND used_at IS NULL');
  await exec('CREATE INDEX IF NOT EXISTS idx_signers_document ON document_signers(document_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_events(document_id)');
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_office
    ON users(role) WHERE role IN ('secretary', 'assistant_secretary')
    AND access_revoked_at IS NULL AND email NOT LIKE '%.local'`);
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_office_invitation
    ON invitations(role) WHERE role IN ('secretary', 'assistant_secretary') AND used_at IS NULL`);
  await exec('DELETE FROM sessions WHERE expires_at < $1', [new Date().toISOString()]);
};
