import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECKS = [
  { file: 'functional-smoke.yml', label: 'Functional rehearsal', maxHours: 36 },
  { file: 'mac-smoke.yml', label: 'Mac smoke checks', maxHours: 8 * 24 },
  { file: 'drift-watch.yml', label: 'Production release verification', maxHours: 36 },
];
export function assessFreshness(check, workflow, runs, now = Date.now()) {
  const successful = runs.filter(run => run.event === 'schedule' && run.status === 'completed' && run.conclusion === 'success'
    && run.head_branch === 'main' && Number.isFinite(Date.parse(run.updated_at)))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
  const ageHours = successful ? (now - Date.parse(successful.updated_at)) / 3600000 : null;
  const state = workflow.state !== 'active' ? 'disabled' : !successful ? 'unverified'
    : ageHours < -0.1 ? 'invalid_time' : ageHours > check.maxHours ? 'stale' : 'current';
  return { check: check.label, state, ageHours: ageHours === null ? null : Math.max(0, Math.round(ageHours * 10) / 10),
    maxHours: check.maxHours, runId: successful?.id || null, completedAt: successful?.updated_at || null };
}
export function checkMonitorFreshness(repository, api, now = Date.now()) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository || '')) throw Error('A valid repository is required.');
  return CHECKS.map(check => {
    const endpoint = `repos/${repository}/actions/workflows/${check.file}`;
    const workflow = api(endpoint);
    const data = api(`${endpoint}/runs?branch=main&event=schedule&status=completed&per_page=30`);
    if (!Array.isArray(data.workflow_runs)) throw Error('Workflow history could not be verified.');
    return assessFreshness(check, workflow, data.workflow_runs, now);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rows = checkMonitorFreshness(process.env.GITHUB_REPOSITORY, endpoint => {
      try { return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })); }
      catch { throw Error('Read-only GitHub workflow history is unavailable.'); }
    });
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks: rows }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### Scheduled check coverage\n\n| Check | State | Last success | Hours old |\n|---|---|---|---|\n'
      + rows.map(row => `| ${row.check} | ${row.state} | ${row.completedAt || 'Unverified'} | ${row.ageHours ?? 'Unknown'} |`).join('\n') + '\n');
    if (rows.some(row => row.state !== 'current')) {
      console.error('::error::One or more regular checks are overdue, disabled, or unverified. A healthy dashboard does not close this monitoring gap.');
      process.exitCode = 1;
    }
  } catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
}
