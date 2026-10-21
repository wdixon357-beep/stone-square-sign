import crypto from 'node:crypto';
import { dbGet } from './db.js';
import { hasPermission } from './access-control.js';
import { assertApprovedSignature, signatureProfilePolicyForUser } from './signature-policy.js';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const decode = (value, maximum) => {
  if (typeof value !== 'string' || !value.length || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
};

// This is a read of the existing pinned profile. It never approves, applies or
// replaces a signature, and it never changes a retained report PDF.
export function verifyReportSignatureAssertion(value, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret) throw fail(503, 'Report signature access is not configured.');
  const parts = typeof value === 'string' ? value.split('.') : [];
  const payload = decode(parts[0], 8192), supplied = decode(parts[1], 100);
  const expected = crypto.createHmac('sha256', secret).update(parts[0] || '').digest();
  if (parts.length !== 2 || !payload || !supplied || supplied.length !== expected.length
      || !crypto.timingSafeEqual(supplied, expected)) throw fail(401, 'Your Report Generator sign-in could not be verified.');
  let actor;
  try { actor = JSON.parse(payload.toString('utf8')); } catch { throw fail(401, 'Your Report Generator sign-in could not be verified.'); }
  if (actor?.aud !== 'stone-square-report-generator' || !Number.isInteger(actor.issuedAt) || !Number.isInteger(actor.expiresAt)
      || actor.issuedAt > now + 30 || actor.expiresAt <= now || actor.expiresAt <= actor.issuedAt || actor.expiresAt - actor.issuedAt > 300
      || typeof actor.email !== 'string' || typeof actor.name !== 'string' || actor.role !== 'owner'
      || !Array.isArray(actor.permissions) || !actor.permissions.includes('reports.create')) {
    throw fail(actor?.role && actor.role !== 'owner' ? 403 : 401, 'The approved owner signature requires a current owner Report Generator sign-in.');
  }
  return actor;
}

export function mountReportSignature(app, { secret, rateLimit, now = () => Math.floor(Date.now() / 1000) }) {
  app.post('/api/reports/signature', rateLimit({ key: 'report-signature', maximum: 120, windowMs: 3600000 }), async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const authorization = req.get('Authorization') || '';
      if (!authorization.startsWith('Bearer ')) throw fail(401, 'A current Report Generator sign-in is required.');
      const actor = verifyReportSignatureAssertion(authorization.slice(7), secret, now());
      const user = await dbGet('SELECT * FROM users WHERE lower(email)=?', [actor.email.trim().toLowerCase()]);
      if (!user || user.access_revoked_at || user.role !== 'owner' || user.role !== actor.role || user.name !== actor.name
          || !hasPermission(user, 'reports.create')) throw fail(403, 'Owner Report Generator access is no longer enabled.');
      if (!(await signatureProfilePolicyForUser(user)).locked) throw fail(409, 'Save and approve the owner signature before previewing this report.');
      const row = await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=?', [user.id]);
      const bytes = row?.signature_bytes && Buffer.from(row.signature_bytes);
      if (!bytes?.length || bytes.length > 2.5 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw fail(409, 'The approved owner signature image is unavailable.');
      }
      await assertApprovedSignature(user, bytes);
      res.setHeader('X-Signature-SHA256', crypto.createHash('sha256').update(bytes).digest('hex'));
      res.type('image/png').send(bytes);
    } catch (error) { next(error); }
  });
}
