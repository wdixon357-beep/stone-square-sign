import { mountBuildingCalendar, initializeBuildingCalendar } from './building-calendar.js';
import { hasPermission, resolvePermissions, permissionsForStorage, mountAccessRoutes, ensureBrotherSelfServiceAccess } from './access-control.js';
import {organizeReport, reportSchema} from './report-ai.js';
import { initActivitySchema, mountActivityRoutes, startActivitySession, endActivitySession, endUserActivity, recordAppIncident, clientName } from './activity.js';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import nodemailer from 'nodemailer';
import { minutesReviewAlert, minutesCompletionAlert } from './minutes-alerts.js';
import { PDFParse } from 'pdf-parse';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  connect, initSchema, dbRun, dbGet, dbAll, withTransaction, isUniqueViolation,
} from './db.js';
import { buildDuesLedger, duesConfigured } from './dues.js';
import { buildDuesPdf, buildDuesXlsx, duesExportFileName } from './dues-export.js';
import { createSessionPolicy } from './session-policy.js';
import { buildMinutesDocx, minutesFileName } from './minutes-document.js';
import { buildMinutesPdf } from './minutes-pdf.js';
import { generateMinutesDraft, normalizeMinutesDraft } from './minutes.js';
import { minutesChanges } from './minutes-changes.js';
import { initGenerationSchema, generationFor, generationStatus } from './ai-generation.js';
import { attendanceReviewIssues, closingReviewIssues } from './minutes-format.js';
import { initTreasurySchema, mountTreasuryRoutes, treasuryAccess } from './treasury-routes.js';
import { initAgendaSchema, mountAgendaRoutes } from './agenda-routes.js';
import { mountArchiveRoutes } from './archive-routes.js';
import { mountOfficerReportRoutes } from './officer-report-routes.js';
import { mountCorrespondenceRoutes } from './correspondence.js';
import { mountMemberFeatures } from './member-features.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_DIR = path.resolve(process.cwd());
const DISPENSATION_TEMPLATE = path.join(APP_DIR, 'assets', 'grand-lodge-dispensation-template.pdf');
const APP_VERSION = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
// The Lodge's 90-day sign-in policy is part of the release. Legacy hosting
// settings must not silently shorten it to the former seven-day lifetime.
const SESSION_POLICY = createSessionPolicy();
const CANDIDATE_TRACKER_URL = String(
  process.env.CANDIDATE_TRACKER_URL || 'https://tracker.stonesquare22pha.org/',
).replace(/\/$/, '');
const REPORT_GENERATOR_URL = String(
  process.env.REPORT_GENERATOR_URL || 'https://request.stonesquare22pha.org/report',
);
const TRACKER_SSO_SHARED_SECRET = String(process.env.TRACKER_SSO_SHARED_SECRET || '');
const WEB_SESSION_COOKIE = 'ss22_session';
const OFFICE_ROLES = new Set(['secretary', 'assistant_secretary']);
const MINUTES_ROLES = new Set(['owner', 'secretary', 'assistant_secretary']);
/* One shared Lodge access code, so an officer can create his own account without waiting on an
 * invitation or on email working. It replaces five separate invitations with one word the Master
 * texts to the officers. Leave it unset and the app stays invitation only. */
const LODGE_ACCESS_CODE = String(process.env.LODGE_ACCESS_CODE || '').trim();
/* The District Deputy the Lodge reports to. Held in configuration rather than in the code because
 * deputies change, and a hard coded name is how a dispensation goes to last year's man. */
const DDGM_EMAIL = String(process.env.DDGM_EMAIL || '').trim();
const DDGM_NAME = String(process.env.DDGM_NAME || 'District Deputy Grand Master').trim();
const LODGE_NAME = String(process.env.LODGE_NAME || 'Stone Square Lodge No. 22').trim();
const SELF_SERVE_ROLES = new Set(['secretary', 'assistant_secretary', 'viewer']);
const secretsMatch = (supplied, expected) => {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const lockOfficeRole = async (role) => {
  if (OFFICE_ROLES.has(role)) {
    await dbGet('SELECT role FROM office_slots WHERE role = ? FOR UPDATE', [role]);
  }
};

const validateProductionConfiguration = () => {
  if (!IS_PRODUCTION) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('Production startup refused: DATABASE_URL is required.');
  }
  let publicUrl;
  try {
    publicUrl = new URL(String(process.env.APP_BASE_URL || ''));
  } catch {
    throw new Error('Production startup refused: APP_BASE_URL must be a valid public HTTPS URL.');
  }
  const localNames = new Set(['localhost', '127.0.0.1', '::1']);
  if (publicUrl.protocol !== 'https:' || localNames.has(publicUrl.hostname)
      || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('Production startup refused: APP_BASE_URL must be a valid public HTTPS URL.');
  }
  if (String(process.env.PGSSL || '').toLowerCase() === 'off') {
    throw new Error('Production startup refused: PostgreSQL TLS verification cannot be disabled.');
  }
};

/* Documents, signed copies and signature images are held in the database, not on
 * disk. A free Render web service has no persistent disk and wipes its filesystem
 * on every restart, which on the old layout lost every executed instrument. */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
const asBuffer = (value) => (value == null ? null : Buffer.from(value));

const nowIso = () => new Date().toISOString();
const normalizeEmail = (value = '') => String(value).trim().toLowerCase();
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const hashSecret = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');
const generateCode = () => String(crypto.randomInt(100000, 1000000));

const createTrackerHandoffUrl = (user) => {
  if (!TRACKER_SSO_SHARED_SECRET) {
    throw new Error('Candidate Tracker single sign-on is not configured.');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const permissions = resolvePermissions(user)
    .filter((permission) => ['candidates.view', 'candidates.edit'].includes(permission));
  const payload = Buffer.from(JSON.stringify({
    email: user.email,
    name: user.name,
    role: user.role,
    permissions,
    audience: 'stone-square-candidate-tracker',
    issuedAt,
    expiresAt: issuedAt + 60,
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TRACKER_SSO_SHARED_SECRET)
    .update(payload)
    .digest('base64url');
  const url = new URL('/api/sso', CANDIDATE_TRACKER_URL);
  url.searchParams.set('assertion', `${payload}.${signature}`);
  return url.toString();
};

const createReportAssertion = (user) => {
  if (!TRACKER_SSO_SHARED_SECRET) {
    throw new Error('Report Generator single sign-on is not configured.');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const payload = Buffer.from(JSON.stringify({
    aud: 'stone-square-report-generator',
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: resolvePermissions(user),
    issuedAt,
    expiresAt,
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TRACKER_SSO_SHARED_SECRET)
    .update(payload)
    .digest('base64url');
  return { assertion: `${payload}.${signature}`, expiresAt };
};

const isWebClient = (req) => req.get('x-stone-square-client') === 'web'
  || req.body?.client === 'web';
const requestsWebSession = (req) => req.body?.client === 'web';
const cookieValues = (req) => Object.fromEntries(
  String(req.headers.cookie || '').split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key),
);
const setWebSessionCookie = (res, token) => {
  const attributes = [
    `${WEB_SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_POLICY.lifetimeDays * 24 * 60 * 60}`,
  ];
  if (IS_PRODUCTION) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
};
const clearWebSessionCookie = (res) => {
  const attributes = [`${WEB_SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (IS_PRODUCTION) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
};

const createTransporter = () => {
  const { SMTP_USER: user, SMTP_PASS: pass, MAIL_FROM: from } = process.env;
  const host = process.env.SMTP_HOST || (user && pass && from ? 'smtp.gmail.com' : '');
  if (!host || !user || !pass || !from) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
};

const transporter = createTransporter();

const sendEmail = async ({ to, subject, text, attachment }) => {
  if (!to) return false;
  if (!transporter) {
    if (!IS_PRODUCTION) console.log(`[mail-preview] ${to}: ${subject}`);
    return false;
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    text,
    // attachments come from the database as bytes, there is no file on disk to point at
    attachments: attachment?.content
      ? [{ filename: attachment.filename || 'document.pdf', content: attachment.content }]
      : [],
  });
  return true;
};

const signatureRoleDefs = [
  {
    role: 'secretary',
    label: 'Secretary',
    defaultName: 'William McDuffie',
    phrases: [/secretary/i, /william\s+mcduffie/i, /w\.\s*mcduffie/i],
  },
  {
    role: 'assistant_secretary',
    label: 'Assistant Secretary',
    defaultName: 'Adrian Reese',
    phrases: [/assistant\s+secretary/i, /asst\.?\s*secretary/i, /adrian\s+reese/i, /a\.\s*reese/i],
  },
];

const detectSignersFromText = (text = '') => {
  const matches = signatureRoleDefs
    .filter((definition) => definition.phrases.some((pattern) => pattern.test(text)))
    .map(({ role, label, defaultName }) => ({ role, label, name: defaultName }));
  if (!matches.length && /dispensation/i.test(text)) {
    return signatureRoleDefs.map(({ role, label, defaultName }) => ({
      role,
      label,
      name: defaultName,
    }));
  }
  return matches;
};

const extractTextFromPdf = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return parsed.text || '';
  } finally {
    await parser.destroy();
  }
};

const createAuthToken = async (userId, req) => {
  const token = generateToken();
  const expiresAt = SESSION_POLICY.expiresAt();
  const createdAt = nowIso();
  await dbRun(`INSERT INTO sessions
    (user_id, token, expires_at, created_at, last_seen_at, client_label, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    userId,
    hashSecret(token),
    expiresAt,
    createdAt,
    createdAt,
    isWebClient(req) ? 'Web browser' : req.get('x-stone-square-client') === 'mac' ? 'Mac app' : 'Other device',
    String(req.get('user-agent') || '').slice(0, 500),
  ]);
  await startActivitySession(userId, hashSecret(token), req);
  return { token, session: { lifetimeDays: SESSION_POLICY.lifetimeDays, expiresAt } };
};

const userForResponse = async (user) => {
  const saved = await dbGet('SELECT 1 FROM profile_signatures WHERE user_id = ?', [user.id]);
  const accessUser = await dbGet('SELECT role,permissions_json,roster_id FROM users WHERE id=?',[user.id]);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    hasSignature: Boolean(saved),
    permissions: resolvePermissions(accessUser || user),
    treasuryAccess: await treasuryAccess({ ...user, ...accessUser }),
  };
};

/* Role capability sets. These are ALLOWLISTS on purpose.
 *
 * The old guards asked "is this role viewer?" and let everything else through. That is a
 * denylist, and it only ever tested the one role somebody happened to think of. The moment
 * a new role existed it would have fallen straight through into the signed dispensations
 * and the Master's private approval notes. Adding a role must never widen access by
 * accident, so every guard below asks what a role MAY do, not what it may not. */
const SIGNING_ROLES = new Set(['owner', 'secretary', 'assistant_secretary', 'signer']);
const APPROVAL_QUEUE_ROLES = new Set(['owner', 'secretary', 'assistant_secretary', 'viewer']);
const APPROVAL_NOTE_ROLES = new Set(['owner']);
/* The two Wardens are named in the environment, never in the source. This repository is
 * public, and a Brother's personal address is his, not the Lodge's to publish. Set
 * WARDEN_EMAILS to the two addresses, comma separated. Left unset, nobody can hold the
 * seat, which is the safe way to fail. */
const WARDEN_EMAILS = new Set(
  String(process.env.WARDEN_EMAILS || '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean),
);
const ACCOUNT_ROLES = ['secretary', 'assistant_secretary', 'treasurer', 'assistant_treasurer', 'treasury_preparer', 'viewer', 'warden', 'member', 'officer'];
const INVITABLE_ROLES = ACCOUNT_ROLES.filter((role) => role !== 'member');

const requireAuth = async (req, res, next) => {
  try {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const headerToken = bearer || req.headers['x-lodge-token'];
    const cookieToken = cookieValues(req)[WEB_SESSION_COOKIE];
    const token = headerToken || cookieToken;
    if (!token) return res.status(401).json({ error: 'Sign in is required.' });
    const authViaCookie = !headerToken && Boolean(cookieToken);
    if (authViaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let expectedOrigin = '';
      try { expectedOrigin = new URL(requestBaseUrl(req)).origin; } catch {}
      if (!req.get('origin') || req.get('origin') !== expectedOrigin) {
        return res.status(403).json({ error: 'This signed-in request did not come from Stone Square Sign.' });
      }
    }
    const tokenHash = hashSecret(token);
    const row = await dbGet(
      `SELECT users.id, users.email, users.name, users.role, users.permissions_json, users.roster_id, users.access_revoked_at,
              sessions.id AS session_id, sessions.expires_at, sessions.last_seen_at
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`,
      [tokenHash],
    );
    if (!row) return res.status(401).json({ error: 'Your sign in has expired.' });
    if (row.access_revoked_at) return res.status(403).json({ error: 'Your access has been revoked by the Worshipful Master.' });
    if (row.role === 'warden' && !WARDEN_EMAILS.has(normalizeEmail(row.email))) {
      return res.status(403).json({ error: 'Warden access is not configured for this account.' });
    }
    if (Date.now() > new Date(row.expires_at).getTime()) {
      await endActivitySession(tokenHash, 'Sign-in expired');
      await dbRun('DELETE FROM sessions WHERE token = ?', [tokenHash]);
      return res.status(401).json({ error: 'Your sign in has expired.' });
    }
    if (SESSION_POLICY.shouldRefresh(row.expires_at)) {
      row.expires_at = SESSION_POLICY.expiresAt();
      await dbRun('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token = ?', [
        row.expires_at, nowIso(), tokenHash,
      ]);
      if (authViaCookie) setWebSessionCookie(res, token);
    } else if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 5 * 60 * 1000) {
      await dbRun('UPDATE sessions SET last_seen_at = ? WHERE token = ?', [nowIso(), tokenHash]);
    }
    row.permissions = resolvePermissions(row);
    req.user = row;
    req.authTokenHash = tokenHash;
    req.authRawToken = token;
    req.authSessionId = row.session_id;
    req.authViaCookie = authViaCookie;
    // Provider and spending diagnostics belong only to the administrator. Keep
    // report content intact; redact only generated notices and error messages.
    if (row.role !== 'owner') {
      const originalJson = res.json.bind(res);
      const neutralNotice = value => String(value)
        .replace(/(?:Terra|Luna)\s*\(GPT-5\.6\)|GPT-5\.6[ -](?:Terra|Luna)|gpt-5\.6-(?:terra|luna)|\b(?:Terra|Luna)\b|\bOpenAI\b/gi, 'Report assistance')
        .replace(/The \$5 monthly report allowance is fully used or reserved\./g, 'Report assistance is temporarily unavailable. Contact the Worshipful Master.')
        .replace(/Paid report generation is paused because reported usage needs review\./g, 'Report assistance needs administrator review. Contact the Worshipful Master.')
        .replace(/This source is too large for one report within the monthly allowance\./g, 'This source is too large for one report.')
        .replace(/This request has an unconfirmed charge\. Its allowance remains reserved to protect the monthly limit\./g, 'This request could not be confirmed. Contact the Worshipful Master before retrying.')
        .replace(/This report request is already processing or has an unconfirmed charge\. Its allowance remains reserved\./g, 'This report request is already processing or needs administrator review.');
      const redact = value => {
        if (Array.isArray(value)) return value.map(redact);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
          ['warnings', 'extractionNotes'].includes(key) && Array.isArray(item) ? item.map(neutralNotice)
          : key === 'error' && typeof item === 'string' ? neutralNotice(item) : redact(item)]));
      };
      res.json = value => originalJson(redact(value));
    }
    next();
  } catch (error) {
    next(error);
  }
};

const requireOwner = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the document owner can perform this action.' });
  }
  next();
};

const requireDocumentAccess = (req, res, next) => {
  if (!hasPermission(req.user, 'documents.sign')) {
    return res.status(403).json({
      error: req.user.role === 'warden'
        ? 'Wardens propose dispensations. They do not open or sign Lodge documents.'
        : 'Viewers can review document status only.',
    });
  }
  next();
};

const requireMinutesAccess = (req, res, next) => {
  if (!hasPermission(req.user, 'minutes.prepare')) {
    return res.status(403).json({ error: 'Meeting minutes are restricted to the Worshipful Master and the Secretaries.' });
  }
  next();
};

const requireSecretaryOrOwner = (req, res, next) => {
  if (!new Set(['owner', 'secretary', 'assistant_secretary']).has(req.user.role) || !hasPermission(req.user,'minutes.prepare')) {
    return res.status(403).json({ error: 'The Secretary or Assistant Secretary records distribution after the Worshipful Master authorizes it.' });
  }
  next();
};

const requireMinutesPreparer = (req, res, next) => {
  if (!hasPermission(req.user, 'minutes.prepare')) {
    return res.status(403).json({ error: 'Only the Worshipful Master or a Secretary can attest to a draft.' });
  }
  next();
};

const requireMinutesView = (req, res, next) => hasPermission(req.user, 'minutes.view')
  ? next()
  : res.status(403).json({ error: 'Meeting minutes access is not enabled.' });

/* Only the two Wardens named in WARDEN_EMAILS may hold the role, checked on every request
 * rather than only at invite time, so removing an address revokes access immediately. */
const requireWarden = (req, res, next) => {
  if(req.user.role==='owner')return next();
  if (!hasPermission(req.user, 'proposals.create')) {
    return res.status(403).json({ error: 'This is for the Senior and Junior Wardens.' });
  }
  next();
};

const requireOwnerOrWarden = (req, res, next) => {
  if (req.user.role === 'owner') return next();
  return requireWarden(req, res, next);
};

let rateLimitRequests = 0;
const rateLimit = ({ key, maximum, windowMs }) => async (req, res, next) => {
  try {
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowMs).toISOString();
    const source = String(req.ip || req.socket?.remoteAddress || 'unknown').trim().slice(0, 120);
    const bucketKey = crypto.createHash('sha256').update(`${key}:${source}`).digest('hex');
    const row = await dbGet(
      `INSERT INTO rate_limits (bucket_key,count,reset_at) VALUES (?,1,?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,
         reset_at=CASE WHEN rate_limits.reset_at<=? THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING count,reset_at`,
      [bucketKey, resetAt, now.toISOString(), now.toISOString()],
    );
    if ((++rateLimitRequests & 255) === 0) await dbRun('DELETE FROM rate_limits WHERE reset_at < ?', [now.toISOString()]);
    if (Number(row.count) > maximum) {
      const seconds = Math.max(1, Math.ceil((Date.parse(row.reset_at) - now.getTime()) / 1000));
      res.setHeader('Retry-After', String(seconds));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  } catch (error) { next(error); }
};

