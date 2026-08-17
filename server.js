import path from 'node:path';
import crypto from 'node:crypto';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { PDFParse } from 'pdf-parse';
import { PDFDocument, rgb } from 'pdf-lib';

import { connect, initSchema, dbRun, dbGet, dbAll } from './db.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_DIR = path.resolve(process.cwd());
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 7));

/* Documents, signed copies and signature images are held in the database, not on
 * disk. A free Render web service has no persistent disk and wipes its filesystem
 * on every restart, which on the old layout lost every executed instrument. */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
const asBuffer = (value) => (value == null ? null : Buffer.from(value));

const nowIso = () => new Date().toISOString();
const normalizeEmail = (value = '') => String(value).trim().toLowerCase();
const normalizePhone = (value = '') => String(value).replace(/\D+/g, '');
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const hashSecret = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');
const generateCode = () => String(crypto.randomInt(100000, 1000000));

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
const smsConfigured = Boolean(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_FROM_NUMBER,
);

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

const sendSms = async ({ to, body }) => {
  if (!smsConfigured) {
    if (!IS_PRODUCTION && process.env.SMS_MODE === 'console') {
      console.log(`[sms-preview] ${to}: ${body}`);
      return true;
    }
    return false;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${accountSid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to.startsWith('+') ? to : `+1${normalizePhone(to)}`,
        From: process.env.TWILIO_FROM_NUMBER,
        Body: body,
      }),
    },
  );
  if (!response.ok) throw new Error('SMS provider rejected the reset message.');
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
    phone: user.phone,
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
      `SELECT users.id, users.email, users.name, users.phone, users.role, sessions.expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`,
      [hashSecret(token)],
    );
    if (!row) return res.status(401).json({ error: 'Your sign in has expired.' });
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
  if (document.owner_user_id === user.id) return true;
  return Boolean(await dbGet(
    `SELECT 1 FROM document_signers
     WHERE document_id = ? AND (user_id = ? OR (user_id IS NULL AND signer_role = ?))`,
    [document.id, user.id, user.role],
  ));
};

/* Takes the current PDF as bytes and returns the stamped PDF as bytes. Nothing is
 * read from or written to disk, because on a free instance there is no disk to keep. */
