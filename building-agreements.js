import crypto from 'node:crypto';
import upng from '@pdf-lib/upng';
import { dbGet } from './db.js';
import { hasPermission } from './access-control.js';
import { buildingStoreHash } from './building-store.js';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unavailable = () => fail(503, 'The saved agreement could not be verified. Its original record has not been changed.');
const text = (value, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
const date = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';

function staticSignaturePng(bytes) {
  // Validate allocation bounds before the decoder reads compressed pixels.
  // Portal capture historically checked only byte length and PNG magic.
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') throw unavailable();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const depth = bytes[24], color = bytes[25];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000
      || !channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1
      || (Math.ceil(width * channels * depth / 8) + 1) * height > 32 * 1024 * 1024) throw unavailable();
  let offset = 8, count = 0, pixels = false, ended = false;
  while (offset < bytes.length) {
    if (++count > 2048 || offset + 12 > bytes.length) throw unavailable();
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > bytes.length - offset - 12
        || ['acTL', 'fcTL', 'fdAT'].includes(type) || (type === 'IHDR' && offset !== 8)) throw unavailable();
    if (type === 'IDAT') pixels = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw unavailable();
      ended = true; break;
    }
  }
  if (!pixels || !ended) throw unavailable();
}

function capturedSignature(label, name, title, at, data, expectedHash) {
  if (!data) return null;
  const match = typeof data === 'string' && data.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match || match[1].length > 500_000) throw unavailable();
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 250 || bytes.length > 375_000 || bytes.toString('base64') !== match[1]
      || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || !validHash(expectedHash) || hash(bytes) !== expectedHash || !date(at) || !text(name).trim()) throw unavailable();
  staticSignaturePng(bytes);
  try {
    const decoder = upng.default || upng;
    const image = decoder.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!image.width || !image.height || image.width * image.height > 8_000_000) throw unavailable();
  } catch { throw unavailable(); }
  return { label, name: text(name, 250), title: text(title, 250), at, image: data, sha256: expectedHash };
}

// Read-only presentation of separately captured terms, final authorization and
// handwriting. Original terms and signed fields are never merged or overwritten.
export function buildingAgreementRecord(request, expectedRevision) {
  const revision = hash(JSON.stringify(request));
  if (!expectedRevision || revision !== expectedRevision) throw fail(409, 'This request changed. Refresh it before opening the agreement.');
  const agreement = request?.agreement;
  if (!agreement || typeof agreement.text !== 'string' || !agreement.text.trim()) throw fail(404, 'No electronically captured agreement text is available for this request.');
  if (agreement.text.length > 200_000 || !validHash(agreement.textHash) || hash(agreement.text) !== agreement.textHash) throw unavailable();
  const signatures = [
    capturedSignature('Organization representative', agreement.signedBy, agreement.signedTitle, agreement.signedAt, agreement.signatureData, agreement.signatureHash),
    capturedSignature('Lodge authorization', agreement.lodgeSignature?.name, agreement.lodgeSignature?.title, agreement.lodgeSignature?.signedAt, agreement.lodgeSignature?.signatureData, agreement.lodgeSignature?.signatureHash),
    capturedSignature('Secretary attestation', agreement.secretaryAttestation?.name, agreement.secretaryAttestation?.title, agreement.secretaryAttestation?.attestedAt, agreement.secretaryAttestation?.signatureData, agreement.secretaryAttestation?.signatureHash),
  ].filter(Boolean);
  const authorization = agreement.lodgeAuthorization ? Object.fromEntries(
    ['date', 'record', 'fee', 'insurance', 'deposit', 'conditions'].map(key => [key, text(agreement.lodgeAuthorization[key])])) : null;
  const complete = request.status === 'approved' && agreement.reviewStatus === 'fully_executed';
  if (complete && (signatures.length !== 3 || !authorization || !authorization.date || !authorization.record || !authorization.fee
      || !['required', 'waived'].includes(authorization.insurance))) throw unavailable();
  return {
    requestId: request.id, revision, organization: text(request.org, 500), eventDate: text(request.date, 40),
    version: text(agreement.version, 100), status: complete ? 'fully_executed' : text(agreement.reviewStatus, 100) || 'pending',
    originalText: agreement.text, originalTextSha256: agreement.textHash, authorization, signatures,
    explanation: 'The original accepted terms are retained exactly as signed. Final Lodge authorization and captured signatures are shown separately below. Pending fields in the original terms have not been rewritten.',
  };
}

export async function readBuildingAgreement(id, expectedRevision) {
  const state = await dbGet('SELECT state FROM building_store_state WHERE id=1');
  const stored = await dbGet("SELECT value_text,value_sha256,expires_at FROM building_store_entries WHERE key='resv:all'");
  if (state?.state !== 'ready' || !stored || stored.expires_at !== null || buildingStoreHash(stored.value_text) !== stored.value_sha256) throw unavailable();
  let requests;
  try { requests = JSON.parse(stored.value_text); } catch { throw unavailable(); }
  if (!Array.isArray(requests)) throw unavailable();
  const request = requests.find(row => row?.id === id);
  if (!request) throw fail(404, 'Building request not found.');
  return buildingAgreementRecord(request, expectedRevision);
}

export function mountBuildingAgreementRoutes(app, { requireAuth, visibleRequest, read = readBuildingAgreement }) {
  app.get('/api/building/requests/:id/agreement', requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      if (!hasPermission(req.user, 'building.view')) throw fail(403, 'Building Requests is not enabled for your account.');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(req.params.id)) throw fail(404, 'Building request not found.');
      const request = await visibleRequest(req, req.params.id);
      // Reuse the portal's visibility rules. A status-only card never grants
      // access to private agreements or another officer's signature images.
      if (!request || request.statusOnly || !request.agreementText) throw fail(404, 'Building agreement not available to this account.');
      if (typeof req.query.revision !== 'string' || req.query.revision !== String(request.revision)) throw fail(409, 'This request changed. Refresh it before opening the agreement.');
      res.json({ agreement: await read(req.params.id, req.query.revision) });
    } catch (error) { next(error); }
  });
}