const locationSearchCache = new Map();
let lastLocationSearchAt = 0;
const searchLocationAddress = async (query) => {
  const normalized = String(query || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const cached = locationSearchCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.matches;
  const waitMs = Math.max(0, 1100 - (Date.now() - lastLocationSearchAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastLocationSearchAt = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('limit', '5');
  if (OWNER_EMAIL) url.searchParams.set('email', OWNER_EMAIL);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'User-Agent': `StoneSquareSign/${APP_VERSION} (${OWNER_EMAIL || 'local Lodge document app'})`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('The address service is temporarily unavailable.');
  const results = await response.json();
  const matches = results.map((item) => {
    const address = item.address || {};
    const road = address.road || address.pedestrian || address.footway || address.residential || '';
    const streetAddress = [address.house_number, road].filter(Boolean).join(' ').trim();
    const city = address.city || address.town || address.village || address.municipality || address.hamlet || '';
    const stateCode = String(address['ISO3166-2-lvl4'] || '').split('-').pop();
    const state = stateCode && stateCode.length === 2 ? stateCode : (address.state || '');
    const cityState = [city, state].filter(Boolean).join(', ') + (address.postcode ? ` ${address.postcode}` : '');
    return {
      displayName: String(item.display_name || query),
      streetAddress,
      cityState: cityState.trim(),
    };
  }).filter((item) => item.streetAddress && item.cityState);
  locationSearchCache.set(normalized, { matches, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return matches;
};

const realtimeClients = new Set();

const disconnectRealtimeUser = (userId) => {
  for (const client of realtimeClients) {
    if (client.userId !== userId) continue;
    client.response.write(`event: access_changed\ndata: {}\n\n`);
    client.response.end();
    realtimeClients.delete(client);
  }
};

const broadcast = (type, data = {}) => {
  const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of realtimeClients) {
    if (type === 'queue_changed' && !client.permissions?.includes('documents.status')) continue;
    if (type === 'proposals_changed' && client.role !== 'owner' && !client.permissions?.includes('proposals.create')) continue;
    if (type === 'treasury_changed' && !client.permissions?.includes('treasury.view')) continue;
    if (type === 'correspondence_changed' && client.role !== 'owner' && !client.permissions?.includes('reports.create')) continue;
    if (type === 'minutes_review_changed' && client.role !== 'owner') continue;
    if (type === 'minutes_completion_changed' && client.role !== 'owner' && !client.permissions?.includes('minutes.prepare')) continue;
    if (type === 'minutes_records_changed' && !client.permissions?.includes('minutes.view')) continue;
    if (type === 'profile_changed' && data.userId !== client.userId) continue;
    client.response.write(event);
  }
};

const addAudit = async ({
  userId = null,
  documentId = null,
  action,
  ip = '',
  userAgent = '',
  details = {},
}) => {
  try {
    await dbRun(
      `INSERT INTO audit_events
       (user_id, document_id, action, ip_address, user_agent, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, documentId, action, ip, userAgent.slice(0, 500), JSON.stringify(details), nowIso()],
    );
  } catch (error) {
    console.warn('Audit record failed:', error.message);
  }
};

/* Sends a fully executed dispensation to the District Deputy for review.
 *
 * Called automatically the moment the last required signature lands, and available by hand for
 * anything signed before this existed or where the first attempt failed. The outcome is written
 * to the document either way. That matters more than it looks: every invitation this app ever
 * "sent" was silently swallowed because no mail was configured, and nobody knew for weeks. A
 * dispensation that quietly fails to reach the Deputy misses its date, so this records the
 * failure and the reason where the Master will see it.
 */
/* One place that composes the note to the District Deputy, so the copy the server sends and the
 * draft the Master opens in his own mail client are word for word the same. */
const districtDeputyMessage = (document) => {
  const title = document.title || document.original_name || 'Dispensation';
  const fileName = /\.pdf$/i.test(document.original_name || '')
    ? document.original_name
    : `${String(title).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'dispensation'}.pdf`;
  const request = document.parsed_preview
    ? String(document.parsed_preview).split('\n')[0].slice(0, 300)
    : title;
  return {
    to: DDGM_EMAIL,
    name: DDGM_NAME,
    filename: fileName,
    subject: `Request for Dispensation for your review: ${title}`,
    body: [
      `${DDGM_NAME},`,
      '',
      `Attached is a Request for Dispensation from ${LODGE_NAME}, executed by the Worshipful Master and the Secretary's office.`,
      '',
      `Request: ${request}`,
      '',
      'It is submitted for your review and approval, and for onward routing to the Grand Lodge as you see fit. Please let me know if anything further is required from the Lodge.',
      '',
      'Respectfully and fraternally,',
      'W. Aaron Dixon-Saunders',
      `Worshipful Master, ${LODGE_NAME}`,
    ].join('\n'),
  };
};

const submitToDistrictDeputy = async (document, { actorUserId = null, baseUrl = '', ip = '', userAgent = '' } = {}) => {
  const attemptedAt = nowIso();
  if (!DDGM_EMAIL) {
    const reason = 'No District Deputy email is configured, so nothing was sent.';
    await dbRun('UPDATE documents SET submitted_error = ? WHERE id = ?', [reason, document.id]);
    return { sent: false, reason };
  }
  const pdf = asBuffer(document.signed_bytes) || asBuffer(document.file_bytes);
  if (!pdf?.length) {
    const reason = 'The executed PDF is missing, so nothing was sent.';
    await dbRun('UPDATE documents SET submitted_error = ? WHERE id = ?', [reason, document.id]);
    return { sent: false, reason };
  }
  const { subject, body, filename: fileName, to } = districtDeputyMessage(document);
  try {
    const sent = await sendEmail({
      to,
      subject,
      text: body,
      attachment: { filename: fileName, content: pdf },
    });
    if (!sent) {
      const reason = 'Email is not configured on the server, so nothing was sent. Add SMTP_PASS and try again.';
      await dbRun('UPDATE documents SET submitted_error = ? WHERE id = ?', [reason, document.id]);
      await addAudit({ userId: actorUserId, documentId: document.id, action: 'dispensation_submission_failed',
        ip, userAgent, details: { to: DDGM_EMAIL, reason } });
      return { sent: false, reason };
    }
    await dbRun(
      'UPDATE documents SET submitted_at = ?, submitted_to = ?, submitted_error = NULL WHERE id = ?',
      [attemptedAt, DDGM_EMAIL, document.id],
    );
    await addAudit({ userId: actorUserId, documentId: document.id, action: 'dispensation_submitted_to_district_deputy',
      ip, userAgent, details: { to: DDGM_EMAIL, name: DDGM_NAME, attachedAs: fileName } });
    return { sent: true, to: DDGM_EMAIL, name: DDGM_NAME, at: attemptedAt };
  } catch (error) {
    const reason = error.message || 'The mail server refused the message.';
    await dbRun('UPDATE documents SET submitted_error = ? WHERE id = ?', [reason, document.id]);
    await addAudit({ userId: actorUserId, documentId: document.id, action: 'dispensation_submission_failed',
      ip, userAgent, details: { to: DDGM_EMAIL, reason } });
    return { sent: false, reason };
  }
};

const requestBaseUrl = (req) =>
  String(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

/* The schema, the column back-fills and the placeholder translation all live in
 * db.js now, so that one file is the only place that knows which Postgres it is
 * talking to. runMigrations is kept as the name the boot path already calls. */
const runMigrations = () => initSchema();

const participantForDocument = async (document, user) => {
  if (user.role === 'owner') return true;
  if (document.owner_user_id === user.id) return true;
  return Boolean(await dbGet(
    `SELECT 1 FROM document_signers
     WHERE document_id = ? AND (user_id = ? OR (user_id IS NULL AND signer_role = ?))`,
    [document.id, user.id, user.role],
  ));
};

/* Takes the current PDF as bytes and returns the stamped PDF as bytes. Nothing is
 * read from or written to disk, because on a free instance there is no disk to keep. */
const appendSignatureToPdf = async ({ pdfBytes, signatureBytes, signerName, order, placement }) => {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const page = pages[pages.length - 1];
  const { width } = page.getSize();
  const signatureImage = await pdfDoc.embedPng(signatureBytes);
  if (placement === 'dispensation-secretary') {
    const ratio = Math.min(176 / signatureImage.width, 42 / signatureImage.height);
    page.drawImage(signatureImage, {
      x: 264,
      y: 286,
      width: signatureImage.width * ratio,
      height: signatureImage.height * ratio,
    });
    return Buffer.from(await pdfDoc.save());
  }
  const markerX = Math.max(36, width * 0.12);
  const markerY = 72 + (order - 1) * 82;
  const ratio = Math.min(170 / signatureImage.width, 52 / signatureImage.height);
  page.drawImage(signatureImage, {
    x: markerX,
    y: markerY + 15,
    width: signatureImage.width * ratio,
    height: signatureImage.height * ratio,
  });
  page.drawLine({
    start: { x: markerX, y: markerY + 12 },
    end: { x: Math.min(width - 36, markerX + 230), y: markerY + 12 },
    thickness: 0.7,
    color: rgb(0.25, 0.25, 0.25),
  });
  page.drawText(`${signerName} | Electronically signed ${new Date().toLocaleString('en-US')}`, {
    x: markerX,
    y: markerY,
    size: 8,
    color: rgb(0.2, 0.2, 0.2),
  });
  return Buffer.from(await pdfDoc.save());
};

const dateParts = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: match[1], month, day };
};

const dateLabel = (parts, includeYear = true) => {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[parts.month - 1]} ${parts.day}${includeYear ? `, ${parts.year}` : ''}`;
};

const normalizePastedDate = (value) => {
  const text = String(value || '').trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(text);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  match = new RegExp(`^(${Object.keys(months).join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i').exec(text);
  if (!match) return '';
  return `${match[3]}-${String(months[match[1].toLowerCase()]).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
};

const normalizePastedTime = (value) => {
  const match = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(String(value || ''));
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = String(match[3] || '').toLowerCase();
  if (period.startsWith('p') && hour < 12) hour += 12;
  if (period.startsWith('a') && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const displayClockTime = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return String(value || '');
  const hour = Number(match[1]);
  if (hour > 23) return String(value || '');
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
};

const easternDateValue = (offsetDays = 0) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offsetDays));
  return date.toISOString().slice(0, 10);
};

const smartTitleCase = (value) => String(value || '')
  .trim()
  .replace(/\s+/g, ' ')
  .replace(/\b(?:middleschool|middlschool|midleschool)\b/gi, 'Middle School')
  .replace(/\b([a-z])/gi, (letter) => letter.toUpperCase())
  .replace(/\bL\b(?=\s+Redding\b)/, 'L.');

const smartDocumentTitle = (value) => smartTitleCase(value)
  .replace(/\b(To|In|At|For|And|Or|Of|The|A|An)\b/g, (word, _match, offset) => offset === 0 ? word : word.toLowerCase());

const checkPastedGrammar = (value, finishSentence = false) => {
  let corrected = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=[A-Za-z])/g, '$1 ')
    .replace(/\b(?:regalis|regalias)\b/gi, 'regalia')
    .replace(/\b(?:masoic|masonc|masonic)\b/gi, 'Masonic')
    .replace(/\b(?:middleschool|middlschool|midleschool)\b/gi, 'Middle School')
    .replace(/\bjust\s+(?:the\s+)?lodge\s+banner\b/gi, 'just the Lodge banner')
    .replace(/\blodge\s+banner\b/gi, 'Lodge banner')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
  if (finishSentence && corrected && !/[.!?]$/.test(corrected)) corrected += '.';
  return corrected;
};

const extractNaturalDispensationDetails = (text, fields, warnings) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const sentences = normalized.split(/[.!?]+\s*/).map((sentence) => sentence.trim()).filter(Boolean);
  const eventLeadMatch = /^(.{3,80}?\bevent)\s+at\s+(.{2,100}?)(?=\s+(?:day after tomorrow|tomorrow|today|on\b|at\s+\d)|[,.]|$)/i.exec(normalized);
  const namedLocationMatch = /(?:^|[.!?]\s*)location\s*[:=-]?\s*(.{2,100}?)\s+in\s+([a-z .'-]+?)\s+(delaware|de)\b/i.exec(normalized);
  const locationFirstMatch = /^(.{2,120}?)\s+in\s+([a-z .'-]+?)\s+(delaware|de)\b(?=[.!?,]|$)/i.exec(normalized);
  const eventTitleMatch = /\b(back\s+to\s+school(?:\s+(?:night|event|program|activity))?)\b/i.exec(normalized)
    || /\b([a-z][a-z ']+?\s+(?:night|event|program|activity))\b/i.exec(normalized);

  if (eventLeadMatch || namedLocationMatch || locationFirstMatch) {
    if (!fields.title && eventLeadMatch) fields.title = smartDocumentTitle(eventLeadMatch[1]);
    if (!fields.locationName) fields.locationName = smartTitleCase(namedLocationMatch?.[1] || eventLeadMatch?.[2] || locationFirstMatch?.[1]);
    const cityMatch = namedLocationMatch || locationFirstMatch;
    if (!fields.cityState && cityMatch) fields.cityState = `${smartTitleCase(cityMatch[2])}, DE`;
    warnings.push('The title and event location were inferred from your description. Please confirm them.');
  }
  if (!fields.title && eventTitleMatch) fields.title = smartDocumentTitle(eventTitleMatch[1]);

  const streetMatch = /\b(\d{1,6}\s+[a-z0-9.' -]+?\s+(?:street|st\.?|road|rd\.?|drive|dr\.?|avenue|ave\.?|lane|ln\.?|boulevard|blvd\.?|court|ct\.?|way|highway|hwy\.?))\b/i.exec(normalized);
  if (!fields.streetAddress && streetMatch) {
    fields.streetAddress = smartTitleCase(streetMatch[1]);
    const addressTail = normalized.slice(streetMatch.index + streetMatch[0].length);
    const cityMatch = /^\s*,?\s*([a-z .'-]+?)\s+(delaware|de)\b(?:\s+(\d{5}))?/i.exec(addressTail);
    if (!fields.cityState && cityMatch) {
      fields.cityState = `${smartTitleCase(cityMatch[1])}, DE${cityMatch[3] ? ` ${cityMatch[3]}` : ''}`;
    }
    warnings.push('The street address was inferred from your description. Please confirm it.');
  }

  if (!fields.eventDate) {
    let relativeOffset = null;
    if (/\bday after tomorrow\b/i.test(normalized)) relativeOffset = 2;
    else if (/\btomorrow\b/i.test(normalized)) relativeOffset = 1;
    else if (/\btoday\b/i.test(normalized)) relativeOffset = 0;
    if (relativeOffset !== null) {
      fields.eventDate = easternDateValue(relativeOffset);
      const source = relativeOffset === 0 ? 'today' : relativeOffset === 1 ? 'tomorrow' : 'day after tomorrow';
      warnings.push(`The event date was inferred from "${source}." Please confirm it.`);
    }
  }

  if (!fields.requestDetails) {
    const scheduledRequest = sentences[0]?.match(/\b(?:day after tomorrow|tomorrow|today)\b(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)?\s+(.+)$/i)?.[1];
    const contentSentences = sentences.filter((sentence, index) => {
      if (locationFirstMatch && index === 0) return false;
      if (/^(?:day after tomorrow|tomorrow|today)\b(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)?$/i.test(sentence)) return false;
      return true;
    });
    const requestSentence = sentences.find((sentence) =>
      /\b(?:lodge|request|dispensation|supplies|regalia|banner|participat(?:e|ing|ion))\b/i.test(sentence)
      && !/^\d{1,6}\s/.test(sentence));
    if (scheduledRequest && fields.title) {
      fields.requestDetails = `${fields.title}. ${scheduledRequest}`.slice(0, 600);
    } else if (contentSentences.length && locationFirstMatch) {
      fields.requestDetails = contentSentences.join('. ').slice(0, 600);
    } else if (requestSentence) {
      fields.requestDetails = requestSentence.slice(0, 600);
    }
  }
};

const parseDispensationPaste = (input) => {
  const text = String(input || '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const todayValue = easternDateValue();
  const fields = {
    title: '', requestDate: todayValue, signerRole: /adrian\s+reese|assistant\s+secretary/i.test(text) ? 'assistant_secretary' : 'secretary',
    requestDetails: '', eventDate: '', eventTime: '', locationName: '', streetAddress: '', cityState: '',
    worshipfulMasterAddress: '', secretaryAddress: '',
  };
  const warnings = [];
  const labels = [
    ['title', /^(?:document\s+)?title\s*[:=-]\s*(.+)$/i],
    ['requestDate', /^(?:request\s+date|date\s+requested)\s*[:=-]\s*(.+)$/i],
    ['requestDetails', /^(?:request|request\s+details|details|reason|what\s+is\s+the\s+lodge\s+requesting)\s*[:=-]\s*(.+)$/i],
    ['eventDate', /^(?:event\s+date|date\s+of\s+event)\s*[:=-]\s*(.+)$/i],
    ['eventTime', /^(?:event\s+time|time)\s*[:=-]\s*(.+)$/i],
    ['locationName', /^(?:location|location\s+name|venue)\s*[:=-]\s*(.+)$/i],
    ['streetAddress', /^(?:street|street\s+address|event\s+address)\s*[:=-]\s*(.+)$/i],
    ['cityState', /^(?:city|city[\s,/]+state(?:[\s,/]+zip)?)\s*[:=-]\s*(.+)$/i],
    ['worshipfulMasterAddress', /^(?:worshipful\s+master|master|my)\s+address\s*[:=-]\s*(.+)$/i],
    ['secretaryAddress', /^(?:secretary|officer|duffy|mcduffie)\s+address\s*[:=-]\s*(.+)$/i],
  ];
  const consumed = new Set();
  lines.forEach((line, index) => {
    for (const [field, pattern] of labels) {
      const match = pattern.exec(line);
      if (!match) continue;
      fields[field] = match[1].trim();
      consumed.add(index);
      break;
    }
  });
  fields.requestDate = normalizePastedDate(fields.requestDate) || todayValue;
  fields.eventDate = normalizePastedDate(fields.eventDate);
  fields.eventTime = normalizePastedTime(fields.eventTime);
  const unconsumed = lines.filter((_line, index) => !consumed.has(index));
  const dateMatches = text.match(/(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/gi) || [];
  if (!fields.eventDate && dateMatches.length) fields.eventDate = normalizePastedDate(dateMatches[dateMatches.length - 1]);
  if (!fields.eventTime) fields.eventTime = normalizePastedTime(text.match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i)?.[0]);
  if (!fields.streetAddress) fields.streetAddress = unconsumed.find((line) => /^\d{1,6}\s+.+/.test(line)) || '';
  if (!fields.cityState) fields.cityState = unconsumed.find((line) => /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s+\d{5})?\b/i.test(line) && line !== fields.streetAddress) || '';
  extractNaturalDispensationDetails(text, fields, warnings);
  if (!fields.title && lines.length > 1) fields.title = unconsumed.find((line) => line.length <= 120 && !/^\d/.test(line)) || '';
  if (!fields.requestDetails) {
    fields.requestDetails = unconsumed
      .filter((line) => ![fields.title, fields.streetAddress, fields.cityState].includes(line))
      .join(' ')
      .slice(0, 600);
  }
  let grammarAdjusted = false;
  const correctedTitle = fields.title ? smartDocumentTitle(fields.title) : '';
  const correctedRequest = checkPastedGrammar(fields.requestDetails, true);
  const correctedLocation = fields.locationName ? smartTitleCase(fields.locationName) : '';
  if (correctedTitle !== fields.title || correctedRequest !== fields.requestDetails || correctedLocation !== fields.locationName) {
    grammarAdjusted = true;
    fields.title = correctedTitle;
    fields.requestDetails = correctedRequest;
    fields.locationName = correctedLocation;
  }
  if (grammarAdjusted) warnings.push('Spelling and grammar were cleaned up. Please confirm the wording.');
  const required = [
    ['title', 'Document title was not found.'], ['requestDetails', 'Request details were not found.'],
    ['eventDate', 'Event date was not found.'], ['eventTime', 'Event time was not found.'],
    ['locationName', 'Location name was not found.'], ['streetAddress', 'Street address was not found.'],
    ['cityState', 'City, state, and ZIP were not found.'],
  ];
  warnings.push(...required.filter(([field]) => !fields[field]).map(([, warning]) => warning));
  return { fields, warnings };
};

const splitRequestLines = (text, font, widths, size) => {
  const words = String(text || '').trim().split(/\s+/);
  const lines = ['', ''];
  for (const word of words) {
    const firstCandidate = `${lines[0]} ${word}`.trim();
    if (!lines[1] && font.widthOfTextAtSize(firstCandidate, size) <= widths[0]) {
      lines[0] = firstCandidate;
    } else {
      lines[1] = `${lines[1]} ${word}`.trim();
    }
  }
  return lines;
};

const formFieldRectangle = (form, name) => {
  const widget = form.getField(name).acroField.getWidgets()[0];
  return widget.getRectangle();
};

const drawValuesOnFormLines = ({ pdfDoc, form, font, values, size = 10 }) => {
  const page = pdfDoc.getPages()[0];
  const placements = values.map(([name, value]) => {
    const field = form.getTextField(name);
    field.setText('');
    return { rectangle: formFieldRectangle(form, name), value: String(value || '') };
  });
  form.updateFieldAppearances(font);
  placements.forEach(({ rectangle, value }) => {
    if (!value) return;
    /* Nothing clips a value to its line, so a long one runs straight across the next
     * field: "12:00 PM to 4:00 PM" in Time lands on top of the location. The template's
     * lines are fixed, so shrink the text to the line instead, down to 6pt, which is the
     * smallest a District Deputy should be asked to read. */
    const room = rectangle.width - 6;
    const natural = font.widthOfTextAtSize(value, size);
    const fitted = natural > room ? Math.max(6, (size * room) / natural) : size;
    page.drawText(value, {
      x: rectangle.x + 3,
      y: rectangle.y + 3,
      size: fitted,
      font,
    });
  });
};

const createDispensationPdf = async ({ fields, ownerName, ownerSignature }) => {
  const templateBytes = await fs.readFile(DISPENSATION_TEMPLATE);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const requestDate = dateParts(fields.requestDate);
  const eventDate = dateParts(fields.eventDate);
  const requestFieldNames = [
    'Requests to reschedule  to change  to cancel 1',
    'Requests to reschedule  to change  to cancel 2',
  ];
  const requestLines = splitRequestLines(
    fields.requestDetails,
    font,
    requestFieldNames.map((name) => formFieldRectangle(form, name).width - 6),
    10,
  );
  drawValuesOnFormLines({
    pdfDoc,
    form,
    font,
    size: 10,
    values: [
      ['Date', dateLabel(requestDate)],
      ['Lodge', 'Stone Square Lodge'],
      ['No', '22'],
      [requestFieldNames[0], requestLines[0]],
      [requestFieldNames[1], requestLines[1]],
      ['Date_2', dateLabel(eventDate, false)],
      ['20', eventDate.year.slice(-2)],
      ['Time', displayClockTime(fields.eventTime)],
      ['Name of Location', fields.locationName],
      ['Street and Number', fields.streetAddress],
      ['City and State', fields.cityState],
      ['Worshipful Master', ownerName],
      ['Secretary', ''],
      ['Address', fields.worshipfulMasterAddress],
      ['Address_2', ''],
    ],
  });
  const page = pdfDoc.getPages()[0];
  /* A Warden previewing his own proposal passes no signature, and that is correct: nothing
   * is signed until the Master approves it, and the Warden has no business seeing the
   * Master's signature on a document that does not exist yet. Every path that creates a
   * real dispensation checks for the signature before it gets here. */
  if (ownerSignature?.length) {
    const signatureImage = await pdfDoc.embedPng(ownerSignature);
    const signatureRectangle = formFieldRectangle(form, 'Signature');
    const ratio = Math.min(
      (signatureRectangle.width - 8) / signatureImage.width,
      (signatureRectangle.height - 4) / signatureImage.height,
    );
    const signatureWidth = signatureImage.width * ratio;
    const signatureHeight = signatureImage.height * ratio;
    page.drawImage(signatureImage, {
      x: signatureRectangle.x + (signatureRectangle.width - signatureWidth) / 2,
      y: signatureRectangle.y + 2,
      width: signatureWidth,
      height: signatureHeight,
    });
  }
  return Buffer.from(await pdfDoc.save());
};

const fillDispensationOfficerInformation = async ({ pdfBytes, officerName, officerAddress }) => {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  drawValuesOnFormLines({
    pdfDoc,
    form,
    font,
    size: 10,
    values: [
      ['Secretary', officerName],
      ['Address_2', officerAddress],
    ],
  });
  // These entries are now part of the signed page. Blank widget appearances must
  // not paint over them, including on imported dispensation templates.
  form.removeField(form.getTextField('Secretary'));
  form.removeField(form.getTextField('Address_2'));
  return Buffer.from(await pdfDoc.save());
};

const sendCompletionNotice = async (document, signers, signedBytes) => {
  const recipients = new Set([
    document.owner_email,
    ...signers.map((signer) => signer.email),
  ].filter(Boolean));
  const name = document.title || document.original_name;
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        subject: `Completed Lodge document: ${name}`,
        text: `All required signatures for ${name} have been captured. A signed PDF is attached for your records.`,
        // the executed copy, not the blank one that was uploaded
        attachment: { filename: `SIGNED ${document.original_name}`, content: signedBytes },
      });
    } catch (error) {
      console.warn(`Completion email to ${to} failed:`, error.message);
    }
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
      return callback(new Error('Only PDF files are supported.'));
    }
    callback(null, true);
  },
});

const minutesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, callback) => {
    const name = file.originalname.toLowerCase();
    if (!name.endsWith('.txt') && !name.endsWith('.docx') && !name.endsWith('.pdf')) {
      return callback(new Error('Upload notes or a transcript as a TXT, DOCX, or PDF file.'));
    }
    callback(null, true);
  },
});

const transcriptFromUpload = async (file) => {
  if (!file) return '';
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) return extractTextFromPdf(file.buffer);
  if (name.endsWith('.docx')) return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  return file.buffer.toString('utf8');
};

const minutesForResponse = (row) => ({
  createdByUserId: row.created_by_user_id,
  sourceUploadedByUserId: row.source_uploaded_by_user_id || row.created_by_user_id,
  sourceUploadedBy: row.source_uploaded_by_name || row.created_by_name,
  preparerUserId: row.preparer_user_id,
  preparer: row.preparer_name,
  claimedAt: row.claimed_at,
  masterChanges: row.master_changes_json ? JSON.parse(row.master_changes_json) : [],
  submittedDraft: row.submitted_draft_json ? JSON.parse(row.submitted_draft_json) : null,
  id: row.id,
  meetingDate: row.meeting_date,
  sourceName: row.source_name,
  draft: normalizeMinutesDraft(JSON.parse(row.draft_json)),
  status: row.status,
  createdBy: row.created_by_name,
  updatedBy: row.updated_by_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  submittedForReviewAt: row.submitted_for_review_at,
  preparerRole: row.created_by_role,
  preparerAttestedAt: row.preparer_attested_at,
  masterAttestedAt: row.master_attested_at,
  masterAttestedBy: row.master_attested_by_name,
  authorizedAt: row.authorized_at,
  authorizedBy: row.authorized_by_name,
  distributedAt: row.distributed_at,
  distributedBy: row.distributed_by_name,
  approvedByLodgeOn: row.approved_by_lodge_on,
  approvalNote: row.approval_note,
});

const getMinutesRow = (id) => dbGet(
  `SELECT m.*,
     creator.name AS created_by_name, creator.role AS created_by_role, updater.name AS updated_by_name,
     source_uploader.name AS source_uploaded_by_name, preparer.name AS preparer_name,
     authorizer.name AS authorized_by_name, distributor.name AS distributed_by_name
     , master.name AS master_attested_by_name,
     EXISTS (SELECT 1 FROM meeting_minutes_attestations att
       WHERE att.minutes_id = m.id AND att.phase = 'master') AS has_master_attestation
   FROM meeting_minutes m
   JOIN users creator ON creator.id = m.created_by_user_id
   JOIN users updater ON updater.id = m.updated_by_user_id
   LEFT JOIN users source_uploader ON source_uploader.id = m.source_uploaded_by_user_id
   LEFT JOIN users preparer ON preparer.id = m.preparer_user_id
   LEFT JOIN users authorizer ON authorizer.id = m.authorized_by_user_id
   LEFT JOIN users distributor ON distributor.id = m.distributed_by_user_id
   LEFT JOIN users master ON master.id = m.master_attested_by_user_id
   WHERE m.id = ? AND m.status <> 'deleted'`,
  [id],
);

if (IS_PRODUCTION) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'self' blob:; frame-src 'self' blob: https://request.stonesquare22pha.org; base-uri 'none'; form-action 'self'",
  );
  if (IS_PRODUCTION && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
app.get('/', async (_req, res, next) => {
  try {
    const index = await fs.readFile(path.join(APP_DIR, 'public', 'index.html'), 'utf8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(index.replaceAll('__APP_VERSION__', APP_VERSION));
  } catch (error) {
    next(error);
  }
});
// Expose only the PDF renderer's browser assets, never the rest of node_modules.
app.use('/pdfjs/build', express.static(path.join(APP_DIR, 'node_modules/pdfjs-dist/build'), { index: false, maxAge: '1d' }));
app.use('/pdfjs/standard_fonts', express.static(path.join(APP_DIR, 'node_modules/pdfjs-dist/standard_fonts'), { index: false, maxAge: '1d' }));
app.use(express.static(path.join(APP_DIR, 'public'), {
  index: false,
  etag: true,
  maxAge: '5m',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate'),
}));

/* Render and the daytime keep-awake workflow call this frequently. It is deliberately
 * process-only: querying Postgres here kept Neon's compute awake even when no officer
 * was using the app. Real app requests still fail clearly if the database is down. */
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'stone-square-sign',
    version: APP_VERSION,
    database: 'not-checked',
    time: nowIso(),
  });
});

/* Deployment and operator checks call readiness deliberately. The frequent hosting
 * liveness probe above remains process-only so it does not keep Neon awake. */
app.get('/api/ready', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await dbGet('SELECT 1 AS ready');
    res.json({ ok: true, service: 'stone-square-sign', version: APP_VERSION,
      database: 'ready', emailDeliveryReady: Boolean(transporter), time: nowIso() });
  } catch {
    res.status(503).json({ ok: false, service: 'stone-square-sign', version: APP_VERSION,
      database: 'unavailable', emailDeliveryReady: Boolean(transporter), time: nowIso() });
  }
});

app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION, commit: process.env.RENDER_GIT_COMMIT || null });
});

app.get('/api/setup', async (_req, res, next) => {
  try {
    const realUsers = await dbGet("SELECT COUNT(*) AS total FROM users WHERE email NOT LIKE '%.local'");
    res.json({
      needsOwnerSetup: realUsers.total === 0,
      registrationMode: realUsers.total === 0
        ? 'owner'
        : (LODGE_ACCESS_CODE ? 'access_code' : 'invitation'),
      emailDeliveryReady: Boolean(transporter),
    });
  } catch (error) {
    next(error);
  }
});

/* 20 rather than 8: this limit is per address, so the officers sitting on the Lodge wifi share it,
 * and a mistyped access code burns an attempt. 20 in 15 minutes is still nothing against anyone
 * trying to guess the code, and it stops the Craft locking itself out on a Thursday night. */
app.post('/api/auth/register', rateLimit({ key: 'register', maximum: 20, windowMs: 15 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const suppliedName = String(req.body?.name || '').trim();
    const invitationToken = String(req.body?.invitationToken || '');
    if (!isEmail(email) || !suppliedName || password.length < 10) {
      return res.status(400).json({
        error: 'Enter a valid email, full name, and a password of at least 10 characters.',
      });
    }

    const accessCode = String(req.body?.accessCode || '').trim();
    const requestedRole = String(req.body?.role || '');
    let role = 'owner';
    let name = suppliedName;
    let invitation = null;
    let joinedWithCode = false;
    if (invitationToken) {
      invitation = await dbGet(
        'SELECT * FROM invitations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
        [hashSecret(invitationToken), nowIso()],
      );
      if (!invitation || normalizeEmail(invitation.email) !== email) {
        return res.status(403).json({ error: 'This invitation is invalid, expired, or belongs to another email.' });
      }
      role = invitation.role;
      name = invitation.name || suppliedName;
    } else if (LODGE_ACCESS_CODE && accessCode) {
      /* Self serve. The code proves he is one of ours; the office he claims is still held to one
       * man, so a second person cannot quietly become Secretary behind the first one's back. */
      if (!secretsMatch(accessCode, LODGE_ACCESS_CODE)) {
        return res.status(403).json({ error: 'That Lodge access code is not correct.' });
      }
      if (!SELF_SERVE_ROLES.has(requestedRole)) {
        return res.status(400).json({ error: 'Choose which office you hold.' });
      }
      role = requestedRole;
      joinedWithCode = true;
    } else {
      const realUsers = await dbGet("SELECT COUNT(*) AS total FROM users WHERE email NOT LIKE '%.local'");
      if (realUsers.total > 0) {
        return res.status(403).json({
          error: LODGE_ACCESS_CODE
            ? 'Enter the Lodge access code, or use the private link the Worshipful Master sent you.'
            : 'An invitation from the document owner is required.',
        });
      }
      if (IS_PRODUCTION && (!OWNER_EMAIL || OWNER_EMAIL !== email)) {
        return res.status(403).json({ error: 'This email is not authorized to create the owner account.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = await withTransaction(async () => {
      if (invitationToken) {
        invitation = await dbGet(
          'SELECT * FROM invitations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? FOR UPDATE',
          [hashSecret(invitationToken), nowIso()],
        );
        if (!invitation || normalizeEmail(invitation.email) !== email) {
          throw httpError(403, 'This invitation is invalid, expired, or belongs to another email.');
        }
        role = invitation.role;
        name = invitation.name || suppliedName;
        await lockOfficeRole(role);
        if (OFFICE_ROLES.has(role)) {
          const occupied = await dbGet(
            `SELECT 1 FROM users WHERE role = ? AND email NOT LIKE '%.local'
             AND access_revoked_at IS NULL AND email <> ?`,
            [role, email],
          );
          if (occupied) throw httpError(409, 'That office already has an active account.');
        }
      }
      if (joinedWithCode) {
        await lockOfficeRole(role);
        if (OFFICE_ROLES.has(role)) {
          const occupied = await dbGet(
            `SELECT 1 FROM users WHERE role = ? AND email NOT LIKE '%.local'
             AND access_revoked_at IS NULL AND email <> ?`,
            [role, email],
          );
          if (occupied) throw httpError(409, 'That office already has an active account. Ask the Worshipful Master.');
        }
        const taken = await dbGet('SELECT 1 FROM users WHERE email = ? AND access_revoked_at IS NULL', [email]);
        if (taken) throw httpError(409, 'That email already has an account. Sign in instead.');
      }
      const revokedAccount = invitation
        ? await dbGet('SELECT * FROM users WHERE email = ? AND access_revoked_at IS NOT NULL', [email])
        : null;
      const placeholder = revokedAccount
        ? null
        : await dbGet("SELECT * FROM users WHERE role = ? AND email LIKE '%.local'", [role]);
      let activatedUserId;
      if (revokedAccount) {
        await dbRun(
          'UPDATE users SET password_hash = ?, name = ?, role = ?, created_at = ?, access_revoked_at = NULL WHERE id = ?',
          [passwordHash, name, role, nowIso(), revokedAccount.id],
        );
        activatedUserId = revokedAccount.id;
      } else if (placeholder) {
        await dbRun(
          'UPDATE users SET email = ?, password_hash = ?, name = ?, created_at = ? WHERE id = ?',
          [email, passwordHash, name, nowIso(), placeholder.id],
        );
        activatedUserId = placeholder.id;
      } else {
        const inserted = await dbRun(
          'INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)',
          [email, passwordHash, name, role, nowIso()],
        );
        activatedUserId = inserted.lastID;
      }
      if (invitation) {
        await dbRun('UPDATE users SET permissions_json=?, roster_id=? WHERE id=?',[invitation.permissions_json || null,invitation.roster_id || null,activatedUserId]);
        const used = await dbRun(
          'UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL',
          [nowIso(), invitation.id],
        );
        if (used.changes !== 1) throw httpError(403, 'This invitation has already been used.');
        await dbRun(
          'UPDATE document_signers SET user_id = ?, signer_name = ? WHERE signer_role = ? AND (user_id IS NULL OR user_id = ?)',
          [activatedUserId, name, role, revokedAccount?.id || placeholder?.id || -1],
        );
      }
      return activatedUserId;
    });
    const user = await dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [userId]);
    const { token, session } = await createAuthToken(userId, req);
    const responseUser = await userForResponse(user);
    await addAudit({
      userId,
      action: invitation ? 'officer_account_activated' : 'owner_account_created',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    broadcast('queue_changed', { reason: 'account_activated' });
    if (requestsWebSession(req)) {
      setWebSessionCookie(res, token);
      res.status(201).json({ user: responseUser, session });
    } else {
      res.status(201).json({ token, user: responseUser, session });
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'That email address is already registered.' });
    }
    next(error);
  }
});

app.post('/api/auth/login', rateLimit({ key: 'login', maximum: 10, windowMs: 15 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || user.access_revoked_at || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const { token, session } = await createAuthToken(user.id, req);
    await addAudit({ userId: user.id, action: 'signed_in', ip: req.ip, userAgent: req.get('user-agent') || '' });
    if (requestsWebSession(req)) {
      setWebSessionCookie(res, token);
      res.json({ user: await userForResponse(user), session });
    } else {
      res.json({ token, user: await userForResponse(user), session });
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await endActivitySession(req.authTokenHash, 'Signed out');
    await addAudit({ userId:req.user.id, action:'signed_out', ip:req.ip, userAgent:req.get('user-agent')||'' });
    await dbRun('DELETE FROM sessions WHERE token = ?', [req.authTokenHash]);
    if (req.authViaCookie || isWebClient(req)) clearWebSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    if (isWebClient(req) && !req.authViaCookie) setWebSessionCookie(res, req.authRawToken);
    res.json({ user: await userForResponse(req.user), session: { lifetimeDays: SESSION_POLICY.lifetimeDays, expiresAt: req.user.expires_at } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/sessions', requireAuth, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const rows = await dbAll(
      `SELECT id, created_at, last_seen_at, expires_at, client_label
         FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at, expires_at) DESC`,
      [req.user.id],
    );
    res.json({ sessions: rows.map((row) => ({
      id: row.id,
      label: row.client_label || 'Existing device',
      createdAt: row.created_at || null,
      lastSeenAt: row.last_seen_at || null,
      expiresAt: row.expires_at,
      current: row.id === req.authSessionId,
    })) });
  } catch (error) { next(error); }
});

app.delete('/api/auth/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Choose a valid device sign-in.' });
    const session = await dbGet('SELECT id, token FROM sessions WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!session) return res.status(404).json({ error: 'That device sign-in is no longer active.' });
    await endActivitySession(session.token, id === req.authSessionId ? 'Signed out' : 'Ended from device settings');
    await dbRun('DELETE FROM sessions WHERE id = ? AND user_id = ?', [id, req.user.id]);
    await addAudit({ userId: req.user.id, action: 'device_session_ended', ip: req.ip,
      userAgent: req.get('user-agent') || '', details: { current: id === req.authSessionId } });
    if (id === req.authSessionId) clearWebSessionCookie(res);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/sessions/revoke-others', requireAuth, async (req, res, next) => {
  try {
    const others = await dbAll('SELECT token FROM sessions WHERE user_id = ? AND id <> ?', [req.user.id, req.authSessionId]);
    for (const session of others) await endActivitySession(session.token, 'Ended from device settings');
    await dbRun('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [req.user.id, req.authSessionId]);
    await addAudit({ userId: req.user.id, action: 'other_device_sessions_ended', ip: req.ip,
      userAgent: req.get('user-agent') || '', details: { count: others.length } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/forgot-password', rateLimit({ key: 'reset', maximum: 5, windowMs: 30 * 60 * 1000 }), async (req, res, next) => {
  const generic = 'If that account is on file, a reset code has been sent to the email address on it.';
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Enter the email address on the account.' });
    }
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.json({ message: generic });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await dbRun('DELETE FROM reset_codes WHERE user_id = ?', [user.id]);
    const inserted = await dbRun(
      'INSERT INTO reset_codes (user_id, code, expires_at, used) VALUES (?, ?, ?, 0)',
      [user.id, hashSecret(code), expiresAt],
    );
    const body = `Stone Square Sign password reset code: ${code}. It expires in 15 minutes.`;
    const delivered = await sendEmail({ to: user.email, subject: 'Stone Square Sign password reset code', text: body });
    if (!delivered) {
      /* Answer exactly as we would for an account that does not exist. Returning an
       * error only when the account IS real turns this form into a way of asking
       * which officers have accounts. The failure is logged for the owner instead. */
      await dbRun('DELETE FROM reset_codes WHERE id = ?', [inserted.lastID]);
      console.error(`Password reset for user ${user.id} could not be delivered. Email is not configured.`);
      return res.json({ message: generic });
    }
    await dbRun('UPDATE reset_codes SET channel = ? WHERE id = ?', ['email', inserted.lastID]);
    await addAudit({ userId: user.id, action: 'password_reset_requested', ip: req.ip });
    res.json({ message: generic });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', rateLimit({ key: 'reset-submit', maximum: 8, windowMs: 30 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const codeHash = hashSecret(req.body?.code || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!isEmail(email) || newPassword.length < 10) {
      return res.status(400).json({ error: 'Enter your email, the code, and a new password of at least 10 characters.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await withTransaction(async () => {
      const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
      const reset = user && await dbGet(
        'SELECT * FROM reset_codes WHERE user_id = ? AND code = ? AND used = 0 FOR UPDATE',
        [user.id, codeHash],
      );
      if (!reset || Date.now() > new Date(reset.expires_at).getTime()) {
        throw httpError(400, 'The reset code is invalid or expired.');
      }
      const consumed = await dbRun('UPDATE reset_codes SET used = 1 WHERE id = ? AND used = 0', [reset.id]);
      if (consumed.changes !== 1) throw httpError(400, 'The reset code is invalid or expired.');
      await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
      await endUserActivity(user.id, 'Password reset');
      await dbRun('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      await addAudit({ userId: user.id, action: 'password_reset_completed', ip: req.ip });
    });
    res.json({ message: 'Password updated. Sign in with the new password.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tracker/handoff', requireAuth, rateLimit({ key: 'tracker-handoff', maximum: 30, windowMs: 60 * 60 * 1000 }), (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if(!hasPermission(req.user,'candidates.view'))return res.status(403).json({error:'Candidate Tracker access is not enabled.'});
    res.json({ url: createTrackerHandoffUrl(req.user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tracker/permissions', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const email = normalizeEmail(req.body?.email);
    const issuedAt = Number(req.body?.issuedAt);
    const signature = String(req.get('X-Stone-Square-Tracker-Signature') || '');
    const now = Math.floor(Date.now() / 1000);
    if (!TRACKER_SSO_SHARED_SECRET || !isEmail(email) || !Number.isInteger(issuedAt)
        || issuedAt < now - 60 || issuedAt > now + 15) {
      return res.status(401).json({ error: 'Candidate Tracker authorization could not be verified.' });
    }
    const expected = crypto.createHmac('sha256', TRACKER_SSO_SHARED_SECRET)
      .update(`${email}\n${issuedAt}`)
      .digest('base64url');
    if (!secretsMatch(signature, expected)) {
      return res.status(401).json({ error: 'Candidate Tracker authorization could not be verified.' });
    }
    const user = await dbGet(
      "SELECT role,permissions_json FROM users WHERE email=? AND access_revoked_at IS NULL AND email NOT LIKE '%.local'",
      [email],
    );
    const permissions = user
      ? resolvePermissions(user).filter((permission) => ['candidates.view', 'candidates.edit'].includes(permission))
      : [];
    return res.json({ active: Boolean(user) && permissions.includes('candidates.view'), permissions });
  } catch (error) { next(error); }
});

app.post('/api/reports/handoff', requireAuth, rateLimit({ key: 'report-handoff', maximum: 120, windowMs: 60 * 60 * 1000 }), (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!hasPermission(req.user, 'reports.create')) {
      return res.status(403).json({ error: 'Report Generator access is not enabled.' });
    }
    const { assertion, expiresAt } = createReportAssertion(req.user);
    const url = new URL(REPORT_GENERATOR_URL);
    res.json({ url: url.toString(), assertion, expiresAt });
  } catch (error) { next(error); }
});

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`retry: 2500\nevent: connected\ndata: ${JSON.stringify({ time: nowIso() })}\n\n`);
  const client = { response: res, userId: req.user.id, role: req.user.role, permissions: resolvePermissions(req.user) };
  realtimeClients.add(client);
  const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    realtimeClients.delete(client);
  });
});

const requireSignatureProfile = (req,res,next) => hasPermission(req.user,'signature.manage') ? next() : res.status(403).json({error:'Signature profile access is not enabled.'});
app.get('/api/profile/signature', requireAuth, requireSignatureProfile, async (req, res, next) => {
  try {
    const signature = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    const bytes = asBuffer(signature?.signature_bytes);
    if (!bytes?.length) {
      return res.status(404).json({ error: 'No saved signature is available.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/png').send(bytes);
  } catch (error) {
    next(error);
  }
});

app.put('/api/profile/signature', requireAuth, requireSignatureProfile, rateLimit({ key: 'signature-profile', maximum: 12, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const signatureData = String(req.body?.signatureData || '');
    const signatureType = ['drawn', 'typed', 'initials'].includes(req.body?.signatureType) ? req.body.signatureType : 'drawn';
    const styleName = String(req.body?.styleName || '').slice(0, 50);
    if (!signatureData.startsWith('data:image/png;base64,') || signatureData.length < 800 || signatureData.length > 2_500_000) {
      return res.status(400).json({ error: 'Create a visible signature before saving.' });
    }
    const bytes = Buffer.from(signatureData.replace(/^data:image\/png;base64,/, ''), 'base64');
    const pngMagic = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
    const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
    if (bytes.length < 300 || !bytes.subarray(0,8).equals(pngMagic) || width < 1 || height < 1 || width > 4096 || height > 4096) {
      return res.status(400).json({ error: 'Create a visible signature before saving.' });
    }
    try {
      const validationDocument = await PDFDocument.create();
      await validationDocument.embedPng(bytes);
    } catch {
      return res.status(400).json({ error: 'Create a visible signature before saving.' });
    }
    await dbRun(
      `INSERT INTO profile_signatures (user_id, signature_bytes, signature_type, style_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET signature_bytes = excluded.signature_bytes,
       signature_type = excluded.signature_type, style_name = excluded.style_name,
       updated_at = excluded.updated_at`,
      [req.user.id, bytes, signatureType, styleName, nowIso()],
    );
    await addAudit({
      userId: req.user.id,
      action: 'profile_signature_saved',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: { signatureType, styleName },
    });
    broadcast('profile_changed', { userId: req.user.id });
    res.json({ message: 'Signature saved.', user: await userForResponse(req.user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/officers', requireAuth, requireOwner, async (_req, res, next) => {
  try {
    const officers = await dbAll(
      `SELECT role, name, email, created_at FROM users
       WHERE role IN ('secretary', 'assistant_secretary', 'treasurer', 'assistant_treasurer', 'treasury_preparer', 'viewer', 'warden', 'member', 'officer')
       AND email NOT LIKE '%.local' AND access_revoked_at IS NULL
       ORDER BY role DESC`,
    );
    /* An invitation that has been created but not taken up is its own state. Without this the
     * Master sees "invitation needed" for a man he invited an hour ago and invites him twice. */
    const pending = await dbAll(
      `SELECT role, name, email, created_at, expires_at FROM invitations
       WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      [nowIso()],
    );
    res.json({ officers, pending });
  } catch (error) {
    next(error);
  }
});

app.post('/api/officers/invite', requireAuth, requireOwner, rateLimit({ key: 'invite', maximum: 10, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || '');
    /* The Warden seat is not open to the Lodge at large. Only the two men William named,
     * checked here and again on every warden request, so removing an address revokes it. */
    if (role === 'warden' && !WARDEN_EMAILS.has(email)) {
      return res.status(403).json({
        error: 'The Warden seats are held by the Senior and Junior Warden. Add the address to the allowlist first.',
      });
    }
    if (!isEmail(email) || !name || !INVITABLE_ROLES.includes(role)) {
      if (role === 'member') return res.status(400).json({ error: 'Create Brother invitations from Member Access so the account is linked to the verified Lodge roster.' });
      return res.status(400).json({ error: 'Enter the officer name, valid email, and office.' });
    }
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await withTransaction(async () => {
      await lockOfficeRole(role);
      const existingAccount = await dbGet('SELECT 1 FROM users WHERE email = ? AND access_revoked_at IS NULL', [email]);
      if (existingAccount) throw httpError(409, 'That email already has an active account.');
      if (OFFICE_ROLES.has(role)) {
        const occupied = await dbGet(
          "SELECT 1 FROM users WHERE role = ? AND email NOT LIKE '%.local' AND access_revoked_at IS NULL",
          [role],
        );
        if (occupied) throw httpError(409, 'That office already has an active account.');
        const pending = await dbGet(
          'SELECT 1 FROM invitations WHERE role = ? AND used_at IS NULL AND email <> ?',
          [role, email],
        );
        if (pending) throw httpError(409, 'That office already has a pending invitation.');
      }
      const previousInvite = await dbGet('SELECT permissions_json FROM invitations WHERE email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [email]);
      await dbRun('DELETE FROM invitations WHERE email = ? AND used_at IS NULL', [email]);
      await dbRun(
        `INSERT INTO invitations
         (email, name, role, token_hash, invited_by_user_id, expires_at, created_at, permissions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [email, name, role, hashSecret(token), req.user.id, expiresAt, nowIso(), previousInvite?.permissions_json ?? null],
      );
    });
    const inviteUrl = `${requestBaseUrl(req)}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    let emailSent = false;
    try {
      emailSent = req.body?.sendEmail === false ? false : await sendEmail({
        to: email,
        subject: 'Your Stone Square Sign account invitation',
        text: `${name},\n\nYou have been invited to Stone Square Sign as ${{ member: 'a Lodge Member', viewer: 'a Lodge Viewer', secretary: 'Secretary', assistant_secretary: 'Assistant Secretary', treasurer: 'Treasurer', assistant_treasurer: 'Assistant Treasurer', treasury_preparer: 'a Treasury Report Preparer', warden: 'a Warden' }[role] || 'a signer'}. ${{ member: 'Your account provides sign-in access. Additional work areas are assigned separately by the administrator.', treasurer: 'You can prepare and sign treasurer reports, or provide banking records for another preparing officer.', assistant_treasurer: 'You can prepare and sign treasurer reports, or provide banking records for another preparing officer.', treasury_preparer: 'You can prepare and sign treasurer reports using banking records supplied in the Dashboard. This does not provide access to the bank account.', viewer: 'You can review document status and signing progress, but cannot upload, create, or sign documents.', warden: 'You can view dispensation status and dues, use the Report Generator and Candidate Tracker, save your signature, and submit and track your own dispensation proposals. The Worshipful Master reviews proposals before any dispensation is created.' }[role] || 'You can review and sign assigned Lodge documents.'}\n\nCreate your password using this private link:\n\n${inviteUrl}\n\nThe link expires in 7 days.`,
      });
    } catch (error) {
      console.warn('Invitation email failed:', error.message);
    }
    await addAudit({
      userId: req.user.id,
      action: 'officer_invited',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: { email, name, role, emailSent },
    });
    res.status(201).json({ inviteUrl, emailSent, expiresAt });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/accounts/:id/role', requireAuth, requireOwner, async(req,res,next)=>{
 try{
  const id=Number(req.params.id),role=String(req.body.role||'');
  if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Choose an active account.'});
  if(!ACCOUNT_ROLES.includes(role))return res.status(400).json({error:'Choose an available account role.'});
  await withTransaction(async()=>{
   const account=await dbGet('SELECT id,name,email,role,permissions_json,roster_id,access_revoked_at FROM users WHERE id=? FOR UPDATE',[id]);
   if(!account||account.access_revoked_at)throw httpError(404,'Active account not found.');
   if(account.role==='owner'||id===req.user.id)throw httpError(403,'The Worshipful Master administrator account is permanent.');
   if(role==='member'&&!account.roster_id)throw httpError(409,'Link this Brother through Member Access before assigning the Lodge Member role.');
   if(role==='warden'&&!WARDEN_EMAILS.has(account.email))throw httpError(403,'This email is not configured for a Warden seat.');
   await lockOfficeRole(role);
   if(OFFICE_ROLES.has(role)){
    if(await dbGet("SELECT 1 FROM users WHERE role=? AND id<>? AND access_revoked_at IS NULL AND email NOT LIKE '%.local'",[role,id]))throw httpError(409,'That office already has an active account.');
    if(await dbGet('SELECT 1 FROM invitations WHERE role=? AND used_at IS NULL AND expires_at>? AND email<>?',[role,nowIso(),account.email]))throw httpError(409,'That office already has a pending invitation.');
   }
   if(account.role===role)return;
   const targetPermissions=resolvePermissions({role,permissions_json:null,roster_id:account.roster_id});
   const permissions=JSON.stringify(permissionsForStorage(targetPermissions,role));
   await dbRun('UPDATE users SET role=?, permissions_json=? WHERE id=?',[role,permissions,id]);
   await endUserActivity(id,'Account permissions changed');
   await dbRun('DELETE FROM sessions WHERE user_id=?',[id]);
   disconnectRealtimeUser(id);
   await addAudit({userId:req.user.id,action:'officer_role_changed',ip:req.ip,details:{userId:id,name:account.name,before:account.role,after:role}});
  });res.json({ok:true});
 }catch(e){next(e)}
});

// Upgrade an existing invitation without replacing its private link or expiry.
app.put('/api/officers/invitations/role', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const role = req.body?.role;
    if (!['warden', 'assistant_treasurer'].includes(role)) return res.status(400).json({ error: 'Choose an available invitation office.' });
    if (role === 'warden' && !WARDEN_EMAILS.has(email)) return res.status(403).json({ error: 'This address is not configured for a Warden seat.' });
    await withTransaction(async () => {
      const invite = await dbGet('SELECT id, role FROM invitations WHERE email = ? AND used_at IS NULL AND expires_at > ? FOR UPDATE', [email, nowIso()]);
      if (!invite) throw httpError(404, 'An active pending invitation was not found.');
      if (role === 'assistant_treasurer') {
        if (!['treasury_preparer', 'assistant_treasurer'].includes(invite.role)) throw httpError(400, 'This correction applies to an existing treasury preparer invitation.');
        if (await dbGet("SELECT 1 FROM users WHERE role='assistant_treasurer' AND access_revoked_at IS NULL AND email<>?", [email]) || await dbGet("SELECT 1 FROM invitations WHERE role='assistant_treasurer' AND used_at IS NULL AND expires_at>? AND id<>?", [nowIso(), invite.id])) throw httpError(409, 'Assistant Treasurer already has an account or invitation.');
      }
      await dbRun('UPDATE invitations SET role = ? WHERE id = ?', [role, invite.id]);
      await addAudit({ userId: req.user.id, action: 'officer_invitation_role_changed', ip: req.ip,
        details: { email, before: invite.role, after: role } });
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/officers/revoke', requireAuth, requireOwner, rateLimit({ key: 'revoke-access', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isEmail(email)) return res.status(400).json({ error: 'Choose a valid active account.' });
    const account = await dbGet(
      'SELECT id, email, name, role, access_revoked_at FROM users WHERE email = ?',
      [email],
    );
    if (!account || account.access_revoked_at) {
      return res.status(404).json({ error: 'That active account was not found.' });
    }
    if (account.role === 'owner' || account.id === req.user.id) {
      return res.status(403).json({ error: 'The Worshipful Master administrator account cannot be revoked.' });
    }
    const revokedAt = nowIso();
    await dbRun('UPDATE users SET access_revoked_at = ? WHERE id = ?', [revokedAt, account.id]);
    await endUserActivity(account.id, 'Access revoked');
    await dbRun('DELETE FROM sessions WHERE user_id = ?', [account.id]);
    disconnectRealtimeUser(account.id);
    await dbRun('DELETE FROM reset_codes WHERE user_id = ?', [account.id]);
    await dbRun('DELETE FROM invitations WHERE email = ? AND used_at IS NULL', [email]);
    await dbRun('DELETE FROM profile_signatures WHERE user_id = ?', [account.id]);
    await dbRun(
      'UPDATE document_signers SET user_id = NULL WHERE user_id = ? AND signed_at IS NULL',
      [account.id],
    );
    await addAudit({
      userId: req.user.id,
      action: 'account_access_revoked',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: { revokedUserId: account.id, email: account.email, name: account.name, role: account.role, revokedAt },
    });
    broadcast('queue_changed', { reason: 'access_revoked', userId: account.id });
    res.json({ message: `${account.name}'s access has been revoked.` });
  } catch (error) {
    next(error);
  }
});

/* Dues. Restricted to the Worshipful Master, the Secretaries and the Wardens. The ledger names who is behind on his dues, so viewers are refused
 * outright rather than shown an empty page. */
const requireDuesAccess = (req, res, next) => {
  if (!hasPermission(req.user,'dues.ledger')) {
    return res.status(403).json({ error: 'Dues access is restricted to authorized Lodge officers.' });
  }
  next();
};

app.get('/api/dues', requireAuth, requireDuesAccess, async (req, res, next) => {
  try {
    if (!duesConfigured()) {
      return res.status(503).json({
        error: 'Dues are not connected yet. The Zeffy campaign settings are missing.',
        configured: false,
      });
    }
    const ledger = await buildDuesLedger();
    await addAudit({
      userId: req.user.id,
      action: 'dues_viewed',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: { duesYear: ledger.duesYear, rows: ledger.rows.length },
    });
    res.json(ledger);
  } catch (error) {
    // a Zeffy outage should read as a Zeffy outage, not a broken Lodge app
    if (/Zeffy API/.test(error.message)) {
      return res.status(502).json({ error: 'Zeffy did not answer. Try again shortly.' });
    }
    next(error);
  }
});

app.get(['/api/dues/export.pdf', '/api/dues/export.xlsx'], requireAuth, requireDuesAccess,
  rateLimit({ key: 'dues-export', maximum: 30, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
    try {
      if (!duesConfigured()) return res.status(503).json({ error: 'Dues are not connected yet.' });
      const format = req.path.endsWith('.xlsx') ? 'xlsx' : 'pdf';
      const ledger = await buildDuesLedger();
      const generatedAt = new Date();
      const bytes = format === 'pdf'
        ? await buildDuesPdf(ledger, generatedAt)
        : await buildDuesXlsx(ledger, generatedAt);
      const filename = duesExportFileName(ledger, generatedAt, format);
      await addAudit({
        userId: req.user.id,
        action: 'dues_exported',
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        details: { duesYear: ledger.duesYear, rows: ledger.rows.length, format, generatedAt: generatedAt.toISOString() },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(bytes);
    } catch (error) {
      if (/Zeffy API/.test(error.message)) return res.status(502).json({ error: 'Zeffy did not answer. Try again shortly.' });
      next(error);
    }
  });

/* Meeting minutes stay inside the same officer sign in as the signing queue. Uploading a
 * Plaud transcript creates private working material. The Worshipful Master's signature
 * publishes the signed PDF to officers inside the Dashboard. External distribution and
 * later approval by the Lodge remain separate recorded facts. */
app.get('/api/minutes/review-alerts', requireAuth, requireOwner, async (_req, res, next) => {
  try {
    const rows = await dbAll(`SELECT m.id, m.meeting_date, m.submitted_for_review_at, u.name AS created_by_name
      FROM meeting_minutes m JOIN users u ON u.id = m.created_by_user_id
      WHERE m.status = 'awaiting_master_attestation' ORDER BY m.submitted_for_review_at DESC`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ alerts: rows.map(minutesReviewAlert) });
  } catch (error) { next(error); }
});

app.get('/api/minutes/completion-alerts', requireAuth, requireMinutesView, async (req, res, next) => {
  try {
    await dbRun(`INSERT INTO minutes_distribution_alerts (minutes_id, user_id, created_at)
      SELECT id, ?, COALESCE(master_attested_at, updated_at) FROM meeting_minutes
      WHERE status IN ('ready_for_distribution', 'distributed', 'approved_by_lodge')
        AND master_attested_at IS NOT NULL
      ON CONFLICT (minutes_id, user_id) DO NOTHING`, [req.user.id]);
    const rows = await dbAll(`SELECT m.id, m.meeting_date, m.master_attested_at, m.status,
        master.name AS master_attested_by_name
      FROM minutes_distribution_alerts alert
      JOIN meeting_minutes m ON m.id = alert.minutes_id
      LEFT JOIN users master ON master.id = m.master_attested_by_user_id
      WHERE alert.user_id = ? AND alert.seen_at IS NULL AND m.master_attested_at IS NOT NULL
        AND m.status IN ('ready_for_distribution', 'distributed', 'approved_by_lodge')
      ORDER BY alert.created_at DESC`, [req.user.id]);
    res.setHeader('Cache-Control', 'private, no-store');
    const distributionRole = ['owner', 'secretary', 'assistant_secretary'].includes(req.user.role);
    res.json({ alerts: rows.map(row => minutesCompletionAlert(row, {
      mayDistribute: distributionRole && row.status === 'ready_for_distribution',
    })) });
  } catch (error) { next(error); }
});

app.post('/api/minutes/:id/completion-alert-seen', requireAuth, requireMinutesView, async (req, res, next) => {
  try {
    const time = nowIso();
    const seen = await dbRun(`UPDATE minutes_distribution_alerts SET seen_at = ?
      WHERE minutes_id = ? AND user_id = ? AND seen_at IS NULL`, [time, req.params.id, req.user.id]);
    if (!seen.changes) return res.status(404).json({ error: 'That reviewed minutes alert is no longer pending.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

const finalMinutes = row => ['ready_for_distribution','distributed','approved_by_lodge'].includes(row.status)
  && Boolean(row.master_attested_at) && Boolean(row.has_master_attestation);
const canOpenWorkingMinutes = (user, row) => user.role === 'owner'
  || row.preparer_user_id === user.id
  || (!row.preparer_user_id && row.created_by_user_id === user.id);
const MINUTES_CLAIM_STALE_MS = 10 * 60 * 1000;
const releaseMinutesClaim = async (id, preparerUserId = null, reason = 'claim_released') => {
  const time = nowIso();
  const params = [time, id];
  const preparerClause = preparerUserId == null ? '' : ' AND preparer_user_id = ?';
  if (preparerUserId != null) params.push(preparerUserId);
  const released = await dbRun(
    `UPDATE meeting_minutes SET status = 'awaiting_preparer', preparer_user_id = NULL,
     claimed_at = NULL, created_by_user_id = COALESCE(source_uploaded_by_user_id, created_by_user_id),
     updated_by_user_id = COALESCE(source_uploaded_by_user_id, updated_by_user_id), updated_at = ?
     WHERE id = ? AND status = 'organizing'${preparerClause}`,
    params,
  );
  if (released.changes) {
    await addAudit({ action: 'minutes_claim_released', details: { minutesId: id, reason } });
    broadcast('minutes_records_changed', { minutesId: id, reason });
  }
  return Boolean(released.changes);
};
const recoverStaleMinutesClaims = async () => {
  const cutoff = new Date(Date.now() - MINUTES_CLAIM_STALE_MS).toISOString();
  const stale = await dbAll(
    `SELECT id FROM meeting_minutes
     WHERE status = 'organizing' AND claimed_at IS NOT NULL AND claimed_at < ?`,
    [cutoff],
  );
  for (const row of stale) await releaseMinutesClaim(row.id, null, 'stale_claim_recovered');
};
app.get('/api/minutes', requireAuth, requireMinutesView, async (req, res, next) => {
  try {
    await recoverStaleMinutesClaims();
    const rows = await dbAll(
      `SELECT m.*,
         creator.name AS created_by_name, creator.role AS created_by_role, updater.name AS updated_by_name,
         source_uploader.name AS source_uploaded_by_name, preparer_user.name AS preparer_name,
         authorizer.name AS authorized_by_name, distributor.name AS distributed_by_name,
         master.name AS master_attested_by_name,
         EXISTS (SELECT 1 FROM meeting_minutes_attestations att
           WHERE att.minutes_id = m.id AND att.phase = 'master') AS has_master_attestation
       FROM meeting_minutes m
       JOIN users creator ON creator.id = m.created_by_user_id
       JOIN users updater ON updater.id = m.updated_by_user_id
       LEFT JOIN users source_uploader ON source_uploader.id = m.source_uploaded_by_user_id
       LEFT JOIN users preparer_user ON preparer_user.id = m.preparer_user_id
       LEFT JOIN users authorizer ON authorizer.id = m.authorized_by_user_id
       LEFT JOIN users distributor ON distributor.id = m.distributed_by_user_id
       LEFT JOIN users master ON master.id = m.master_attested_by_user_id
       WHERE m.status <> 'deleted'
       ORDER BY COALESCE(m.meeting_date, m.created_at) DESC`,
    );
    const preparer=hasPermission(req.user,'minutes.prepare');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ minutes: rows.filter(row=>finalMinutes(row)||(preparer&&(canOpenWorkingMinutes(req.user,row)||['awaiting_preparer','organizing'].includes(row.status)))).map(row=>{
      const record=minutesForResponse(row);
      if (preparer && (canOpenWorkingMinutes(req.user,row) || row.status === 'awaiting_preparer')) return record;
      if (preparer && row.status === 'organizing') return {
        ...record,
        sourceName: null,
        submittedDraft: null,
        masterChanges: [],
        approvalNote: null,
        draft: normalizeMinutesDraft({}),
      };
      return {...record,sourceName:null,submittedDraft:null,masterChanges:[],approvalNote:null,draft:normalizeMinutesDraft({meetingDate:row.meeting_date,meetingType:record.draft.meetingType,degree:record.draft.degree})};
    }) });
  } catch (error) {
    next(error);
  }
});

// The Worshipful Master can place a Plaud transcript or compiled notes into the
// Secretary's Office queue without spending a generation call. Adrian or
// McDuffie claims the source before organization so one officer owns the draft.
app.post('/api/minutes/handoff', requireAuth, requireOwner,
  rateLimit({ key: 'minutes-handoff', maximum: 12, windowMs: 60 * 60 * 1000 }),
  minutesUpload.single('transcriptFile'), async (req, res, next) => {
    try {
      const uploadedText = await transcriptFromUpload(req.file);
      const transcript = uploadedText || String(req.body.transcriptText || '').trim();
      if (!transcript) return res.status(400).json({ error: 'Choose meeting notes or a transcript, or paste the text.' });
      if (transcript.length > 500_000) return res.status(400).json({ error: 'The meeting source is too long. Upload one meeting at a time.' });
      const sourceType = ['auto', 'compiled_notes', 'transcript'].includes(req.body.sourceType) ? req.body.sourceType : 'auto';
      const id = crypto.randomUUID();
      const time = nowIso();
      const sourceName = req.file?.originalname || (sourceType === 'compiled_notes' ? 'Pasted meeting notes' : 'Pasted transcript');
      const placeholder = normalizeMinutesDraft({ sourceType, sections: [] });
      await dbRun(
        `INSERT INTO meeting_minutes
          (id, meeting_date, source_name, transcript_text, draft_json, status,
           created_by_user_id, source_uploaded_by_user_id, preparer_user_id,
           updated_by_user_id, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, 'awaiting_preparer', ?, ?, NULL, ?, ?, ?)`,
        [id, sourceName, transcript, JSON.stringify(placeholder), req.user.id, req.user.id, req.user.id, time, time],
      );
      await addAudit({
        userId: req.user.id,
        action: 'minutes_source_handed_off',
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        details: { minutesId: id, sourceName },
      });
      broadcast('minutes_records_changed', { minutesId: id, reason: 'source_handed_off' });
      const secretaries = await dbAll("SELECT * FROM users WHERE access_revoked_at IS NULL AND role IN ('secretary','assistant_secretary') ORDER BY role");
      const notificationWarnings = [];
      for (const secretary of secretaries.filter(candidate => hasPermission(candidate, 'minutes.prepare'))) {
        try {
          const sent = await sendEmail({
            to: secretary.email,
            subject: 'Meeting transcript ready for minutes preparation',
            text: `${req.user.name} uploaded ${sourceName} to the Stone Square Dashboard. It is awaiting Adrian Reese or William McDuffie. Open Meeting Minutes to claim the source and create the organized draft. Once one officer claims it, the other officer cannot create a duplicate.\n\n${requestBaseUrl(req)}/?section=minutes`,
          });
          if (!sent) notificationWarnings.push(`The source is available in the Dashboard, but the email notice to ${secretary.email} could not be sent.`);
        } catch (error) {
          console.warn('Minutes handoff notice failed:', error.message);
          notificationWarnings.push(`The source is available in the Dashboard, but the email notice to ${secretary.email} could not be sent.`);
        }
      }
      res.status(201).json({ minutes: minutesForResponse(await getMinutesRow(id)), notificationWarnings });
    } catch (error) { next(error); }
  });

app.post('/api/minutes/:id/claim', requireAuth, requireMinutesAccess,
  rateLimit({ key: 'minutes-generate', maximum: 12, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
    let claimed = false;
    try {
      if (!['secretary', 'assistant_secretary'].includes(req.user.role)) {
        return res.status(403).json({ error: 'The Secretary or Assistant Secretary claims a minutes source from this queue.' });
      }
      await recoverStaleMinutesClaims();
      const row = await getMinutesRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Meeting minutes source not found.' });
      if (row.status !== 'awaiting_preparer' || row.preparer_user_id) {
        return res.status(409).json({ error: row.preparer_name ? `This source has already been claimed by ${row.preparer_name}.` : 'This source is no longer awaiting a preparer.' });
      }
      const time = nowIso();
      const result = await dbRun(
        `UPDATE meeting_minutes SET status = 'organizing', preparer_user_id = ?, claimed_at = ?,
         created_by_user_id = ?, updated_by_user_id = ?, updated_at = ?
         WHERE id = ? AND status = 'awaiting_preparer' AND preparer_user_id IS NULL`,
        [req.user.id, time, req.user.id, req.user.id, time, row.id],
      );
      if (!result.changes) {
        const current = await getMinutesRow(row.id);
        return res.status(409).json({ error: current?.preparer_name ? `This source has already been claimed by ${current.preparer_name}.` : 'Another officer claimed this source first.' });
      }
      claimed = true;
      broadcast('minutes_records_changed', { minutesId: row.id, reason: 'source_claimed', preparer: req.user.name });
      const sourceType = String(JSON.parse(row.draft_json || '{}').sourceType || 'auto');
      const draft = await generateMinutesDraft(row.transcript_text, { sourceType, generateStructured: generationFor(req.user.id) });
      const savedAt = nowIso();
      const saved = await dbRun(
        `UPDATE meeting_minutes SET meeting_date = ?, draft_json = ?, status = 'draft',
         updated_by_user_id = ?, updated_at = ?
         WHERE id = ? AND status = 'organizing' AND preparer_user_id = ?`,
        [draft.meetingDate, JSON.stringify(draft), req.user.id, savedAt, row.id, req.user.id],
      );
      if (!saved.changes) throw Object.assign(new Error('The source changed while it was being organized. Refresh before trying again.'), { statusCode: 409 });
      await addAudit({
        userId: req.user.id,
        action: 'minutes_source_claimed',
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        details: { minutesId: row.id, sourceUploadedByUserId: row.source_uploaded_by_user_id },
      });
      broadcast('minutes_records_changed', { minutesId: row.id, reason: 'draft_created', preparer: req.user.name });
      res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)) });
    } catch (error) {
      if (claimed) {
        try {
          await releaseMinutesClaim(req.params.id, req.user.id, 'generation_failed');
        } catch (releaseError) {
          console.error('Minutes claim release failed; stale-claim recovery will retry:', releaseError);
        }
      }
      next(error);
    }
  });

app.post('/api/minutes/generate', requireAuth, requireMinutesAccess,
  rateLimit({ key: 'minutes-generate', maximum: 12, windowMs: 60 * 60 * 1000 }),
  minutesUpload.single('transcriptFile'), async (req, res, next) => {
    try {
      const uploadedText = await transcriptFromUpload(req.file);
      const transcript = uploadedText || String(req.body.transcriptText || '').trim();
      if (!transcript) return res.status(400).json({ error: 'Choose meeting notes or a transcript, or paste the text.' });
      const draft = await generateMinutesDraft(transcript, { sourceType: req.body.sourceType, generateStructured: generationFor(req.user.id) });
      const id = crypto.randomUUID();
      const time = nowIso();
      await dbRun(
        `INSERT INTO meeting_minutes
          (id, meeting_date, source_name, transcript_text, draft_json, status,
           created_by_user_id, source_uploaded_by_user_id, preparer_user_id,
           updated_by_user_id, created_at, updated_at, claimed_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        [id, draft.meetingDate, req.file?.originalname || (draft.sourceType === 'compiled_notes' ? 'Pasted meeting notes' : 'Pasted transcript'), transcript,
          JSON.stringify(draft), req.user.id, req.user.id, req.user.id, req.user.id, time, time, time],
      );
      await dbRun(
        `INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at)
         VALUES (?, 'minutes_draft_created', ?, ?, ?, ?)`,
        [req.user.id, req.ip, req.get('user-agent') || '', JSON.stringify({ minutesId: id }), time],
      );
      res.status(201).json({ minutes: minutesForResponse(await getMinutesRow(id)) });
    } catch (error) {
      next(error);
    }
  });

// Remove an unsigned working draft from the active list while retaining its source
// and audit trail. A signed record cannot be deleted, even after reopening it.
app.delete('/api/minutes/:id', requireAuth, requireMinutesAccess, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (req.user.role !== 'owner' && row.created_by_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the preparing officer or the Worshipful Master can delete this draft.' });
    }
    const time = nowIso();
    const removed = await withTransaction(async () => {
      const result = await dbRun(
        `UPDATE meeting_minutes SET status = 'deleted', updated_at = ?, updated_by_user_id = ?
         WHERE id = ? AND status IN ('awaiting_preparer', 'draft') AND preparer_attested_at IS NULL
           AND master_attested_at IS NULL AND authorized_at IS NULL AND approved_by_lodge_on IS NULL
           AND NOT EXISTS (SELECT 1 FROM meeting_minutes_attestations WHERE minutes_id = meeting_minutes.id)
           AND NOT EXISTS (SELECT 1 FROM audit_events WHERE action IN ('minutes_preparer_attested', 'minutes_master_attested', 'minutes_lodge_approval_recorded') AND details_json::jsonb ->> 'minutesId' = ?)`,
        [time, req.user.id, row.id, row.id],
      );
      if (result.changes) await dbRun(
        `INSERT INTO audit_events (user_id, action, details_json, created_at) VALUES (?, 'minutes_draft_deleted', ?, ?)`,
        [req.user.id, JSON.stringify({ minutesId: row.id }), time],
      );
      return result.changes;
    });
    if (!removed) return res.status(409).json({ error: 'Only an unclaimed source or unsigned working draft can be deleted. Signed and approved records are retained.' });
    res.json({ deleted: true });
  } catch (error) { next(error); }
});

// Reorganizing returns an unsaved replacement for review. It never overwrites
// corrections or changes signatures, approvals, or the original source.
app.post('/api/minutes/:id/reorganize', requireAuth, requireMinutesAccess, rateLimit({ key: 'minutes-generate', maximum: 12, windowMs: 3600000 }), async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (!canOpenWorkingMinutes(req.user, row)) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (row.status !== 'draft') return res.status(409).json({ error: 'Reopen this record before preparing corrections.' });
    if (req.body.expectedUpdatedAt !== row.updated_at) return res.status(409).json({ error: 'The record changed. Refresh before reorganizing.' });
    const draft = await generateMinutesDraft(row.transcript_text, { sourceType: req.body.sourceType, generateStructured: generationFor(req.user.id) });
    const current = await getMinutesRow(row.id);
    if (!current || current.status !== 'draft' || current.updated_at !== row.updated_at) return res.status(409).json({ error: 'The record changed while its source was being organized. Reopen it before continuing.' });
    res.json({ draft });
  } catch (error) { next(error); }
});


app.put('/api/minutes/:id', requireAuth, requireMinutesAccess, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (!canOpenWorkingMinutes(req.user, row)) return res.status(404).json({ error: 'Meeting minutes not found.' });
    const masterReview = row.status === 'awaiting_master_attestation' && req.user.role === 'owner';
    if (row.status !== 'draft' && !masterReview) {
      return res.status(409).json({ error: 'Reopen these minutes before changing an attested or official record.' });
    }
    const draft = normalizeMinutesDraft(req.body.draft);
    if (!draft.sections.some(section => section.body.trim())) return res.status(400).json({ error: 'The minutes need at least one section with meeting notes.' });
    const time = nowIso();
    const changes = masterReview ? minutesChanges(JSON.parse(row.submitted_draft_json || row.draft_json), draft) : [];
    const saved = await dbRun(
      `UPDATE meeting_minutes SET meeting_date = ?, draft_json = ?, updated_by_user_id = ?,
       updated_at = ?, master_changes_json = ? WHERE id = ? AND status = ? AND updated_at = ?`,
      [draft.meetingDate, JSON.stringify(draft), req.user.id, time, JSON.stringify(changes), row.id, row.status, req.body.expectedUpdatedAt || row.updated_at],
    );
    if (!saved.changes) return res.status(409).json({ error: 'The record changed. Refresh before saving.' });
    await dbRun(
      `INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at)
       VALUES (?, 'minutes_draft_saved', ?, ?, ?, ?)`,
      [req.user.id, req.ip, req.get('user-agent') || '', JSON.stringify({ minutesId: row.id, masterReview, changedFields: changes.map(change => change.field) }), time],
    );
    res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/minutes/:id/preparer-attest', requireAuth, requireMinutesPreparer, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (row.status !== 'draft') return res.status(409).json({ error: 'Only a working draft can be attested and sent to the Worshipful Master.' });
    if (row.created_by_user_id !== req.user.id) {
      return res.status(403).json({ error: 'The officer who prepared this draft must attest to it.' });
    }
    const draft = JSON.parse(row.draft_json);
    const reviewIssues = [...attendanceReviewIssues(draft), ...closingReviewIssues(draft)];
    if (reviewIssues.length) return res.status(409).json({ error: reviewIssues.join(' ') });
    const signature = await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    if (!signature) return res.status(409).json({ error: 'Save your signature profile before attesting to the minutes.' });
    const time = nowIso();
    const attestation = await withTransaction(async () => {
      const result = await dbRun(
      `UPDATE meeting_minutes SET status = 'awaiting_master_attestation', submitted_for_review_at = ?,
       preparer_attested_at = ?, submitted_draft_json = ?, preparer_signature_bytes = ?, master_changes_json = '[]',
       updated_by_user_id = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?`,
      [time, time, row.draft_json, asBuffer(signature.signature_bytes), req.user.id, time, row.id, row.updated_at],
    );
      if (result.changes) await dbRun(
        `INSERT INTO meeting_minutes_attestations (id, minutes_id, user_id, phase, draft_json, signature_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), row.id, req.user.id, 'preparer', row.draft_json, asBuffer(signature.signature_bytes), time],
      );
      return result;
    });
    if (!attestation.changes) return res.status(409).json({ error: 'The draft changed. Refresh before attesting.' });
    await dbRun(
      `INSERT INTO audit_events (user_id, action, details_json, created_at) VALUES (?, 'minutes_preparer_attested', ?, ?)`,
      [req.user.id, JSON.stringify({ minutesId: row.id }), time],
    );
    broadcast('minutes_review_changed');
    const alert = minutesReviewAlert(row);
    const owner = await dbGet("SELECT email FROM users WHERE role = 'owner' AND access_revoked_at IS NULL ORDER BY id LIMIT 1");
    let noticeSent = false;
    if (owner?.email) {
      try {
        noticeSent = await sendEmail({
          to: owner.email,
          subject: alert.title,
          text: `${alert.title}.\n\n${req.user.name} submitted the minutes for your review and attestation. Open Meeting Minutes in the Stone Square Dashboard to review the draft.\n\n${requestBaseUrl(req)}${alert.url}`,
        });
      } catch (error) {
        console.warn('Minutes review notice failed:', error.message);
      }
    }
    res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)), notificationWarnings: noticeSent ? [] : ['The signed draft is in the Worshipful Master\'s review queue, but the email notice could not be sent.'] });
  } catch (error) {
    next(error);
  }
});

