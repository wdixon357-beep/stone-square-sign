import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun } from './db.js';
import { agendaFileName, agendaIssues, buildAgendaPdf, defaultAgendaDraft, normalizeAgendaDraft } from './agenda.js';

const now = () => new Date().toISOString();
const record = row => ({
  id: row.id, meetingDate: row.meeting_date, status: row.status, revision: Number(row.revision),
  draft: normalizeAgendaDraft(JSON.parse(row.draft_json)), createdAt: row.created_at, updatedAt: row.updated_at,
});

export async function initAgendaSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS agendas (
    id TEXT PRIMARY KEY,
    meeting_date TEXT,
    draft_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    revision INTEGER NOT NULL DEFAULT 1,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    updated_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_agendas_date ON agendas(meeting_date, updated_at)');
}

export function mountAgendaRoutes(app, { requireAuth, requireOwner, addAudit }) {
  const guarded = [requireAuth, requireOwner, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }];
  app.get('/api/agendas', ...guarded, async (_req, res, next) => {
    try { res.json({ agendas: (await dbAll('SELECT * FROM agendas WHERE deleted_at IS NULL ORDER BY meeting_date DESC NULLS LAST, updated_at DESC')).map(record) }); }
    catch (error) { next(error); }
  });
  app.post('/api/agendas', ...guarded, async (req, res, next) => {
    try {
      const draft = normalizeAgendaDraft(req.body?.draft || defaultAgendaDraft());
      const id = crypto.randomUUID(), stamp = now();
      await dbRun(`INSERT INTO agendas (id,meeting_date,draft_json,status,revision,created_by_user_id,updated_by_user_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [id, draft.meetingDate || null, JSON.stringify(draft), 'draft', 1, req.user.id, req.user.id, stamp, stamp]);
      await addAudit({ userId: req.user.id, documentId: id, action: 'agenda_created', ip: req.ip, userAgent: req.get('user-agent') || '', details: { meetingDate: draft.meetingDate || null } });
      res.status(201).json({ agenda: record(await dbGet('SELECT * FROM agendas WHERE id=?', [id])) });
    } catch (error) { next(error); }
  });
  app.get('/api/agendas/:id', ...guarded, async (req, res, next) => {
    try {
      const row = await dbGet('SELECT * FROM agendas WHERE id=? AND deleted_at IS NULL', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Agenda not found.' });
      res.json({ agenda: record(row) });
    } catch (error) { next(error); }
  });
  app.put('/api/agendas/:id', ...guarded, async (req, res, next) => {
    try {
      const current = await dbGet('SELECT * FROM agendas WHERE id=? AND deleted_at IS NULL', [req.params.id]);
      if (!current) return res.status(404).json({ error: 'Agenda not found.' });
      if (Number(req.body?.revision) !== Number(current.revision)) return res.status(409).json({ error: 'This agenda changed on another screen. Refresh before saving again.' });
      const draft = normalizeAgendaDraft(req.body?.draft);
      const stamp = now(), revision = Number(current.revision) + 1;
      await dbRun('UPDATE agendas SET meeting_date=?,draft_json=?,revision=?,updated_by_user_id=?,updated_at=? WHERE id=? AND revision=?',
        [draft.meetingDate || null, JSON.stringify(draft), revision, req.user.id, stamp, req.params.id, current.revision]);
      await addAudit({ userId: req.user.id, documentId: req.params.id, action: 'agenda_edited', ip: req.ip, userAgent: req.get('user-agent') || '', details: { revision } });
      res.json({ agenda: record(await dbGet('SELECT * FROM agendas WHERE id=?', [req.params.id])) });
    } catch (error) { next(error); }
  });
  app.post('/api/agendas/:id/preview', ...guarded, async (req, res, next) => {
    try {
      if (!(await dbGet('SELECT id FROM agendas WHERE id=? AND deleted_at IS NULL', [req.params.id]))) return res.status(404).json({ error: 'Agenda not found.' });
      const draft = normalizeAgendaDraft(req.body?.draft);
      const issues = agendaIssues(draft);
      if (issues.length) return res.status(400).json({ error: issues.join(' ') });
      res.type('application/pdf').send(await buildAgendaPdf(draft));
    } catch (error) { next(error); }
  });
  app.get('/api/agendas/:id/pdf', ...guarded, async (req, res, next) => {
    try {
      const row = await dbGet('SELECT * FROM agendas WHERE id=? AND deleted_at IS NULL', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Agenda not found.' });
      const draft = record(row).draft, issues = agendaIssues(draft);
      if (issues.length) return res.status(400).json({ error: issues.join(' ') });
      res.setHeader('Content-Disposition', `attachment; filename="${agendaFileName(draft)}"`);
      res.type('application/pdf').send(await buildAgendaPdf(draft));
    } catch (error) { next(error); }
  });
  app.delete('/api/agendas/:id', ...guarded, async (req, res, next) => {
    try {
      const current = await dbGet('SELECT * FROM agendas WHERE id=? AND deleted_at IS NULL', [req.params.id]);
      if (!current) return res.status(404).json({ error: 'Agenda not found.' });
      if (req.body?.revision != null && Number(req.body.revision) !== Number(current.revision)) return res.status(409).json({ error: 'This agenda changed on another screen. Refresh before deleting it.' });
      await dbRun('UPDATE agendas SET deleted_at=?,updated_at=? WHERE id=?', [now(), now(), req.params.id]);
      await addAudit({ userId: req.user.id, documentId: req.params.id, action: 'agenda_deleted', ip: req.ip, userAgent: req.get('user-agent') || '', details: { meetingDate: current.meeting_date } });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
}
