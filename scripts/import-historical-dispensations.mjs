import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();
const { close, connect, dbGet, dbRun, initSchema } = await import('../db.js');

const sourceDir = '/Users/williamdixon-saunders/Desktop/Stone Square 22 Dispensations';
const signaturePath = '/Users/williamdixon-saunders/Documents/Codex/2026-08-16/i-n/work/dispensation-import/w-aaron-dixon-saunders-signature.png';
const ownerEmail = 'brodixonsaunders@stonesquare22pha.org';

const records = [
  {
    id: 'historical-2026-06-05-cancel-june-18',
    file: '1. 2026-06-05 Cancel the June 18 Stated Communication (not granted).pdf',
    title: 'Cancel June 18 Stated Communication (Not Granted)',
    documentDate: '2026-06-05',
    completedDate: '2026-06-05',
    outcome: 'not_granted',
    secretary: 'William McDuffie',
  },
  {
    id: 'historical-2026-06-11-mot-camp-fish-fry',
    file: '2. 2026-06-11 MOT Camp Fish Fry, July 19 (approved).pdf',
    title: 'MOT Camp Fish Fry, July 19 (Approved)',
    documentDate: '2026-06-11',
    completedDate: '2026-06-11',
    outcome: 'approved',
    secretary: 'William M. McDuffie',
  },
  {
    id: 'historical-2026-06-17-relay-for-life',
    file: '3. 2026-06-17 Relay For Life, September 12 (approved).pdf',
    title: 'Relay For Life, September 12 (Approved)',
    documentDate: '2026-06-17',
    completedDate: '2026-06-18',
    outcome: 'approved',
    secretary: 'William McDuffie',
  },
];

await connect();
await initSchema();

try {
  let owner = await dbGet("SELECT * FROM users WHERE role = 'owner' ORDER BY id LIMIT 1");
  if (!owner) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12);
    const inserted = await dbRun(
      `INSERT INTO users (email, password_hash, name, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
      ['worshipful-master@stone-square.local', passwordHash, 'W. Aaron Dixon-Saunders', new Date().toISOString()],
    );
    owner = await dbGet('SELECT * FROM users WHERE id = ?', [inserted.lastID]);
  }

  const signature = await fs.readFile(signaturePath);
  await dbRun(
    `INSERT INTO profile_signatures (user_id, signature_bytes, signature_type, style_name, updated_at)
     VALUES (?, ?, 'drawn', 'historical-docusign-original', ?)
     ON CONFLICT(user_id) DO UPDATE SET signature_bytes = excluded.signature_bytes,
       signature_type = excluded.signature_type, style_name = excluded.style_name,
       updated_at = excluded.updated_at`,
    [owner.id, signature, new Date().toISOString()],
  );

  for (const record of records) {
    const bytes = await fs.readFile(path.join(sourceDir, record.file));
    await dbRun(
      `INSERT INTO documents
       (id, title, original_name, stored_name, owner_user_id, owner_email, file_bytes,
        signed_bytes, status, parsed_preview, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, original_name = excluded.original_name,
         stored_name = excluded.stored_name, owner_user_id = excluded.owner_user_id,
         owner_email = excluded.owner_email, file_bytes = excluded.file_bytes,
         signed_bytes = excluded.signed_bytes, status = 'completed',
         parsed_preview = excluded.parsed_preview, created_at = excluded.created_at,
         updated_at = excluded.updated_at, completed_at = excluded.completed_at`,
      [
        record.id,
        record.title,
        record.file,
        record.file,
        owner.id,
        ownerEmail,
        bytes,
        bytes,
        `Historical completed dispensation. Outcome: ${record.outcome}.`,
        record.documentDate,
        record.completedDate,
        record.completedDate,
      ],
    );

    await dbRun('DELETE FROM document_signers WHERE document_id = ?', [record.id]);
    await dbRun(
      `INSERT INTO document_signers
       (document_id, user_id, signer_role, signer_name, signed_at, signature_bytes, consent_text)
       VALUES (?, ?, 'worshipful_master', 'W. Aaron Dixon-Saunders', ?, ?, ?)`,
      [record.id, owner.id, record.completedDate, signature, 'Historical signed record imported from completed DocuSign PDF.'],
    );
    await dbRun(
      `INSERT INTO document_signers
       (document_id, user_id, signer_role, signer_name, signed_at, consent_text)
       VALUES (?, NULL, 'secretary', ?, ?, ?)`,
      [record.id, record.secretary, record.completedDate, 'Historical secretary signature retained in the completed PDF.'],
    );

    await dbRun(
      "DELETE FROM audit_events WHERE document_id = ? AND action = 'historical_document_imported'",
      [record.id],
    );
    await dbRun(
      `INSERT INTO audit_events (user_id, document_id, action, details_json, created_at)
       VALUES (?, ?, 'historical_document_imported', ?, ?)`,
      [
        owner.id,
        record.id,
        JSON.stringify({ source: record.file, outcome: record.outcome, originalSignedPdfPreserved: true }),
        record.completedDate,
      ],
    );
  }

  console.log(`Imported ${records.length} completed dispensations and saved the Worshipful Master signature.`);
} finally {
  await close();
}