app.post('/api/minutes/:id/master-attest', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (row.status !== 'awaiting_master_attestation') return res.status(409).json({ error: 'The preparing officer must attest to the draft first.' });
    const draft = JSON.parse(row.draft_json);
    const reviewIssues = [...attendanceReviewIssues(draft), ...closingReviewIssues(draft)];
    if (reviewIssues.length) return res.status(409).json({ error: `The preparing officer must complete the required attendance review before these minutes can be signed. ${reviewIssues.join(' ')}` });
    const signature = await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    if (!signature) return res.status(409).json({ error: 'Save your signature profile before attesting to the minutes.' });
    const time = nowIso();
    const attested = await withTransaction(async () => {
      const result = await dbRun(
      `UPDATE meeting_minutes SET status = 'ready_for_distribution', master_attested_by_user_id = ?,
       master_attested_at = ?, master_signature_bytes = ?, authorized_by_user_id = ?, authorized_at = ?,
       preparer_review_seen_at = NULL, updated_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'awaiting_master_attestation' AND updated_at = ?`,
      [req.user.id, time, asBuffer(signature.signature_bytes), req.user.id, time, req.user.id, time, row.id, row.updated_at],
    );
      if (result.changes) await dbRun(
        `INSERT INTO meeting_minutes_attestations (id, minutes_id, user_id, phase, draft_json, signature_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), row.id, req.user.id, 'master', row.draft_json, asBuffer(signature.signature_bytes), time],
      );
      return result;
    });
    if (!attested.changes) return res.status(409).json({ error: 'The record changed. Refresh before attesting.' });
    await dbRun(
      `INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at)
       VALUES (?, 'minutes_master_attested', ?, ?, ?, ?)`,
      [req.user.id, req.ip, req.get('user-agent') || '', JSON.stringify({ minutesId: row.id, publishedToOfficers: true }), time],
    );
    const recipientCandidates = await dbAll("SELECT * FROM users WHERE access_revoked_at IS NULL AND (role IN ('secretary', 'assistant_secretary') OR id = ?)", [row.created_by_user_id]);
    const recipients = [...new Map(recipientCandidates
      .filter(candidate => hasPermission(candidate, 'minutes.prepare'))
      .map(candidate => [normalizeEmail(candidate.email), candidate]))
      .values()];
    const activeUsers = await dbAll('SELECT * FROM users WHERE access_revoked_at IS NULL');
    const alertUsers = activeUsers.filter(candidate => hasPermission(candidate, 'minutes.view'));
    for (const recipient of alertUsers) {
      await dbRun(`INSERT INTO minutes_distribution_alerts (minutes_id, user_id, created_at)
        VALUES (?, ?, ?) ON CONFLICT (minutes_id, user_id) DO UPDATE SET created_at = EXCLUDED.created_at, seen_at = NULL`,
      [row.id, recipient.id, time]);
    }
    broadcast('minutes_review_changed');
    broadcast('minutes_completion_changed');
    broadcast('minutes_records_changed', { minutesId: row.id, reason: 'published' });
    const changes = row.master_changes_json ? JSON.parse(row.master_changes_json) : [];
    const changedSections = changes.map(change => change.field).join(', ');
    const notificationWarnings = [];
    for (const recipient of recipients) {
      try {
        const sent = await sendEmail({
          to: recipient.email,
          subject: `Meeting minutes reviewed and signed: ${row.meeting_date || 'date needs review'}`,
          text: `The Worshipful Master reviewed and signed the meeting minutes. ${changes.length ? `Corrections were recorded in: ${changedSections}. Open the record to compare the submitted and reviewed text.` : 'No corrections were made to the submitted draft.'} The signed minutes are now available to all officers in the Stone Square Dashboard and are ready for McDuffie or Reese to distribute to the Craft.\n\n${requestBaseUrl(req)}/?section=minutes`,
        });
        if (!sent) notificationWarnings.push(`The reviewed record is available in the Dashboard, but the email notice to ${recipient.email} could not be sent.`);
      } catch (error) { console.warn('Minutes review completion notice failed:', error.message); notificationWarnings.push(`The reviewed record is available in the Dashboard, but the email notice to ${recipient.email} could not be sent.`); }
    }
    res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)), notificationWarnings });
  } catch (error) {
    next(error);
  }
});

app.post('/api/minutes/:id/mark-distributed', requireAuth, requireSecretaryOrOwner, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (row.status !== 'ready_for_distribution') {
      return res.status(409).json({ error: 'The Worshipful Master must attest to the minutes first.' });
    }
    const time = nowIso();
    await dbRun(
      `UPDATE meeting_minutes SET status = 'distributed', distributed_by_user_id = ?,
       distributed_at = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
      [req.user.id, time, req.user.id, time, row.id],
    );
    broadcast('minutes_records_changed', { minutesId: row.id, reason: 'distributed' });
    res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/minutes/:id/lodge-approval', requireAuth, requireSecretaryOrOwner, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (!['ready_for_distribution', 'distributed'].includes(row.status)) {
      return res.status(409).json({ error: 'Record the Lodge approval only after the draft has been authorized.' });
    }
    const approvalDate = String(req.body.approvalDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(approvalDate)) {
      return res.status(400).json({ error: 'Enter the date on which the Lodge approved the minutes.' });
    }
    const time = nowIso();
    await dbRun(
      `UPDATE meeting_minutes SET status = 'approved_by_lodge', approved_by_lodge_on = ?,
       approval_note = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
      [approvalDate, String(req.body.approvalNote || '').trim() || null, req.user.id, time, row.id],
    );
    await dbRun(
      `INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at)
       VALUES (?, 'minutes_lodge_approval_recorded', ?, ?, ?, ?)`,
      [req.user.id, req.ip, req.get('user-agent') || '', JSON.stringify({ minutesId: row.id, approvalDate }), time],
    );
    broadcast('minutes_records_changed', { minutesId: row.id, reason: 'approved_by_lodge' });
    res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/minutes/:id/reopen', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (row.status === 'approved_by_lodge') return res.status(409).json({ error: 'An approved Lodge record cannot be reopened here.' });
    const time = nowIso();
    await dbRun(
      `UPDATE meeting_minutes SET status = 'draft', submitted_for_review_at = NULL,
       preparer_attested_at = NULL, master_attested_by_user_id = NULL, master_attested_at = NULL, master_signature_bytes = NULL, submitted_draft_json = NULL, master_changes_json = NULL, preparer_signature_bytes = NULL,
       authorized_by_user_id = NULL, authorized_at = NULL, distributed_by_user_id = NULL,
       distributed_at = NULL, updated_by_user_id = ?, updated_at = ? WHERE id = ?`,
      [req.user.id, time, row.id],
    );
    broadcast('minutes_review_changed');
    broadcast('minutes_records_changed', { minutesId: row.id, reason: 'reopened' });
    res.json({ minutes: minutesForResponse(await getMinutesRow(row.id)) });
  } catch (error) {
    next(error);
  }
});

const minutesArtifactContext = async (row, draft, captured = {}) => {
  const preparerSignature = row.preparer_attested_at
    ? await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id = ?', [row.created_by_user_id])
    : null;
  const masterSignature = row.master_attested_at
    ? await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id = ?', [row.master_attested_by_user_id])
    : null;
  return {
    draft,
    status: row.status,
    approvedByLodgeOn: row.approved_by_lodge_on,
    preparedBy: row.created_by_name,
    preparerRole: row.created_by_role,
    preparedSignature: asBuffer(captured.preparerSignature || row.preparer_signature_bytes || preparerSignature?.signature_bytes),
    preparerAttestedAt: row.preparer_attested_at,
    masterName: captured.masterName || row.master_attested_by_name,
    masterSignature: asBuffer(captured.masterSignature || row.master_signature_bytes || masterSignature?.signature_bytes),
    masterChanges: row.status === 'awaiting_master_attestation' && row.submitted_draft_json
      ? minutesChanges(JSON.parse(row.submitted_draft_json), draft)
      : row.master_changes_json ? JSON.parse(row.master_changes_json) : [],
    masterAttestedAt: row.master_attested_at,
  };
};

const publishedMinutesSnapshot = async (row) => {
  const master=await dbGet(`SELECT a.draft_json, a.signature_bytes, u.name
    FROM meeting_minutes_attestations a JOIN users u ON u.id=a.user_id
    WHERE a.minutes_id=? AND a.phase='master' ORDER BY a.created_at DESC LIMIT 1`,[row.id]);
  const preparer=await dbGet(`SELECT signature_bytes FROM meeting_minutes_attestations
    WHERE minutes_id=? AND phase='preparer' ORDER BY created_at DESC LIMIT 1`,[row.id]);
  if(!master||!preparer)return null;
  return {draft:normalizeMinutesDraft(JSON.parse(master.draft_json)),captured:{
    masterName:master.name,masterSignature:master.signature_bytes,preparerSignature:preparer.signature_bytes,
  }};
};

app.get('/api/minutes/:id/pdf',requireAuth,requireMinutesView,async(req,res,next)=>{try{
  const row=await getMinutesRow(req.params.id);
  const mayOpenWorking=Boolean(row&&hasPermission(req.user,'minutes.prepare')&&canOpenWorkingMinutes(req.user,row));
  if(!row||(!mayOpenWorking&&!finalMinutes(row)))return res.status(404).json({error:'Finished meeting minutes not found.'});
  let draft=normalizeMinutesDraft(JSON.parse(row.draft_json));
  let captured={};
  if(finalMinutes(row)){
    const snapshot=await publishedMinutesSnapshot(row);
    if(!snapshot)return res.status(404).json({error:'Signed meeting minutes are not available.'});
    ({draft,captured}=snapshot);
  }
  const bytes=await buildMinutesPdf(await minutesArtifactContext(row,draft,captured));
  if(finalMinutes(row))await addAudit({userId:req.user.id,action:'minutes_signed_pdf_viewed',ip:req.ip,userAgent:req.get('user-agent')||'',details:{minutesId:row.id}});
  const pdfName = minutesFileName(draft, row.status).replace(/\.docx$/i, '.pdf');
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Disposition', `${disposition}; filename="${pdfName}"`);res.type('application/pdf').send(bytes);
}catch(e){next(e)}});

app.post('/api/minutes/:id/preview', requireAuth, requireMinutesAccess,
  rateLimit({ key: 'minutes-preview', maximum: 600, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
    try {
      const row = await getMinutesRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
      if (!canOpenWorkingMinutes(req.user, row)) return res.status(404).json({ error: 'Meeting minutes not found.' });
      const savedDraft = normalizeMinutesDraft(JSON.parse(row.draft_json));
      const draft = (row.status === 'draft' || (row.status === 'awaiting_master_attestation' && req.user.role === 'owner')) && req.body?.draft
        ? normalizeMinutesDraft(req.body.draft) : savedDraft;
      if (!draft.sections.some(section => section.body.trim())) return res.status(400).json({ error: 'The minutes need at least one section with meeting notes.' });
      const bytes = await buildMinutesPdf(await minutesArtifactContext(row, draft));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="meeting-minutes-preview.pdf"');
      res.send(bytes);
    } catch (error) {
      next(error);
    }
  });

app.get('/api/minutes/:id/docx', requireAuth, requireMinutesAccess, async (req, res, next) => {
  try {
    const row = await getMinutesRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found.' });
    if (!canOpenWorkingMinutes(req.user, row) && !finalMinutes(row)) return res.status(404).json({ error: 'Meeting minutes not found.' });
    let draft = normalizeMinutesDraft(JSON.parse(row.draft_json));
    let captured = {};
    if (finalMinutes(row)) {
      const snapshot = await publishedMinutesSnapshot(row);
      if (!snapshot) return res.status(404).json({ error: 'Signed meeting minutes are not available.' });
      ({ draft, captured } = snapshot);
    }
    const bytes = await buildMinutesDocx(await minutesArtifactContext(row, draft, captured));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${minutesFileName(draft, row.status)}"`);
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents', requireAuth, async (req, res, next) => {
  if(!hasPermission(req.user,'documents.status'))return res.status(403).json({error:'Document access has not been assigned to this account.'});
  const statusOnly=!hasPermission(req.user,'documents.sign');
  const queueRole=req.user.role==='owner'?'owner':statusOnly?(req.user.role==='viewer'?'viewer':'warden'):'signer';
  try {
    const rows = await dbAll(
      `SELECT d.id, d.title, d.original_name, d.status, d.created_at, d.updated_at,
              d.completed_at, d.template_kind, d.submitted_at, d.submitted_to, d.submitted_error,
              d.approval_status, d.approved_by, d.approved_on, d.approval_source,
              u.name AS owner_name, u.email AS owner_email
       FROM documents d LEFT JOIN users u ON u.id = d.owner_user_id
       WHERE (? IN ('owner','viewer','warden') OR d.owner_user_id = ? OR EXISTS (
         SELECT 1 FROM document_signers ds
         WHERE ds.document_id = d.id
         AND (ds.user_id = ? OR (ds.user_id IS NULL AND ds.signer_role = ?))
       )) AND (? <> 'warden' OR d.template_kind = 'dispensation_v1')
       ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'partially_signed' THEN 1 ELSE 2 END,
                CASE WHEN d.status IN ('completed', 'rescinded') THEN d.updated_at END DESC,
                d.created_at ASC`,
      [queueRole, req.user.id, req.user.id, req.user.role, queueRole],
    );
    const documents = [];
    for (const row of rows) {
      const signers = await dbAll(
        `SELECT id, user_id, signer_role, signer_name, signed_at, superseded_at
         FROM document_signers WHERE document_id = ? ORDER BY id`,
        [row.id],
      );
      if (statusOnly) {
        documents.push({
          id: row.id,
          title: row.title,
          original_name: row.original_name,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          completed_at: row.completed_at,
          owner_name: row.owner_name,
          template_kind: row.template_kind,
          approval_status: row.approval_status,
          approved_by: row.approved_by,
          approved_on: row.approved_on,
          signers: signers.map((signer) => ({
            signer_role: signer.signer_role,
            signer_name: signer.signer_name,
            signed: Boolean(signer.signed_at),
          })),
          needsSignature: false,
        });
      } else {
        documents.push({
          ...row,
          signers,
          needsSignature: row.status !== 'rescinded' && signers.some((signer) =>
            !signer.signed_at && !signer.superseded_at &&
            (signer.user_id === req.user.id || (!signer.user_id && signer.signer_role === req.user.role))),
        });
      }
    }
    res.json({ documents });
  } catch (error) {
    next(error);
  }
});

