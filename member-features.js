import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { buildDuesLedger, duesConfigured, duesPaymentLinks } from './dues.js';
import { hasPermission } from './access-control.js';

const nowIso = () => new Date().toISOString();
const STATUSES = new Set(['Received', 'Under Review', 'Responded', 'Closed']);
const TRANSACTION_SIGNS = { payment: 1, credit: 1, refund: -1, chargeback: -1, correction: 1, reversal: -1 };
const METHODS = new Set(['Cash', 'Check', 'Money order', 'Bank transfer', 'Other']);
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const moneyCents = value => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 100000 ? Math.round(amount * 100) : null;
};
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function mountMemberFeatures(app, {
  requireAuth, requireOwner, sendEmail, baseUrl, generateToken, hashSecret,
}) {
  app.get('/api/dues/me', requireAuth, async (req, res, next) => {
    try {
      if (!hasPermission(req.user, 'dues.self')) throw failure(403, 'Personal dues access is not enabled.');
      const account = await dbGet('SELECT roster_id FROM users WHERE id=?', [req.user.id]);
      if (!account?.roster_id) throw failure(409, 'Your Lodge account is not yet linked to your roster record. Ask the Worshipful Master to review your enrollment.');
      if (!duesConfigured()) throw failure(503, 'Dues are not connected yet.');
      const ledger = await buildDuesLedger();
      const row = ledger.rows.find(item => item.rosterId === account.roster_id);
      if (!row) throw failure(404, 'Your dues record was not found.');
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ duesYear: ledger.duesYear, rateCents: ledger.rateCents, row, paymentLinks: duesPaymentLinks(), updatedAt: nowIso() });
    } catch (error) { next(error); }
  });

  app.post('/api/dues/adjustments', requireAuth, async (req, res, next) => {
    try {
      if (!hasPermission(req.user, 'dues.manage') || !['owner', 'secretary', 'assistant_secretary'].includes(req.user.role)) {
        throw failure(403, 'Only the Worshipful Master and the Secretary offices may record non-Zeffy dues activity.');
      }
      const rosterId = Number(req.body?.rosterId);
      const type = clean(req.body?.transactionType, 30).toLowerCase();
      const cents = moneyCents(req.body?.amount);
      const effectiveDate = clean(req.body?.effectiveDate, 10);
      const method = clean(req.body?.paymentMethod, 40);
      const source = clean(req.body?.sourceReference, 160);
      const note = clean(req.body?.note, 500);
      if (!Number.isSafeInteger(rosterId) || rosterId < 1 || !Object.hasOwn(TRANSACTION_SIGNS, type) || !cents
          || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !METHODS.has(method)) {
        throw failure(400, 'Choose a Brother, transaction type, amount, date, and payment method.');
      }
      if (type === 'reversal') throw failure(400, 'Use the reverse action on the original entry.');
      const signed = cents * TRANSACTION_SIGNS[type];
      let id;
      await withTransaction(async () => {
        const brother = await dbGet('SELECT id,first_name,last_name FROM roster WHERE id=? FOR UPDATE', [rosterId]);
        if (!brother) throw failure(404, 'That Brother was not found on the Lodge roster.');
        const inserted = await dbRun(`INSERT INTO dues_adjustments
          (roster_id,dues_year,transaction_type,amount_cents,effective_date,payment_method,source_reference,note,entered_by_user_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [rosterId, process.env.DUES_YEAR || '2026-2027', type, signed, effectiveDate, method, source || null, note || null, req.user.id, nowIso()]);
        id = inserted.lastID;
        await dbRun(`INSERT INTO audit_events (user_id,action,ip_address,user_agent,details_json,created_at)
          VALUES (?,?,?,?,?,?)`, [req.user.id, 'dues_adjustment_recorded', req.ip, clean(req.get('user-agent'), 500), JSON.stringify({ adjustmentId: id, rosterId, transactionType: type, amountCents: signed, effectiveDate }), nowIso()]);
      });
      res.status(201).json({ id, message: 'The non-Zeffy dues activity was recorded.' });
    } catch (error) { next(error); }
  });

  app.post('/api/dues/adjustments/:id/reverse', requireAuth, async (req, res, next) => {
    try {
      if (!hasPermission(req.user, 'dues.manage') || !['owner', 'secretary', 'assistant_secretary'].includes(req.user.role)) throw failure(403, 'Dues adjustment access is restricted.');
      const originalId = Number(req.params.id); const reason = clean(req.body?.reason, 500);
      if (!Number.isSafeInteger(originalId) || originalId < 1 || !reason) throw failure(400, 'Give the reason for the reversal.');
      let id;
      await withTransaction(async () => {
        const original = await dbGet('SELECT * FROM dues_adjustments WHERE id=? FOR UPDATE', [originalId]);
        if (!original) throw failure(404, 'The original dues entry was not found.');
        if (await dbGet('SELECT 1 FROM dues_adjustments WHERE reverses_adjustment_id=?', [originalId])) throw failure(409, 'That entry has already been reversed.');
        const inserted = await dbRun(`INSERT INTO dues_adjustments
          (roster_id,dues_year,transaction_type,amount_cents,effective_date,payment_method,source_reference,note,entered_by_user_id,reverses_adjustment_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [original.roster_id, original.dues_year, 'reversal', -original.amount_cents, nowIso().slice(0,10), original.payment_method, original.source_reference, reason, req.user.id, originalId, nowIso()]);
        id = inserted.lastID;
        await dbRun(`INSERT INTO audit_events (user_id,action,ip_address,user_agent,details_json,created_at)
          VALUES (?,?,?,?,?,?)`, [req.user.id, 'dues_adjustment_reversed', req.ip, clean(req.get('user-agent'), 500), JSON.stringify({ adjustmentId: id, reversesAdjustmentId: originalId, rosterId: original.roster_id }), nowIso()]);
      });
      res.status(201).json({ id, message: 'The original entry remains in the record and a reversal was added.' });
    } catch (error) { next(error); }
  });

  app.post('/api/suggestions', requireAuth, async (req, res, next) => {
    try {
      if (!hasPermission(req.user, 'suggestions.create')) throw failure(403, 'Suggestion Box access is not enabled.');
      const category = clean(req.body?.category, 80) || 'General Lodge suggestion';
      const subject = clean(req.body?.subject, 160);
      const body = clean(req.body?.body, 5000);
      if (!subject || body.length < 10) throw failure(400, 'Add a short subject and enough detail for the Worshipful Master to understand the suggestion.');
      const reference = `SUG-${String(generateToken()).slice(0,8).toUpperCase()}`;
      await dbRun(`INSERT INTO suggestions (reference_code,submitted_by_user_id,category,subject,body,status,submitted_at,updated_at)
        VALUES (?,?,?,?,?,'Received',?,?)`, [reference, req.user.id, category, subject, body, nowIso(), nowIso()]);
      res.status(201).json({ reference, status: 'Received', message: 'Received. Your suggestion is confidential to WM Dixon-Saunders.' });
    } catch (error) { next(error); }
  });

  app.get('/api/suggestions/me', requireAuth, async (req, res, next) => {
    try {
      if (!hasPermission(req.user, 'suggestions.create')) throw failure(403, 'Suggestion Box access is not enabled.');
      const rows = await dbAll(`SELECT reference_code,category,subject,status,owner_response,submitted_at,updated_at
        FROM suggestions WHERE submitted_by_user_id=? ORDER BY submitted_at DESC`, [req.user.id]);
      res.setHeader('Cache-Control', 'private, no-store'); res.json({ suggestions: rows });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/suggestions', requireAuth, requireOwner, async (_req, res, next) => {
    try {
      const rows = await dbAll(`SELECT s.id,s.reference_code,s.category,s.subject,s.body,s.status,s.owner_response,s.submitted_at,s.updated_at,u.name AS submitted_by
        FROM suggestions s JOIN users u ON u.id=s.submitted_by_user_id ORDER BY s.submitted_at DESC`);
      res.setHeader('Cache-Control', 'private, no-store'); res.json({ suggestions: rows });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/suggestions/:id', requireAuth, requireOwner, async (req, res, next) => {
    try {
      const id = Number(req.params.id); const status = clean(req.body?.status, 30); const response = clean(req.body?.response, 3000);
      if (!Number.isSafeInteger(id) || id < 1 || !STATUSES.has(status)) throw failure(400, 'Choose a valid suggestion status.');
      if (status === 'Responded' && !response) throw failure(400, 'Add the response before marking this suggestion Responded.');
      const updated = await dbRun(`UPDATE suggestions SET status=?,owner_response=?,reviewed_by_user_id=?,updated_at=? WHERE id=?`, [status, response || null, req.user.id, nowIso(), id]);
      if (!updated.changes) throw failure(404, 'That suggestion was not found.');
      res.json({ message: 'Suggestion status updated.' });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/member-access', requireAuth, requireOwner, async (_req, res, next) => {
    try {
      const rows = await dbAll(`SELECT r.id,r.first_name,r.last_name,r.title,r.prefix,r.emails,
        u.id AS user_id,u.email AS account_email,u.access_revoked_at,
        i.id AS invitation_id,i.email AS invitation_email,i.expires_at
        FROM roster r LEFT JOIN users u ON u.roster_id=r.id AND u.access_revoked_at IS NULL
        LEFT JOIN invitations i ON i.roster_id=r.id AND i.used_at IS NULL AND i.expires_at>?
        ORDER BY r.last_name,r.first_name`, [nowIso()]);
      res.setHeader('Cache-Control', 'private, no-store'); res.json({ members: rows });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/member-access/:rosterId/invite', requireAuth, requireOwner, async (req, res, next) => {
    try {
      const rosterId = Number(req.params.rosterId); const requestedEmail = clean(req.body?.email, 320).toLowerCase();
      const brother = await dbGet('SELECT * FROM roster WHERE id=?', [rosterId]);
      if (!brother) throw failure(404, 'That Brother was not found.');
      const emails = (brother.emails || []).map(value => String(value).toLowerCase());
      const email = requestedEmail || emails[0] || '';
      if (!email || !emails.includes(email)) throw failure(400, 'Choose a verified email address from the Lodge roster.');
      const name = `${brother.first_name} ${brother.last_name}`.trim(); const token = generateToken();
      const expiresAt = new Date(Date.now() + 7*86400000).toISOString();
      await withTransaction(async () => {
        if (await dbGet('SELECT 1 FROM users WHERE roster_id=? AND access_revoked_at IS NULL', [rosterId])) throw failure(409, 'This Brother already has an active account.');
        if (await dbGet('SELECT 1 FROM users WHERE lower(email)=lower(?) AND access_revoked_at IS NULL', [email])) throw failure(409, 'That email already belongs to an active account. Link it from Member Access instead of creating a duplicate.');
        await dbRun('DELETE FROM invitations WHERE roster_id=? AND used_at IS NULL', [rosterId]);
        await dbRun(`INSERT INTO invitations (email,name,role,token_hash,invited_by_user_id,expires_at,created_at,permissions_json,roster_id)
          VALUES (?,?, 'member',?,?,?,?,NULL,?)`, [email,name,hashSecret(token),req.user.id,expiresAt,nowIso(),rosterId]);
      });
      const inviteUrl = `${baseUrl(req)}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
      let emailSent = false;
      if (req.body?.sendEmail === true) emailSent = await sendEmail({ to:email, subject:'Your Stone Square Dashboard account', text:`${name},\n\nYour private Stone Square Dashboard account is ready. Use this link to create your password:\n\n${inviteUrl}\n\nThe link expires in 7 days. Your account includes your personal dues record, finalized Lodge minutes and Treasurer Reports, the Report Generator, and the confidential Suggestion Box.` });
      res.status(201).json({ inviteUrl, emailSent, expiresAt });
    } catch (error) { next(error); }
  });
}
