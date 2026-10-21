import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

// Official API contract: https://missiveapp.com/docs/developers/rest-api/endpoints.md
// Missive does not document a create-draft idempotency key. A lost POST response
// must be reconciled, never retried as a new creation automatically.
export const MISSIVE_MAX_PAYLOAD_BYTES = 10_000_000;
const API = 'https://public.missiveapp.com/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
const normalizeAddress = value => String(value || '').trim().toLowerCase();
const normalizePlainText = value => String(value || '').replace(/\s+/g, ' ').trim();
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = value => String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
export class MissiveDraftError extends Error {
  constructor(code, message, { ambiguous = false, receipt = null } = {}) {
    super(message); this.name = 'MissiveDraftError'; this.code = code; this.ambiguous = ambiguous; this.receipt = receipt;
  }
}
const problem = (code, message, options) => new MissiveDraftError(code, message, options);

const privateNetworks = new net.BlockList();
for (const [base, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) privateNetworks.addSubnet(base, bits, 'ipv4');
for (const [base, bits] of [['::',96],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]]) privateNetworks.addSubnet(base,bits,'ipv6');
export function safeAttachmentUrl(value) {
  let url; try { url = new URL(value); } catch { throw problem('unsafe_attachment_url', 'Missive returned an invalid attachment link.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !host.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || (net.isIP(host) && privateNetworks.check(host, net.isIP(host) === 6 ? 'ipv6' : 'ipv4'))) {
    throw problem('unsafe_attachment_url', 'Missive returned an unsafe attachment link.');
  }
  return url;
}

// Download provider-signed attachments without the API token. Pin a public DNS
// result to the actual TLS connection, disallow redirects, and cap every read.
function downloadAttachment(value, { maxBytes, timeoutMs }) {
  const url = safeAttachmentUrl(value);
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/pdf' }, lookup(host, options, callback) {
      dns.lookup(host, { all: true }, (cause, addresses) => {
        if (cause) return callback(cause);
        const valid = addresses?.filter(item => net.isIP(item.address) && !privateNetworks.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4'));
        if (!valid?.length || valid.length !== addresses.length) return callback(problem('unsafe_attachment_url', 'The attachment host did not resolve to a public address.'));
        return options?.all ? callback(null, [valid[0]]) : callback(null, valid[0].address, valid[0].family);
      });
    } }, response => {
      if (response.statusCode !== 200) { response.resume(); return reject(problem('attachment_unavailable', 'The draft attachment could not be checked.')); }
      if (Number(response.headers['content-length'] || 0) > maxBytes) { response.destroy(); return reject(problem('attachment_too_large', 'The draft attachment exceeds its expected size.')); }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) response.destroy(problem('attachment_too_large', 'The draft attachment exceeds its expected size.')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(problem('attachment_timeout', 'The draft attachment check timed out.')));
    request.on('error', reject); request.end();
  });
}

export function buildMissiveDraftRequest(snapshot) {
  if (!email(snapshot?.from?.address) || !email(snapshot?.to?.address) || !snapshot.subject || !snapshot.body || !Array.isArray(snapshot.attachments) || snapshot.attachments.length !== 2) {
    throw problem('invalid_packet', 'The Missive draft needs a sender, recipient, overview, and both PDFs.');
  }
  const names = new Set();
  const attachments = snapshot.attachments.map(item => {
    const bytes = Buffer.from(item.base64 || '', 'base64');
    if (!/^[^\\/\u0000-\u001f]+\.pdf$/i.test(item.filename || '') || names.has(item.filename) || !bytes.length || !bytes.subarray(0,8).toString('ascii').startsWith('%PDF-') || sha(bytes) !== item.sha256 || bytes.length !== item.size) {
      throw problem('invalid_packet', 'The saved draft PDFs could not be verified.');
    }
    names.add(item.filename); return { filename: item.filename, base64_data: bytes.toString('base64') };
  });
  // These values are built here rather than accepted from callers. This client
  // has no sending, scheduling, reply, sharing, or arbitrary endpoint method.
  const payload = { drafts: { subject: String(snapshot.subject), body: `<div>${escape(snapshot.body).replace(/\n/g, '<br>')}</div>`,
    from_field: { address: normalizeAddress(snapshot.from.address) }, to_fields: [{ address: normalizeAddress(snapshot.to.address), ...(snapshot.to.name ? { name: snapshot.to.name } : {}) }],
    send: false, add_default_signature: true, quote_previous_message: false, attachments } };
  if (Buffer.byteLength(JSON.stringify(payload)) > MISSIVE_MAX_PAYLOAD_BYTES) throw problem('payload_too_large', 'Both PDFs together exceed Missive’s 10 MB draft limit. Save smaller PDFs before retrying.');
  return payload;
}

