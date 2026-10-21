import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { PDFDocument } from 'pdf-lib';
import { dbGet, dbRun, dbAll, withTransaction } from './db.js';
import { initOwnerSignatureRevisionSchema } from './owner-signature-revisions.js';

export const MAX_SUPPORTING_REPORT_BYTES = 12 * 1024 * 1024;
export const DISPENSATION_DELIVERY_DISABLED_MESSAGE = 'Automatic emailing to the District Deputy is turned off. Download the signed dispensation and supporting report, review them, and send them from your email app.';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const buffer = (value) => value == null ? null : Buffer.from(value);
const now = () => new Date().toISOString();
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const plain = (value, maximum = 180) => String(value || '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maximum);
const pdfName = (name, fallback) => {
  // Multipart filenames commonly arrive as UTF-8 bytes decoded with Latin-1.
  // Repair only a lossless UTF-8 sequence; preserve already decoded filenames.
  let decoded = String(name || '');
  if (/[^\x00-\x7f]/.test(decoded) && [...decoded].every(value => value.charCodeAt(0) <= 255)) {
    const utf8 = Buffer.from(decoded, 'latin1').toString('utf8');
    if (!utf8.includes('\ufffd')) decoded = utf8;
  }
  const base = plain(decoded.split(/[\\/]/).pop(), 160).replace(/["<>:|?*]/g, '-');
  return /\.pdf$/i.test(base) ? base : `${base || fallback}.pdf`;
};

async function markStaleDeliveries(audit) {
  return withTransaction(async () => {
    const markedAt = now();
    const rows = await dbAll(`UPDATE dispensation_submissions SET delivery_state = 'uncertain',
      delivery_error = ?, delivery_token = NULL, updated_at = ? WHERE delivery_state = 'sending' AND attempted_at < ?
      RETURNING document_id, message_id, attempted_at`,
    ['Delivery was interrupted. Check the sent message with the District Deputy before retrying.', markedAt, new Date(Date.now() - 300_000).toISOString()]);
    for (const row of rows) {
      const details = { messageId: row.message_id, attemptedAt: row.attempted_at, detectedAt: markedAt, state: 'uncertain' };
      if (audit) await audit(row.document_id, details);
      else await dbRun(`INSERT INTO audit_events(document_id, action, details_json, created_at) VALUES (?, ?, ?, ?)`,
        [row.document_id, 'dispensation_submission_delivery_interrupted', JSON.stringify(details), markedAt]);
    }
    return rows;
  });
}

export async function initDispensationSubmissionSchema() {
  await initOwnerSignatureRevisionSchema();
  await dbRun(`CREATE TABLE IF NOT EXISTS dispensation_submissions (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    report_bytes BYTEA, report_filename TEXT, report_sha256 TEXT, source_label TEXT,
    report_added_at TEXT, report_added_by INTEGER REFERENCES users(id),
    signed_sha256 TEXT, message_id TEXT, message_raw BYTEA, message_json TEXT,
    prepared_at TEXT, delivery_state TEXT, delivery_error TEXT, delivery_token TEXT,
    attempted_at TEXT, sent_at TEXT, updated_at TEXT NOT NULL
  )`);
  await dbRun('ALTER TABLE dispensation_submissions ADD COLUMN IF NOT EXISTS delivery_confirmed_at TEXT');
  await dbRun('ALTER TABLE dispensation_submissions ADD COLUMN IF NOT EXISTS delivery_confirmation_note TEXT');
  await dbRun('ALTER TABLE dispensation_submissions ADD COLUMN IF NOT EXISTS delivery_confirmation_outcome TEXT');
  // A stopped process cannot know whether the SMTP server accepted its last DATA.
  // Never turn that uncertainty into a duplicate automatic delivery.
  await markStaleDeliveries();
}

export async function validateSupportingReport(bytes) {
  if (!bytes?.length) throw error(400, 'Choose the corresponding report PDF.');
  if (bytes.length > MAX_SUPPORTING_REPORT_BYTES) throw error(413, 'The report PDF must be 12 MB or smaller.');
  if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-')) throw error(400, 'The corresponding report must be a valid PDF.');
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true });
    if (pdf.isEncrypted || !pdf.getPageCount()) throw new Error('Encrypted or empty PDF');
  } catch {
    throw error(400, 'This report PDF is unreadable, empty, or password protected. Export an unlocked PDF and try again.');
  }
}