const appendSignatureToPdf = async ({ pdfBytes, signatureBytes, signerName, order }) => {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const page = pages[pages.length - 1];
  const { width } = page.getSize();
  const markerX = Math.max(36, width * 0.12);
  const markerY = 72 + (order - 1) * 82;
  const signatureImage = await pdfDoc.embedPng(signatureBytes);
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
app.use(express.static(path.join(APP_DIR, 'public')));

app.get('/api/health', async (_req, res) => {
  try {
    await dbGet('SELECT 1 AS ok');
    res.json({ ok: true, service: 'stone-square-sign', time: nowIso() });
  } catch (_error) {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/setup', async (_req, res, next) => {
  try {
    const realUsers = await dbGet("SELECT COUNT(*) AS total FROM users WHERE email NOT LIKE '%.local'");
    res.json({
      needsOwnerSetup: realUsers.total === 0,
      registrationMode: realUsers.total === 0 ? 'owner' : 'invitation',
      emailDeliveryReady: Boolean(transporter),
      smsDeliveryReady: smsConfigured || (!IS_PRODUCTION && process.env.SMS_MODE === 'console'),
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
    const phone = normalizePhone(req.body?.phone);
    const invitationToken = String(req.body?.invitationToken || '');
    if (!isEmail(email) || !suppliedName || phone.length < 10 || password.length < 10) {
      return res.status(400).json({
        error: 'Enter a valid email, full name, phone number, and a password of at least 10 characters.',
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
      if (invitation.phone && normalizePhone(invitation.phone) !== phone) {
        return res.status(403).json({ error: 'Use the mobile number assigned to this invitation.' });
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
    const placeholder = await dbGet("SELECT * FROM users WHERE role = ? AND email LIKE '%.local'", [role]);
    let userId;
    if (placeholder) {
      await dbRun(
        'UPDATE users SET email = ?, password_hash = ?, name = ?, phone = ?, created_at = ? WHERE id = ?',
        [email, passwordHash, name, phone, nowIso(), placeholder.id],
      );
      userId = placeholder.id;
    } else {
      const inserted = await dbRun(
        'INSERT INTO users (email, password_hash, name, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [email, passwordHash, name, phone, role, nowIso()],
      );
      userId = inserted.lastID;
    }

    if (invitation) {
      await dbRun('UPDATE invitations SET used_at = ? WHERE id = ?', [nowIso(), invitation.id]);
      await dbRun(
        'UPDATE document_signers SET user_id = ?, signer_name = ? WHERE signer_role = ? AND (user_id IS NULL OR user_id = ?)',
        [userId, name, role, placeholder?.id || -1],
      );
    }
    const user = await dbGet('SELECT id, email, name, phone, role FROM users WHERE id = ?', [userId]);
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
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'That email or phone number is already registered.' });
    }
    next(error);
  }
});

app.post('/api/auth/login', rateLimit({ key: 'login', maximum: 10, windowMs: 15 * 60 * 1000 }), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
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
    const phone = normalizePhone(req.body?.phone);
    const email = normalizeEmail(req.body?.email);
    // either identifier works, because the code is delivered by email either way
    if (phone.length < 10 && !isEmail(email)) {
      return res.status(400).json({ error: 'Enter the phone number or the email address on the account.' });
    }
    const user = phone.length >= 10
      ? await dbGet('SELECT * FROM users WHERE phone = ?', [phone])
      : await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.json({ message: generic });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await dbRun('DELETE FROM reset_codes WHERE user_id = ?', [user.id]);
    const inserted = await dbRun(
      'INSERT INTO reset_codes (user_id, code, phone, expires_at, used) VALUES (?, ?, ?, ?, 0)',
      [user.id, hashSecret(code), user.phone || phone, expiresAt],
    );
    const body = `Stone Square Sign password reset code: ${code}. It expires in 15 minutes.`;
    // SMS first if Twilio is configured, otherwise the officer's own email address.
    // There is no free production SMS, and every officer already has email.
    let delivered = await sendSms({ to: phone, body });
    let channel = 'sms';
    if (!delivered) {
      delivered = await sendEmail({ to: user.email, subject: 'Stone Square Sign password reset code', text: body });
      channel = 'email';
    }
    if (!delivered) {
      /* Answer exactly as we would for an account that does not exist. Returning an
       * error only when the account IS real turns this form into a way of asking
       * which officers have accounts. The failure is logged for the owner instead. */
      await dbRun('DELETE FROM reset_codes WHERE id = ?', [inserted.lastID]);
      console.error(`Password reset for user ${user.id} could not be delivered. Neither SMS nor mail is configured.`);
      return res.json({ message: generic });
    }
    await dbRun('UPDATE reset_codes SET channel = ? WHERE id = ?', [channel, inserted.lastID]);
    await addAudit({ userId: user.id, action: 'password_reset_requested', ip: req.ip });
    res.json({ message: generic });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', rateLimit({ key: 'reset-submit', maximum: 8, windowMs: 30 * 60 * 1000 }), async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const email = normalizeEmail(req.body?.email);
    const codeHash = hashSecret(req.body?.code || '');
    const newPassword = String(req.body?.newPassword || '');
    if ((phone.length < 10 && !isEmail(email)) || newPassword.length < 10) {
      return res.status(400).json({ error: 'Enter your phone number or email, the code, and a new password of at least 10 characters.' });
    }
    const user = phone.length >= 10
      ? await dbGet('SELECT * FROM users WHERE phone = ?', [phone])
      : await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    const reset = user && await dbGet(
      'SELECT * FROM reset_codes WHERE user_id = ? AND code = ? AND used = 0',
      [user.id, codeHash],
    );
    if (!reset || Date.now() > new Date(reset.expires_at).getTime()) {
      return res.status(400).json({ error: 'The reset code is invalid or expired.' });
    }
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, 12), user.id]);
    await dbRun('UPDATE reset_codes SET used = 1 WHERE id = ?', [reset.id]);
    await dbRun('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    await addAudit({ userId: user.id, action: 'password_reset_completed', ip: req.ip });
    res.json({ message: 'Password updated. Sign in with the new password.' });
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

app.get('/api/profile/signature', requireAuth, async (req, res, next) => {
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

app.put('/api/profile/signature', requireAuth, rateLimit({ key: 'signature-profile', maximum: 12, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    const signatureData = String(req.body?.signatureData || '');
    const signatureType = ['drawn', 'typed'].includes(req.body?.signatureType) ? req.body.signatureType : 'drawn';
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
      `SELECT role, name, email, phone, created_at FROM users
       WHERE role IN ('secretary', 'assistant_secretary') AND email NOT LIKE '%.local'
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
    const phone = normalizePhone(req.body?.phone);
    const role = String(req.body?.role || '');
    if (!isEmail(email) || !name || phone.length < 10 || !['secretary', 'assistant_secretary'].includes(role)) {
      return res.status(400).json({ error: 'Enter the officer name, valid email, phone number, and office.' });
    }
    const occupied = await dbGet("SELECT 1 FROM users WHERE role = ? AND email NOT LIKE '%.local'", [role]);
    if (occupied) return res.status(409).json({ error: 'That office already has an active account.' });
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await dbRun('DELETE FROM invitations WHERE email = ? AND used_at IS NULL', [email]);
    await dbRun(
      `INSERT INTO invitations
       (email, name, phone, role, token_hash, invited_by_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [email, name, phone, role, hashSecret(token), req.user.id, expiresAt, nowIso()],
    );
    const inviteUrl = `${requestBaseUrl(req)}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    let emailSent = false;
    try {
      emailSent = await sendEmail({
        to: email,
        subject: 'Your Stone Square Sign account invitation',
        text: `${name},\n\nYou have been invited to sign Lodge documents as ${role === 'secretary' ? 'Secretary' : 'Assistant Secretary'}. Create your password using this private link:\n\n${inviteUrl}\n\nThe link expires in 7 days.`,
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

app.get('/api/documents', requireAuth, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT d.id, d.title, d.original_name, d.status, d.created_at, d.updated_at,
              d.completed_at, u.name AS owner_name, u.email AS owner_email
       FROM documents d LEFT JOIN users u ON u.id = d.owner_user_id
       WHERE d.owner_user_id = ? OR EXISTS (
         SELECT 1 FROM document_signers ds
         WHERE ds.document_id = d.id
         AND (ds.user_id = ? OR (ds.user_id IS NULL AND ds.signer_role = ?))
       )
       ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'partially_signed' THEN 1 ELSE 2 END,
                CASE WHEN d.status = 'completed' THEN d.updated_at END DESC,
                d.created_at ASC`,
      [req.user.id, req.user.id, req.user.role],
    );
    const documents = [];
    for (const row of rows) {
      const signers = await dbAll(
        `SELECT id, user_id, signer_role, signer_name, signed_at
         FROM document_signers WHERE document_id = ? ORDER BY id`,
        [row.id],
      );
      documents.push({
        ...row,
        signers,
        needsSignature: signers.some((signer) =>
          !signer.signed_at &&
          (signer.user_id === req.user.id || (!signer.user_id && signer.signer_role === req.user.role))),
      });
    }
    res.json({ documents });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id', requireAuth, async (req, res, next) => {
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

app.get('/api/documents/:id/file', requireAuth, async (req, res, next) => {
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
app.get('/api/documents/:id/original', requireAuth, async (req, res, next) => {
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

app.post('/api/documents/:id/sign', requireAuth, rateLimit({ key: 'sign', maximum: 20, windowMs: 60 * 60 * 1000 }), async (req, res, next) => {
  try {
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'Confirm the electronic signature consent before signing.' });
    }
    const savedSignature = await dbGet('SELECT * FROM profile_signatures WHERE user_id = ?', [req.user.id]);
    const signatureBytes = asBuffer(savedSignature?.signature_bytes);
    if (!signatureBytes?.length) {
      return res.status(409).json({ error: 'Create your saved signature before signing a document.' });
    }
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    const signer = await dbGet(
      `SELECT * FROM document_signers WHERE document_id = ? AND signed_at IS NULL
       AND (user_id = ? OR (user_id IS NULL AND signer_role = ?)) ORDER BY id LIMIT 1`,
      [document.id, req.user.id, req.user.role],
    );
    if (!signer) return res.status(409).json({ error: 'No pending signature is assigned to this account.' });
    const count = await dbGet(
      'SELECT COUNT(*) AS total FROM document_signers WHERE document_id = ? AND signed_at IS NOT NULL',
      [document.id],
    );
    // each signature stamps the copy the previous signer left, so they accumulate
    const current = asBuffer(document.signed_bytes) || asBuffer(document.file_bytes);
    if (!current?.length) return res.status(409).json({ error: 'Document file is missing.' });
    const stamped = await appendSignatureToPdf({
      pdfBytes: current,
      signatureBytes,
      signerName: req.user.name,
      order: Number(count.total) + 1,
    });
    const signedAt = nowIso();
    const consentText = 'I agree that this electronic signature represents my signature on this document.';
    await dbRun(
      `UPDATE document_signers SET user_id = ?, signer_name = ?, signed_at = ?, signature_bytes = ?,
       signed_ip = ?, signed_user_agent = ?, consent_text = ? WHERE id = ?`,
      [req.user.id, req.user.name, signedAt, signatureBytes, req.ip,
        String(req.get('user-agent') || '').slice(0, 500), consentText, signer.id],
    );
    // file_bytes keeps the document as uploaded; signed_bytes carries the executed copy
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
      details: { role: req.user.role, signedAt, savedSignature: true },
    });
    if (status === 'completed') {
      const completedDocument = await dbGet('SELECT * FROM documents WHERE id = ?', [document.id]);
      const completeSigners = await dbAll(
        `SELECT ds.signer_name, u.email FROM document_signers ds
         LEFT JOIN users u ON u.id = ds.user_id WHERE ds.document_id = ?`,
        [document.id],
      );
      await sendCompletionNotice(completedDocument, completeSigners, asBuffer(completedDocument.signed_bytes));
      await addAudit({ userId: req.user.id, documentId: document.id, action: 'document_completed' });
    }
    broadcast('queue_changed', { reason: 'document_signed', documentId: document.id, status });
    res.json({
      message: status === 'completed'
        ? 'Document completed. Record copies are being delivered.'
        : 'Signature captured.',
      status,
      nextStep: remaining.total === 0 ? 'No signatures remain.' : `${remaining.total} signature remains.`,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/audit', requireAuth, async (req, res, next) => {
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
  res.status(500).json({ error: 'The signing service could not complete that request.' });
});

const connection = await connect();
await runMigrations();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stone Square Sign is running at http://localhost:${PORT}`);
  console.log(`Database: ${connection.driver} (${connection.location})`);
  if (IS_PRODUCTION && connection.driver === 'pglite') {
    console.warn('WARNING: running in production without DATABASE_URL. On a free instance with no persistent disk every signed document is lost on restart.');
  }
  if (IS_PRODUCTION && !OWNER_EMAIL) {
    console.warn('OWNER_EMAIL must be configured before production account setup.');
  }
  /* Reset answers are deliberately identical whether or not delivery works, so a
   * broken mail configuration is silent to the user. Say it loudly here instead. */
  if (IS_PRODUCTION && !process.env.SMTP_HOST) {
    console.warn('WARNING: no SMTP_HOST. Invitations, record copies and password reset codes cannot be delivered.');
  }
});