app.get('/api/submission-profiles', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'owner' && !OFFICE_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'This account cannot access officer addresses.' });
    }
    const profiles = req.user.role === 'owner'
      ? await dbAll('SELECT role, name, address FROM submission_profiles ORDER BY role')
      : await dbAll('SELECT role, name, address FROM submission_profiles WHERE role = ?', [req.user.role]);
    res.json({ profiles });
  } catch (error) {
    next(error);
  }
});

app.put('/api/submission-profiles/:role', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const role = req.params.role;
    if (!OFFICE_ROLES.has(role)) return res.status(400).json({ error: 'Choose a Secretary office.' });
    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    if (!name || name.length > 120 || !address || address.length > 160
        || address.toLowerCase() === name.toLowerCase()) {
      return res.status(400).json({ error: 'Save the officer name and a separate mailing address.' });
    }
    await withTransaction(async () => {
      await dbRun(`INSERT INTO submission_profiles (role, name, address, source_reference, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET name = excluded.name,
        address = excluded.address, source_reference = excluded.source_reference, updated_at = excluded.updated_at`,
      [role, name, address, 'Confirmed by Worshipful Master', nowIso()]);
      await addAudit({ userId: req.user.id, action: 'officer_submission_profile_updated',
        ip: req.ip, userAgent: req.get('user-agent') || '', details: { role } });
    });
    res.json({ profile: { role, name, address } });
  } catch (error) { next(error); }
});

