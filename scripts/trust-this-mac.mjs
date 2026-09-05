// Owner-authorized setup for William's existing local Mac installation only.
// Creates a separate revocable session; it does not alter website login policy.
import 'dotenv/config';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { postgresTlsOptions } from '../db.js';

const file = path.join(os.homedir(), 'Library/Containers/com.dstechnology.stonesquare.sign/Data/Library/Application Support/Stone Square Sign/session');
const base = 'https://stone-square-sign.onrender.com';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const current = (await fs.readFile(file, 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(current)) throw new Error('The installed Mac session is not available.');
const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${current}` }, redirect: 'error' });
if (!me.ok || (await me.json()).user?.role !== 'owner') throw new Error('An active owner session on this Mac is required.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: postgresTlsOptions() });
const temporary = `${file}.trusted-setup`;
let createdHash;
let committed = false;
try {
  await client.connect();
  await client.query('BEGIN');
  const {rows:[existing]} = await client.query(`SELECT s.user_id, s.expires_at, u.role, u.access_revoked_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 FOR UPDATE OF s,u`, [hash(current)]);
  if (!existing || existing.role !== 'owner' || existing.access_revoked_at || Date.parse(existing.expires_at) < Date.now()) {
    throw new Error('The owner session is no longer valid.');
  }
  // The existing schema requires an expiration. Year 9999 represents manual
  // revocation only for this one credential; ordinary sessions retain 90 days.
  if (existing.expires_at.startsWith('9999-')) {
    await client.query('ROLLBACK');
    console.log('This Mac already has its persistent owner session.');
  } else {
    const token = crypto.randomBytes(32).toString('hex');
    createdHash = hash(token);
    await client.query('INSERT INTO sessions (user_id, token, expires_at) VALUES ($1,$2,$3)', [existing.user_id, createdHash, '9999-12-31T23:59:59.999Z']);
    await client.query(`INSERT INTO audit_events (user_id, action, user_agent, details_json, created_at)
      VALUES ($1,$2,$3,$4,$5)`, [existing.user_id, 'trusted_mac_login_enabled', 'Stone Square Sign local setup',
      JSON.stringify({device:'Owner Mac app',authorization:'Owner requested no password or Touch ID on this Mac',revocation:'Account reset, access revocation or deleting this session',websiteSessionPolicyChanged:false}),new Date().toISOString()]);
    await fs.writeFile(temporary, token, { mode: 0o600, flag: 'wx' });
    await client.query('COMMIT'); committed = true;
    const check = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    if (!check.ok || (await check.json()).user?.role !== 'owner') throw new Error('The persistent session could not be verified.');
    await fs.rename(temporary, file);
    console.log('Persistent owner login installed and verified. Website sessions unchanged.');
  }
} catch (error) {
  if (!committed) await client.query('ROLLBACK').catch(()=>{});
  else if (createdHash) await client.query('DELETE FROM sessions WHERE token=$1',[createdHash]);
  await fs.unlink(temporary).catch(()=>{});
  throw error;
} finally { await client.end(); }
