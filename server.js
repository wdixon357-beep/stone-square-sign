import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { PDFParse } from 'pdf-parse';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  connect, initSchema, dbRun, dbGet, dbAll, withTransaction, isUniqueViolation,
} from './db.js';
import { buildDuesLedger, duesConfigured, DUES_ROLES } from './dues.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_DIR = path.resolve(process.cwd());
const DISPENSATION_TEMPLATE = path.join(APP_DIR, 'assets', 'grand-lodge-dispensation-template.pdf');
const APP_VERSION = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 7));
const CANDIDATE_TRACKER_URL = String(
  process.env.CANDIDATE_TRACKER_URL || 'https://tracker.stonesquare22pha.org/',
).replace(/\/$/, '');
const TRACKER_SSO_SHARED_SECRET = String(process.env.TRACKER_SSO_SHARED_SECRET || '');
const OFFICE_ROLES = new Set(['secretary', 'assistant_secretary']);

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
  const payload = Buffer.from(JSON.stringify({
    email: user.email,
    name: user.name,
    role: user.role,
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

const createTransporter = () => {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass, MAIL_FROM: from } = process.env;
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

const createAuthToken = async (userId) => {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await dbRun('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [
    userId,
    hashSecret(token),
    expiresAt,
  ]);
  return token;
};

const userForResponse = async (user) => {
  const saved = await dbGet('SELECT 1 FROM profile_signatures WHERE user_id = ?', [user.id]);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    hasSignature: Boolean(saved),
  };
};

const requireAuth = async (req, res, next) => {
  try {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = bearer || req.headers['x-lodge-token'];
    if (!token) return res.status(401).json({ error: 'Sign in is required.' });
    const row = await dbGet(
      `SELECT users.id, users.email, users.name, users.role, users.access_revoked_at, sessions.expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`,
      [hashSecret(token)],
    );
    if (!row) return res.status(401).json({ error: 'Your sign in has expired.' });
    if (row.access_revoked_at) return res.status(403).json({ error: 'Your access has been revoked by the Worshipful Master.' });
    if (Date.now() > new Date(row.expires_at).getTime()) {
      await dbRun('DELETE FROM sessions WHERE token = ?', [hashSecret(token)]);
      return res.status(401).json({ error: 'Your sign in has expired.' });
    }
    req.user = row;
    req.authTokenHash = hashSecret(token);
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
  if (req.user.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers can review document status only.' });
  }
  next();
};

const rateBuckets = new Map();
const rateLimit = ({ key, maximum, windowMs }) => (req, res, next) => {
  const bucketKey = `${key}:${req.ip}`;
  const current = rateBuckets.get(bucketKey);
  const time = Date.now();
  if (!current || current.resetAt < time) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: time + windowMs });
    return next();
  }
  if (current.count >= maximum) {
    return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  }
  current.count += 1;
  next();
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
const broadcast = (type, data = {}) => {
  const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of realtimeClients) client.response.write(event);
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

