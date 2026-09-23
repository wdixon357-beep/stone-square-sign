import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { dbAll, dbGet, dbRun } from './db.js';
import { AGENDA_OFFICERS } from './agenda.js';
import { resolvePermissions } from './access-control.js';

const eligible = user => ['owner', 'secretary', 'assistant_secretary'].includes(user?.role)
  && (user.role === 'owner' || user.permissions?.includes('reports.create'));
const office = role => ({ owner: 'Worshipful Master', secretary: 'Secretary', assistant_secretary: 'Assistant Secretary' })[role];
const clean = (value, limit) => String(value ?? '').trim().slice(0, limit);
const nextRevisionTime = row => new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
const data = body => ({
  matter: ['demit', 'general'].includes(body?.matter) ? body.matter : 'general',
  recipientLodge: clean(body?.recipientLodge, 160),
  recipientName: clean(body?.recipientName, 160),
  subject: clean(body?.subject, 200),
  body: clean(body?.body, 12000),
});
const dto = row => ({
  id: row.id, matter: row.matter, recipientLodge: row.recipient_lodge,
  recipientName: row.recipient_name, subject: row.subject, body: row.body,
  status: row.status, preparedByName: row.prepared_by_name,
  preparedByOffice: row.prepared_by_office, preparedByUserId: row.prepared_by_user_id,
  assignedToUserId: row.assigned_to_user_id, assignedToName: row.assigned_to_name,
  assignedToOffice: row.assigned_to_office,
  signingMode: row.signing_mode || 'single',
  sharedSignerUserIds: [row.shared_signer_1_id, row.shared_signer_2_id].filter(Number.isInteger),
  signedByUserId: row.signed_by_user_id, signedByName: row.signed_by_name, signedAt: row.signed_at,
  returnNote: row.return_note,
  updatedAt: row.updated_at,
});
const denied = (res) => res.status(403).json({ error: 'Official correspondence is available only to the Worshipful Master and secretaries.' });
const unfilledDemitTemplate = fields => fields.matter === 'demit' &&
  /\[(?:Brother full name|Receiving Lodge|record date|verified standing and charges statement)\]/i.test(`${fields.subject} ${fields.body}`);
