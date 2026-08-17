/* Migrates the local PGlite database into a target Postgres (Neon in production).
 *
 *   node migrate.mjs --to "$NEON_URL"            copy and verify
 *   node migrate.mjs --to "$NEON_URL" --verify   verify only, no writes
 *   node migrate.mjs --to "$NEON_URL" --force    allow a non-empty target
 *
 * The source is opened read only in spirit: nothing here writes to .pglite.
 *
 * The table list is read from the source's own catalog rather than hard coded, so
 * tables added after this was written (office_slots, submission_profiles) migrate
 * without anyone remembering to update a list. Only the FK ordering is fixed.
 *
 * Identity columns are inserted with OVERRIDING SYSTEM VALUE so primary keys survive
 * the move; document_signers and audit_events reference documents by id, and a
 * renumbered users table would silently reassign who signed what.
 */

import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const has = (name) => args.includes(name);

const TARGET = arg('--to') || process.env.TARGET_DATABASE_URL;
const SOURCE_DIR = arg('--from') || process.env.PGLITE_DIR || '.pglite';
const VERIFY_ONLY = has('--verify');
const FORCE = has('--force');

if (!TARGET) {
  console.error('Give a target with --to "postgres://..." or TARGET_DATABASE_URL.');
  process.exit(2);
}

/* parents before children */
const ORDER = [
  'users', 'sessions', 'invitations', 'reset_codes', 'submission_profiles',
  'office_slots', 'profile_signatures', 'documents', 'document_signers', 'audit_events',
];

/* Columns holding bytes whose integrity is verified hash by hash, with the key each
 * table is actually identified by. profile_signatures is keyed on user_id, not id. */
const BLOBS = {
  documents: { key: 'id', cols: ['file_bytes', 'signed_bytes'] },
  document_signers: { key: 'id', cols: ['signature_bytes'] },
  profile_signatures: { key: 'user_id', cols: ['signature_bytes'] },
};