const requestBaseUrl = (req) =>
  String(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

/* The schema, the column back-fills and the placeholder translation all live in
 * db.js now, so that one file is the only place that knows which Postgres it is
 * talking to. runMigrations is kept as the name the boot path already calls. */
const runMigrations = () => initSchema();

const participantForDocument = async (document, user) => {
  if (user.role === 'viewer') return true;
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
    page.drawText(value, {
      x: rectangle.x + 3,
      y: rectangle.y + 3,
      size,
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

if (IS_PRODUCTION) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'none'; form-action 'self'",
  );
  if (IS_PRODUCTION && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '4mb' }));
app.get('/', async (_req, res, next) => {
  try {
    const index = await fs.readFile(path.join(APP_DIR, 'public', 'index.html'), 'utf8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(index.replaceAll('__APP_VERSION__', APP_VERSION));
  } catch (error) {
    next(error);
  }
});
app.use(express.static(path.join(APP_DIR, 'public'), {
  index: false,
  etag: false,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'),
}));

app.get('/api/health', async (_req, res) => {
  try {
    await dbGet('SELECT 1 AS ok');
    res.json({ ok: true, service: 'stone-square-sign', time: nowIso() });
  } catch (_error) {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION });
});

app.get('/api/setup', async (_req, res, next) => {
  try {
    const realUsers = await dbGet("SELECT COUNT(*) AS total FROM users WHERE email NOT LIKE '%.local'");
    res.json({
      needsOwnerSetup: realUsers.total === 0,
      registrationMode: realUsers.total === 0 ? 'owner' : 'invitation',
      emailDeliveryReady: Boolean(transporter),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', rateLimit({ key: 'register', maximum: 8, windowMs: 15 * 60 * 1000 }), async (req, res, next) => {
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

    let role = 'owner';
    let name = suppliedName;
    let invitation = null;
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
    } else {
      const realUsers = await dbGet("SELECT COUNT(*) AS total FROM users WHERE email NOT LIKE '%.local'");
      if (realUsers.total > 0) {
        return res.status(403).json({ error: 'An invitation from the document owner is required.' });
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
    const token = await createAuthToken(userId);
    const responseUser = await userForResponse(user);
    await addAudit({
      userId,
      action: invitation ? 'officer_account_activated' : 'owner_account_created',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    broadcast('queue_changed', { reason: 'account_activated' });
    res.status(201).json({ token, user: responseUser });
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
    const token = await createAuthToken(user.id);
    await addAudit({ userId: user.id, action: 'signed_in', ip: req.ip, userAgent: req.get('user-agent') || '' });
    res.json({ token, user: await userForResponse(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await dbRun('DELETE FROM sessions WHERE token = ?', [req.authTokenHash]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ user: await userForResponse(req.user) });
  } catch (error) {
    next(error);
  }
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
    res.json({ url: createTrackerHandoffUrl(req.user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`retry: 2500\nevent: connected\ndata: ${JSON.stringify({ time: nowIso() })}\n\n`);
  const client = { response: res, userId: req.user.id };
  realtimeClients.add(client);
  const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    realtimeClients.delete(client);
  });
});

app.get('/api/profile/signature', requireAuth, requireDocumentAccess, async (req, res, next) => {
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

app.put('/api/profile/signature', requireAuth, requireDocumentAccess, rateLimit({ key: 'signature-profile', maximum: 12, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const signatureData = String(req.body?.signatureData || '');
    const signatureType = ['drawn', 'typed', 'initials'].includes(req.body?.signatureType) ? req.body.signatureType : 'drawn';
    const styleName = String(req.body?.styleName || '').slice(0, 50);
    if (!signatureData.startsWith('data:image/png;base64,') || signatureData.length < 800 || signatureData.length > 2_500_000) {
      return res.status(400).json({ error: 'Create a visible signature before saving.' });
    }
    const bytes = Buffer.from(signatureData.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (bytes.length < 300) return res.status(400).json({ error: 'Create a visible signature before saving.' });
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
       WHERE role IN ('secretary', 'assistant_secretary', 'viewer')
       AND email NOT LIKE '%.local' AND access_revoked_at IS NULL
       ORDER BY role DESC`,
    );
    res.json({ officers });
  } catch (error) {
    next(error);
  }
});

app.post('/api/officers/invite', requireAuth, requireOwner, rateLimit({ key: 'invite', maximum: 10, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || '');
    if (!isEmail(email) || !name || !['secretary', 'assistant_secretary', 'viewer'].includes(role)) {
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
      await dbRun('DELETE FROM invitations WHERE email = ? AND used_at IS NULL', [email]);
      await dbRun(
        `INSERT INTO invitations
         (email, name, role, token_hash, invited_by_user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [email, name, role, hashSecret(token), req.user.id, expiresAt, nowIso()],
      );
    });
    const inviteUrl = `${requestBaseUrl(req)}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    let emailSent = false;
    try {
      emailSent = await sendEmail({
        to: email,
        subject: 'Your Stone Square Sign account invitation',
        text: `${name},\n\nYou have been invited to Stone Square Sign as ${role === 'viewer' ? 'a Lodge Viewer' : role === 'secretary' ? 'Secretary' : 'Assistant Secretary'}. ${role === 'viewer' ? 'You can review document status and signing progress, but cannot upload, create, or sign documents.' : 'You can review and sign assigned Lodge documents.'}\n\nCreate your password using this private link:\n\n${inviteUrl}\n\nThe link expires in 7 days.`,
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
    await dbRun('DELETE FROM sessions WHERE user_id = ?', [account.id]);
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

/* Dues. Restricted to the Worshipful Master, the Secretary and the Assistant
 * Secretary. The ledger names who is behind on his dues, so viewers are refused
 * outright rather than shown an empty page. */
const requireDuesAccess = (req, res, next) => {
  if (!DUES_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'Dues are restricted to the Worshipful Master and the Secretaries.' });
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

app.get('/api/documents', requireAuth, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT d.id, d.title, d.original_name, d.status, d.created_at, d.updated_at,
              d.completed_at, u.name AS owner_name, u.email AS owner_email
       FROM documents d LEFT JOIN users u ON u.id = d.owner_user_id
       WHERE ? = 'viewer' OR d.owner_user_id = ? OR EXISTS (
         SELECT 1 FROM document_signers ds
         WHERE ds.document_id = d.id
         AND (ds.user_id = ? OR (ds.user_id IS NULL AND ds.signer_role = ?))
       )
       ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'partially_signed' THEN 1 ELSE 2 END,
                CASE WHEN d.status IN ('completed', 'rescinded') THEN d.updated_at END DESC,
                d.created_at ASC`,
      [req.user.role, req.user.id, req.user.id, req.user.role],
    );
    const documents = [];
    for (const row of rows) {
      const signers = await dbAll(
        `SELECT id, user_id, signer_role, signer_name, signed_at
         FROM document_signers WHERE document_id = ? ORDER BY id`,
        [row.id],
      );
      if (req.user.role === 'viewer') {
        documents.push({
          id: row.id,
          title: row.title,
          original_name: row.original_name,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          completed_at: row.completed_at,
          owner_name: row.owner_name,
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
            !signer.signed_at &&
            (signer.user_id === req.user.id || (!signer.user_id && signer.signer_role === req.user.role))),
        });
      }
    }
    res.json({ documents });
  } catch (error) {
    next(error);
  }
});

app.get('/api/submission-profiles', requireAuth, requireOwner, async (_req, res, next) => {
  try {
    const profiles = await dbAll(
      'SELECT role, name, address FROM submission_profiles ORDER BY role',
    );
    res.json({ profiles });
  } catch (error) {
    next(error);
  }
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
      'SELECT id, user_id, signer_role, signer_name, signed_at FROM document_signers WHERE document_id = ? ORDER BY id',
      [document.id],
    );
    delete document.file_bytes;
    delete document.signed_bytes;
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
      'SELECT id, user_id, signer_role, signer_name, signed_at FROM document_signers WHERE document_id = ? ORDER BY id',
      [documentId],
    );
    const signerAccounts = await dbAll(
      `SELECT DISTINCT u.email, u.name FROM document_signers ds JOIN users u ON u.id = ds.user_id
       WHERE ds.document_id = ? AND u.email NOT LIKE '%.local'`,
      [documentId],
    );
    for (const signer of signerAccounts) {
      try {
        await sendEmail({
          to: signer.email,
          subject: `Signature requested: ${title}`,
          text: `${signer.name},\n\nA Lodge document is ready for your signature. Sign in at ${requestBaseUrl(req)} to review and sign ${title}.`,
        });
      } catch (error) {
        console.warn('Signature request email failed:', error.message);
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
    const signerRole = String(req.body?.signerRole || '');
    const personalInfoConfirmed = req.body?.personalInfoConfirmed === true;
    if (!dateParts(requestDate) || !dateParts(eventDate) || !requestDetails || !eventTime || !locationName
        || !streetAddress || !cityState || !worshipfulMasterAddress || !personalInfoConfirmed
        || !['secretary', 'assistant_secretary'].includes(signerRole)) {
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

app.post('/api/dispensations', requireAuth, requireOwner, rateLimit({ key: 'dispensation-create', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const requestDate = String(req.body?.requestDate || '');
    const eventDate = String(req.body?.eventDate || '');
    const requestDetails = String(req.body?.requestDetails || '').trim().slice(0, 600);
    const eventTime = String(req.body?.eventTime || '').trim().slice(0, 40);
    const locationName = String(req.body?.locationName || '').trim().slice(0, 120);
    const streetAddress = String(req.body?.streetAddress || '').trim().slice(0, 120);
    const cityState = String(req.body?.cityState || '').trim().slice(0, 120);
    const worshipfulMasterAddress = String(req.body?.worshipfulMasterAddress || '').trim().slice(0, 160);
    const signerRole = String(req.body?.signerRole || '');
    const personalInfoConfirmed = req.body?.personalInfoConfirmed === true;
    const title = String(req.body?.title || '').trim().slice(0, 200);
    if (!dateParts(requestDate) || !dateParts(eventDate) || !requestDetails || !eventTime || !locationName
        || !streetAddress || !cityState || !worshipfulMasterAddress
        || !personalInfoConfirmed || !['secretary', 'assistant_secretary'].includes(signerRole)) {
      return res.status(400).json({ error: 'Complete the remaining Lodge questions before sending the PDF.' });
    }
    const savedSignature = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    const ownerSignature = asBuffer(savedSignature?.signature_bytes);
    if (!ownerSignature?.length) {
      return res.status(409).json({ error: 'Save your Worshipful Master signature before creating a dispensation.' });
    }
    const officer = await dbGet('SELECT id, name, email FROM users WHERE role = ?', [signerRole]);
    const secretaryName = officer?.name || (signerRole === 'secretary' ? 'William McDuffie' : 'Adrian Reese');
    const pdfBytes = await createDispensationPdf({
      fields: {
        requestDate, eventDate, requestDetails, eventTime, locationName, streetAddress,
        cityState, worshipfulMasterAddress,
      },
      ownerName: req.user.name,
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
      [documentId, documentTitle, fileName, `${documentId}.pdf`, req.user.id, req.user.email,
        pdfBytes, pdfBytes, requestDetails, createdAt, createdAt],
    );
    await dbRun(
      `INSERT INTO document_signers
       (document_id, user_id, signer_role, signer_name, signed_at, signature_bytes, consent_text)
       VALUES (?, ?, 'worshipful_master', ?, ?, ?, ?)`,
      [documentId, req.user.id, req.user.name, createdAt, ownerSignature,
        'Saved Worshipful Master signature applied when the official template was created.'],
    );
    await dbRun(
      'INSERT INTO document_signers (document_id, user_id, signer_role, signer_name) VALUES (?, ?, ?, ?)',
      [documentId, officer?.id || null, signerRole, secretaryName],
    );
    if (officer?.email && !officer.email.endsWith('.local')) {
      try {
        await sendEmail({
          to: officer.email,
          subject: `Signature requested: ${documentTitle}`,
          text: `${secretaryName},\n\nA dispensation is ready for your signature. Sign in at ${requestBaseUrl(req)} to review and sign ${documentTitle}.`,
        });
      } catch (error) {
        console.warn('Signature request email failed:', error.message);
      }
    }
    await addAudit({
      userId: req.user.id,
      documentId,
      action: 'dispensation_created_from_template',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      details: { signerRole, secretaryName, requestDate, eventDate, template: 'official-grand-lodge', personalInfoConfirmed },
    });
    broadcast('queue_changed', { reason: 'dispensation_created', documentId });
    res.status(201).json({ document: { id: documentId } });
  } catch (error) {
    next(error);
  }
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
      if (document.template_kind === 'dispensation_v1') {
        officerAddress = String(req.body?.officerAddress || '').trim().slice(0, 160);
        if (!officerAddress) throw httpError(400, 'Enter your address as it should appear on the dispensation.');
        prepared = await fillDispensationOfficerInformation({
          pdfBytes: current,
          officerName: req.user.name,
          officerAddress,
        });
      }
      const stamped = await appendSignatureToPdf({
        pdfBytes: prepared,
        signatureBytes,
        signerName: req.user.name,
        order: Number(count.total) + 1,
        placement: document.template_kind === 'dispensation_v1' ? 'dispensation-secretary' : 'general',
      });
      const signedAt = nowIso();
      const consentText = 'I agree that this electronic signature represents my signature on this document.';
      const captured = await dbRun(
        `UPDATE document_signers SET user_id = ?, signer_name = ?, signed_at = ?, signature_bytes = ?,
         signed_ip = ?, signed_user_agent = ?, consent_text = ? WHERE id = ? AND signed_at IS NULL`,
        [req.user.id, req.user.name, signedAt, signatureBytes, req.ip,
          String(req.get('user-agent') || '').slice(0, 500), consentText, signer.id],
      );
      if (captured.changes !== 1) throw httpError(409, 'This signature was already captured.');
      await dbRun('UPDATE documents SET signed_bytes = ?, updated_at = ? WHERE id = ?', [stamped, signedAt, document.id]);
      const remaining = await dbGet(
        'SELECT COUNT(*) AS total FROM document_signers WHERE document_id = ? AND signed_at IS NULL',
        [document.id],
      );
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
    if (status === 'completed') {
      const completedDocument = await dbGet('SELECT * FROM documents WHERE id = ?', [documentId]);
      const completeSigners = await dbAll(
        `SELECT ds.signer_name, u.email FROM document_signers ds
         LEFT JOIN users u ON u.id = ds.user_id WHERE ds.document_id = ?`,
        [documentId],
      );
      await sendCompletionNotice(completedDocument, completeSigners, asBuffer(completedDocument.signed_bytes));
    }
    broadcast('queue_changed', { reason: 'document_signed', documentId, status });
    res.json({
      message: status === 'completed'
        ? 'Document completed. Record copies are being delivered.'
        : 'Signature captured.',
      status,
      nextStep: remaining === 0 ? 'No signatures remain.' : `${remaining} signature remains.`,
    });
  } catch (error) {
    next(error);
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

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === 'LIMIT_FILE_SIZE'
        ? `PDF must be ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`
        : error.message,
    });
  }
  if (error.message === 'Only PDF files are supported.') {
    return res.status(400).json({ error: error.message });
  }
  if (Number.isInteger(error.statusCode)) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  res.status(500).json({ error: 'The signing service could not complete that request.' });
});

validateProductionConfiguration();
const connection = await connect();
await runMigrations();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stone Square Sign is running at http://localhost:${PORT}`);
  console.log(`Database: ${connection.driver} (${connection.location})`);
  if (IS_PRODUCTION && !OWNER_EMAIL) {
    console.warn('OWNER_EMAIL must be configured before production account setup.');
  }
  /* Reset answers are deliberately identical whether or not delivery works, so a
   * broken mail configuration is silent to the user. Say it loudly here instead. */
  if (IS_PRODUCTION && !process.env.SMTP_HOST) {
    console.warn('WARNING: no SMTP_HOST. Invitations, record copies and password reset codes cannot be delivered.');
  }
});
