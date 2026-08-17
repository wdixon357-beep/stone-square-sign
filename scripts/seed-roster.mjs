/* Loads the Lodge roster into the database.
 *
 *   node scripts/seed-roster.mjs                 # into the local .pglite
 *   DATABASE_URL="..." node scripts/seed-roster.mjs   # into Neon
 *
 * Reads the roster from the Lodge website's gitignored src/lib/roster.ts, which is the
 * one place it is maintained. It is deliberately NOT copied into this repository,
 * because this repository is public and those are 46 Brothers' names and addresses.
 * Run this from William's Mac, which already holds the file.
 *
 * Idempotent. Re-running updates existing Brothers and adds new ones; it never drops
 * anybody, because a name vanishing from a roster file should not silently erase a
 * man's dues history.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect, initSchema, dbRun, dbGet, close } from '../db.js';

const SOURCE = process.argv[2]
  || path.join(os.homedir(), 'lodge22-site', 'src', 'lib', 'roster.ts');

if (!fs.existsSync(SOURCE)) {
  console.error(`Roster not found at ${SOURCE}`);
  console.error('Pass the path as an argument if it lives somewhere else.');
  process.exit(2);
}

/* The roster is a TypeScript array literal. Rather than pull in a parser, read the
 * fields off each entry with a regex; the shape is stable and machine written. */
const src = fs.readFileSync(SOURCE, 'utf8');
const entries = [...src.matchAll(/\{\s*last:\s*"([^"]*)",\s*first:\s*"([^"]*)",\s*title:\s*"([^"]*)",\s*prefix:\s*"([^"]*)"[\s\S]*?emails:\s*\[([^\]]*)\]/g)]
  .map((m) => ({
    last: m[1],
    first: m[2],
    title: m[3],
    prefix: m[4],
    emails: [...m[5].matchAll(/"([^"]+)"/g)].map((e) => e[1].toLowerCase()),
  }));

if (!entries.length) {
  console.error('Parsed zero Brothers. The roster format may have changed.');
  process.exit(1);
}

const info = await connect();
await initSchema();

let added = 0;
let updated = 0;
for (const e of entries) {
  const existing = await dbGet(
    'SELECT id FROM roster WHERE first_name = ? AND last_name = ?', [e.first, e.last],
  );
  if (existing) {
    await dbRun(
      'UPDATE roster SET title = ?, prefix = ?, emails = ?, updated_at = ? WHERE id = ?',
      [e.title, e.prefix, e.emails, new Date().toISOString(), existing.id],
    );
    updated += 1;
  } else {
    await dbRun(
      'INSERT INTO roster (first_name, last_name, title, prefix, emails, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [e.first, e.last, e.title, e.prefix, e.emails, new Date().toISOString()],
    );
    added += 1;
  }
}

const total = await dbGet('SELECT COUNT(*) AS c FROM roster');
const withEmail = await dbGet("SELECT COUNT(*) AS c FROM roster WHERE array_length(emails, 1) > 0");

console.log(`database: ${info.driver} (${info.location})`);
console.log(`parsed ${entries.length} Brothers from the roster`);
console.log(`  added   ${added}`);
console.log(`  updated ${updated}`);
console.log(`roster now holds ${total.c} Brothers, ${withEmail.c} with an email on file`);
console.log('\nNo names were printed. Nothing was written to this repository.');
await close();