const sha = (buf) => (buf == null ? null : crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex'));
const redact = (url) => String(url).replace(/\/\/[^@]*@/, '//***:***@');

/* The source is a PGlite directory by default, but accepts a postgres:// URL too.
 * That is what makes a Neon backup possible without pg_dump: run this the other way,
 * Neon to a local PGlite directory, and every row and every stored byte is hash
 * verified on the way out by the same code path that verified them on the way in. */
const openSource = async () => {
  if (/^postgres(ql)?:\/\//.test(SOURCE_DIR)) {
    const { default: pg } = await import('pg');
    const { postgresTlsOptions } = await import('./db.js');
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    const pool = new pg.Pool({
      connectionString: SOURCE_DIR,
      ssl: postgresTlsOptions({ databaseUrl: SOURCE_DIR }),
      max: 4,
    });
    return {
      label: redact(SOURCE_DIR),
      query: (sql, params = []) => pool.query(sql, params),
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create({ dataDir: SOURCE_DIR });
  return {
    label: `pglite ${SOURCE_DIR}`,
    query: (sql, params = []) => db.query(sql, params),
    close: () => db.close(),
  };
};

const openTarget = async () => {
  /* A pglite: target exists so the whole copy-and-verify path can be exercised
   * against real Postgres before it is ever pointed at Neon. Same SQL, no network. */
  if (TARGET.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = TARGET.slice('pglite:'.length);
    const db = await PGlite.create(dir ? { dataDir: dir } : {});
    return {
      label: `pglite ${dir || 'memory'} (rehearsal)`,
      query: (sql, params = []) => db.query(sql, params),
      close: () => db.close(),
    };
  }
  const { default: pg } = await import('pg');
  const { postgresTlsOptions } = await import('./db.js');
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  const pool = new pg.Pool({
    connectionString: TARGET,
    // same fail-closed TLS the app itself uses; a migration must not be the weak link
    ssl: postgresTlsOptions({ databaseUrl: TARGET }),
    max: 4,
  });
  return {
    label: redact(TARGET),
    query: (sql, params = []) => pool.query(sql, params),
    close: () => pool.end(),
  };
};

const tablesIn = async (db) => {
  const { rows } = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const found = rows.map((r) => r.tablename);
  const ordered = ORDER.filter((t) => found.includes(t));
  const extra = found.filter((t) => !ORDER.includes(t));
  if (extra.length) ordered.push(...extra);   // migrate it anyway, at the end
  return { ordered, extra };
};

const columnsOf = async (db, table) => {
  const { rows } = await db.query(
    `SELECT column_name, is_identity FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return {
    names: rows.map((r) => r.column_name),
    hasIdentity: rows.some((r) => r.is_identity === 'YES'),
  };
};

const fingerprint = async (db, tables) => {
  const out = {};
  for (const t of tables) {
    const { rows } = await db.query(`SELECT COUNT(*) AS c FROM ${t}`);
    out[t] = { rows: Number(rows[0].c), blobs: {} };
    const spec = BLOBS[t];
    for (const col of spec?.cols || []) {
      const { rows: data } = await db.query(
        `SELECT ${spec.key} AS k, ${col} AS b FROM ${t} ORDER BY ${spec.key}`,
      );
      for (const r of data) {
        if (r.b != null) out[t].blobs[`${r.k}.${col}`] = sha(r.b);
      }
    }
  }
  return out;
};

const source = await openSource();
const target = await openTarget();
let failures = 0;

try {
  console.log(`source: ${source.label}`);
  console.log(`target: ${target.label}\n`);

  const { ordered: tables, extra } = await tablesIn(source);
  if (extra.length) console.log(`note: migrating tables not in the fixed order last: ${extra.join(', ')}\n`);

  if (!VERIFY_ONLY) {
    /* Occupancy is judged BEFORE the schema is built. initSchema seeds rows of its
     * own (the two office slots), so counting after it would always look non-empty
     * and would mask a target that genuinely already holds somebody's data. */
    let occupied = 0;
    for (const t of tables) {
      try {
        const { rows } = await target.query(`SELECT COUNT(*) AS c FROM ${t}`);
        occupied += Number(rows[0].c);
      } catch { /* table does not exist yet, which is the normal fresh case */ }
    }
    if (occupied > 0 && !FORCE) {
      console.error(`ABORT: the target already holds ${occupied} rows. Re-run with --force only if you mean to overwrite.`);
      process.exit(1);
    }
    if (occupied > 0) console.log(`target holds ${occupied} rows and --force was given, they will be replaced\n`);

    console.log('Building the schema on the target');
    /* Hand initSchema the connection this tool already holds. Letting db.js open its
     * own would mean two handles on one database, and for a pglite target it would
     * try to parse "pglite:..." as a Postgres URL. */
    const { initSchema } = await import('./db.js');
    await initSchema((sql, params = []) => target.query(sql, params));
    console.log('  schema ready\n');

    /* Clear unconditionally. The target was verified empty above, so anything here
     * is initSchema's own seed data, which the source's real rows must replace. */
    for (const t of [...tables].reverse()) await target.query(`DELETE FROM ${t}`);

    console.log('Copying');
    for (const t of tables) {
      const { names, hasIdentity } = await columnsOf(source, t);
      const { rows } = await source.query(`SELECT ${names.join(', ')} FROM ${t}`);
      if (!rows.length) { console.log(`  ${String(0).padStart(6)}  ${t}`); continue; }
      const cols = names.join(', ');
      const overriding = hasIdentity ? 'OVERRIDING SYSTEM VALUE ' : '';
      for (const row of rows) {
        const values = names.map((n) => {
          const v = row[n];
          // pg needs a real Buffer for bytea; PGlite hands back a Uint8Array
          return v instanceof Uint8Array ? Buffer.from(v) : v;
        });
        const marks = names.map((_, i) => `$${i + 1}`).join(', ');
        await target.query(`INSERT INTO ${t} (${cols}) ${overriding}VALUES (${marks})`, values);
      }
      console.log(`  ${String(rows.length).padStart(6)}  ${t}`);
    }

    /* An identity sequence still sits at 1 after explicit inserts, so the next real
     * insert would collide with an existing primary key. Advance each one. */
    console.log('\nAdvancing identity sequences');
    for (const t of tables) {
      const { rows } = await target.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND is_identity='YES'`, [t],
      );
      for (const { column_name: col } of rows) {
        const { rows: max } = await target.query(`SELECT COALESCE(MAX(${col}), 0) AS m FROM ${t}`);
        const next = Number(max[0].m) + 1;
        await target.query(`ALTER TABLE ${t} ALTER COLUMN ${col} RESTART WITH ${next}`);
        console.log(`  ${t}.${col} restarts at ${next}`);
      }
    }
  }

  console.log('\nVerifying');
  const before = await fingerprint(source, tables);
  const after = await fingerprint(target, tables);

  console.log('\n  rows      source  target');
  for (const t of tables) {
    const a = before[t].rows; const b = after[t].rows;
    const ok = a === b;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${String(a).padStart(6)}  ${String(b).padStart(6)}  ${t}`);
  }

  console.log('\n  stored bytes, sha256 compared per object');
  let checked = 0;
  for (const t of tables) {
    for (const [key, hash] of Object.entries(before[t].blobs)) {
      checked += 1;
      const got = after[t].blobs[key];
      if (got !== hash) {
        failures += 1;
        console.log(`  FAIL  ${t}.${key}  ${String(hash).slice(0, 16)} != ${String(got).slice(0, 16)}`);
      } else {
        console.log(`  ok    ${t}.${key}  ${hash.slice(0, 16)}...`);
      }
    }
    const missing = Object.keys(after[t].blobs).filter((k) => !(k in before[t].blobs));
    for (const k of missing) { failures += 1; console.log(`  FAIL  ${t}.${k} exists on the target but not the source`); }
  }
  console.log(`  ${checked} stored objects compared`);

  /* the statuses the brief calls out by name */
  const { rows: statuses } = await target.query(
    'SELECT status, COUNT(*) AS c FROM documents GROUP BY status ORDER BY status',
  );
  console.log('\n  document status on the target');
  for (const s of statuses) console.log(`        ${String(s.c).padStart(3)}  ${s.status}`);
} catch (error) {
  failures += 1;
  console.error(`\nFAILED: ${error?.message || error}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 5).join('\n'));
} finally {
  await source.close();
  await target.close();
}

console.log(failures === 0
  ? '\nMigration verified. Row counts match and every stored PDF and signature hashes identical.'
  : `\n${failures} verification failure(s). The target is NOT trustworthy.`);
process.exit(failures === 0 ? 0 : 1);
