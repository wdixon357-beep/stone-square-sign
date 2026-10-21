import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { connect, initSchema, dbGet, dbRun, withTransaction, close } from '../db.js';
import { createDispensationSubmissions, initDispensationSubmissionSchema } from '../dispensation-submissions.js';
import { createDispensationMissiveDrafts, initDispensationMissiveDraftSchema } from '../dispensation-missive-drafts.js';

assert.equal(process.env.DATABASE_URL || '', '');
assert.equal(process.env.PGLITE_DIR || '', '');
await connect(); await initSchema();
await initDispensationSubmissionSchema(); await initDispensationMissiveDraftSchema();
const at = new Date().toISOString();
await dbRun('INSERT INTO users(email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)',
  ['owner@example.invalid', 'unused', 'Fixture Owner', 'owner', at]);
const owner = await dbGet('SELECT * FROM users WHERE email = ?', ['owner@example.invalid']);
const makePdf = async width => { const pdf = await PDFDocument.create(); pdf.addPage([width, 700]); return Buffer.from(await pdf.save()); };
const signed = await makePdf(500), report = await makePdf(550), otherReport = await makePdf(600);
let networkCalls = 0;
const client = { configured: true,
  async createDraft() { networkCalls++; return { draftId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222' }; },
  async verifyDraft(receipt, snapshot) {
    networkCalls++;
    return { ...receipt, unsent: true, url: `https://mail.missiveapp.com/#inbox/conversations/${receipt.conversationId}`,
      attachments: snapshot.attachments.map(({ filename, sha256, size }) => ({ filename, sha256, size })) };
  },
};
const drafts = createDispensationMissiveDrafts({ client, from: 'owner@example.invalid', recipient: { to: 'deputy@example.invalid' } });
const packets = createDispensationSubmissions({ sendEmail: async () => { throw new Error('SMTP forbidden'); },
  addAudit: async () => {}, recipient: { to: 'deputy@example.invalid' },
  missiveDraftStatus: (id, user) => drafts.status(id, user),
  onReportSaved: (id, context) => drafts.enqueue(id, { ...context, onlyExisting: true }),
});
const attach = (id, bytes = report) => packets.attachReport(id, owner,
  { buffer: bytes, originalname: 'Corresponding event proposal.pdf' }, 'Isolated test', { actorUserId: owner.id });
async function make(id) {
  await dbRun(`INSERT INTO documents(id,title,original_name,stored_name,owner_user_id,file_bytes,signed_bytes,status,template_kind,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'partially_signed','dispensation_v1',?,?)`,
  [id, 'Sample event', 'Sample dispensation.pdf', 'unused', owner.id, signed, signed, at, at]);
  await dbRun(`INSERT INTO document_signers(document_id,signer_role,signer_name) VALUES (?,'secretary','Fixture Secretary')`, [id]);
}
async function finish(id) {
  return withTransaction(async () => {
    await dbRun("UPDATE document_signers SET signed_at = ? WHERE document_id = ? AND signer_role = 'secretary'", [at, id]);
    await dbRun("UPDATE documents SET status = 'completed' WHERE id = ?", [id]);
    await drafts.enqueue(id, { actorUserId: owner.id });
  });
}
try {
  await make('early-report');
  await attach('early-report');
  assert.equal(await dbGet('SELECT 1 FROM dispensation_missive_drafts WHERE document_id = ?', ['early-report']), undefined);
  await finish('early-report');
  assert.equal(networkCalls, 0, 'Saving a report and capturing signatures never waits for Missive.');
  assert.equal((await packets.packet('early-report', owner)).missiveDraft.state, 'pending');
  assert.equal((await packets.packet('early-report')).missiveDraft, undefined, 'Secretary completion packet contains no draft body, recipient, or receipt.');
  await assert.rejects(packets.packet('early-report', { ...owner, role: 'secretary' }), /Only the document owner/);
  await assert.rejects(packets.packet('early-report', { ...owner, id: owner.id + 1 }), /Only the document owner/);
  assert.equal((await drafts.processPending()).changed, 1);
  const packet = await packets.packet('early-report', owner);
  assert.equal(packet.automaticDeliveryEnabled, false);
  assert.equal(packet.missiveDraft.state, 'drafted'); assert.equal(packet.reportLocked, true);
  assert.equal(packet.delivery.sentAt, null, 'Saving a Missive draft never records email delivery.');
  await assert.rejects(attach('early-report', otherReport), /Missive draft already uses this report/);
  assert.deepEqual(Buffer.from((await dbGet('SELECT report_bytes FROM dispensation_submissions WHERE document_id = ?', ['early-report'])).report_bytes), report);
  await attach('early-report'); await drafts.processPending();
  assert.equal(networkCalls, 2, 'A duplicate file save preserves the existing draft.');
  await make('late-report'); await finish('late-report');
  assert.equal((await packets.packet('late-report', owner)).missiveDraft.state, 'awaiting_report');
  await attach('late-report');
  assert.equal((await packets.packet('late-report', owner)).missiveDraft.state, 'pending', 'Adding the matching report wakes the existing durable queue.');
  await make('historical');
  await dbRun("UPDATE documents SET status = 'completed' WHERE id = 'historical'");
  await dbRun("UPDATE document_signers SET signed_at = ? WHERE document_id = 'historical'", [at]);
  await attach('historical');
  assert.equal((await packets.packet('historical', owner)).missiveDraft.state, 'not_requested');
  assert.equal(await dbGet("SELECT 1 FROM dispensation_missive_drafts WHERE document_id = 'historical'"), undefined);
  await make('rollback');
  await assert.rejects(withTransaction(async () => { await finish('rollback'); throw new Error('Interrupted signature transaction'); }), /Interrupted signature/);
  assert.equal((await dbGet("SELECT status FROM documents WHERE id = 'rollback'")).status, 'partially_signed');
  assert.equal(await dbGet("SELECT 1 FROM dispensation_missive_drafts WHERE document_id = 'rollback'"), undefined);
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const transactionEnd = server.indexOf('return { documentId: document.id, status, remaining: remaining.total };');
  assert.ok(server.lastIndexOf('await dispensationMissiveDrafts.enqueue(document.id', transactionEnd) > server.lastIndexOf("action: 'document_completed'", transactionEnd), 'Production signature enqueues before its transaction commits.');
  assert.match(server, /missive-draft\/retry', requireAuth, requireOwner/);
  assert.match(server, /automaticDeliveryEnabled: false/);
  console.log('PASS: combined signature/report outbox integration, owner privacy, immutable attachments, no historical backfill, no SMTP sending, and atomic rollback.');
} finally { await close(); }
