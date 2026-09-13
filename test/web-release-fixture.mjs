import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const port = Number(process.env.WEB_RELEASE_FIXTURE_PORT || 3617);
const user = {
  id: 999,
  name: 'William Dixon-Saunders',
  email: 'preview@example.invalid',
  role: 'owner',
  hasSignature: true,
  permissions: [],
};
const json = (response, payload, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
};
const body = request => new Promise(resolve => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks)));
});
const draft = {
  periodStart: '2026-08-01', periodEnd: '2026-08-31', presentedOn: '2026-09-03', bankName: 'Lodge Bank',
  sourceNames: ['August statement.pdf'], extractionNotes: [], unmappedLines: [],
  accounts: [{ id: 'checking', name: 'Checking', openingBalance: 1200, statementBalance: 1380, bookBalance: 1380, receipts: 300, disbursements: 120, transfersIn: 0, transfersOut: 0, depositsInTransit: 0, outstandingChecks: 0, bankHold: 0, activityComplete: true }],
  transactions: [{ date: '2026-08-12', account: 'checking', kind: 'receipt', amount: 300, description: 'Fundraiser receipts', reference: '', category: 'Fundraiser' }],
  funds: [], obligations: [], remarks: 'Accounts reconciled.', fundsReviewed: true, obligationsReviewed: true, sourceReviewed: true,
};

