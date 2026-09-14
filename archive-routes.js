import { dbAll, dbGet, dbRun } from './db.js';
import { hasPermission } from './access-control.js';

const kinds = new Map([
  ['minutes', { permission: 'minutes.view', label: 'Meeting Minutes' }],
  ['treasury', { permission: 'treasury.view', label: 'Treasurer Reports' }],
]);

const configuration = (req, res) => {
  const value = kinds.get(req.params.kind);
  if (!value) {
    res.status(404).json({ error: 'Historical record section not found.' });
    return null;
  }
  if (!hasPermission(req.user, value.permission)) {
    res.status(403).json({ error: `${value.label} access is not enabled.` });
    return null;
  }
  return value;
};

export function mountArchiveRoutes(app, { requireAuth }) {
  app.get('/api/archives/:kind', requireAuth, async (req, res, next) => {
    try {
      if (!configuration(req, res)) return;
      const rows = await dbAll(`SELECT id, title, record_date, original_name, original_mime,
          source_label, evidence_status, imported_at
        FROM historical_reports WHERE kind = ?
        ORDER BY record_date DESC NULLS LAST, title`, [req.params.kind]);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ records: rows.map(row => ({ id: row.id, title: row.title, recordDate: row.record_date })) });
    } catch (error) { next(error); }
  });

  app.get('/api/archives/:kind/:id/pdf', requireAuth, async (req, res, next) => {
    try {
      if (!configuration(req, res)) return;
      const row = await dbGet(`SELECT title, rendered_pdf_bytes FROM historical_reports
        WHERE kind = ? AND id = ?`, [req.params.kind, req.params.id]);
      if (!row) return res.status(404).json({ error: 'Historical record not found.' });
      const safe = `${row.title}.pdf`.replace(/[\r\n"\\/]/g, ' ').trim();
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
      res.send(Buffer.from(row.rendered_pdf_bytes));
      await dbRun(`INSERT INTO audit_events (user_id, action, ip_address, user_agent, details_json, created_at)
        VALUES (?, 'historical_report_viewed', ?, ?, ?, ?)`, [req.user.id, req.ip,
        req.get('user-agent') || '', JSON.stringify({ archiveId: req.params.id, kind: req.params.kind }),
        new Date().toISOString()]);
    } catch (error) { next(error); }
  });
}
