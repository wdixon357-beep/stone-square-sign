import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun } from './db.js';
import { hasPermission } from './access-control.js';

const MAX_PDF_BYTES = 2 * 1024 * 1024;
const idPart = value => String(value || '').trim();
const clean = (value, maximum) => idPart(value).slice(0, maximum);
const iso = value => {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
};
const roleOffice = role => ({
  owner: 'Worshipful Master', secretary: 'Secretary', assistant_secretary: 'Assistant Secretary',
  treasurer: 'Treasurer', assistant_treasurer: 'Assistant Treasurer', treasury_preparer: 'Treasury Report Preparer',
  warden: 'Warden', officer: 'Lodge Officer', viewer: 'Lodge Viewer', member: 'Lodge Member',
}[role] || 'Lodge Officer');

function decodePdf(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 16
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
  return bytes;
}

export function mountOfficerReportRoutes(app, { requireAuth, requireOwner }) {
  app.post('/api/officer-reports', requireAuth, async (req, res, next) => {
    try {
      if (!hasPermission(req.user, 'reports.create')) return res.status(403).json({ error: 'Report Generator access is not enabled.' });
      const pdf = decodePdf(req.body?.pdf);
      const externalId = clean(req.body?.externalId, 80);
      const clientId = clean(req.body?.clientId, 80) || null;
      const reportType = clean(req.body?.type, 40);
      const title = clean(req.body?.title, 240);
      const filename = clean(req.body?.filename, 240).replace(/[\r\n"\\/]/g, ' ');
      if (!pdf || !/^[A-Za-z0-9-]{4,80}$/.test(externalId) || !reportType || !title || !filename.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({ error: 'The completed report could not be saved. Refresh the Report Generator and try again.' });
      }
      const imported = req.user.role === 'owner' && req.body?.importedSubmission === true;
      const preparedByName = imported ? clean(req.body?.preparedByName, 120) : req.user.name;
      const preparedByOffice = imported ? clean(req.body?.preparedByOffice, 100) : clean(req.body?.preparedByOffice, 100) || roleOffice(req.user.role);
      const preparedByEmail = imported ? clean(req.body?.preparedByEmail, 180).toLowerCase() : req.user.email;
      const submittedAt = imported ? iso(req.body?.submittedAt) : new Date().toISOString();
      if (!preparedByName || !preparedByOffice || !submittedAt) return res.status(400).json({ error: 'The report submission details are incomplete.' });
      const id = `officer-report-${crypto.createHash('sha256').update(externalId).digest('hex').slice(0, 24)}`;
      const existing = await dbGet('SELECT id FROM officer_reports WHERE external_id = ?', [externalId]);
      if (!existing) {
        await dbRun(`INSERT INTO officer_reports
          (id,external_id,client_id,report_type,title,filename,pdf_bytes,prepared_by_user_id,prepared_by_name,prepared_by_office,prepared_by_email,emailed,source_label,submitted_at,received_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, externalId, clientId, reportType, title, filename, pdf,
          imported ? null : req.user.id, preparedByName, preparedByOffice, preparedByEmail || null, req.body?.emailed === true,
          imported ? 'Verified Lodge inbox attachment' : 'Lodge Report Generator', submittedAt, new Date().toISOString()]);
        await dbRun(`INSERT INTO audit_events (user_id,action,ip_address,user_agent,details_json,created_at)
          VALUES (?, 'officer_report_received', ?, ?, ?, ?)`, [req.user.id, req.ip, req.get('user-agent') || '',
          JSON.stringify({ reportId: id, externalId, title, preparedByName, imported }), new Date().toISOString()]);
      }
      res.status(existing ? 200 : 201).json({ ok: true, id: existing?.id || id, duplicate: Boolean(existing) });
    } catch (error) { next(error); }
  });

  app.get('/api/officer-reports', requireAuth, requireOwner, async (_req, res, next) => {
    try {
      const reports = await dbAll(`SELECT id,external_id,report_type,title,filename,prepared_by_name,prepared_by_office,
          emailed,source_label,submitted_at,received_at FROM officer_reports ORDER BY submitted_at DESC, received_at DESC`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ reports: reports.map(row => ({ id: row.id, externalId: row.external_id, type: row.report_type,
        title: row.title, filename: row.filename, preparedBy: row.prepared_by_name, office: row.prepared_by_office,
        emailed: Boolean(row.emailed), source: row.source_label, submittedAt: row.submitted_at, receivedAt: row.received_at })) });
    } catch (error) { next(error); }
  });

  app.get('/api/officer-reports/:id/pdf', requireAuth, requireOwner, async (req, res, next) => {
    try {
      const report = await dbGet('SELECT filename,pdf_bytes FROM officer_reports WHERE id = ?', [req.params.id]);
      if (!report) return res.status(404).json({ error: 'Received report not found.' });
      await dbRun(`INSERT INTO audit_events (user_id,action,ip_address,user_agent,details_json,created_at)
        VALUES (?, 'officer_report_viewed', ?, ?, ?, ?)`, [req.user.id, req.ip, req.get('user-agent') || '',
        JSON.stringify({ reportId: req.params.id }), new Date().toISOString()]);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${report.filename.replace(/[\r\n"\\/]/g, ' ')}"`);
      res.send(Buffer.from(report.pdf_bytes));
    } catch (error) { next(error); }
  });
}
