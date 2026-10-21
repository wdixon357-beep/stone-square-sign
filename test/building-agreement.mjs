import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import upng from '@pdf-lib/upng';
import { connect, close, initSchema, dbGet, dbAll, dbRun } from '../db.js';
import { initBuildingStoreSchema, buildingStoreHash } from '../building-store.js';
import { buildingAgreementRecord, readBuildingAgreement, mountBuildingAgreementRoutes } from '../building-agreements.js';
import { buildingAgreementMarkup, attachBuildingAgreement } from '../public/building-agreement.js';

assert.equal(process.env.DATABASE_URL || '', '', 'Use only the isolated in-memory database.');
assert.equal(process.env.PGLITE_DIR || '', '', 'Do not use an existing local database.');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from((await readFile(new URL('./signature.b64', import.meta.url), 'utf8')).trim(), 'base64');
const image = 'data:image/png;base64,' + bytes.toString('base64');
const at = '2026-10-01T16:00:00.000Z';
const originalText = 'Original accepted agreement. Fee: [Pending].\n\n<em>Exact original text</em>';
const request = { id: 'SSL-SYNTHETIC', org: 'Synthetic organization', date: '2026-10-31', status: 'approved', statusAccessHash: 'synthetic-private-status-key',
  agreement: { text: originalText, textHash: hash(originalText), version: 'synthetic-v1', reviewStatus: 'fully_executed', signedBy: 'Synthetic Applicant', signedTitle: 'Representative', signedAt: at, signatureData: image, signatureHash: hash(bytes), verifiedEmail: 'private@example.test',
    lodgeAuthorization: { date: '2026-10-01', record: 'Synthetic recorded approval', fee: '$25', insurance: 'waived', deposit: 'waived', conditions: 'Recorded conditions' },
    lodgeSignature: { name: 'Synthetic Master', title: 'Worshipful Master', signedAt: at, signatureData: image, signatureHash: hash(bytes) },
    secretaryAttestation: { name: 'Synthetic Secretary', title: 'Secretary', attestedAt: at, signatureData: image, signatureHash: hash(bytes), email: 'private-secretary@example.test' } } };
const revision = hash(JSON.stringify(request));
const before = JSON.stringify(request);
const record = buildingAgreementRecord(request, revision);
assert.equal(record.originalText, originalText);
assert.equal(record.authorization.fee, '$25');
assert.equal(record.signatures.length, 3);
assert.ok(record.signatures.every(signature => signature.image === image && signature.sha256 === hash(bytes)));
assert.equal(record.status, 'fully_executed');
assert.equal(JSON.stringify(request), before, 'Presentation never rewrites original terms, signature bytes or fields.');
assert.doesNotMatch(JSON.stringify(record), /private@example|private-secretary|statusAccessHash|synthetic-private-status-key/);
assert.throws(() => buildingAgreementRecord(request, 'stale'), error => error.statusCode === 409);
for (const mutate of [r => { r.agreement.text += 'changed'; }, r => { r.agreement.secretaryAttestation.signatureHash = '0'.repeat(64); }, r => { delete r.agreement.lodgeSignature; }, r => { r.agreement.signatureData = 'data:image/svg+xml;base64,invalid'; }, r => { r.agreement.lodgeSignature.signedAt = 'not-a-date'; }]) {
  const altered = structuredClone(request); mutate(altered);
  assert.throws(() => buildingAgreementRecord(altered, hash(JSON.stringify(altered))), error => error.statusCode === 503);
}
const pending = structuredClone(request); pending.status = 'pending'; pending.agreement.reviewStatus = 'pending'; delete pending.agreement.lodgeSignature; delete pending.agreement.secretaryAttestation; delete pending.agreement.lodgeAuthorization;
assert.equal(buildingAgreementRecord(pending, hash(JSON.stringify(pending))).signatures.length, 1);