export function createMissiveDraftClient({ token = process.env.MISSIVE_API_TOKEN, fetchImpl = globalThis.fetch, downloadImpl = downloadAttachment, timeoutMs = 20_000 } = {}) {
  const configured = Boolean(typeof token === 'string' && token.trim());
  const deadline = Math.min(30_000, Math.max(1000, Number(timeoutMs) || 20_000));
  async function api(path, { method = 'GET', body } = {}) {
    if (!configured) throw problem('not_configured', 'Connect the Lodge’s Missive account to save email drafts.');
    let response;
    try { response = await fetchImpl(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(deadline) }); }
    catch { throw problem('network_outcome_unknown', method === 'POST' ? 'Missive did not confirm the draft. Check Missive before creating another one.' : 'Missive could not be reached to verify this draft.', { ambiguous: true }); }
    if (!response.ok) {
      // A server/timeout response may follow acceptance. Only a documented client
      // refusal gives permission to retry creation without first reconciling it.
      const definitive = method === 'POST' && [400,401,403,404,413,422,429].includes(response.status);
      throw problem(`http_${response.status}`, definitive ? 'Missive refused the draft. Check the connection and attachment sizes, then retry.' : 'Missive has not confirmed this draft. Check Missive before creating another one.', { ambiguous: !definitive });
    }
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > 2_000_000) throw problem('invalid_response', 'Missive’s response could not be verified.', { ambiguous: true });
    let raw;
    try {
      if (response.body?.getReader) {
        const reader = response.body.getReader(); const chunks = []; let received = 0;
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            received += part.value.length;
            if (received > 2_000_000) { await reader.cancel(); throw new Error('Oversized response'); }
            chunks.push(Buffer.from(part.value));
          }
          raw = Buffer.concat(chunks).toString('utf8');
        } finally { reader.releaseLock(); }
      } else { raw = await response.text(); if (Buffer.byteLength(raw) > 2_000_000) throw new Error('Oversized response'); }
      return raw ? JSON.parse(raw) : {};
    } catch { throw problem('invalid_response', 'Missive’s response could not be verified.', { ambiguous: true }); }
  }
  async function createDraft(snapshot) {
    const payload = buildMissiveDraftRequest(snapshot);
    const result = await api('/drafts', { method: 'POST', body: payload });
    const draft = Array.isArray(result?.drafts) ? result.drafts[0] : result?.drafts;
    const draftId = draft?.id;
    const conversationId = typeof draft?.conversation === 'string' ? draft.conversation : draft?.conversation?.id;
    if (!UUID.test(draftId || '')) throw problem('create_unconfirmed', 'Missive may have created the draft, but did not return a usable receipt. Check Missive before creating another one.', { ambiguous: true });
    return { draftId, conversationId: UUID.test(conversationId || '') ? conversationId : null };
  }
  async function verifyDraft(receipt, snapshot) {
    if (!UUID.test(receipt?.draftId || '')) throw problem('invalid_receipt', 'The saved Missive draft receipt is invalid.', { ambiguous: true });
    const fetched = await api(`/messages/${receipt.draftId}`);
    const message = Array.isArray(fetched.messages) ? fetched.messages.find(item => item.id === receipt.draftId) : fetched.messages;
    const conversationId = message?.conversation?.id || receipt.conversationId;
    if (message?.id !== receipt.draftId || !UUID.test(conversationId || '') || (receipt.conversationId && receipt.conversationId !== conversationId)) throw problem('readback_mismatch', 'The Missive draft receipt did not match its saved conversation.', { ambiguous: true, receipt });
    const listed = await api(`/conversations/${conversationId}/drafts`);
    const draft = listed?.drafts?.find?.(item => item.id === receipt.draftId);
    if (!draft || draft.draft !== true || draft.delivered_at != null || message.delivered_at != null || message.draft === false || message.send_at || draft.send_at) throw problem('not_unsent_draft', 'This item could not be confirmed as an unsent draft. Check it in Missive.', { ambiguous: true, receipt });
    const recipients = message.to_fields || [];
    if (message.type !== 'email' || normalizeAddress(message.from_field?.address) !== normalizeAddress(snapshot.from.address) || recipients.length !== 1
        || normalizeAddress(recipients[0]?.address) !== normalizeAddress(snapshot.to.address) || (message.cc_fields || []).length || (message.bcc_fields || []).length || message.subject !== snapshot.subject
        || !(text(message.body) === normalizePlainText(snapshot.body) || text(message.body).startsWith(`${normalizePlainText(snapshot.body)} `))) throw problem('readback_mismatch', 'The draft’s sender, recipient, subject, or overview did not match the saved packet.', { ambiguous: true, receipt });
    const returned = message.attachments || []; const verifiedAttachments = [];
    for (const expected of snapshot.attachments) {
      const matches = returned.filter(item => item.filename === expected.filename);
      if (matches.length !== 1 || matches[0].size !== expected.size || matches[0].extension?.toLowerCase() !== 'pdf') throw problem('attachment_mismatch', 'Both exact PDF attachments could not be confirmed in Missive.', { ambiguous: true, receipt });
      const item = matches[0]; safeAttachmentUrl(item.url);
      let bytes; try { bytes = Buffer.from(await downloadImpl(item.url, { maxBytes: expected.size, timeoutMs: deadline })); }
      catch { throw problem('attachment_unverified', 'The draft is saved, but its PDF contents could not yet be verified.', { ambiguous: true, receipt }); }
      if (bytes.length !== expected.size || sha(bytes) !== expected.sha256) throw problem('attachment_mismatch', 'A draft PDF did not match the exact signed packet. Check Missive before proceeding.', { ambiguous: true, receipt });
      verifiedAttachments.push({ id: item.id, filename: item.filename, size: bytes.length, sha256: sha(bytes) });
    }
    const extras = returned.filter(item => !snapshot.attachments.some(expected => expected.filename === item.filename));
    if (extras.some(item => item.media_type !== 'image' || !String(message.body).includes(`data-missive-attachment-id="${item.id}"`))) throw problem('attachment_mismatch', 'The draft contains an unexpected attachment. Check it in Missive.', { ambiguous: true, receipt });
    return { draftId: receipt.draftId, conversationId, url: `https://mail.missiveapp.com/#inbox/conversations/${conversationId}`,
      verifiedAt: new Date().toISOString(), unsent: true, from: normalizeAddress(message.from_field.address), to: normalizeAddress(recipients[0].address),
      subject: message.subject, overviewSha256: sha(Buffer.from(snapshot.body)), providerBodySha256: sha(Buffer.from(message.body)), attachments: verifiedAttachments };
  }
  return { configured, createDraft, verifyDraft };
}
