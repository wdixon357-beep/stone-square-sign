import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { dbAll, dbGet, dbRun } from './db.js';

const eligible = user => ['owner', 'secretary', 'assistant_secretary'].includes(user?.role)
  && (user.role === 'owner' || user.permissions?.includes('reports.create'));
const office = role => ({ owner: 'Worshipful Master', secretary: 'Secretary', assistant_secretary: 'Assistant Secretary' })[role];
const clean = (value, limit) => String(value ?? '').trim().slice(0, limit);
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
  updatedAt: row.updated_at,
});
const denied = (res) => res.status(403).json({ error: 'Official correspondence is available only to the Worshipful Master and secretaries.' });
const validate = fields => fields.recipientLodge && fields.recipientName && fields.subject && fields.body;
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
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.07, 0.15, 0.25), gold = rgb(0.70, 0.49, 0.17), gray = rgb(0.33, 0.38, 0.44);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  let page, y;
  const nextPage = () => {
    page = pdf.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 747, width: 612, height: 45, color: navy });
    page.drawImage(seal, { x: 50, y: 686, width: 54, height: 54 });
    page.drawText('STONE SQUARE LODGE NO. 22', { x: 120, y: 712, size: 17, font: bold, color: navy });
    page.drawText('Free and Accepted Masons, Prince Hall Affiliated  |  Delaware', { x: 121, y: 693, size: 9, font: regular, color: gray });
    page.drawLine({ start: { x: 50, y: 672 }, end: { x: 562, y: 672 }, thickness: 1, color: gold });
    page.drawText('DRAFT  •  NOT SIGNED OR SENT', { x: 50, y: 36, size: 8, font: bold, color: gray });
    page.drawText(`Page ${pdf.getPageCount()}`, { x: 530, y: 36, size: 8, font: regular, color: gray });
    y = 646;
  };
  const line = (value, font = regular, size = 10.5, gap = 16) => {
    for (const part of wrap(value, font, size, 505)) {
      if (y < 84) nextPage();
      if (part) page.drawText(part, { x: 53, y, size, font, color: navy });
      y -= gap;
    }
  };
  nextPage();
  const date = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(new Date(row.updated_at || Date.now()));
  line(date); y -= 10;
  line(row.recipient_name, bold); line(row.recipient_lodge); y -= 9;
  line(`Re: ${row.subject}`, bold); y -= 18;
  line(row.body, regular, 10.5, 17); y -= 24;
  line('Fraternally,'); y -= 18;
  line(row.prepared_by_name, bold); line(row.prepared_by_office);
  return Buffer.from(await pdf.save());
}

export function mountCorrespondenceRoutes(app, { requireAuth }) {
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
      if (!validate(fields)) return res.status(400).json({ error: 'Complete the receiving Lodge, recipient, subject, and letter before saving.' });
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await dbRun(`INSERT INTO correspondence_drafts
        (id,matter,recipient_lodge,recipient_name,subject,body,status,prepared_by_user_id,prepared_by_name,prepared_by_office,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?)`, [id, fields.matter, fields.recipientLodge, fields.recipientName,
        fields.subject, fields.body, req.user.id, req.user.name, office(req.user.role), now, now]);
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_draft_created', req.ip, JSON.stringify({ id, matter: fields.matter }), now]);
      res.status(201).json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [id])) });
    } catch (error) { next(error); }
  });
  app.put('/api/correspondence/:id', requireAuth, async (req, res, next) => {
    try {
      if (!eligible(req.user)) return denied(res);
      const row = await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Letter draft not found.' });
      if (req.user.role !== 'owner' && row.prepared_by_user_id !== req.user.id) return denied(res);
      const fields = data(req.body);
      if (!validate(fields)) return res.status(400).json({ error: 'Complete the receiving Lodge, recipient, subject, and letter before saving.' });
      const now = new Date().toISOString();
      await dbRun(`UPDATE correspondence_drafts SET matter=?,recipient_lodge=?,recipient_name=?,subject=?,body=?,updated_at=? WHERE id=?`,
        [fields.matter, fields.recipientLodge, fields.recipientName, fields.subject, fields.body, now, row.id]);
      await dbRun('INSERT INTO audit_events (user_id,action,ip_address,details_json,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, 'correspondence_draft_updated', req.ip, JSON.stringify({ id: row.id }), now]);
      res.json({ draft: dto(await dbGet('SELECT * FROM correspondence_drafts WHERE id=?', [row.id])) });
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
      res.setHeader('Content-Disposition', 'inline; filename="Stone-Square-Correspondence-Draft.pdf"');
      res.send(bytes);
    } catch (error) { next(error); }
  });
}