// These images have bounded compressed byte lengths and matching retained
// hashes. Header/frame bounds must reject them before any pixel inflation.
const decoder = upng.default || upng;
const originalDecode = decoder.decode;
let decodeCalls = 0;
decoder.decode = () => { decodeCalls++; throw Error('Pixel decoder must not run for adversarial headers.'); };
try {
  const huge = Buffer.from(bytes); huge.writeUInt32BE(0xffffffff, 16); huge.writeUInt32BE(0xffffffff, 20);
  const oversizedPixels = Buffer.from(bytes); oversizedPixels.writeUInt32BE(4096, 16); oversizedPixels.writeUInt32BE(4096, 20);
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8, 0); animation.write('acTL', 4); animation.writeUInt32BE(100000, 8);
  const animated = Buffer.concat([bytes.subarray(0, 33), animation, bytes.subarray(33)]);
  const invalidChunk = Buffer.from(bytes); invalidChunk.writeUInt32BE(0xffffffff, 33);
  for (const malicious of [huge, oversizedPixels, animated, invalidChunk]) {
    const altered = structuredClone(request);
    altered.agreement.signatureData = 'data:image/png;base64,' + malicious.toString('base64');
    altered.agreement.signatureHash = hash(malicious);
    assert.throws(() => buildingAgreementRecord(altered, hash(JSON.stringify(altered))), error => error.statusCode === 503);
  }
  assert.equal(decodeCalls, 0, 'Unsafe IHDR dimensions, pixel counts, APNG frames and oversized chunks are rejected before decode/inflate.');
} finally { decoder.decode = originalDecode; }

const native = await readFile(new URL('../macos/Sources/StoneSquareSign/BuildingCalendar.swift', import.meta.url), 'utf8');
const sheetGuards = native.slice(native.indexOf('.sheet(item: $recordedAgreement)'), native.indexOf('.updateDraftGuard('));
assert.match(sheetGuards, /if model\.user\?\.can\("building\.view"\) == true \{ BuildingAgreementRecordView/,
  'Visible native signature content remains guarded while permission updates are processed.');
assert.match(sheetGuards, /\.onChange\(of: model\.user\?\.can\("building\.view"\) \?\? false\) \{ _, mayView in if !mayView \{ recordedAgreement = nil \} \}/,
  'Revoking building.view for the same account clears the existing private sheet.');
assert.match(sheetGuards, /\.onChange\(of: model\.user\?\.id\).*recordedAgreement = nil/);
assert.match(sheetGuards, /\.onChange\(of: model\.user\?\.role\).*recordedAgreement = nil/);
assert.match(sheetGuards, /\.onChange\(of: selectedID\).*recordedAgreement = nil/);
const openAgreement = native.slice(native.indexOf('private func openAgreement('), native.indexOf('private struct BuildingAgreementRecordView:'));
assert.match(openAgreement, /model\.user\?\.id == userID, model\.user\?\.can\("building\.view"\) == true/);
assert.match(openAgreement, /selectedID == request\.id, selected\?\.revision == request\.revision/);

await connect(); let listener;
try {
  await initSchema(); await initBuildingStoreSchema();
  const raw = '[\n' + before + '\n]';
  await dbRun("UPDATE building_store_state SET state='ready' WHERE id=1");
  await dbRun('INSERT INTO building_store_entries(key,value_text,value_sha256,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', ['resv:all', raw, buildingStoreHash(raw), 7, null, at, at]);
  const storedBefore = await dbAll('SELECT * FROM building_store_entries');
  const stateBefore = await dbAll('SELECT * FROM building_store_state');
  assert.equal((await readBuildingAgreement(request.id, revision)).originalText, originalText);
  let reads = 0;
  const app = express();
  mountBuildingAgreementRoutes(app, { requireAuth: (req, res, next) => {
    const role = req.get('x-test-role'); if (!role) return res.status(401).json({ error: 'Sign in' });
    req.user = { id: 1, role, permissions_json: JSON.stringify(role === 'reader' ? ['building.view'] : []) }; next();
  }, visibleRequest: async (req, id) => req.user.role === 'owner' && id === request.id ? { id, revision, agreementText: originalText } : null,
  read: async (...args) => { reads++; return readBuildingAgreement(...args); } });
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const api = async (path, role) => { const response = await fetch(base + path, { headers: role ? { 'x-test-role': role } : {} }); return { response, data: await response.json() }; };
  const path = `/api/building/requests/${request.id}/agreement?revision=${revision}`;
  assert.equal((await api(path)).response.status, 401);
  assert.equal((await api(path, 'officer')).response.status, 403);
  assert.equal((await api(path, 'reader')).response.status, 404, 'Building capability does not bypass private portal visibility.');
  assert.equal((await api(path.replace(revision, 'stale'), 'owner')).response.status, 409);
  assert.equal(reads, 0, 'Unauthorized or stale requests never read the private source.');
  const result = await api(path, 'owner');
  assert.equal(result.response.status, 200); assert.equal(result.data.agreement.signatures.length, 3);
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.response.headers.get('pragma'), 'no-cache');
  assert.deepEqual(await dbAll('SELECT * FROM building_store_entries'), storedBefore);
  assert.deepEqual(await dbAll('SELECT * FROM building_store_state'), stateBefore);
  assert.equal((await dbGet('SELECT COUNT(*) AS n FROM building_store_receipts')).n, 0);
  assert.equal((await dbGet('SELECT COUNT(*) AS n FROM audit_events')).n, 0);
  await dbRun("UPDATE building_store_entries SET value_sha256=? WHERE key='resv:all'", ['0'.repeat(64)]);
  await assert.rejects(() => readBuildingAgreement(request.id, revision), error => error.statusCode === 503);
} finally { if (listener) await new Promise(resolve => listener.close(resolve)); await close(); }

