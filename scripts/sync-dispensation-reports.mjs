// Local companion: only the two owner-designated folders are read. The hosted
// service sends after signature completion using its durable report copy.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';

export const reportFolders = [
  path.join(os.homedir(), 'Desktop/Stone Square Dispensation Reports'),
  path.join(os.homedir(), 'Library/CloudStorage/Dropbox/Dispensation Reports - Oct 2026'),
];
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const containsPhrase = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function matchingDocumentIds({ filename, text }, documents) {
  const name = normalize(path.basename(filename, path.extname(filename)));
  // Only a report's heading is considered. A passing mention deep inside an
  // unrelated report cannot associate it with a dispensation.
  const heading = normalize(String(text || '').slice(0, 1600));
  const candidates = documents.filter(document => document.template_kind === 'dispensation_v1'
    && ['pending', 'partially_signed', 'completed'].includes(document.status) && !document.submitted_at);
  const exactIds = candidates.filter(document => containsPhrase(name, normalize(document.id)));
  if (exactIds.length) return exactIds.map(document => document.id);
  return candidates.filter(document => {
    const title = String(document.title || '').replace(/^dispensation\s+request\s*:\s*/i, '').trim();
    const date = title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
    // Require the full event name AND its calendar date. No fuzzy or model
    // inference is permitted to decide which report leaves the Lodge.
    if (!date) return false;
    const event = normalize(title.slice(0, date.index).replace(/[,\s]+$/, ''));
    if (event.split(' ').length < 3) return false;
    const eventDate = normalize(date[0]);
    const month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(date[1].toLowerCase()) + 1;
    const isoDate = normalize(`${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`);
    return [name, heading].some(source => containsPhrase(source, event)
      && (containsPhrase(source, eventDate) || containsPhrase(source, isoDate)));
  }).map(document => document.id);
}

export async function collectReportCandidates(folders = reportFolders, now = Date.now()) {
  const reports = [];
  for (const folder of folders) {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.pdf$/i.test(entry.name) || entry.name.startsWith('.')) continue;
      const file = path.join(folder, entry.name);
      const before = await fs.lstat(file);
      if (!before.isFile() || before.size > 12 * 1024 * 1024 || before.size < 20 || now - before.mtimeMs < 5000) continue;
      let bytes;
      try { bytes = await fs.readFile(file); } catch { continue; }
      const after = await fs.lstat(file);
      if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) continue;
      const parser = new PDFParse({ data: bytes });
      let text;
      try { text = (await parser.getText()).text || ''; } catch { continue; }
      finally { await parser.destroy(); }
      reports.push({ file, filename: entry.name, sourceLabel: path.basename(folder), bytes, text, sha256: digest(bytes) });
    }
  }
  return reports;
}

export async function syncReports({ apply = false, folders = reportFolders, base = 'https://stone-square-sign.onrender.com', token, fetcher = fetch } = {}) {
  if (!token) throw new Error('The owner Mac session is unavailable. Open the dashboard and sign in.');
  if (base !== 'https://stone-square-sign.onrender.com' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Unrecognized dashboard service.');
  const api = async (route, options = {}) => {
    const response = await fetcher(`${base}${route}`, { ...options, headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Dashboard request failed (${response.status}).`);
    return result;
  };
  const { user } = await api('/api/auth/me');
  if (user?.role !== 'owner') throw new Error('Only the Worshipful Master can connect supporting reports.');
  const { documents } = await api('/api/documents');
  const reports = await collectReportCandidates(folders);
  const grouped = new Map();
  const result = { mode: apply ? 'apply' : 'preview', uploaded: [], waiting: [], alreadyLinked: [] };
  for (const report of reports) {
    const ids = matchingDocumentIds(report, documents);
    if (ids.length !== 1) { result.waiting.push({ filename: report.filename, reason: ids.length ? 'More than one dispensation matches. Choose the report in the dashboard.' : 'No exact event and date match. Choose the report in the dashboard.' }); continue; }
    const matches = grouped.get(ids[0]) || [];
    matches.push(report); grouped.set(ids[0], matches);
  }
  for (const [id, matches] of grouped) {
    const unique = new Map(matches.map(report => [report.sha256, report]));
    if (unique.size !== 1) { result.waiting.push({ documentId: id, reason: 'Different reports match this dispensation. Choose the correct one in the dashboard.' }); continue; }
    const report = unique.values().next().value;
    const { packet } = await api(`/api/documents/${id}/submission-packet`);
    if (packet.report) {
      if (packet.report.sha256 === report.sha256) result.alreadyLinked.push(id);
      else result.waiting.push({ documentId: id, reason: 'A different report is already attached. No changes made.' });
      continue;
    }
    if (!apply) { result.waiting.push({ documentId: id, filename: report.filename, reason: 'Exact match ready to attach.' }); continue; }
    const data = new FormData();
    data.append('report', new Blob([report.bytes], { type: 'application/pdf' }), report.filename);
    data.append('sourceLabel', report.sourceLabel);
    await api(`/api/documents/${id}/supporting-report`, { method: 'PUT', body: data });
    result.uploaded.push({ documentId: id, filename: report.filename });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tokenFile = path.join(os.homedir(), 'Library/Containers/com.dstechnology.stonesquare.sign/Data/Library/Application Support/Stone Square Sign/session');
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    const result = await syncReports({ apply: process.argv.includes('--apply'), token });
    // Log state changes only. Do not emit source text, credentials, or PDF data.
    const stateDir = path.join(os.homedir(), 'Library/Application Support/Stone Square Sign Report Sync');
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const stateFile = path.join(stateDir, 'status.json');
    const serialized = JSON.stringify(result);
    let prior = ''; try { prior = await fs.readFile(stateFile, 'utf8'); } catch {}
    if (serialized !== prior) {
      await fs.writeFile(stateFile, serialized, { mode: 0o600 });
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