const validate = fields => fields.recipientLodge && fields.recipientName && fields.subject && fields.body && !unfilledDemitTemplate(fields);
const printable = value => String(value || '').replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g,
  character => ({ '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '•': '*', '…': '...' }[character] || '?'));
const wrap = (value, font, size, width) => {
  const lines = [];
  for (const paragraph of printable(value).replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
};

export async function buildCorrespondencePdf(row) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const navy = rgb(19 / 255, 47 / 255, 88 / 255);
  const gold = rgb(183 / 255, 139 / 255, 48 / 255);
  const gray = rgb(89 / 255, 89 / 255, 89 / 255);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  const bodyLeft = 120, bodyWidth = 446;
  const sharedUnsigned = row.signing_mode === 'either' && row.status !== 'signed';
  const outgoingName = sharedUnsigned ? '' : (row.signed_by_name || row.assigned_to_name || row.prepared_by_name);
  const outgoingOffice = sharedUnsigned ? 'Office of the Secretary' : (row.assigned_to_office || row.prepared_by_office);
  let page, y;
  const centered = (value, atY, font, size, color = navy) => {
    const label = printable(value);
    page.drawText(label, { x: 32 + (548 - font.widthOfTextAtSize(label, size)) / 2, y: atY, size, font, color });
  };
  const nextPage = () => {
    page = pdf.addPage([612, 792]);
    page.drawImage(seal, { x: 35, y: 705, width: 43, height: 43 });
    page.drawImage(seal, { x: 534, y: 705, width: 43, height: 43 });
    centered('Stone Square Lodge No. 22', 729, bold, 19);
    centered('Free and Accepted Masons, Prince Hall Affiliation', 715, regular, 9.2);
    centered('208 East Lake Street', 703, regular, 7.5);
    centered('Middletown, DE 19709', 693, regular, 7.5);
    centered('Telephone (302) 304-6123', 683, regular, 7.5);
    centered('Stated Meetings: 1st & 3rd Thursdays, 7:30 PM', 672, regular, 7.5);
    page.drawLine({ start: { x: 32, y: 662 }, end: { x: 580, y: 662 }, thickness: 1.6, color: navy });
    centered('O F F I C I A L   C O R R E S P O N D E N C E', 646, bold, 9.2);
    centered(`${outgoingOffice} ${outgoingName}`.trim(), 635, italic, 7.6);
    page.drawLine({ start: { x: 32, y: 626 }, end: { x: 580, y: 626 }, thickness: 1.6, color: navy });
    page.drawText('OFFICERS', { x: 32, y: 608, size: 8.3, font: bold, color: navy });
    page.drawText('2026     2027', { x: 32, y: 598, size: 6.5, font: regular, color: gold });
    let railY = 584;
    for (const officer of AGENDA_OFFICERS) {
      if (railY < 70) break;
      page.drawText(printable(officer.office), { x: 32, y: railY, size: 5.5, font: bold, color: gold }); railY -= 8;
      for (const nameLine of wrap(officer.name, bold, 6.6, 78)) {
        page.drawText(nameLine, { x: 32, y: railY, size: 6.6, font: bold, color: navy }); railY -= 7.3;
      }
      page.drawText('208 East Lake Street', { x: 32, y: railY, size: 4.8, font: regular, color: gray }); railY -= 6;
      page.drawText('Middletown, DE 19709', { x: 32, y: railY, size: 4.8, font: regular, color: gray }); railY -= 10;
    }
    page.drawLine({ start: { x: 108, y: 614 }, end: { x: 108, y: 58 }, thickness: .45, color: gold });
    page.drawText(row.status === 'signed' ? 'SIGNED - DELIVERY BY THE SIGNING OFFICER PENDING' : 'DRAFT - NOT SIGNED OR SENT', { x: bodyLeft, y: 30, size: 6.6, font: bold, color: gray });
    page.drawText(`Page ${pdf.getPageCount()}`, { x: 538, y: 30, size: 6.6, font: regular, color: gray });
    centered('Returning to the Fundamentals, 2026 to 2027', 18, italic, 6.6, gray);
    y = 608;
  };
  const line = (value, font = regular, size = 10.5, gap = 17) => {
    for (const part of wrap(value, font, size, bodyWidth)) {
      if (y < 58) nextPage();
      if (part) page.drawText(part, { x: bodyLeft, y, size, font, color: navy });
      y -= gap;
    }
  };
  nextPage();
  const date = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date(row.submitted_at || row.updated_at || Date.now()));
  line(date); y -= 10;
  line(row.recipient_name, bold); line(row.recipient_lodge); y -= 13;
  line(`Re: ${row.subject}`, bold); y -= 20;
  const bodyLines = wrap(row.body, regular, 10.5, bodyWidth);
  const lastParagraphStart = bodyLines.lastIndexOf('') + 1;
  const keepLastParagraph = bodyLines.length - lastParagraphStart <= 10;
  for (let index = 0; index < bodyLines.length; index++) {
    const remaining = bodyLines.length - index;
    // Carry the final paragraph (or at least its final four lines) with the
    // signature block so the last page never contains a signature alone.
    if (keepLastParagraph && index === lastParagraphStart && y - remaining * 17 - 25 < 210) nextPage();
    if ((!keepLastParagraph || index >= lastParagraphStart) && remaining <= 4 && y - remaining * 17 - 25 < 210) nextPage();
    if (y < 58) nextPage();
    if (bodyLines[index]) page.drawText(bodyLines[index], { x: bodyLeft, y, size: 10.5, font: regular, color: navy });
    y -= 17;
  }
  y -= 25;
  // Keep the complete signature block together and reserve the same space in
  // both draft and signed PDFs so signing never shifts the officer's name.
  if (y < 210) nextPage();
  line('Fraternally,');
  const signatureLineY = y - 54;
  if (row.status === 'signed' && row.signed_signature_bytes) {
    const signature = await pdf.embedPng(row.signed_signature_bytes);
    const natural = signature.scale(1);
    const scale = Math.min(195 / natural.width, 43 / natural.height);
    page.drawImage(signature, { x: bodyLeft + 3, y: signatureLineY + 4, width: natural.width * scale, height: natural.height * scale });
  }
  page.drawLine({ start: { x: bodyLeft, y: signatureLineY }, end: { x: bodyLeft + 215, y: signatureLineY }, thickness: .55, color: navy });
  y = signatureLineY - 19;
  if (outgoingName) line(outgoingName, bold);
  line(sharedUnsigned ? 'Secretary or Assistant Secretary' : outgoingOffice, italic, 9.5, 15);
  if (row.status === 'signed') line(`Signed ${new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date(row.signed_at))}`, italic, 8.3);
  return Buffer.from(await pdf.save());
}

const signingOfficers = async () => {
  const users = await dbAll("SELECT id, name, role, permissions_json FROM users WHERE role IN ('secretary','assistant_secretary') AND access_revoked_at IS NULL ORDER BY CASE role WHEN 'secretary' THEN 0 ELSE 1 END, id");
  return users.filter(user => resolvePermissions(user).includes('reports.create'))
    .map(user => ({ id: user.id, name: user.name, office: office(user.role), role: user.role }));
};
const draftSigner = async (userId, signers) => signers.find(user => user.id === Number(userId));
const normalizedName = value => String(value || '').trim().replace(/\s+/g, ' ').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en-US');
export const sharedSigningOfficers = signers => {
  const mcduffie = signers.filter(user => user.role === 'secretary' && normalizedName(user.name) === 'william mcduffie');
  const adrian = signers.filter(user => user.role === 'assistant_secretary' && normalizedName(user.name) === 'adrian reese');
  return mcduffie.length === 1 && adrian.length === 1 ? [mcduffie[0], adrian[0]] : [];
};
const sharedSigningLabel = 'William McDuffie or Adrian Reese';

export function mountCorrespondenceRoutes(app, { requireAuth, broadcast }) {
  app.get('/api/correspondence/signers', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ signers: await signingOfficers() });
    } catch (error) { next(error); }
  });
  app.get('/api/correspondence/alerts', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const rows = req.user.role === 'owner'
        ? await dbAll("SELECT id,subject,return_note,status FROM correspondence_drafts WHERE status='draft' AND return_note IS NOT NULL ORDER BY updated_at DESC LIMIT 20")
        : await dbAll("SELECT id,subject,status FROM correspondence_drafts WHERE status='awaiting_secretary' AND (assigned_to_user_id=? OR shared_signer_1_id=? OR shared_signer_2_id=?) ORDER BY updated_at DESC LIMIT 20",
          [req.user.id, req.user.id, req.user.id]);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ alerts: rows.map(row => ({ id: row.id, title: row.subject,
        message: req.user.role === 'owner' ? `Returned for correction: ${row.return_note}` : 'Your review and signature are requested.' })) });
    } catch (error) { next(error); }
  });
  app.get('/api/correspondence', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const rows = await dbAll('SELECT * FROM correspondence_drafts ORDER BY updated_at DESC LIMIT 100');
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ drafts: rows.map(dto) });
    } catch (error) { next(error); }
  });
  app.post('/api/correspondence', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const fields = data(req.body);
      if (unfilledDemitTemplate(fields)) return res.status(400).json({ error: 'Replace every bracketed demit inquiry prompt with verified information before saving.' });
      if (!validate(fields)) return res.status(400).json({ error: 'Complete the receiving Lodge, recipient, subject, and letter before saving.' });
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const signers = req.user.role === 'owner' ? await signingOfficers() : [];
      const shared = req.user.role === 'owner' && req.body?.signerUserId == null;
      const signer = req.user.role === 'owner' && !shared
        ? await draftSigner(req.body.signerUserId, signers) : null;
      if (shared && sharedSigningOfficers(signers).length !== 2)
        return res.status(409).json({ error: 'Both McDuffie and Adrian Reese need active correspondence access before this shared signature queue can be used.' });
      if (req.user.role === 'owner' && req.body?.signerUserId != null && !signer)
        return res.status(409).json({ error: 'Choose an active Secretary or Assistant Secretary with correspondence access.' });
      await dbRun(`INSERT INTO correspondence_drafts
        (id,matter,recipient_lodge,recipient_name,subject,body,status,prepared_by_user_id,prepared_by_name,prepared_by_office,assigned_to_user_id,assigned_to_name,assigned_to_office,signing_mode,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)`, [id, fields.matter, fields.recipientLodge, fields.recipientName,
        fields.subject, fields.body, req.user.id, req.user.name, office(req.user.role), signer?.id || null,
        shared ? sharedSigningLabel : signer?.name || null, signer?.office || null, shared ? 'either' : 'single', now, now]);
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_draft_created', req.ip, JSON.stringify({ id, matter: fields.matter }), now]);
      res.status(201).json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [id])) });
      broadcast?.('correspondence_changed', { id });
    } catch (error) { next(error); }
  });
  app.put('/api/correspondence/:id', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const row = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Letter draft not found.' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'This letter has already been sent for the Secretary’s signature and cannot be changed.' });
      if (req.user.role !== 'owner' && row.prepared_by_user_id !== req.user.id) return denied(res);
      const fields = data(req.body);
      if (unfilledDemitTemplate(fields)) return res.status(400).json({ error: 'Replace every bracketed demit inquiry prompt with verified information before saving.' });
      if (!validate(fields)) return res.status(400).json({ error: 'Complete the receiving Lodge, recipient, subject, and letter before saving.' });
      const signers = req.user.role === 'owner' ? await signingOfficers() : [];
      const changingSigner = req.user.role === 'owner' && Object.hasOwn(req.body || {}, 'signerUserId');
      const shared = changingSigner && req.body.signerUserId == null;
      const signer = changingSigner && !shared ? await draftSigner(req.body.signerUserId, signers) : null;
      if (shared && sharedSigningOfficers(signers).length !== 2)
        return res.status(409).json({ error: 'Both McDuffie and Adrian Reese need active correspondence access before this shared signature queue can be used.' });
      if (req.user.role === 'owner' && req.body?.signerUserId != null && !signer)
        return res.status(409).json({ error: 'Choose an active Secretary or Assistant Secretary with correspondence access.' });
      const now = nextRevisionTime(row);
      const updated = await dbRun(`UPDATE correspondence_drafts SET matter=?,recipient_lodge=?,recipient_name=?,subject=?,body=?,
        assigned_to_user_id=?,assigned_to_name=?,assigned_to_office=?,signing_mode=?,updated_at=?
        WHERE id=? AND status='draft' AND updated_at=?`,
        [fields.matter, fields.recipientLodge, fields.recipientName, fields.subject, fields.body,
          changingSigner ? signer?.id || null : row.assigned_to_user_id,
          changingSigner ? (shared ? sharedSigningLabel : signer?.name || null) : row.assigned_to_name,
          changingSigner ? signer?.office || null : row.assigned_to_office,
          changingSigner ? (shared ? 'either' : 'single') : row.signing_mode, now, row.id, row.updated_at]);
      if (!updated.changes) return res.status(409).json({ error: 'The letter changed. Refresh it before saving.' });
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_draft_updated', req.ip, JSON.stringify({ id: row.id }), now]);
      res.json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [row.id])) });
      broadcast?.('correspondence_changed', { id: row.id });
    } catch (error) { next(error); }
  });
  app.post('/api/correspondence/:id/submit', requireAuth, async (req, res, next) => {
    try {
      if (req.user.role !== 'owner') return denied(res);
      const row = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Letter draft not found.' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be sent to the Secretary.' });
      if (req.body?.expectedUpdatedAt !== row.updated_at)
        return res.status(409).json({ error: 'This letter changed since the PDF was reviewed. Refresh and review the latest PDF before assigning it.' });
      const signers = await signingOfficers();
      const shared = row.signing_mode === 'either';
      const sharedPair = shared ? sharedSigningOfficers(signers) : [];
      const signer = shared ? null : row.assigned_to_user_id
        ? await draftSigner(row.assigned_to_user_id, signers)
        : signers.find(user => user.name === row.assigned_to_name);
      if (shared && sharedPair.length !== 2)
        return res.status(409).json({ error: 'Both McDuffie and Adrian Reese need active correspondence access before this shared signature queue can be used.' });
      if (!shared && !signer) return res.status(409).json({ error: 'The chosen Secretary or Assistant Secretary is unavailable. Choose an active signing officer, save, and review the updated PDF.' });
      if (req.body?.signerUserId != null && Number(req.body.signerUserId) !== signer?.id)
        return res.status(409).json({ error: 'The signing officer changed. Save and review the updated PDF before assigning this letter.' });
      const now = nextRevisionTime(row);
      const updated = await dbRun(`UPDATE correspondence_drafts SET status='awaiting_secretary', assigned_to_user_id=?,
        assigned_to_name=?,assigned_to_office=?,shared_signer_1_id=?,shared_signer_2_id=?,submitted_at=?,return_note=NULL,updated_at=? WHERE id=? AND status='draft' AND updated_at=?`,
      [signer?.id || null, shared ? sharedSigningLabel : signer.name, signer?.office || null,
        sharedPair[0]?.id || null, sharedPair[1]?.id || null, now, now, row.id, row.updated_at]);
      if (!updated.changes) return res.status(409).json({ error: 'The letter changed. Refresh it before sending to the Secretary.' });
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_submitted_to_secretary', req.ip, JSON.stringify({ id: row.id, signerId: signer?.id || null, signingMode: shared ? 'either' : 'single' }), now]);
      res.json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [row.id])) });
      broadcast?.('correspondence_changed', { id: row.id });
    } catch (error) { next(error); }
  });
  app.post('/api/correspondence/:id/return', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const row = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Letter not found.' });
      if (row.status !== 'awaiting_secretary') return res.status(409).json({ error: 'Only an unsigned assigned letter can be returned for correction.' });
      if (req.user.role !== 'owner' && row.assigned_to_user_id !== req.user.id &&
          !(row.signing_mode === 'either' && [row.shared_signer_1_id, row.shared_signer_2_id].includes(req.user.id))) return denied(res);
      const note = clean(req.body?.reason, 1000);
      if (!note) return res.status(400).json({ error: 'Say what needs to change before returning this letter.' });
      const now = nextRevisionTime(row);
      const updated = await dbRun(`UPDATE correspondence_drafts SET status='draft',assigned_to_user_id=NULL,
        shared_signer_1_id=NULL,shared_signer_2_id=NULL,submitted_at=NULL,return_note=?,updated_at=? WHERE id=? AND status='awaiting_secretary' AND updated_at=?`,
      [note, now, row.id, row.updated_at]);
      if (!updated.changes) return res.status(409).json({ error: 'The letter changed. Refresh before returning it.' });
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_returned_for_correction', req.ip, JSON.stringify({ id: row.id, reason: note }), now]);
      res.json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [row.id])) });
      broadcast?.('correspondence_changed', { id: row.id });
    } catch (error) { next(error); }
  });
  app.post('/api/correspondence/:id/sign', requireAuth, async (req, res, next) => {
    try {
      if (!['secretary', 'assistant_secretary'].includes(req.user.role) || !eligible(req.user)) return denied(res);
      const row = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Letter draft not found.' });
      const sharedEligible = row.signing_mode === 'either' &&
        [row.shared_signer_1_id, row.shared_signer_2_id].includes(req.user.id);
      if (row.status !== 'awaiting_secretary' || (!sharedEligible && row.assigned_to_user_id !== req.user.id))
        return res.status(403).json({ error: 'This letter is not assigned to your signature queue.' });
      if (req.body?.expectedUpdatedAt !== row.updated_at)
        return res.status(409).json({ error: 'The letter changed since you reviewed it. Refresh and review the current PDF before signing.' });
      if (req.body?.consent !== true) return res.status(400).json({ error: 'Review the complete letter and confirm before signing.' });
      const signature = await dbGet('SELECT signature_bytes FROM profile_signatures WHERE user_id=?', [req.user.id]);
      if (!signature?.signature_bytes) return res.status(409).json({ error: 'Save your signature in Signature Profile before signing this letter.' });
      const now = nextRevisionTime(row);
      const updated = await dbRun(`UPDATE correspondence_drafts SET status='signed',signed_by_user_id=?,
        signed_by_name=?,assigned_to_user_id=?,assigned_to_name=?,assigned_to_office=?,signed_at=?,signed_signature_bytes=?,updated_at=?
        WHERE id=? AND status='awaiting_secretary' AND (assigned_to_user_id=? OR shared_signer_1_id=? OR shared_signer_2_id=?) AND updated_at=?`,
      [req.user.id, req.user.name, req.user.id, req.user.name, office(req.user.role), now,
        signature.signature_bytes, now, row.id, req.user.id, req.user.id, req.user.id, row.updated_at]);
      if (!updated.changes) return res.status(409).json({ error: 'The letter changed. Refresh before signing.' });
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_signed', req.ip, JSON.stringify({ id: row.id }), now]);
      res.json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [row.id])) });
      broadcast?.('correspondence_changed', { id: row.id });
    } catch (error) { next(error); }
  });
  app.get('/api/correspondence/:id/pdf', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const row = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Letter draft not found.' });
      const bytes = await buildCorrespondencePdf(row);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Stone-Square-Correspondence-${row.status === 'signed' ? 'Signed' : 'Draft'}.pdf"`);
      res.send(bytes);
    } catch (error) { next(error); }
  });
}