const markup = buildingAgreementMarkup({ ...record, organization: '<img src=x onerror=alert(1)>' });
assert.ok(markup.includes('Original accepted terms') && markup.includes('[Pending]') && markup.includes('Recorded Lodge authorization') && markup.includes('Captured signatures'));
assert.ok(markup.includes('&lt;em&gt;Exact original text&lt;/em&gt;'));
assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
assert.equal((markup.match(/<img src="data:image\/png;base64,/g) || []).length, 3);
assert.doesNotMatch(buildingAgreementMarkup({ ...record, signatures: [{ ...record.signatures[0], image: 'javascript:alert(1)' }] }), /src="javascript/);

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.isConnected = true; this.attributes = {}; this.handlers = {}; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  set innerHTML(value) { this.html = value; this.children = value ? [{}] : []; }
  get childElementCount() { return this.children.length; }
}
globalThis.document = { createElement: tag => new Element(tag) };
let apiCalls = 0;
const card = new Element('article');
attachBuildingAgreement(card, { id: request.id, revision, agreementText: originalText, agreementStatus: 'fully_executed' }, { api: async path => { assert.ok(path.endsWith(`revision=${revision}`)); apiCalls++; return { agreement: record }; } });
const [button, message, details] = card.children[0].children;
await button.handlers.click(); assert.equal(apiCalls, 1); assert.equal(details.hidden, false); assert.equal(message.textContent, ''); assert.equal(button.attributes['aria-expanded'], 'true');
await button.handlers.click(); assert.equal(details.hidden, true); assert.equal(apiCalls, 1, 'Closing is local and never changes a record.');
const restricted = new Element('article'); attachBuildingAgreement(restricted, { agreementText: originalText, statusOnly: true }, { api: () => { throw Error('No call'); } }); assert.equal(restricted.children.length, 0);
const oldCard = new Element('article'); attachBuildingAgreement(oldCard, { id: request.id, revision, agreementText: originalText }, { api: async () => ({ agreement: record }), isCurrent: () => false });
await oldCard.children[0].children[0].handlers.click(); assert.equal(oldCard.children[0].children[2].childElementCount, 0, 'An account or view change discards a late private response.');
console.log('PASS building agreement: exact immutable source, all captured handwriting, source/signature hashes, stale revision, visibility, cache privacy, no record writes, escaped responsive inline view and late-account response protection.');
