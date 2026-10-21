import crypto from 'node:crypto';
import { dbGet, dbAll, dbRun, withTransaction } from './db.js';
import { validateSupportingReport } from './dispensation-submissions.js';
import { buildMissiveDraftRequest, createMissiveDraftClient } from './missive-draft-client.js';

const now = () => new Date().toISOString();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = (value, maximum = 180) => String(value || '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maximum);
const error = (code, message) => Object.assign(new Error(message), { statusCode: code });
const address = value => plain(value, 254).toLowerCase();
const validEmail = value => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value || '');
const decode = value => value ? JSON.parse(value) : null;
const fileName = (value, fallback) => {
  let name = plain(String(value || '').split(/[\\/]/).pop(), 150).replace(/["<>:|?*]/g, '-');
  if (!name) name = fallback;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
};
const claimLeaseMs = 5 * 60_000;

export async function initDispensationMissiveDraftSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS dispensation_missive_drafts (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    state TEXT NOT NULL, snapshot_json TEXT, payload_sha256 TEXT,
    signed_sha256 TEXT, report_sha256 TEXT, draft_id TEXT, conversation_id TEXT, draft_url TEXT,
    receipt_json TEXT, failure_code TEXT, failure_message TEXT, claim_token TEXT, claim_started_at TEXT,
    attempted_at TEXT, verified_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
    context_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS dispensation_missive_drafts_state_idx ON dispensation_missive_drafts(state, updated_at)');
}

export function createDispensationMissiveDrafts({ client = createMissiveDraftClient(), from = process.env.MISSIVE_DRAFT_FROM,
  recipient = {}, lodgeName = 'Stone Square Lodge No. 22', addAudit } = {}) {
  const configured = () => client.configured === true && validEmail(address(from)) && validEmail(address(recipient.to));
  const audit = async (id, action, context = {}, details = {}) => {
    if (addAudit) await addAudit({ documentId: id, action, userId: context.actorUserId || null, ip: context.ip || '', userAgent: context.userAgent || '', details });
    else await dbRun('INSERT INTO audit_events(document_id, action, details_json, created_at) VALUES (?, ?, ?, ?)', [id, action, JSON.stringify(details), now()]);
  };
  const safeContext = context => ({ actorUserId: Number.isInteger(context?.actorUserId) ? context.actorUserId : null,
    ip: plain(context?.ip, 100), userAgent: plain(context?.userAgent, 300) });
  async function documentFor(id, user, { lock = false } = {}) {
    const document = await dbGet(`SELECT * FROM documents WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!document) throw error(404, 'Document not found.');
    if (user && (user.role !== 'owner' || user.id !== document.owner_user_id)) throw error(403, 'Only the document owner can view or manage its Missive draft.');
    if (document.template_kind !== 'dispensation_v1') throw error(409, 'Missive dispensation drafts are available only for dispensations.');
    return document;
  }
  const excerpt = (value, maximumWords) => {
    const cleaned = plain(value, 2000); const words = cleaned.split(/\s+/).filter(Boolean);
    return words.length <= maximumWords ? cleaned : `${words.slice(0, maximumWords).join(' ')}…`;
  };
  const overview = (document, reportFilename) => {
    const title = plain(document.title || 'Dispensation request', 180)
      .replace(/^dispensation\s+request:\s*/i, '') || 'Dispensation request';
    let request = document.parsed_preview || '';
    // Current generators store requestDetails directly. Older structured previews
    // are supported only when the same explicit field can be read safely.
    if (/^\s*[\[{]/.test(request)) {
      try { const parsed = JSON.parse(request); request = parsed.requestDetails || parsed.request_details || ''; }
      catch { request = ''; }
    }
    const detail = excerpt(request, 32);
    const reportLabel = reportFilename ? `corresponding report (${excerpt(reportFilename, 10)})` : 'corresponding report';
    return { subject: `Dispensation request: ${title}`,
      body: `${detail ? `Request: ${detail}\n\n` : ''}Attached are the fully signed dispensation for ${excerpt(title, 12)} and its ${reportLabel} from ${plain(lodgeName, 100)}.` };
  };
  async function readiness(document) {
    if (document.status === 'rescinded') return { state: 'failed', code: 'rescinded', message: 'This dispensation was rescinded. No draft will be created.' };
    const signedSecretary = await dbGet(`SELECT 1 FROM document_signers WHERE document_id = ? AND signer_role IN ('secretary', 'assistant_secretary')
      AND signed_at IS NOT NULL AND superseded_at IS NULL LIMIT 1`, [document.id]);
    const unsigned = await dbGet('SELECT 1 FROM document_signers WHERE document_id = ? AND signed_at IS NULL AND superseded_at IS NULL LIMIT 1', [document.id]);
    if (document.status !== 'completed' || !document.signed_bytes?.length || !signedSecretary || unsigned) return { state: 'awaiting_signature' };
    const report = await dbGet('SELECT report_bytes, report_filename, report_sha256 FROM dispensation_submissions WHERE document_id = ?', [document.id]);
    if (!report?.report_bytes?.length || !report.report_sha256) return { state: 'awaiting_report' };
    return { state: 'ready', report };
  }
  async function snapshot(document, report) {
    const signed = Buffer.from(document.signed_bytes); const supporting = Buffer.from(report.report_bytes);
    await validateSupportingReport(signed); await validateSupportingReport(supporting);
    if (hash(supporting) !== report.report_sha256) throw error(409, 'The saved corresponding report does not match its recorded checksum. Nothing was drafted.');
    const signedName = fileName(document.original_name || document.title, 'signed-dispensation');
    let reportName = fileName(report.report_filename, 'corresponding-report');
    if (reportName === signedName) reportName = `Corresponding report - ${reportName}`;
    const result = { version: 1, documentId: document.id, ...overview(document, reportName), from: { address: address(from) },
      to: { address: address(recipient.to), name: plain(recipient.name, 120) }, attachments: [
        { filename: signedName, base64: signed.toString('base64'), size: signed.length, sha256: hash(signed) },
        { filename: reportName, base64: supporting.toString('base64'), size: supporting.length, sha256: hash(supporting) },
      ] };
    buildMissiveDraftRequest(result); return result;
  }
  async function refreshLocked(document, row, context) {
    // Once a network attempt starts, the immutable payload and its receipt are
    // never rebuilt from a later edit, attachment replacement, or signature fix.
    if (row.attempted_at || ['creating', 'drafted', 'uncertain'].includes(row.state)) return row;
    const ready = await readiness(document);
    let state = ready.state; let packet = null; let failureCode = ready.code || null; let failureMessage = ready.message || null;
    if (state === 'ready') {
      if (!configured()) state = 'not_configured';
      else {
        try { packet = await snapshot(document, ready.report); state = 'pending'; }
        catch (cause) { state = 'failed'; failureCode = cause.code || 'invalid_packet'; failureMessage = cause.message; }
      }
    }
    const timestamp = now();
    await dbRun(`UPDATE dispensation_missive_drafts SET state = ?, snapshot_json = ?, payload_sha256 = ?, signed_sha256 = ?, report_sha256 = ?,
      failure_code = ?, failure_message = ?, context_json = ?, updated_at = ? WHERE document_id = ?`, [state, packet ? JSON.stringify(packet) : null,
      packet ? hash(Buffer.from(JSON.stringify(packet))) : null, packet?.attachments[0].sha256 || null, packet?.attachments[1].sha256 || null,
      failureCode, failureMessage, JSON.stringify(safeContext(context)), timestamp, document.id]);
    if (row.state !== state) await audit(document.id, 'dispensation_missive_draft_state_changed', context, { before: row.state, state, reason: failureCode });
    return dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ?', [document.id]);
  }
  async function enqueue(id, context = {}) {
    await withTransaction(async () => {
      const document = await documentFor(id, null, { lock: true });
      let row = await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ? FOR UPDATE', [id]);
      if (!row && context.onlyExisting) return;
      if (!row) {
        // submitted_at belongs to historical SMTP/manual submissions. A generic
        // queue scan or report attachment may never turn those into new drafts.
        if (document.submitted_at) return;
        const timestamp = now();
        await dbRun(`INSERT INTO dispensation_missive_drafts(document_id, state, context_json, created_at, updated_at)
          VALUES (?, 'awaiting_signature', ?, ?, ?)`, [id, JSON.stringify(safeContext(context)), timestamp, timestamp]);
        await audit(id, 'dispensation_missive_draft_enqueued', context, { automaticSending: false });
        row = await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ?', [id]);
      }
      await refreshLocked(document, row, context);
    });
    return readStatus(id);
  }
  async function readStatus(id) {
    const document = await documentFor(id); const row = await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ?', [id]);
    let state = row?.state;
    if (!row) {
      const ready = await readiness(document);
      state = document.status === 'completed' ? 'not_requested' : ready.state;
    }
    const saved = decode(row?.snapshot_json);
    const sourceChanged = Boolean(row?.attempted_at && saved && !(await sourceMatches(id, saved)));
    if (sourceChanged) state = 'uncertain';
    const messageByState = {
      not_requested: 'No Missive draft has been requested for this existing dispensation. Nothing will be created automatically.',
      not_configured: 'Both documents are saved. Connect the Lodge’s Missive account to prepare an unsent email draft.',
      awaiting_signature: 'The unsent email draft waits for the required secretary signature.',
      awaiting_report: 'The secretary has signed. Add the corresponding report PDF to prepare the unsent Missive draft.',
      pending: row ? 'Both PDFs are ready. An unsent email draft is queued for Missive.' : 'No Missive draft has been requested for this existing dispensation.',
      creating: 'The unsent Missive draft is being created and its two PDF attachments are being checked.',
      drafted: 'An unsent draft with both verified PDFs is saved in Missive. Review and send it yourself.',
      uncertain: 'Missive has not confirmed the draft. Check Missive before creating another one to avoid a duplicate.',
      failed: 'The Missive draft could not be prepared. Both original documents remain saved.',
    };
    // Until a complete packet has been saved, no overview should claim that
    // missing or unsigned attachments already exist in an email draft.
    const preview = saved || {};
    return { state, message: sourceChanged ? 'The signed dispensation or corresponding report changed after this draft attempt. Check the earlier draft in Missive before proceeding.' : row?.failure_message || messageByState[state], subject: preview.subject, body: preview.body,
      draftId: row?.draft_id || null, conversationId: row?.conversation_id || null, url: state === 'drafted' ? row.draft_url : null,
      createdAt: row?.verified_at || null, queuedAt: row?.created_at || null, updatedAt: row?.updated_at || null,
      canRetry: Boolean(row && !sourceChanged && configured() && ((row.state === 'failed' && !row.draft_id && row.failure_code !== 'rescinded') || (row.state === 'uncertain' && row.draft_id))),
      reportLocked: Boolean(row?.attempted_at), automaticSendingEnabled: false };
  }
  async function status(id, user) {
    if (!user) throw error(403, 'Only the document owner can view or manage its Missive draft.');
    await documentFor(id, user); return readStatus(id);
  }
  async function sourceMatches(id, packet) {
    const document = await documentFor(id); const ready = await readiness(document);
    return ready.state === 'ready' && hash(Buffer.from(document.signed_bytes)) === packet.attachments[0].sha256
      && hash(Buffer.from(ready.report.report_bytes)) === packet.attachments[1].sha256 && ready.report.report_sha256 === packet.attachments[1].sha256;
  }
  async function processOne(id) {
    const claim = await withTransaction(async () => {
      const document = await documentFor(id, null, { lock: true });
      let row = await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ? FOR UPDATE', [id]);
      if (!row) return null;
      if (row.state === 'creating') {
        if (Date.parse(row.claim_started_at) >= Date.now() - claimLeaseMs) return null;
        await dbRun(`UPDATE dispensation_missive_drafts SET state = 'uncertain', claim_token = NULL, failure_code = 'worker_interrupted',
          failure_message = ?, updated_at = ? WHERE document_id = ?`, ['Draft preparation was interrupted. Check Missive before creating another draft.', now(), id]);
        await audit(id, 'dispensation_missive_draft_interrupted', {}, { draftId: row.draft_id || null });
        return null;
      }
      if (['awaiting_signature','awaiting_report','not_configured'].includes(row.state)) row = await refreshLocked(document, row, decode(row.context_json) || {});
      if (row.state !== 'pending' || !configured()) return null;
      const packet = decode(row.snapshot_json);
      if (!packet || hash(Buffer.from(JSON.stringify(packet))) !== row.payload_sha256) {
        await dbRun(`UPDATE dispensation_missive_drafts SET state = 'failed', failure_code = 'snapshot_mismatch', failure_message = ?, updated_at = ? WHERE document_id = ?`, ['The saved draft packet could not be verified. No new draft was created.', now(), id]);
        return null;
      }
      if (!(await sourceMatches(id, packet))) {
        await dbRun(`UPDATE dispensation_missive_drafts SET state = ?, failure_code = 'source_changed', failure_message = ?, updated_at = ? WHERE document_id = ?`, [row.draft_id ? 'uncertain' : 'failed', 'The signed dispensation or corresponding report changed. Check any existing draft in Missive before proceeding.', now(), id]);
        return null;
      }
      const token = crypto.randomUUID(); const timestamp = now();
      await dbRun(`UPDATE dispensation_missive_drafts SET state = 'creating', claim_token = ?, claim_started_at = ?, attempted_at = COALESCE(attempted_at, ?),
        attempt_count = attempt_count + 1, failure_code = NULL, failure_message = NULL, updated_at = ? WHERE document_id = ?`, [token, timestamp, timestamp, timestamp, id]);
      await audit(id, 'dispensation_missive_draft_attempted', decode(row.context_json) || {}, { payloadSha256: row.payload_sha256, verifyingExisting: Boolean(row.draft_id), automaticSending: false });
      return { packet, token, row };
    });
    if (!claim) return;
    const { packet, token, row } = claim;
    let receipt = row.draft_id ? { draftId: row.draft_id, conversationId: row.conversation_id } : null;
    let verified = null; let failure = null;
    try {
      if (!receipt) {
        receipt = await client.createDraft(packet);
        if (!receipt?.draftId) throw Object.assign(new Error('Missive did not return a usable draft receipt. Check Missive before creating another draft.'), { code: 'create_unconfirmed', ambiguous: true });
        // Persist the provider receipt before any readback or attachment network
        // call. Recovery with an ID can only verify that same draft.
        const saved = await dbRun(`UPDATE dispensation_missive_drafts SET draft_id = ?, conversation_id = ?, receipt_json = ?, updated_at = ? WHERE document_id = ? AND claim_token = ?`,
          [receipt.draftId, receipt.conversationId || null, JSON.stringify(receipt), now(), id, token]);
        if (saved.changes !== 1) return;
      }
      verified = await client.verifyDraft(receipt, packet);
      if (!verified?.unsent || verified.draftId !== receipt.draftId || verified.attachments?.length !== 2
          || verified.attachments.some((item, index) => item.sha256 !== packet.attachments[index].sha256 || item.filename !== packet.attachments[index].filename)) {
        throw Object.assign(new Error('The unsent draft and both exact PDFs could not be verified.'), { code: 'readback_mismatch', ambiguous: true });
      }
    } catch (cause) {
      failure = { state: receipt || cause.ambiguous !== false ? 'uncertain' : 'failed', code: plain(cause.code || 'provider_error', 80),
        message: plain(cause.message || 'Missive could not confirm the unsent draft. Check Missive before creating another one.', 500) };
    }
    await withTransaction(async () => {
      await documentFor(id, null, { lock: true });
      if (!failure && !(await sourceMatches(id, packet))) failure = { state: 'uncertain', code: 'source_changed', message: 'The draft was created from an earlier document version. Check it in Missive before proceeding.' };
      const result = await dbRun(`UPDATE dispensation_missive_drafts SET state = ?, claim_token = NULL, failure_code = ?, failure_message = ?,
        conversation_id = COALESCE(?, conversation_id), draft_url = ?, receipt_json = COALESCE(?, receipt_json), verified_at = ?, updated_at = ? WHERE document_id = ? AND claim_token = ?`,
        [failure?.state || 'drafted', failure?.code || null, failure?.message || null, verified?.conversationId || null,
          !failure ? verified.url : null, verified ? JSON.stringify(verified) : null, !failure ? now() : null, now(), id, token]);
      if (result.changes === 1) await audit(id, failure ? 'dispensation_missive_draft_unconfirmed' : 'dispensation_missive_draft_verified', decode(row.context_json) || {},
        { state: failure?.state || 'drafted', reason: failure?.code || null, draftId: receipt?.draftId || null, payloadSha256: row.payload_sha256,
          signedSha256: row.signed_sha256, reportSha256: row.report_sha256, automaticSending: false });
    });
  }
  async function processPending({ limit = 3 } = {}) {
    const bounded = Math.min(10, Math.max(1, Number(limit) || 3));
    const rows = await dbAll(`SELECT document_id FROM dispensation_missive_drafts WHERE state IN ('awaiting_signature','awaiting_report','not_configured','pending','creating') ORDER BY updated_at, document_id LIMIT ?`, [bounded]);
    let changed = 0;
    for (const row of rows) {
      const before = await dbGet('SELECT state, draft_id, verified_at, failure_code FROM dispensation_missive_drafts WHERE document_id = ?', [row.document_id]);
      await processOne(row.document_id);
      const after = await dbGet('SELECT state, draft_id, verified_at, failure_code FROM dispensation_missive_drafts WHERE document_id = ?', [row.document_id]);
      if (JSON.stringify(before) !== JSON.stringify(after)) changed++;
    }
    return { checked: rows.length, changed };
  }
  async function retry(id, user, context = {}) {
    if (!user) throw error(403, 'Only the document owner can view or manage its Missive draft.');
    await withTransaction(async () => {
      const document = await documentFor(id, user, { lock: true });
      const row = await dbGet('SELECT * FROM dispensation_missive_drafts WHERE document_id = ? FOR UPDATE', [id]);
      if (!row || !configured()) throw error(409, 'Connect the Lodge’s Missive account before retrying a queued draft.');
      if (row.state === 'uncertain' && row.draft_id) {
        await dbRun(`UPDATE dispensation_missive_drafts SET state = 'pending', updated_at = ? WHERE document_id = ?`, [now(), id]);
      } else if (row.state === 'failed' && row.failure_code !== 'rescinded' && !row.draft_id) {
        await dbRun(`UPDATE dispensation_missive_drafts SET attempted_at = NULL, state = 'awaiting_report', updated_at = ? WHERE document_id = ?`, [now(), id]);
        await refreshLocked(document, { ...row, attempted_at: null, state: 'awaiting_report' }, context);
      } else throw error(409, 'This draft cannot be created again safely. Check its current state in Missive first.');
      await audit(id, 'dispensation_missive_draft_retry_requested', context, { verifyingExisting: Boolean(row.draft_id), automaticSending: false });
    });
    return readStatus(id);
  }
  return { enqueue, status, retry, processPending };
}