export function createDispensationSubmissions({ sendEmail, addAudit, recipient, lodgeName, mailFrom, automaticDeliveryEnabled = false,
  missiveDraftStatus, onReportSaved, onReportCommitted }) {
  // Sending is disconnected by default. Production never opts in; the opt-in is
  // retained solely for isolated transport regression tests of historical code.
  automaticDeliveryEnabled = automaticDeliveryEnabled === true;
  const configuredRecipient = () => ({ to: plain(recipient.to, 254), name: plain(recipient.name || 'District Deputy Grand Master', 120) });
  const recordAudit = (documentId, action, context = {}, details = {}) => addAudit({
    documentId, action, userId: context.actorUserId || null, ip: context.ip || '',
    userAgent: context.userAgent || '', details,
  });

  async function documentFor(id, user) {
    const document = await dbGet(`SELECT id, owner_user_id, template_kind, status, submitted_at, submitted_to
      FROM documents WHERE id = ?`, [id]);
    if (!document) throw error(404, 'Document not found.');
    if (user && (user.role !== 'owner' || document.owner_user_id !== user.id)) throw error(403, 'Only the document owner can manage this submission.');
    if (document.template_kind !== 'dispensation_v1') throw error(409, 'Only dispensations go to the District Deputy.');
    if (document.status === 'rescinded') throw error(409, 'This dispensation was rescinded. Its submission is unavailable.');
    return document;
  }

  async function packet(id, user) {
    const document = await documentFor(id, user);
    // The secretary's completion response deliberately contains no owner email
    // overview, supporting report, or Missive receipt.
    const missiveDraft = user && missiveDraftStatus ? await missiveDraftStatus(id, user) : null;
    const correction = await dbGet(`SELECT corrected_at, before_pdf_sha256, after_pdf_sha256
      FROM owner_signature_revisions WHERE document_id = ? ORDER BY corrected_at DESC, id DESC LIMIT 1`, [id]);
    const row = await dbGet(`SELECT report_filename, report_sha256, source_label, report_added_at,
      message_json IS NOT NULL AS has_message,
      message_json::jsonb ->> 'to' AS message_to, message_json::jsonb ->> 'name' AS message_name,
      message_json::jsonb ->> 'filename' AS message_filename, message_json::jsonb ->> 'reportFilename' AS message_report_filename,
      message_json::jsonb ->> 'subject' AS message_subject, message_json::jsonb ->> 'body' AS message_body,
      prepared_at, delivery_state, delivery_error, message_id, sent_at, attempted_at
      , delivery_confirmed_at, delivery_confirmation_outcome
      FROM dispensation_submissions WHERE document_id = ?`, [id]);
    const draft = row?.has_message ? { to: row.message_to, name: row.message_name, filename: row.message_filename,
      reportFilename: row.message_report_filename, subject: row.message_subject, body: row.message_body } : null;
    const historicalSent = document.submitted_at && !row?.sent_at;
    const stale = row?.delivery_state === 'sending' && Date.parse(row.attempted_at) < Date.now() - 300_000;
    const recordedState = historicalSent ? 'sent' : document.status !== 'completed' ? 'awaiting_signature'
      : stale ? 'uncertain'
      : !row?.report_sha256 ? 'awaiting_report' : row.delivery_state || 'ready';
    const state = !automaticDeliveryEnabled && !['sent', 'sending', 'uncertain'].includes(recordedState) ? 'disabled' : recordedState;
    const messages = {
      awaiting_signature: 'The signed dispensation and corresponding report will be emailed to the District Deputy after either secretary signs.',
      awaiting_report: 'The secretary has signed. Add the corresponding report PDF to email both documents to the District Deputy.',
      ready: 'Both documents are available. The email is ready to send to the District Deputy.',
      sending: 'The signed dispensation and corresponding report are being emailed to the District Deputy.',
      sent: historicalSent ? 'This dispensation was previously sent to the District Deputy. It will not be sent again automatically.'
        : row?.delivery_confirmation_outcome === 'delivered' ? 'You confirmed that the District Deputy received both documents. No additional email was sent.'
          : 'The signed dispensation and corresponding report were emailed to the District Deputy.',
      failed: row?.delivery_error || 'The email could not be sent. Both documents are saved; retry delivery.',
      uncertain: row?.delivery_error || 'Delivery could not be confirmed. Check before sending again to avoid a duplicate.',
    };
    return {
      state, automaticDeliveryEnabled, reportLocked: Boolean(draft || document.submitted_at || missiveDraft?.reportLocked), recipient: draft ? { to: draft.to, name: draft.name } : configuredRecipient(),
      ...(missiveDraft ? { missiveDraft } : {}),
      report: row?.report_sha256 ? { filename: row.report_filename, sha256: row.report_sha256, sourceLabel: row.source_label || '', addedAt: row.report_added_at } : null,
      draft: automaticDeliveryEnabled && draft ? { ...draft, preparedAt: row.prepared_at } : null,
      delivery: { sentAt: row?.sent_at || document.submitted_at || null, to: draft?.to || document.submitted_to || null,
        messageId: row?.message_id || null, confirmedAt: row?.delivery_confirmed_at || null,
        confirmationOutcome: row?.delivery_confirmation_outcome || null, attemptedAt: row?.attempted_at || null },
      correction: correction ? { correctedAt: correction.corrected_at, previousPdfSha256: correction.before_pdf_sha256,
        correctedPdfSha256: correction.after_pdf_sha256, previousDeliveryAppliesToPreviousPdf: true } : null,
      message: `${correction ? 'The Worshipful Master signature was corrected. Earlier email history refers to the previous PDF. ' : ''}${missiveDraft
        ? `${state === 'sent' ? 'A previous email submission is recorded. This does not confirm receipt. ' : ['sending', 'uncertain'].includes(state) ? 'A previous delivery attempt remains unconfirmed. ' : ''}Automatic emailing to the District Deputy is turned off. ${missiveDraft.message}`
        : automaticDeliveryEnabled ? messages[state]
        : `${state === 'sent' ? 'A previous email submission is recorded. This does not confirm receipt. ' : ['sending', 'uncertain'].includes(state) ? 'A previous delivery attempt remains unconfirmed. ' : ''}${DISPENSATION_DELIVERY_DISABLED_MESSAGE}`}`,
    };
  }

  async function prepareLocked(document, row, context) {
    if (row?.message_raw) return row;
    const signed = buffer(document.signed_bytes);
    if (document.status !== 'completed' || !signed?.length) throw error(409, 'The dispensation must be fully signed before its email can be prepared.');
    const secretary = await dbGet(`SELECT 1 FROM document_signers WHERE document_id = ?
      AND signer_role IN ('secretary', 'assistant_secretary') AND signed_at IS NOT NULL LIMIT 1`, [document.id]);
    if (!secretary) throw error(409, 'A Secretary or Assistant Secretary signature is required before submission.');
    const unsigned = await dbGet(`SELECT 1 FROM document_signers WHERE document_id = ?
      AND signed_at IS NULL AND superseded_at IS NULL LIMIT 1`, [document.id]);
    if (unsigned) throw error(409, 'A required signature is still missing. Nothing was sent.');
    if (!row?.report_bytes) throw error(409, 'Add the corresponding report PDF before preparing the submission.');
    const to = configuredRecipient();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.to)) throw error(409, 'No valid District Deputy email is configured. Both documents remain saved.');
    const owner = await dbGet('SELECT name FROM users WHERE id = ?', [document.owner_user_id]);
    const title = plain(document.title || document.original_name || 'Dispensation', 220);
    const request = plain(document.parsed_preview || title, 2000);
    const summary = request.length <= 360 ? request : `${request.slice(0, 357).replace(/\s+\S*$/, '')}...`;
    const signedHash = hash(signed);
    const messageId = `<dispensation-${hash(Buffer.from(`${document.id}:${signedHash}:${row.report_sha256}`))}@stonesquare22pha.org>`;
    const draft = {
      ...to, filename: pdfName(document.original_name || title, 'signed-dispensation'), reportFilename: row.report_filename,
      subject: `Request for Dispensation: ${title}`,
      body: [`${to.name},`, '', `Attached are the signed dispensation and corresponding report from ${plain(lodgeName, 160)}.`,
        '', `Summary: ${summary}`, '', 'Please review the attached documents. Thank you for your consideration.',
        '', 'Fraternally,', plain(owner?.name || 'Worshipful Master', 120), `Worshipful Master, ${plain(lodgeName, 160)}`].join('\n'),
    };
    const preparedAt = now();
    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    const composed = await composer.sendMail({ from: mailFrom || 'Stone Square Lodge <noreply@stonesquare22pha.org>',
      to: draft.to, subject: draft.subject, text: draft.body, messageId, date: new Date(preparedAt),
      attachments: [{ filename: draft.filename, content: signed, contentType: 'application/pdf' },
        { filename: draft.reportFilename, content: buffer(row.report_bytes), contentType: 'application/pdf' }] });
    await dbRun(`UPDATE dispensation_submissions SET signed_sha256 = ?, message_id = ?, message_raw = ?,
      message_json = ?, prepared_at = ?, delivery_state = 'ready', delivery_error = NULL, updated_at = ? WHERE document_id = ?`,
    [signedHash, messageId, composed.message, JSON.stringify(draft), preparedAt, preparedAt, document.id]);
    await recordAudit(document.id, 'dispensation_submission_packet_prepared', context,
      { to: draft.to, signedSha256: signedHash, reportSha256: row.report_sha256, messageId });
    return dbGet('SELECT * FROM dispensation_submissions WHERE document_id = ?', [document.id]);
  }

  async function deliver(id, context = {}, { retry = false } = {}) {
    if (!automaticDeliveryEnabled) return packet(id);
    const claimed = await withTransaction(async () => {
      const document = await dbGet('SELECT * FROM documents WHERE id = ? FOR UPDATE', [id]);
      if (!document || document.template_kind !== 'dispensation_v1' || document.status !== 'completed' || document.submitted_at) return null;
      let row = await dbGet('SELECT * FROM dispensation_submissions WHERE document_id = ? FOR UPDATE', [id]);
      if (!row?.report_bytes || ['sending', 'sent', 'uncertain'].includes(row.delivery_state)
          || (row.delivery_state === 'failed' && !retry)) return null;
      try { row = await prepareLocked(document, row, context); }
      catch (cause) {
        await dbRun(`UPDATE dispensation_submissions SET delivery_state = 'failed', delivery_error = ?, updated_at = ? WHERE document_id = ?`, [cause.message, now(), id]);
        await recordAudit(id, 'dispensation_submission_failed', context, { reason: cause.message, beforeDelivery: true });
        return null;
      }
      const token = crypto.randomUUID();
      // Timestamp doubles as the client-visible attempt revision. Advance it even
      // when two owner-authorized attempts happen in the same millisecond.
      const attemptedAt = new Date(Math.max(Date.now(), (Date.parse(row.attempted_at) || 0) + 1)).toISOString();
      await dbRun(`UPDATE dispensation_submissions SET delivery_state = 'sending', delivery_token = ?,
        attempted_at = ?, delivery_error = NULL, updated_at = ? WHERE document_id = ?`, [token, attemptedAt, now(), id]);
      return { document, row, token, draft: JSON.parse(row.message_json) };
    });
    if (!claimed) return packet(id);
    const { document, row, token, draft } = claimed;
    let sent = false; let failure = null;
    try {
      sent = await sendEmail({ to: draft.to, subject: draft.subject, text: draft.body,
        messageId: row.message_id, raw: buffer(row.message_raw), attachments: [
          { filename: draft.filename, content: buffer(document.signed_bytes), contentType: 'application/pdf' },
          { filename: draft.reportFilename, content: buffer(row.report_bytes), contentType: 'application/pdf' },
        ] });
      if (!sent) failure = { state: 'failed', reason: 'Email delivery is not configured. Both signed documents are saved; retry after the mail service is connected.' };
    } catch (cause) {
      const rejected = Number(cause.responseCode) >= 400 || ['EAUTH', 'EDNS', 'ECONNECTION', 'ECONNREFUSED'].includes(cause.code)
        || cause.command === 'CONN' || cause.deliveryUncertain === false;
      failure = { state: rejected ? 'failed' : 'uncertain', reason: rejected
        ? 'The mail service refused the email. Both documents are saved; check the mail service and retry.'
        : 'The mail service did not confirm delivery. Check the sent message before retrying to avoid a duplicate.' };
    }
    const finishedAt = now();
    await withTransaction(async () => {
      await dbGet('SELECT id FROM documents WHERE id = ? FOR UPDATE', [id]);
      const result = await dbRun(`UPDATE dispensation_submissions SET delivery_state = ?, delivery_error = ?, sent_at = ?,
        delivery_token = NULL, updated_at = ? WHERE document_id = ? AND delivery_token = ?`,
      [sent ? 'sent' : failure.state, failure?.reason || null, sent ? finishedAt : null, finishedAt, id, token]);
      if (result.changes !== 1) return;
      if (sent) await dbRun(`UPDATE documents SET submitted_at = ?, submitted_to = ?, submitted_error = NULL WHERE id = ?`, [finishedAt, draft.to, id]);
      else await dbRun('UPDATE documents SET submitted_error = ? WHERE id = ?', [failure.reason, id]);
      await recordAudit(id, sent ? 'dispensation_submitted_to_district_deputy' : 'dispensation_submission_failed', context,
        { to: draft.to, messageId: row.message_id, signedSha256: row.signed_sha256, reportSha256: row.report_sha256,
          attachments: [draft.filename, draft.reportFilename], state: sent ? 'sent' : failure.state, reason: failure?.reason || null });
    });
    return packet(id);
  }

  async function saveReport(id, user, file, sourceLabel, context) {
    const bytes = buffer(file?.buffer);
    await validateSupportingReport(bytes);
    const digest = hash(bytes);
    await withTransaction(async () => {
      const document = await dbGet('SELECT * FROM documents WHERE id = ? FOR UPDATE', [id]);
      await documentFor(id, user);
      const previous = await dbGet('SELECT * FROM dispensation_submissions WHERE document_id = ? FOR UPDATE', [id]);
      if (previous?.report_sha256 === digest) return;
      const missiveDraft = missiveDraftStatus ? await missiveDraftStatus(id, user) : null;
      if (missiveDraft?.reportLocked) throw error(409, 'A Missive draft already uses this report. Keep its saved attachments together and review the draft in Missive.');
      if (previous?.message_raw || document.submitted_at) throw error(409, 'This submission packet is already prepared or sent. Its attached report cannot be replaced.');
      const savedAt = now();
      const filename = pdfName(file.originalname, 'corresponding-report');
      await dbRun(`INSERT INTO dispensation_submissions
        (document_id, report_bytes, report_filename, report_sha256, source_label, report_added_at, report_added_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET
        report_bytes = excluded.report_bytes, report_filename = excluded.report_filename, report_sha256 = excluded.report_sha256,
        source_label = excluded.source_label, report_added_at = excluded.report_added_at,
        report_added_by = excluded.report_added_by, delivery_state = NULL, delivery_error = NULL, updated_at = excluded.updated_at`,
      [id, bytes, filename, digest, plain(sourceLabel, 120), savedAt, user.id, savedAt]);
      await recordAudit(id, 'dispensation_supporting_report_associated', context,
        { filename, sha256: digest, sourceLabel: plain(sourceLabel, 120), replaced: Boolean(previous?.report_sha256) });
      // Commit the report and its existing draft-queue wakeup together. This
      // callback never creates a queue row for a historical signed document.
      if (onReportSaved) await onReportSaved(id, context);
    });
  }

  async function attachReport(id, user, file, sourceLabel, context) {
    await saveReport(id, user, file, sourceLabel, context);
    return automaticDeliveryEnabled ? deliver(id, context) : packet(id, user);
  }

  async function resolveDelivery(id, user, outcome, note, context = {}, expectedAttemptedAt) {
    if (!automaticDeliveryEnabled) throw error(409, DISPENSATION_DELIVERY_DISABLED_MESSAGE);
    if (!['delivered', 'not_delivered'].includes(outcome)) throw error(400, 'Confirm whether both documents were delivered or were not delivered.');
    const explanation = String(note || '').trim();
    if (explanation.length < 10 || explanation.length > 600) throw error(400, 'Add a verification note of 10 to 600 characters before resolving delivery.');
    await withTransaction(async () => {
      const document = await dbGet('SELECT * FROM documents WHERE id = ? FOR UPDATE', [id]);
      await documentFor(id, user);
      const row = await dbGet('SELECT * FROM dispensation_submissions WHERE document_id = ? FOR UPDATE', [id]);
      const stale = row?.delivery_state === 'sending' && Date.parse(row.attempted_at) < Date.now() - 300_000;
      if (document.status !== 'completed' || !row?.message_raw || !(row.delivery_state === 'uncertain' || stale)) {
        throw error(409, 'Only an uncertain completed submission can be resolved.');
      }
      if (!expectedAttemptedAt || expectedAttemptedAt !== row.attempted_at) {
        throw error(409, 'This delivery attempt changed. Reload the submission and verify the latest attempt before resolving it.');
      }
      const verifiedAt = now();
      await dbRun(`UPDATE dispensation_submissions SET delivery_state = ?, delivery_token = NULL,
        delivery_error = ?, delivery_confirmed_at = ?, delivery_confirmation_note = ?,
        delivery_confirmation_outcome = ?, sent_at = ?, updated_at = ? WHERE document_id = ?`,
      [outcome === 'delivered' ? 'sent' : 'failed', outcome === 'delivered' ? null : 'The owner confirmed no delivery and authorized a retry.',
        verifiedAt, explanation, outcome, outcome === 'delivered' ? verifiedAt : null, verifiedAt, id]);
      if (outcome === 'delivered') {
        const draft = JSON.parse(row.message_json);
        await dbRun('UPDATE documents SET submitted_at = ?, submitted_to = ?, submitted_error = NULL WHERE id = ?', [verifiedAt, draft.to, id]);
      }
      await recordAudit(id, 'dispensation_submission_delivery_resolved', context,
        { outcome, verificationNote: explanation, verifiedAt, messageId: row.message_id, attemptedAt: row.attempted_at,
          signedSha256: row.signed_sha256, reportSha256: row.report_sha256, ownerConfirmed: true });
    });
    return outcome === 'not_delivered' ? deliver(id, context, { retry: true }) : packet(id, user);
  }

  let scanning = false;
  async function runPending(broadcast = () => {}) {
    if (!automaticDeliveryEnabled) return;
    if (scanning) return;
    scanning = true;
    try {
      const interrupted = await markStaleDeliveries((id, details) => recordAudit(id, 'dispensation_submission_delivery_interrupted', {}, details));
      for (const row of interrupted) broadcast('queue_changed', { reason: 'dispensation_submission_interrupted', documentId: row.document_id });
      const waiting = await dbAll(`SELECT s.document_id FROM dispensation_submissions s
        JOIN documents d ON d.id = s.document_id WHERE d.status = 'completed'
        AND d.template_kind = 'dispensation_v1' AND d.submitted_at IS NULL
        AND s.report_bytes IS NOT NULL AND (s.delivery_state IS NULL OR s.delivery_state = 'ready')
        ORDER BY s.updated_at LIMIT 10`);
      for (const row of waiting) {
        await deliver(row.document_id);
        broadcast('queue_changed', { reason: 'dispensation_submission_delivery', documentId: row.document_id });
      }
    } finally { scanning = false; }
  }
  function startWorker(broadcast) {
    if (!automaticDeliveryEnabled) return () => {};
    const scan = () => runPending(broadcast).catch(cause => console.warn('Dispensation submission queue:', cause.message));
    void scan();
    const timer = setInterval(scan, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  function mount(app, { requireAuth, requireOwner, upload, broadcast, rateLimit }) {
    const owner = [requireAuth, requireOwner];
    const context = req => ({ actorUserId: req.user.id, ip: req.ip, userAgent: req.get('user-agent') || '' });
    const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (cause) { next(cause); } };
    app.get('/api/documents/:id/submission-packet', ...owner, route(async (req, res) => res.json({ packet: await packet(req.params.id, req.user) })));
    app.put('/api/documents/:id/supporting-report', ...owner,
      rateLimit({ key: 'dispensation-report-upload', maximum: 20, windowMs: 60 * 60 * 1000 }), upload.single('report'), route(async (req, res) => {
      await documentFor(req.params.id, req.user);
      // saveReport resolves immediately after its transaction commits. Wake the
      // worker before DTO reads, which may fail independently of that commit.
      await saveReport(req.params.id, req.user, req.file, req.body?.sourceLabel, context(req));
      if (onReportCommitted) onReportCommitted(req.params.id);
      broadcast('queue_changed', { reason: 'dispensation_report_associated', documentId: req.params.id });
      const result = automaticDeliveryEnabled ? await deliver(req.params.id, context(req)) : await packet(req.params.id, req.user);
      res.json({ packet: result, message: result.message });
    }));
    app.get('/api/documents/:id/supporting-report', ...owner, route(async (req, res) => {
      await documentFor(req.params.id, req.user);
      const row = await dbGet('SELECT report_bytes, report_filename FROM dispensation_submissions WHERE document_id = ?', [req.params.id]);
      if (!row?.report_bytes) throw error(404, 'No corresponding report PDF is attached.');
      const asciiName = row.report_filename.replace(/[^\x20-\x7e]/g, '_');
      const encodedName = encodeURIComponent(row.report_filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
      res.set('Content-Type', 'application/pdf').set('Content-Disposition',
        `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`).send(buffer(row.report_bytes));
    }));
    app.get('/api/documents/:id/submission-draft', ...owner, route(async (req, res) => {
      if (!automaticDeliveryEnabled) throw error(409, DISPENSATION_DELIVERY_DISABLED_MESSAGE);
      const result = await packet(req.params.id, req.user);
      if (!result.draft || result.state === 'awaiting_signature') throw error(409, 'The fully signed dispensation and corresponding report are required before an email can be prepared.');
      res.json({ draft: { ...result.draft, alreadySent: result.delivery.sentAt } });
    }));
    app.get('/api/documents/:id/submission-email', ...owner, route(async (req, res) => {
      if (!automaticDeliveryEnabled) throw error(409, DISPENSATION_DELIVERY_DISABLED_MESSAGE);
      const document = await documentFor(req.params.id, req.user);
      const row = await dbGet(`SELECT s.message_raw, (d.signed_bytes IS NOT NULL) AS has_signed
        FROM dispensation_submissions s JOIN documents d ON d.id = s.document_id WHERE s.document_id = ?`, [req.params.id]);
      if (document.status !== 'completed' || !row?.has_signed || !row?.message_raw) throw error(409, 'The fully signed dispensation and corresponding report are required before an email can be prepared.');
      res.set('Content-Type', 'message/rfc822').set('Content-Disposition', 'attachment; filename="dispensation-submission.eml"').send(buffer(row.message_raw));
    }));
    app.post('/api/documents/:id/submit', ...owner,
      rateLimit({ key: 'submit-ddgm', maximum: 20, windowMs: 60 * 60 * 1000 }), route(async (req, res) => {
      if (!automaticDeliveryEnabled) throw error(409, DISPENSATION_DELIVERY_DISABLED_MESSAGE);
      const document = await documentFor(req.params.id, req.user);
      if (document.status !== 'completed') throw error(409, 'Either secretary must sign before this dispensation can be submitted.');
      const before = await packet(document.id, req.user);
      if (['sent', 'sending', 'uncertain'].includes(before.state)) throw error(409, before.message);
      if (!before.report) throw error(409, 'Add the corresponding report PDF. Both attachments are required.');
      const result = await deliver(document.id, context(req), { retry: true });
      broadcast('queue_changed', { reason: 'dispensation_submission_delivery', documentId: document.id });
      res.status(result.state === 'sent' ? 200 : result.state === 'sending' ? 202 : 502).json({ packet: result, message: result.message, ...(result.state === 'sent' ? {} : { error: result.message }) });
    }));
    app.post('/api/documents/:id/submission-resolution', ...owner,
      rateLimit({ key: 'resolve-ddgm', maximum: 20, windowMs: 60 * 60 * 1000 }), route(async (req, res) => {
        const result = await resolveDelivery(req.params.id, req.user, req.body?.outcome, req.body?.note, context(req), req.body?.expectedAttemptedAt);
        broadcast('queue_changed', { reason: 'dispensation_submission_resolved', documentId: req.params.id });
        res.json({ packet: result, message: result.message });
      }));
  }
  return { automaticDeliveryEnabled, packet, deliver, attachReport, resolveDelivery, mount, runPending, startWorker };
}