app.get('/api/documents/:id', requireAuth, requireDocumentAccess, async (req, res, next) => {
  try {
    const document = await dbGet(
      `SELECT d.*, u.name AS owner_name, u.email AS owner_email
       FROM documents d LEFT JOIN users u ON u.id = d.owner_user_id WHERE d.id = ?`,
      [req.params.id],
    );
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (!(await participantForDocument(document, req.user))) {
      return res.status(403).json({ error: 'You do not have access to this document.' });
    }
    const signers = await dbAll(
      'SELECT id, user_id, signer_role, signer_name, signed_at, superseded_at FROM document_signers WHERE document_id = ? ORDER BY id',
      [document.id],
    );
    delete document.file_bytes;
    delete document.signed_bytes;
    document.has_endorsed_copy = Boolean(asBuffer(document.approved_bytes)?.length);
    delete document.approved_bytes;
    res.json({ document: { ...document, signers } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/file', requireAuth, requireDocumentAccess, async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (!(await participantForDocument(document, req.user))) {
      return res.status(403).json({ error: 'You do not have access to this document.' });
    }
    const safeName = document.original_name.replace(/[\r\n"]/g, '').replace(/[^a-zA-Z0-9._ -]/g, '_');
    // once anyone has signed, the executed copy is the one worth showing
    const bytes = asBuffer(document.signed_bytes) || asBuffer(document.file_bytes);
    if (!bytes?.length) return res.status(404).json({ error: 'Document file is missing.' });
    await addAudit({userId:req.user.id,documentId:document.id,action:'document_opened',ip:req.ip});
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.type('application/pdf').send(bytes);
  } catch (error) {
    next(error);
  }
});

/* The document exactly as it was uploaded. Signatures stamp a separate copy, so the
 * instrument the Worshipful Master submitted is always recoverable, which matters if
 * anyone ever questions what was put in front of the officers to sign. */
app.get('/api/documents/:id/original', requireAuth, requireDocumentAccess, async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (!(await participantForDocument(document, req.user))) {
      return res.status(403).json({ error: 'You do not have access to this document.' });
    }
    const bytes = asBuffer(document.file_bytes);
    if (!bytes?.length) return res.status(404).json({ error: 'Document file is missing.' });
    const safeName = document.original_name.replace(/[\r\n"]/g, '').replace(/[^a-zA-Z0-9._ -]/g, '_');
    await addAudit({userId:req.user.id,documentId:document.id,action:'document_opened',ip:req.ip});
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.type('application/pdf').send(bytes);
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents', requireAuth, requireOwner, upload.single('document'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF to upload.' });
    const text = await extractTextFromPdf(req.file.buffer);
    const detected = detectSignersFromText(text);
    const signerDefs = detected.length
      ? detected
      : signatureRoleDefs.map(({ role, label, defaultName }) => ({ role, label, name: defaultName }));
    const documentId = crypto.randomUUID();
    const createdAt = nowIso();
    const title = String(req.body.title || req.file.originalname).trim().slice(0, 200);
    const preview = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 20).join('\n').slice(0, 5000);
    await dbRun(
      `INSERT INTO documents
       (id, title, original_name, stored_name, owner_user_id, owner_email, file_bytes,
        status, parsed_preview, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [documentId, title, req.file.originalname, `${documentId}.pdf`, req.user.id,
        req.user.email, req.file.buffer, preview, createdAt, createdAt],
    );
    for (const signer of signerDefs) {
      const account = await dbGet('SELECT id, name FROM users WHERE role = ?', [signer.role]);
      await dbRun(
        'INSERT INTO document_signers (document_id, user_id, signer_role, signer_name) VALUES (?, ?, ?, ?)',
        [documentId, account?.id || null, signer.role, account?.name || signer.name || signer.label],
      );
    }
    const signers = await dbAll(
      'SELECT id, user_id, signer_role, signer_name, signed_at, superseded_at FROM document_signers WHERE document_id = ? ORDER BY id',
      [documentId],
    );
    const signerAccounts = await dbAll(
      `SELECT DISTINCT u.email, u.name FROM document_signers ds JOIN users u ON u.id = ds.user_id
       WHERE ds.document_id = ? AND u.email NOT LIKE '%.local'`,
      [documentId],
    );
    const notificationWarnings = [];
    for (const signer of signerAccounts) {
      try {
        const sent = await sendEmail({
          to: signer.email,
          subject: `Signature requested: ${title}`,
          text: `${signer.name},\n\nA Lodge document is ready for your signature. Sign in at ${requestBaseUrl(req)} to review and sign ${title}.`,
        });
        if (!sent) notificationWarnings.push(`The document is saved, but the email notice to ${signer.name} could not be delivered.`);
      } catch (error) {
        console.warn('Signature request email failed:', error.message);
        notificationWarnings.push(`The document is saved, but the email notice to ${signer.name} could not be delivered.`);
      }
    }
    await addAudit({
      userId: req.user.id,
      documentId,
      action: 'document_uploaded',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: {
        title,
        originalName: req.file.originalname,
        detectedRoles: signerDefs.map((item) => item.role),
      },
    });
    broadcast('queue_changed', { reason: 'document_uploaded', documentId });
    res.status(201).json({
      document: {
        id: documentId,
        title,
        original_name: req.file.originalname,
        status: 'pending',
        created_at: createdAt,
        signers,
      },
      notificationWarnings,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/dispensations/parse', requireAuth, requireOwner, rateLimit({ key: 'dispensation-parse', maximum: 60, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  const text = String(req.body?.text || '').trim().slice(0, 8000);
  if (!text) return res.status(400).json({ error: 'Paste the dispensation information first.' });
  try {
    const result = parseDispensationPaste(text);
    const needsAddressHelp = result.fields.locationName
      && (!result.fields.streetAddress || !/\b\d{5}\b/.test(result.fields.cityState));
    if (needsAddressHelp) {
      const suggestions = await searchLocationAddress([result.fields.locationName, result.fields.cityState].filter(Boolean).join(', '));
      const suggestion = suggestions[0];
      if (suggestion) {
        if (!result.fields.streetAddress) result.fields.streetAddress = suggestion.streetAddress;
        if (suggestion.cityState) result.fields.cityState = suggestion.cityState;
        result.warnings.push('The complete address was suggested using OpenStreetMap. Please confirm it before continuing.');
      }
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/locations/search', requireAuth, requireOwner, rateLimit({ key: 'location-search', maximum: 30, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const locationName = String(req.body?.locationName || '').trim().slice(0, 160);
    const cityState = String(req.body?.cityState || '').trim().slice(0, 120);
    if (!locationName) return res.status(400).json({ error: 'Enter the event location name first.' });
    const query = [locationName, cityState].filter(Boolean).join(', ');
    const matches = await searchLocationAddress(query);
    res.json({ matches });
  } catch (error) {
    next(error);
  }
});

app.post('/api/dispensations/preview', requireAuth, requireOwner, rateLimit({ key: 'dispensation-preview', maximum: 40, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const requestDate = String(req.body?.requestDate || '');
    const eventDate = String(req.body?.eventDate || '');
    const requestDetails = String(req.body?.requestDetails || '').trim().slice(0, 600);
    const eventTime = String(req.body?.eventTime || '').trim().slice(0, 40);
    const locationName = String(req.body?.locationName || '').trim().slice(0, 120);
    const streetAddress = String(req.body?.streetAddress || '').trim().slice(0, 120);
    const cityState = String(req.body?.cityState || '').trim().slice(0, 120);
    const worshipfulMasterAddress = String(req.body?.worshipfulMasterAddress || '').trim().slice(0, 160);
    /* The Worshipful Master chooses who it goes to. Most of the time that is both
     * Secretaries, and then the first one to sign completes it. The old single-value
     * signerRole is still accepted so nothing already pointing at it breaks. */
    const requestedRoles = Array.isArray(req.body?.signerRoles) && req.body.signerRoles.length
      ? req.body.signerRoles.map(String)
      : [String(req.body?.signerRole || '')];
    const signerRoles = [...new Set(requestedRoles)]
      .filter((role) => ['secretary', 'assistant_secretary'].includes(role));
    const personalInfoConfirmed = req.body?.personalInfoConfirmed === true;
    if (!dateParts(requestDate) || !dateParts(eventDate) || !requestDetails || !eventTime || !locationName
        || !streetAddress || !cityState || !worshipfulMasterAddress || !personalInfoConfirmed
        || signerRoles.length === 0) {
      return res.status(400).json({ error: 'Complete the remaining Lodge questions before reviewing the PDF.' });
    }
    const savedSignature = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    const ownerSignature = asBuffer(savedSignature?.signature_bytes);
    if (!ownerSignature?.length) {
      return res.status(409).json({ error: 'Save your Worshipful Master signature before reviewing the PDF.' });
    }
    const pdfBytes = await createDispensationPdf({
      fields: { requestDate, eventDate, requestDetails, eventTime, locationName, streetAddress, cityState, worshipfulMasterAddress },
      ownerName: req.user.name,
      ownerSignature,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="dispensation-preview.pdf"');
    return res.send(pdfBytes);
  } catch (error) {
    return next(error);
  }
});

/* The one place a dispensation document is created.
 *
 * Both the Worshipful Master's own builder and the Warden proposal approval path call this.
 * Two copies of this logic would drift, and the drift would be silent until a dispensation
 * came out wrong on somebody's date.
 *
 * Every dispensation now goes to BOTH Secretaries in either/or mode by William's decision of
 * 2026-08-25: "I don't want to pick which secretary, I wanted to go to both, and whoever signs
 * it first is whoever signs it." The signer picker is gone from both clients. */
const BOTH_SECRETARIES = ['secretary', 'assistant_secretary'];

const createDispensationDocument = async ({ fields, ownerUser, baseUrl, ip, userAgent, auditAction }) => {
  const {
    requestDate, eventDate, requestDetails, eventTime, locationName,
    streetAddress, cityState, worshipfulMasterAddress, title,
  } = fields;
  if (!dateParts(requestDate) || !dateParts(eventDate) || !requestDetails || !eventTime
      || !locationName || !streetAddress || !cityState || !worshipfulMasterAddress) {
    throw httpError(400, 'Complete the remaining Lodge questions before sending the PDF.');
  }
  const savedSignature = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [ownerUser.id]);
  const ownerSignature = asBuffer(savedSignature?.signature_bytes);
  if (!ownerSignature?.length) {
    throw httpError(409, 'Save your Worshipful Master signature before creating a dispensation.');
  }
  const pdfBytes = await createDispensationPdf({
    fields: {
      requestDate, eventDate, requestDetails, eventTime, locationName, streetAddress,
      cityState, worshipfulMasterAddress,
    },
    ownerName: ownerUser.name,
    ownerSignature,
  });
  const documentId = crypto.randomUUID();
  const createdAt = nowIso();
  const documentTitle = title || `Dispensation - ${requestDetails.slice(0, 90)}`;
  const fileName = `${documentTitle.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'dispensation'}.pdf`;
  await dbRun(
    `INSERT INTO documents
     (id, title, original_name, stored_name, owner_user_id, owner_email, file_bytes,
      signed_bytes, status, parsed_preview, created_at, updated_at, template_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partially_signed', ?, ?, ?, 'dispensation_v1')`,
    [documentId, documentTitle, fileName, `${documentId}.pdf`, ownerUser.id, ownerUser.email,
      pdfBytes, pdfBytes, requestDetails, createdAt, createdAt],
  );
  await dbRun(
    `INSERT INTO document_signers
     (document_id, user_id, signer_role, signer_name, signed_at, signature_bytes, consent_text)
     VALUES (?, ?, 'worshipful_master', ?, ?, ?, ?)`,
    [documentId, ownerUser.id, ownerUser.name, createdAt, ownerSignature,
      'Saved Worshipful Master signature applied when the official template was created.'],
  );
  await dbRun('UPDATE documents SET signing_mode = ? WHERE id = ?', ['any', documentId]);
  const signerNames = [];
  const notificationWarnings = [];
  for (const role of BOTH_SECRETARIES) {
    const officer = await dbGet('SELECT id, name, email FROM users WHERE role = ?', [role]);
    const officerName = officer?.name
      || (role === 'secretary' ? 'William McDuffie' : 'Adrian Reese');
    signerNames.push(officerName);
    await dbRun(
      'INSERT INTO document_signers (document_id, user_id, signer_role, signer_name) VALUES (?, ?, ?, ?)',
      [documentId, officer?.id || null, role, officerName],
    );
    if (officer?.email && !officer.email.endsWith('.local')) {
      try {
        const sent = await sendEmail({
          to: officer.email,
          subject: `Signature requested: ${documentTitle}`,
          text: `${officerName},\n\nA dispensation is ready for your signature. Either Secretary may sign this one; whoever signs first completes it. Sign in at ${baseUrl} to review and sign ${documentTitle}.`,
        });
        if (!sent) notificationWarnings.push(`The dispensation is saved, but the email notice to ${officerName} could not be delivered.`);
      } catch (error) {
        console.warn('Signature request email failed:', error.message);
        notificationWarnings.push(`The dispensation is saved, but the email notice to ${officerName} could not be delivered.`);
      }
    } else notificationWarnings.push(`The dispensation is saved, but ${officerName} does not have a deliverable account email for the signature notice.`);
  }
  await addAudit({
    userId: ownerUser.id,
    documentId,
    action: auditAction || 'dispensation_created_from_template',
    ip,
    userAgent,
    details: {
      signerRoles: BOTH_SECRETARIES, signingMode: 'any', signerNames,
      requestDate, eventDate, template: 'official-grand-lodge',
    },
  });
  broadcast('queue_changed', { reason: 'dispensation_created', documentId });
  return { documentId, documentTitle, notificationWarnings };
};

app.post('/api/dispensations', requireAuth, requireOwner, rateLimit({ key: 'dispensation-create', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const personalInfoConfirmed = req.body?.personalInfoConfirmed === true;
    if (!personalInfoConfirmed) {
      return res.status(400).json({ error: 'Complete the remaining Lodge questions before sending the PDF.' });
    }
    /* signerRoles is still accepted from an older cached page and deliberately ignored.
     * Every dispensation goes to both Secretaries now. */
    const { documentId, notificationWarnings } = await createDispensationDocument({
      fields: {
        requestDate: String(req.body?.requestDate || ''),
        eventDate: String(req.body?.eventDate || ''),
        requestDetails: String(req.body?.requestDetails || '').trim().slice(0, 600),
        eventTime: String(req.body?.eventTime || '').trim().slice(0, 40),
        locationName: String(req.body?.locationName || '').trim().slice(0, 120),
        streetAddress: String(req.body?.streetAddress || '').trim().slice(0, 120),
        cityState: String(req.body?.cityState || '').trim().slice(0, 120),
        worshipfulMasterAddress: String(req.body?.worshipfulMasterAddress || '').trim().slice(0, 160),
        title: String(req.body?.title || '').trim().slice(0, 200),
      },
      ownerUser: req.user,
      baseUrl: requestBaseUrl(req),
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.status(201).json({ document: { id: documentId }, notificationWarnings });
  } catch (error) {
    next(error);
  }
});

/* ---------------------------------------------------------------------------
 * Warden dispensation proposals.
 *
 * Xavier White (Senior Warden) and Jamal Sadler (Junior Warden) propose. The Worshipful
 * Master decides. A Warden never signs, never opens a Lodge document, and never reaches
 * the queue or the approvals record.
 * ------------------------------------------------------------------------- */

const PROPOSAL_FIELDS = ['requestDate', 'eventDate', 'requestDetails', 'eventTime',
  'locationName', 'streetAddress', 'cityState', 'title'];
const PROPOSAL_LIMITS = { requestDetails: 600, eventTime: 40, locationName: 120,
  streetAddress: 120, cityState: 120, title: 200, requestDate: 40, eventDate: 40 };

const readProposalFields = (body = {}) => {
  const out = {};
  for (const f of PROPOSAL_FIELDS) out[f] = String(body[f] || '').trim().slice(0, PROPOSAL_LIMITS[f] || 200);
  return out;
};

const proposalForResponse = (row) => ({
  id: row.id,
  proposerName: row.proposer_name,
  proposerUserId: row.proposer_user_id,
  status: row.status,
  requestDate: row.request_date,
  eventDate: row.event_date,
  requestDetails: row.request_details,
  eventTime: row.event_time,
  locationName: row.location_name,
  streetAddress: row.street_address,
  cityState: row.city_state,
  title: row.title,
  proposerNote: row.proposer_note,
  wmNote: row.wm_note,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  resultingDocumentId: row.resulting_document_id,
  /* A Warden sees the progress of the document his proposal became, and nothing else about
   * it. Scalars only, joined here so no document route has to admit him. */
  document: row.doc_id ? {
    status: row.doc_status,
    completedAt: row.doc_completed_at,
    submittedAt: row.doc_submitted_at,
    submittedTo: row.doc_submitted_to,
    approvalStatus: row.doc_approval_status,
    approvedOn: row.doc_approved_on,
  } : null,
});

const PROPOSAL_SELECT = `
  SELECT p.*, d.id AS doc_id, d.status AS doc_status, d.completed_at AS doc_completed_at,
         d.submitted_at AS doc_submitted_at, d.submitted_to AS doc_submitted_to,
         d.approval_status AS doc_approval_status, d.approved_on AS doc_approved_on
    FROM dispensation_proposals p
    LEFT JOIN documents d ON d.id = p.resulting_document_id`;

app.get('/api/proposals', requireAuth, requireOwnerOrWarden, async (req, res, next) => {
  try {
    const rows = await dbAll(`${PROPOSAL_SELECT} WHERE ? = 'owner' OR p.proposer_user_id = ? ORDER BY p.created_at DESC`, [req.user.role, req.user.id]);
    res.json({ proposals: rows.map(proposalForResponse) });
  } catch (error) { next(error); }
});

app.post('/api/proposals', requireAuth, requireWarden, rateLimit({ key: 'proposal-create', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const f = readProposalFields(req.body);
    if (!f.requestDate) f.requestDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const note = String(req.body?.proposerNote || '').trim().slice(0, 2000);
    if (!f.requestDetails || !f.eventDate) {
      return res.status(400).json({ error: 'Tell the Master what the event is and when it is.' });
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await dbRun(
      `INSERT INTO dispensation_proposals
       (id, proposer_user_id, proposer_name, status, request_date, event_date, request_details,
        event_time, location_name, street_address, city_state, title, proposer_note,
        created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, req.user.name, f.requestDate, f.eventDate, f.requestDetails, f.eventTime,
        f.locationName, f.streetAddress, f.cityState, f.title, note, now, now],
    );
    await addAudit({ userId: req.user.id, action: 'proposal_created', ip: req.ip,
      userAgent: req.get('user-agent') || '', details: { proposalId: id, eventDate: f.eventDate } });
    const notificationWarnings = [];
    if (OWNER_EMAIL) {
      try {
        const sent = await sendEmail({
          to: OWNER_EMAIL,
          subject: `Dispensation proposed by ${req.user.name}`,
          text: `${req.user.name} has proposed a dispensation for ${f.eventDate}.\n\n${f.requestDetails}\n\nHis note:\n${note || '(none)'}\n\nReview it at ${requestBaseUrl(req)}`,
        });
        if (!sent) notificationWarnings.push('The proposal is saved, but the Worshipful Master email notice could not be delivered.');
      } catch (error) {
        console.warn('Proposal notice email failed:', error.message);
        notificationWarnings.push('The proposal is saved, but the Worshipful Master email notice could not be delivered.');
      }
    } else notificationWarnings.push('The proposal is saved, but the Worshipful Master email notice is not configured.');
    broadcast('proposals_changed', { reason: 'proposal_created', proposalId: id });
    res.status(201).json({ proposal: { id }, notificationWarnings });
  } catch (error) { next(error); }
});

app.put('/api/proposals/:id', requireAuth, requireWarden, async (req, res, next) => {
  try {
    const row = await dbGet('SELECT * FROM dispensation_proposals WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Proposal not found.' });
    if (row.proposer_user_id !== req.user.id && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'You can only change a proposal you made.' });
    }
    if (row.status !== 'changes_requested') {
      return res.status(409).json({ error: 'Only a proposal the Master sent back can be changed.' });
    }
    const f = readProposalFields(req.body);
    const note = String(req.body?.proposerNote || '').trim().slice(0, 2000);
    /* Same floor the create path holds, so a resubmit cannot empty a proposal. */
    if (!f.requestDetails || !f.eventDate) {
      return res.status(400).json({ error: 'Tell the Master what the event is and when it is.' });
    }
    await dbRun(
      `UPDATE dispensation_proposals
          SET request_date=?, event_date=?, request_details=?, event_time=?, location_name=?,
              street_address=?, city_state=?, title=?, proposer_note=?, status='pending', updated_at=?
        WHERE id = ?`,
      [f.requestDate, f.eventDate, f.requestDetails, f.eventTime, f.locationName,
        f.streetAddress, f.cityState, f.title, note, nowIso(), req.params.id],
    );
    await addAudit({ userId: req.user.id, action: 'proposal_resubmitted', ip: req.ip,
      userAgent: req.get('user-agent') || '', details: { proposalId: req.params.id } });
    const notificationWarnings = [];
    if (OWNER_EMAIL) {
      try {
        const sent = await sendEmail({
          to: OWNER_EMAIL,
          subject: `Dispensation proposal revised by ${req.user.name}`,
          text: `${req.user.name} revised the dispensation proposal for ${f.eventDate}.\n\n${f.requestDetails}\n\nReview it at ${requestBaseUrl(req)}`,
        });
        if (!sent) notificationWarnings.push('The revised proposal is saved, but the Worshipful Master email notice could not be delivered.');
      } catch (error) {
        console.warn('Proposal revision notice email failed:', error.message);
        notificationWarnings.push('The revised proposal is saved, but the Worshipful Master email notice could not be delivered.');
      }
    } else notificationWarnings.push('The revised proposal is saved, but the Worshipful Master email notice is not configured.');
    broadcast('proposals_changed', { reason: 'proposal_resubmitted', proposalId: req.params.id });
    res.json({ ok: true, notificationWarnings });
  } catch (error) { next(error); }
});

app.post('/api/proposals/:id/preview', requireAuth, requireOwnerOrWarden, rateLimit({ key: 'proposal-preview', maximum: 40, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const f = readProposalFields(req.body);
    /* The template writes the date into split boxes, so a blank or malformed one throws deep
     * inside the PDF builder. Say what is missing instead of returning a 500. */
    if (!dateParts(f.eventDate)) {
      return res.status(400).json({ error: 'Put the date of the event in before previewing it.' });
    }
    if (!dateParts(f.requestDate)) f.requestDate = new Date().toISOString().slice(0, 10);
    const owner = await dbGet("SELECT id, name FROM users WHERE role = 'owner' LIMIT 1");
    const pdfBytes = await createDispensationPdf({
      fields: {
        ...f,
        worshipfulMasterAddress: String(req.body?.worshipfulMasterAddress || '208 East Lake Street, Middletown, DE 19709'),
      },
      ownerName: owner?.name || 'W. Aaron Dixon-Saunders',
      ownerSignature: null,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="dispensation-preview.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (error) { next(error); }
});

app.post('/api/proposals/:id/decision', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '');
    if (!['approve', 'decline', 'changes'].includes(decision)) {
      return res.status(400).json({ error: 'Choose approve, decline, or request changes.' });
    }
    const wmNote = String(req.body?.wmNote || '').trim().slice(0, 2000);

    /* Claimed inside a transaction with FOR UPDATE so a double-clicked Approve cannot
     * create two dispensations and email both Secretaries twice. */
    const claimed = await withTransaction(async () => {
      const row = await dbGet('SELECT * FROM dispensation_proposals WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!row) throw httpError(404, 'Proposal not found.');
      /* 'approving' means a previous attempt died between claiming the row and creating the
       * document. Nothing was created, or the id would have been stamped, so let it be retried
       * rather than leaving it stuck forever. */
      const retryable = row.status === 'approving' && !row.resulting_document_id;
      if (!['pending', 'changes_requested'].includes(row.status) && !retryable) {
        throw httpError(409, 'That proposal has already been decided.');
      }
      const nextStatus = decision === 'approve' ? 'approving'
        : decision === 'decline' ? 'declined' : 'changes_requested';
      await dbRun('UPDATE dispensation_proposals SET status = ?, wm_note = ?, updated_at = ? WHERE id = ?',
        [nextStatus, wmNote, nowIso(), req.params.id]);
      return row;
    });

    const proposer = await dbGet('SELECT email, name FROM users WHERE id = ?', [claimed.proposer_user_id]);
    const notify = async (subject, text) => {
      const warnings = [];
      if (proposer?.email && !proposer.email.endsWith('.local')) {
        try {
          const sent = await sendEmail({ to: proposer.email, subject, text });
          if (!sent) warnings.push(`The decision is saved, but the email notice to ${proposer.name || 'the proposer'} could not be delivered.`);
        } catch (error) {
          console.warn('Proposal decision email failed:', error.message);
          warnings.push(`The decision is saved, but the email notice to ${proposer.name || 'the proposer'} could not be delivered.`);
        }
      } else warnings.push('The decision is saved, but the proposer does not have a deliverable email address.');
      return warnings;
    };

    if (decision !== 'approve') {
      const action = decision === 'decline' ? 'proposal_declined' : 'proposal_changes_requested';
      await addAudit({ userId: req.user.id, action, ip: req.ip,
        userAgent: req.get('user-agent') || '', details: { proposalId: req.params.id } });
      const notificationWarnings = await notify(
        decision === 'decline' ? 'Your dispensation proposal was not approved' : 'The Worshipful Master sent your proposal back',
        `${proposer?.name || 'Brother'},\n\n${decision === 'decline'
          ? 'The Worshipful Master has not approved the dispensation you proposed.'
          : 'The Worshipful Master has asked for changes to the dispensation you proposed. Sign in and update it.'}\n\n${wmNote ? `His note:\n${wmNote}\n\n` : ''}${requestBaseUrl(req)}`,
      );
      broadcast('proposals_changed', { reason: action, proposalId: req.params.id });
      return res.json({ ok: true, status: decision === 'decline' ? 'declined' : 'changes_requested', notificationWarnings });
    }

    /* Approve. The Master's edits win over whatever the Warden typed. */
    const edited = readProposalFields({
      requestDate: req.body?.requestDate ?? claimed.request_date,
      eventDate: req.body?.eventDate ?? claimed.event_date,
      requestDetails: req.body?.requestDetails ?? claimed.request_details,
      eventTime: req.body?.eventTime ?? claimed.event_time,
      locationName: req.body?.locationName ?? claimed.location_name,
      streetAddress: req.body?.streetAddress ?? claimed.street_address,
      cityState: req.body?.cityState ?? claimed.city_state,
      title: req.body?.title ?? claimed.title,
    });
    /* The Master's own address on the instrument. Neither client sends it on a decision and
     * they should not have to: it is his, not the Warden's. Read it from the stored submission
     * profile the way his own builder does, and fall back to the Lodge address so an empty
     * profile table can never make Approve a dead button. */
    const wmProfile = await dbGet("SELECT address FROM submission_profiles WHERE role = 'worshipful_master'");
    const masterAddress = String(
      req.body?.worshipfulMasterAddress || wmProfile?.address || '208 East Lake Street, Middletown, DE 19709',
    ).trim().slice(0, 160);
    let createdDocumentId = null;
    try {
      const { documentId, notificationWarnings: secretaryWarnings } = await createDispensationDocument({
        fields: { ...edited, worshipfulMasterAddress: masterAddress },
        ownerUser: req.user,
        baseUrl: requestBaseUrl(req),
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        auditAction: 'dispensation_created_from_proposal',
      });
      createdDocumentId = documentId;
      await dbRun(
        `UPDATE dispensation_proposals
            SET status='approved', decided_at=?, decided_by=?, resulting_document_id=?, updated_at=?
          WHERE id = ?`,
        [nowIso(), req.user.id, documentId, nowIso(), req.params.id],
      );
      await addAudit({ userId: req.user.id, documentId, action: 'proposal_approved', ip: req.ip,
        userAgent: req.get('user-agent') || '', details: { proposalId: req.params.id } });
      const proposerWarnings = await notify('Your dispensation proposal was approved',
        `${proposer?.name || 'Brother'},\n\nThe Worshipful Master approved the dispensation you proposed. It has gone to the Secretaries for signature and will follow the usual course from there.\n\n${wmNote ? `His note:\n${wmNote}\n\n` : ''}You can follow its progress at ${requestBaseUrl(req)}`);
      broadcast('proposals_changed', { reason: 'proposal_approved', proposalId: req.params.id });
      res.json({ ok: true, status: 'approved', documentId,
        notificationWarnings: [...secretaryWarnings, ...proposerWarnings] });
    } catch (error) {
      /* Hand the proposal back rather than stranding it, but ONLY if nothing was created.
       * If the dispensation exists and something later failed, returning it to pending would
       * let a retry build a second one. */
      if (!createdDocumentId) {
        await dbRun("UPDATE dispensation_proposals SET status='pending', updated_at=? WHERE id = ?",
          [nowIso(), req.params.id]);
      }
      throw error;
    }
  } catch (error) { next(error); }
});

app.post('/api/documents/:id/sign', requireAuth, requireDocumentAccess, rateLimit({ key: 'sign', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'Confirm the electronic signature consent before signing.' });
    }
    const savedSignature = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    const signatureBytes = asBuffer(savedSignature?.signature_bytes);
    if (!signatureBytes?.length) {
      return res.status(409).json({ error: 'Create your saved signature before signing a document.' });
    }
    const outcome = await withTransaction(async () => {
      const document = await dbGet('SELECT * FROM documents WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!document) throw httpError(404, 'Document not found.');
      if (document.status === 'rescinded') {
        throw httpError(409, 'This document was rescinded and cannot be signed.');
      }
      const signer = await dbGet(
        `SELECT * FROM document_signers WHERE document_id = ? AND signed_at IS NULL
         AND superseded_at IS NULL
         AND (user_id = ? OR (user_id IS NULL AND signer_role = ?)) ORDER BY id LIMIT 1 FOR UPDATE`,
        [document.id, req.user.id, req.user.role],
      );
      if (!signer) throw httpError(409, 'No pending signature is assigned to this account.');
      const count = await dbGet(
        'SELECT COUNT(*) AS total FROM document_signers WHERE document_id = ? AND signed_at IS NOT NULL',
        [document.id],
      );
      const current = asBuffer(document.signed_bytes) || asBuffer(document.file_bytes);
      if (!current?.length) throw httpError(409, 'Document file is missing.');
      let prepared = current;
      let officerAddress = '';
      let signerName = req.user.name;
      if (document.template_kind === 'dispensation_v1') {
        const profile = await dbGet('SELECT name, address FROM submission_profiles WHERE role = ?', [req.user.role]);
        officerAddress = String(profile?.address || '').trim();
        signerName = String(profile?.name || '').trim();
        if (!signerName || !officerAddress || officerAddress.toLowerCase() === signerName.toLowerCase()) {
          throw httpError(409, 'Ask the Worshipful Master to save your name and mailing address before signing.');
        }
        prepared = await fillDispensationOfficerInformation({
          pdfBytes: current,
          officerName: signerName,
          officerAddress,
        });
      }
      const stamped = await appendSignatureToPdf({
        pdfBytes: prepared,
        signatureBytes,
        signerName,
        order: Number(count.total) + 1,
        placement: document.template_kind === 'dispensation_v1' ? 'dispensation-secretary' : 'general',
      });
      const signedAt = nowIso();
      const consentText = 'I agree that this electronic signature represents my signature on this document.';
      const captured = await dbRun(
        `UPDATE document_signers SET user_id = ?, signer_name = ?, signed_at = ?, signature_bytes = ?,
         signed_ip = ?, signed_user_agent = ?, consent_text = ? WHERE id = ? AND signed_at IS NULL`,
        [req.user.id, signerName, signedAt, signatureBytes, req.ip,
          String(req.get('user-agent') || '').slice(0, 500), consentText, signer.id],
      );
      if (captured.changes !== 1) throw httpError(409, 'This signature was already captured.');
      await dbRun('UPDATE documents SET signed_bytes = ?, updated_at = ? WHERE id = ?', [stamped, signedAt, document.id]);
      let remaining = await dbGet(
        `SELECT COUNT(*) AS total FROM document_signers
         WHERE document_id = ? AND signed_at IS NULL AND superseded_at IS NULL`,
        [document.id],
      );
      /* On an 'any' document the first signature is the whole requirement. The other
       * officer's row is marked superseded rather than deleted: the record should still
       * show who it was offered to, and his queue must stop asking him for it. */
      if (document.signing_mode === 'any' && remaining.total > 0) {
        await dbRun(
          `UPDATE document_signers SET superseded_at = ?
           WHERE document_id = ? AND signed_at IS NULL AND superseded_at IS NULL`,
          [signedAt, document.id],
        );
        remaining = { total: 0 };
      }
      const status = remaining.total === 0 ? 'completed' : 'partially_signed';
      await dbRun('UPDATE documents SET status = ?, completed_at = ? WHERE id = ?', [
        status,
        status === 'completed' ? signedAt : null,
        document.id,
      ]);
      await addAudit({
        userId: req.user.id,
        documentId: document.id,
        action: 'document_signed',
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        details: { role: req.user.role, signedAt, savedSignature: true, officerInformationCompleted: Boolean(officerAddress) },
      });
      if (status === 'completed') {
        await addAudit({ userId: req.user.id, documentId: document.id, action: 'document_completed' });
      }
      return { documentId: document.id, status, remaining: remaining.total };
    });
    const { documentId, status, remaining } = outcome;
    let submission = null;
    if (status === 'completed') {
      const completedDocument = await dbGet('SELECT * FROM documents WHERE id = ?', [documentId]);
      const completeSigners = await dbAll(
        `SELECT ds.signer_name, u.email FROM document_signers ds
         LEFT JOIN users u ON u.id = ds.user_id WHERE ds.document_id = ?`,
        [documentId],
      );
      await sendCompletionNotice(completedDocument, completeSigners, asBuffer(completedDocument.signed_bytes));
      /* A dispensation is not finished when it is signed, it is finished when the District
       * Deputy has it. Only dispensations go, and only once. */
      if (completedDocument.template_kind === 'dispensation_v1' && !completedDocument.submitted_at) {
        submission = await submitToDistrictDeputy(completedDocument, {
          actorUserId: req.user.id,
          baseUrl: requestBaseUrl(req),
          ip: req.ip,
          userAgent: req.get('user-agent') || '',
        });
      }
    }
    broadcast('queue_changed', { reason: 'document_signed', documentId, status });
    const submissionNote = submission
      ? (submission.sent
        ? ` It has been emailed to ${submission.name} for review.`
        : ` It could NOT be emailed to the District Deputy: ${submission.reason}`)
      : '';
    res.json({
      message: status === 'completed'
        ? `Document completed. Record copies are being delivered.${submissionNote}`
        : 'Signature captured.',
      status,
      submitted: submission ? submission.sent : null,
      submissionError: submission && !submission.sent ? submission.reason : null,
      nextStep: remaining === 0 ? 'No signatures remain.' : `${remaining} signature remains.`,
    });
  } catch (error) {
    next(error);
  }
});

/* The draft the Master opens in his own mail client.
 *
 * Worth having even once the server can send for itself: mail from his own mailbox reaches the
 * Deputy from the address he already corresponds with, the reply comes back to him rather than to
 * a server mailbox nobody watches, and it lands in his Sent folder as the Lodge's own record.
 *
 * No attachment field exists in mailto, that is the URL scheme and not a client limitation, so the
 * clients download the executed PDF alongside opening the draft. */
app.get('/api/documents/:id/submission-draft', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (document.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the document owner can draft this submission.' });
    }
    if (document.template_kind !== 'dispensation_v1') {
      return res.status(409).json({ error: 'Only dispensations go to the District Deputy.' });
    }
    const draft = districtDeputyMessage(document);
    if (!draft.to) return res.status(409).json({ error: 'No District Deputy email is configured.' });
    return res.json({ draft: { ...draft, alreadySent: document.submitted_at || null } });
  } catch (error) {
    return next(error);
  }
});

const APPROVAL_STATUSES = new Set(['approved', 'disapproved', 'withdrawn', 'pending']);
/* Text message is here because it is what this District actually does. Both of Cooke's
 * endorsements and Jones's approval of the Back to School request all arrived by text, which is
 * precisely why none of them were ever filed anywhere. */
const APPROVAL_SOURCES = new Set(['endorsed_pdf', 'email', 'text_message', 'verbal']);

/* Records what the District Deputy decided.
 *
 * Kept separate from the document's signing status on purpose. A dispensation can be fully
 * executed by the Lodge and still not be granted, and both of the Lodge's approvals so far were
 * given by email over an instrument whose approval block was left completely blank. Recording
 * how the decision arrived is therefore part of the record, not a detail. */
app.put('/api/documents/:id/approval', requireAuth, requireOwner, upload.single('endorsed'), async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (document.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the document owner can record an approval.' });
    }
    if (document.template_kind !== 'dispensation_v1') {
      return res.status(409).json({ error: 'Only dispensations carry a District Deputy approval.' });
    }
    const status = String(req.body?.status || '').trim();
    const approvedBy = String(req.body?.approvedBy || '').trim().slice(0, 120);
    const approvedOn = String(req.body?.approvedOn || '').trim();
    const source = String(req.body?.source || '').trim();
    const note = String(req.body?.note || '').trim().slice(0, 600);
    if (!APPROVAL_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Choose approved, disapproved, withdrawn, or pending.' });
    }
    if (status !== 'pending') {
      if (!approvedBy) return res.status(400).json({ error: 'Name the District Deputy who decided it.' });
      /* The date is optional on purpose. The Lodge genuinely does not know when the Fish Fry
       * dispensation was granted; the register records only that it was. Forcing a date here
       * would invite somebody to invent one, which is worse than an honest gap. */
      if (approvedOn && !dateParts(approvedOn)) {
        return res.status(400).json({ error: 'That approval date is not a real date.' });
      }
      if (!APPROVAL_SOURCES.has(source)) {
        return res.status(400).json({ error: 'Say how it was given: an endorsed PDF, an email, a text message, or verbally.' });
      }
      if (source === 'endorsed_pdf' && !req.file && !document.approved_bytes) {
        return res.status(400).json({ error: 'Attach the endorsed copy, or record it as email or verbal instead.' });
      }
    }
    const recordedAt = nowIso();
    await dbRun(
      `UPDATE documents SET approval_status = ?, approved_by = ?, approved_on = ?,
       approval_source = ?, approval_note = ?, approval_recorded_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, status === 'pending' ? null : approvedBy, status === 'pending' ? null : approvedOn,
        status === 'pending' ? null : source, note || null, recordedAt, recordedAt, document.id],
    );
    if (req.file) {
      await dbRun('UPDATE documents SET approved_bytes = ? WHERE id = ?', [req.file.buffer, document.id]);
    }
    await addAudit({
      userId: req.user.id,
      documentId: document.id,
      action: 'dispensation_approval_recorded',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: { status, approvedBy, approvedOn, source, endorsedCopyAttached: Boolean(req.file) },
    });
    broadcast('queue_changed', { reason: 'approval_recorded', documentId: document.id });
    return res.json({ message: 'Approval recorded.' });
  } catch (error) {
    return next(error);
  }
});

/* The endorsed copy the District Deputy returned, when there is one. */
app.get('/api/documents/:id/endorsed', requireAuth, requireDocumentAccess, async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    /* Its four sibling routes check this and this one never did, so anybody who could guess
     * a document id could pull the executed copy. */
    if (!(await participantForDocument(document, req.user))) {
      return res.status(403).json({ error: 'You are not a participant on this document.' });
    }
    const bytes = asBuffer(document.approved_bytes);
    if (!bytes?.length) return res.status(404).json({ error: 'No endorsed copy has been filed for this one.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="endorsed-${document.id}.pdf"`);
    return res.send(bytes);
  } catch (error) {
    return next(error);
  }
});

/* Every dispensation the District Deputy has ruled on, newest first. */
app.get('/api/approvals', requireAuth, (req, res, next) => {
  /* This route returns every dispensation the Lodge has ever filed. It carried requireAuth
   * only, so any authenticated account saw the lot. Wardens are deliberately excluded. */
  if (!APPROVAL_QUEUE_ROLES.has(req.user.role) || !hasPermission(req.user, 'documents.status')) {
    return res.status(403).json({ error: 'The approvals record is for the Master and the Secretaries.' });
  }
  next();
}, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT id, title, original_name, created_at, approval_status, approved_by, approved_on,
              approval_source, approval_note, approval_recorded_at,
              (approved_bytes IS NOT NULL) AS has_endorsed_copy
       FROM documents
       WHERE template_kind = 'dispensation_v1' AND approval_status IS NOT NULL
         AND approval_status <> 'pending'
       ORDER BY approved_on DESC, approval_recorded_at DESC`,
    );
    const approvals = rows.map((row) => ({
      ...row,
      /* A viewer sees that the Lodge was granted its request, not the Master's own paperwork. */
      approval_note: APPROVAL_NOTE_ROLES.has(req.user.role) ? row.approval_note : null,
    }));
    return res.json({ approvals });
  } catch (error) {
    return next(error);
  }
});

/* Sends, or re-sends, a completed dispensation to the District Deputy by hand. Needed for
 * anything that was signed before this existed, and for the day the mail server has a bad hour. */
app.post('/api/documents/:id/submit', requireAuth, requireOwner, rateLimit({ key: 'submit-ddgm', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (document.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the document owner can submit this document.' });
    }
    if (document.status === 'rescinded') return res.status(409).json({ error: 'This document was rescinded.' });
    if (document.status !== 'completed') {
      return res.status(409).json({ error: 'Every signature has to be on it before it goes to the District Deputy.' });
    }
    const force = req.body?.resend === true;
    if (document.submitted_at && !force) {
      return res.status(409).json({
        error: `This was already sent to the District Deputy on ${document.submitted_at}. Send it again only if you mean to.`,
      });
    }
    const result = await submitToDistrictDeputy(document, {
      actorUserId: req.user.id,
      baseUrl: requestBaseUrl(req),
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    broadcast('queue_changed', { reason: 'document_submitted', documentId: document.id });
    if (!result.sent) return res.status(502).json({ error: result.reason });
    return res.json({ message: `Sent to ${result.name} for review, with the signed PDF attached.` });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/documents/:id/rescind', requireAuth, requireOwner, rateLimit({ key: 'rescind', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const result = await withTransaction(async () => {
      const document = await dbGet('SELECT * FROM documents WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!document) throw httpError(404, 'Document not found.');
      if (document.owner_user_id !== req.user.id) throw httpError(403, 'Only the document owner can rescind this document.');
      if (document.status === 'rescinded') throw httpError(409, 'This document has already been rescinded.');
      const rescindedAt = nowIso();
      await dbRun('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', ['rescinded', rescindedAt, document.id]);
      await addAudit({
        userId: req.user.id,
        documentId: document.id,
        action: 'document_rescinded',
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        details: { reason, previousStatus: document.status, rescindedAt },
      });
      return { documentId: document.id, previousStatus: document.status, rescindedAt };
    });
    broadcast('queue_changed', { reason: 'document_rescinded', documentId: result.documentId, status: 'rescinded' });
    res.json({ message: 'Document rescinded. Its signed history and audit record were preserved.', status: 'rescinded', ...result });
  } catch (error) {
    next(error);
  }
});

/* Opens a document already waiting on one Secretary to the other one as well.
 * The Master needs this for anything sent before he could choose, and for the case
 * where the man it went to is away and the Lodge needs it signed today. */
app.post('/api/documents/:id/offer-to-both', requireAuth, requireOwner, rateLimit({ key: 'offer-to-both', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const result = await withTransaction(async () => {
      const document = await dbGet('SELECT * FROM documents WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!document) throw httpError(404, 'Document not found.');
      if (document.owner_user_id !== req.user.id) throw httpError(403, 'Only the document owner can change who may sign this document.');
      if (document.status === 'rescinded') throw httpError(409, 'This document was rescinded.');
      if (document.status === 'completed') throw httpError(409, 'This document is already signed.');
      const existing = await dbAll(
        'SELECT signer_role FROM document_signers WHERE document_id = ?', [document.id],
      );
      const held = new Set(existing.map((row) => row.signer_role));
      const missing = ['secretary', 'assistant_secretary'].filter((role) => !held.has(role));
      if (!held.has('secretary') && !held.has('assistant_secretary')) {
        throw httpError(409, 'This document does not ask the secretary\'s office for a signature.');
      }
      if (!missing.length) throw httpError(409, 'Both Secretaries can already sign this document.');
      const added = [];
      for (const role of missing) {
        const officer = await dbGet('SELECT id, name, email FROM users WHERE role = ?', [role]);
        const officerName = officer?.name || (role === 'secretary' ? 'William McDuffie' : 'Adrian Reese');
        await dbRun(
          'INSERT INTO document_signers (document_id, user_id, signer_role, signer_name) VALUES (?, ?, ?, ?)',
          [document.id, officer?.id || null, role, officerName],
        );
        added.push({ role, name: officerName, email: officer?.email || '' });
      }
      await dbRun('UPDATE documents SET signing_mode = ?, updated_at = ? WHERE id = ?',
        ['any', nowIso(), document.id]);
      await addAudit({
        userId: req.user.id,
        documentId: document.id,
        action: 'document_opened_to_both_secretaries',
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        details: { added: added.map((entry) => entry.role) },
      });
      return { documentId: document.id, title: document.title, added };
    });
    const notificationWarnings = [];
    for (const officer of result.added) {
      if (officer.email && !officer.email.endsWith('.local')) {
        try {
          const sent = await sendEmail({
            to: officer.email,
            subject: `Signature requested: ${result.title}`,
            text: `${officer.name},\n\nA dispensation is ready for your signature. Either Secretary may sign this one; whoever signs first completes it. Sign in at ${requestBaseUrl(req)} to review and sign ${result.title}.`,
          });
          if (!sent) notificationWarnings.push(`The signing assignment is saved, but the email notice to ${officer.name} could not be delivered.`);
        } catch (error) {
          console.warn('Signature request email failed:', error.message);
          notificationWarnings.push(`The signing assignment is saved, but the email notice to ${officer.name} could not be delivered.`);
        }
      } else notificationWarnings.push(`The signing assignment is saved, but ${officer.name} does not have a deliverable email address.`);
    }
    broadcast('queue_changed', { reason: 'document_opened_to_both', documentId: result.documentId });
    res.json({
      message: 'Either Secretary can now sign this document. Whoever signs first completes it.',
      added: result.added.map((officer) => officer.name),
      notificationWarnings,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/audit', requireAuth, requireDocumentAccess, async (req, res, next) => {
  try {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (!(await participantForDocument(document, req.user))) {
      return res.status(403).json({ error: 'You do not have access to this record.' });
    }
    const events = await dbAll(
      `SELECT a.action, a.created_at, u.name AS actor_name
       FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.document_id = ? ORDER BY a.created_at`,
      [document.id],
    );
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(APP_DIR, 'public', 'index.html')));

mountActivityRoutes(app, { requireAuth, requireOwner, rateLimit });

app.post('/api/reports/organize', requireAuth, rateLimit({key:'report-organize',maximum:12,windowMs:3600000}), async (req,res,next) => {
  try {
    if(!hasPermission(req.user,'reports.create'))return res.status(403).json({error:'Report assistance is available to authorized Lodge officers.'});
    if(req.body.master === true && req.user.role !== 'owner')return res.status(403).json({error:"Only the Worshipful Master can organize a Worshipful Master's report."});
    const generateStructured=generationFor(req.user.id);
    if(!generateStructured)return res.status(503).json({error:'Report assistance is not configured. You can still complete the report manually.'});
    const result=await organizeReport(req.body,{schema:await reportSchema(),generateStructured});
    res.setHeader('Cache-Control','no-store');res.json(result);
  }catch(error){next(error);}
});

app.get('/api/generation/status', requireAuth, async (req, res, next) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await generationStatus({ includeBudget: req.user.role === 'owner' })); } catch (error) { next(error); }
});

mountAccessRoutes(app,{requireAuth,requireOwner,onAccessChanged:disconnectRealtimeUser});
mountBuildingCalendar(app,{requireAuth,sendBuildingEmail:sendEmail});
mountAgendaRoutes(app, { requireAuth, requireOwner, addAudit });
mountArchiveRoutes(app, { requireAuth });
mountOfficerReportRoutes(app, { requireAuth, requireOwner });
mountCorrespondenceRoutes(app, { requireAuth, broadcast });
mountMemberFeatures(app, { requireAuth, requireOwner, sendEmail, baseUrl: requestBaseUrl, generateToken, hashSecret, generationFor, rateLimit });

mountTreasuryRoutes(app, { requireAuth, rateLimit, sendEmail, baseUrl: requestBaseUrl, broadcast, generationFor });

app.use((error, req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === 'LIMIT_FILE_SIZE'
        ? `The file must be ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`
        : error.message,
    });
  }
  if (error.message === 'Only PDF files are supported.'
      || error.message === 'Upload notes or a transcript as a TXT, DOCX, or PDF file.') {
    return res.status(400).json({ error: error.message });
  }
  if (Number.isInteger(error.statusCode)) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  const reference = `SS22-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  void recordAppIncident({reference,userId:req.user?.id,client:clientName(req),area:'Dashboard',path:req.path,method:req.method,status:500,category:error?.name||'server_error',state:'open'}).catch(incidentError=>console.error('Could not record incident',incidentError));
  res.status(500).json({ error: 'The dashboard could not complete that request.', incidentReference: reference, retryable: true, retryAfterSeconds: 10 });
});

validateProductionConfiguration();
const connection = await connect();
await runMigrations();
await ensureBrotherSelfServiceAccess();
await initializeBuildingCalendar();
await initAgendaSchema();
await initTreasurySchema();
await initGenerationSchema();
await initActivitySchema();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stone Square Sign is running at http://localhost:${PORT}`);
  console.log(`Database: ${connection.driver} (${connection.location})`);
  if (IS_PRODUCTION && !OWNER_EMAIL) {
    console.warn('OWNER_EMAIL must be configured before production account setup.');
  }
  /* Reset answers are deliberately identical whether or not delivery works, so a
   * broken mail configuration is silent to the user. Say it loudly here instead. */
  if (IS_PRODUCTION && !transporter) {
    console.warn('WARNING: email delivery is not configured. Invitations, record copies and password reset codes cannot be delivered.');
  }
});
