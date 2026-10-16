import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { matchingDocumentIds, syncReports } from '../scripts/sync-dispensation-reports.mjs';

const record = { id: 'fixture-2026-mobile-pantry', title: 'Dispensation Request: Food Bank Mobile Pantry, December 7, 2026', template_kind: 'dispensation_v1', status: 'partially_signed' };
assert.deepEqual(matchingDocumentIds({ filename: 'Food Bank Mobile Pantry December 7 2026 Report.pdf' }, [record]), [record.id]);
assert.deepEqual(matchingDocumentIds({ filename: 'Food Bank Mobile Pantry December 7 2025 Report.pdf' }, [record]), []);
assert.deepEqual(matchingDocumentIds({ filename: 'other.pdf', text: 'Food Bank Mobile Pantry\nEvent date: 2026-12-07' }, [record]), [record.id]);
assert.deepEqual(matchingDocumentIds({ filename: 'other.pdf', text: 'Food Bank Mobile Pantry\nDecember 7, 2025' }, [record]), []);
assert.deepEqual(matchingDocumentIds({ filename: 'other.pdf', text: 'Other event'.padEnd(1700, ' ') + 'Food Bank Mobile Pantry December 7, 2026' }, [record]), []);
assert.deepEqual(matchingDocumentIds({ filename: `${record.id}.pdf` }, [{ ...record, status: 'rescinded' }]), []);
assert.deepEqual(matchingDocumentIds({ filename: `${record.id}.pdf` }, [{ ...record, submitted_at: '2026-10-16' }]), []);
assert.equal(matchingDocumentIds({ filename: 'Food Bank Mobile Pantry December 7 2026.pdf' }, [record, { ...record, id: 'duplicate-fixture' }]).length, 2);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ss22-report-sync-'));
let puts = 0;
let reportOnServer = null;
let automaticDeliveryEnabled = false;
let role = 'owner';
const fakeFetch = async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(options.redirect, 'error');
  const route = new URL(url).pathname;
  let body;
  if (route === '/api/auth/me') body = { user: { role } };
  else if (route === '/api/documents') body = { documents: [record] };
  else if (route.endsWith('/submission-packet')) body = { packet: { state: 'disabled', automaticDeliveryEnabled, report: reportOnServer } };
  else if (route.endsWith('/supporting-report') && options.method === 'PUT') {
    assert.equal(options.body.get('report').type, 'application/pdf');
    assert.equal(options.body.get('sourceLabel'), path.basename(directory));
    puts += 1; body = { packet: { state: 'awaiting_signature' } };
  } else throw new Error(`Unexpected route ${route}`);
  return { ok: true, json: async () => body };
};
try {
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Food Bank Mobile Pantry December 7, 2026');
  const file = path.join(directory, 'Pantry.pdf');
  await fs.writeFile(file, await pdf.save());
  await fs.utimes(file, new Date(0), new Date(0));
  const settings = { folders: [directory], base: 'http://127.0.0.1:12345', token: 'fixture-token', fetcher: fakeFetch };
  const preview = await syncReports(settings);
  assert.equal(puts, 0); assert.equal(preview.waiting[0].reason, 'Exact match ready to attach.');
  const applied = await syncReports({ ...settings, apply: true });
  assert.equal(puts, 1); assert.equal(applied.uploaded.length, 1);
  for (const capability of [undefined, true]) {
    automaticDeliveryEnabled = capability;
    const blocked = await syncReports({ ...settings, apply: true });
    assert.equal(puts, 1, 'Older or enabled servers cannot receive an archive upload that might trigger email.');
    assert.match(blocked.waiting[0].reason, /Automatic sending must be confirmed off/);
  }
  automaticDeliveryEnabled = false;
  reportOnServer = { sha256: 'different-existing-report' };
  const conflict = await syncReports({ ...settings, apply: true });
  assert.equal(puts, 1); assert.match(conflict.waiting[0].reason, /different report/);
  reportOnServer = null;
  const second = await PDFDocument.create(); second.addPage().drawText('Food Bank Mobile Pantry December 7, 2026 Corrected report');
  const secondFile = path.join(directory, 'Pantry v2.pdf');
  await fs.writeFile(secondFile, await second.save()); await fs.utimes(secondFile, new Date(0), new Date(0));
  const ambiguous = await syncReports({ ...settings, apply: true });
  assert.equal(puts, 1); assert.match(ambiguous.waiting[0].reason, /Different reports/);
  role = 'secretary';
  await assert.rejects(syncReports({ ...settings, apply: true }), /Only the Worshipful Master/);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
console.log('PASS: report folder sync requires exact event and date, refuses conflicts and duplicate matches, isolates sent/rescinded records, and only uploads as owner.');