const api = async (request, response, url) => {
  await body(request);
  if (url.pathname === '/api/setup') return json(response, { registrationMode: 'invitation', needsOwnerSetup: false });
  if (url.pathname === '/api/version') return json(response, { version: '1.19.0' });
  if (url.pathname === '/api/auth/me') return json(response, { user, session: { lifetimeDays: 90 } });
  if (url.pathname === '/api/auth/sessions') return json(response, { sessions: [
    { id: 'current', label: 'Safari on iPhone', createdAt: '2026-09-01T12:00:00Z', lastSeenAt: '2026-09-13T14:30:00Z', expiresAt: '2026-12-01T12:00:00Z', current: true },
    { id: 'other', label: 'Stone Square Sign on Mac', createdAt: '2026-08-20T12:00:00Z', lastSeenAt: '2026-09-12T23:10:00Z', expiresAt: '2026-11-18T12:00:00Z', current: false },
  ] });
  if (url.pathname === '/api/minutes/review-alerts') return json(response, { alerts: [] });
  if (url.pathname === '/api/documents') return json(response, { documents: [{ id: 1, title: 'Community Event Dispensation', original_name: 'dispensation.pdf', status: 'completed', needsSignature: false, template_kind: 'dispensation_v1', created_at: '2026-09-10T19:00:00Z', submitted_at: '2026-09-11T13:00:00Z', signers: [{ signer_name: 'William McDuffie', signed_at: '2026-09-10T20:00:00Z', signer_role: 'secretary' }] }] });
  if (url.pathname === '/api/officers') return json(response, { officers: [{ id: 2, name: 'William McDuffie', email: 'secretary@example.invalid', role: 'secretary' }, { id: 3, name: 'Adrian Reese', email: 'assistant@example.invalid', role: 'assistant_secretary' }], pending: [] });
  if (url.pathname === '/api/submission-profiles') return json(response, { profiles: [{ role: 'worshipful_master', name: user.name, address: 'Lodge profile address' }] });
  if (url.pathname === '/api/admin/access') return json(response, { capabilities: [{ id: 'reports.create', label: 'Create reports' }, { id: 'minutes.prepare', label: 'Prepare meeting minutes' }, { id: 'building.request', label: 'Submit building requests' }], accounts: [{ key: 'owner', ...user, pending: false, revoked: false }, { key: 'secretary', name: 'William McDuffie', email: 'secretary@example.invalid', role: 'secretary', permissions: ['reports.create','minutes.prepare'], pending: false, revoked: false }] });
  if (url.pathname === '/api/generation/status') return json(response, { configured: true, remainingDollars: 20, model: 'gpt-5.6-terra' });
  if (url.pathname === '/api/minutes') return json(response, { minutes: [{ id: 20, meetingDate: '2026-09-03', createdBy: 'Adrian Reese', updatedBy: 'Adrian Reese', updatedAt: '2026-09-12T20:00:00Z', createdByUserId: 3, status: 'ready_for_distribution', draft: { meetingDate: '2026-09-03', meetingType: 'Stated Communication', degree: 'Third Degree', openingTime: '7:36 PM', closingTime: '10:30 PM', presiding: 'WM Dixon-Saunders', quorum: 'Yes', nextMeeting: '2026-10-01', present: ['Brother One'], excused: ['Brother Two'], visitors: [], officerAttendance: [], sections: [{ heading: 'Sickness and Distress', body: 'The Lodge remembered the sick and distressed.' }], warnings: [], sensitiveReview: [], actionItems: [] } }] });
  if (url.pathname === '/api/approvals') return json(response, { approvals: [{ id: 1, title: 'Community Event Dispensation', original_name: 'dispensation.pdf', approval_status: 'approved', approval_source: 'email', approved_by: 'District Deputy', approved_on: '2026-09-11T13:00:00Z', has_endorsed_copy: false }] });
  if (url.pathname === '/api/proposals') return json(response, { proposals: [{ id: 31, title: 'Community outreach event', requestDetails: 'Request permission for Lodge participation.', proposerName: 'Jamal Davis', proposerUserId: 4, eventDate: '2026-10-10', eventTime: '1:00 PM to 4:00 PM', locationName: 'Community Center', streetAddress: '100 Main Street', cityState: 'Middletown, DE', status: 'pending', proposerNote: '' }] });
  if (url.pathname === '/api/dues') return json(response, { duesYear: 2026, rateCents: 25000, totals: { collectedCents: 50000, outstandingCents: 25000, paidCount: 2, unpaidCount: 1 }, staleCampaign: null, rows: [{ name: 'Brother One', status: 'paid', paidCents: 25000, assessedCents: 25000, remainingCents: 0, creditCents: 0, lastPaymentISO: '2026-01-15', payments: [{ matchedVia: 'email' }] }, { name: 'Brother Two', status: 'unpaid', paidCents: 0, assessedCents: 25000, remainingCents: 25000, creditCents: 0, payments: [] }], unmatched: [] });
  if (url.pathname === '/api/building/requests') return json(response, { canDecide: true, requests: [{ id: 'SSL-100', organization: 'Stone Square Lodge No. 22', date: '2026-10-10', start: '13:00', end: '16:00', spaces: ['Lodge building'], description: 'Community outreach planning', contactName: 'Jamal Davis', contact: 'jamal@example.invalid', status: 'pending', revision: 1, note: '' }] });
  if (url.pathname === '/api/lodge-calendar') return json(response, { warnings: [], events: [{ id: 'event-1', title: 'Stated Communication', startDate: new Date().toISOString().slice(0, 8) + '15', endDate: new Date().toISOString().slice(0, 8) + '15', startTime: '19:30', endTime: '22:00', allDay: false, category: 'lodge', status: 'scheduled', location: 'Stone Square Lodge No. 22', description: 'Monthly stated communication.', source: 'Lodge calendar', editable: true, revision: 1 }] });
  if (url.pathname === '/api/treasury') return json(response, { reports: [{ id: 'treasury-1', draft, status: 'draft', preparerUserId: 999, createdByUserId: 999, createdBy: user.name, uploadedBy: 'William McDuffie', revision: 1 }] });
  if (url.pathname === '/api/admin/activity') return json(response, { measuredFrom: '2026-09-01T12:00:00Z', eventNext: null, sessionNext: null, users: [{ id: 999, name: user.name, role: 'owner', revoked: false }, { id: 2, name: 'William McDuffie', role: 'secretary', revoked: false }], sessions: [{ actor: user.name, status: 'Active', client: 'Website', area: 'home', startedAt: '2026-09-13T13:00:00Z', lastSeenAt: '2026-09-13T14:30:00Z', measured: true, activeSeconds: 900 }], events: [{ actor: 'Adrian Reese', label: 'Prepared meeting minutes', detail: 'September stated communication', at: '2026-09-12T20:00:00Z' }] });
  if (url.pathname === '/api/reports/handoff') return json(response, { url: 'https://request.stonesquare22pha.org/report', assertion: 'visual-audit-only', expiresAt: Math.floor(Date.now() / 1000) + 300 });
  if (url.pathname === '/api/tracker/handoff') return json(response, { url: 'https://tracker.stonesquare22pha.org/api/sso?assertion=visual-audit-only' });
  if (url.pathname === '/api/events') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); response.end('event: ready\ndata: {}\n\n'); return; }
  if (request.method !== 'GET') return json(response, { ok: true, notificationWarnings: ['The record was saved, but the test notification was not sent.'] });
  return json(response, { error: `No fixture for ${url.pathname}` }, 404);
};

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname.startsWith('/api/')) return api(request, response, url);
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) return response.end();
  try {
    let contents = await fs.readFile(file);
    if (relative === 'index.html') contents = Buffer.from(contents.toString().replaceAll('__APP_VERSION__', '1.19.0'));
    const ext = path.extname(file);
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(contents);
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`WEB_RELEASE_FIXTURE http://127.0.0.1:${port}`));
