import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../.github/workflows/keep-awake.yml', import.meta.url), 'utf8');
const localDeploy = fs.readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');

for (const [name, source] of [['GitHub workflow', workflow], ['local deployment script', localDeploy]]) {
  for (const status of ['200', '201', '202']) {
    assert.match(source, new RegExp(`code.*${status}`), `${name} must accept Render HTTP ${status}`);
  }
}
assert.match(workflow, /check-production\.mjs .*--track-main/);
assert.match(monitor, /30 4-9 \* \* \*/, 'production must still be monitored while William\'s Mac is asleep');
assert.match(monitor, /RENDER_DEPLOY_HOOK/);
assert.match(monitor, /\/api\/ready/);
assert.match(monitor, /MONITOR_SCHEDULE: \$\{\{ github\.event\.schedule \}\}/);
assert.match(monitor, /MONITOR_EVENT: \$\{\{ github\.event_name \}\}/);
assert.match(monitor, /did not recover within eight minutes/);
assert.doesNotMatch(localDeploy, /BASE_URL="\$\{APP_BASE_URL:/, 'local deployment must not watch a development localhost');
assert.match(localDeploy, /PRODUCTION_BASE_URL:-https:\/\/stone-square-sign\.onrender\.com/);
// Rehearse the actual shell body with isolated transports. Runner delay must
// never skip an hourly event or wake the database for a process-only event.
const schedules = [...monitor.matchAll(/- cron: "([^"]+)"/g)].map(match => match[1]);
assert.equal(schedules.filter(schedule => schedule === '0 * * * *').length, 1);
function expand(field, max) {
  if (field === '*') return Array.from({ length: max + 1 }, (_, value) => value);
  return field.split(',').flatMap(part => {
    const [first, last = first] = part.split('-').map(Number);
    return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  });
}
const events = new Map();
for (const schedule of schedules) {
  const [minute, hour, day, month, weekday] = schedule.split(' ');
  assert.deepEqual([day, month, weekday], ['*', '*', '*']);
  for (const hourValue of expand(hour, 23)) {
    for (const minuteValue of expand(minute, 59)) {
      const key = hourValue + ':' + minuteValue;
      assert.ok(!events.has(key), 'duplicate process check at ' + key);
      events.set(key, schedule);
    }
  }
}
for (let hour = 0; hour < 24; hour += 1) {
  const minutes = [...events.keys()].filter(key => Number(key.split(':')[0]) === hour).map(key => Number(key.split(':')[1])).sort((a, b) => a - b);
  assert.deepEqual(minutes, hour >= 4 && hour <= 9 ? [0, 30] : [0, 10, 20, 30, 40, 50], 'process cadence at UTC hour ' + hour);
}
const runBody = monitor.match(/        run: \|\n([\s\S]*)$/)?.[1].replace(/^ {10}/gm, '');
assert.ok(runBody);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-square-monitor-'));
try {
  fs.writeFileSync(path.join(fixture, 'curl'), [
    '#!/bin/sh',
    'url=""; for value; do case "$value" in https://*) url="$value";; esac; done',
    'printf "%s\\n" "$url" >> "$MOCK_LOG"',
    'case "$url" in',
    '  */api/health)',
    '    count=0; if [ -f "$MOCK_DIR/count" ]; then count=$(cat "$MOCK_DIR/count"); fi',
    '    count=$((count + 1)); printf "%s" "$count" > "$MOCK_DIR/count"',
    '    if [ "$count" -le "$MOCK_HEALTH_FAILURES" ]; then exit 22; fi',
    '    printf "%s" "{\\"ok\\":true}" > "$MOCK_DIR/health";;',
    '  */api/ready)',
    '    printf "%s" "{\\"ready\\":true}" > "$MOCK_DIR/ready"',
    '    printf "%s" "$MOCK_READY_STATUS";;',
    '  https://fixture.invalid/restart) printf "%s" "$MOCK_HOOK_STATUS";;',
    '  *) exit 99;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, 'date'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_START_MINUTE"\n', { mode: 0o755 });
  const script = runBody.replaceAll('/tmp/health', path.join(fixture, 'health')).replaceAll('/tmp/ready', path.join(fixture, 'ready'));
  function rehearse({ schedule = '0 * * * *', event = 'schedule', minute = '24', ready = '200', healthFailures = 0, hookStatus = '202' } = {}) {
    const log = path.join(fixture, 'requests');
    for (const file of [log, path.join(fixture, 'count')]) fs.rmSync(file, { force: true });
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: fixture + ':' + process.env.PATH, HOOK: 'https://fixture.invalid/restart', MONITOR_SCHEDULE: schedule, MONITOR_EVENT: event, MOCK_LOG: log, MOCK_DIR: fixture, MOCK_START_MINUTE: minute, MOCK_READY_STATUS: ready, MOCK_HEALTH_FAILURES: String(healthFailures), MOCK_HOOK_STATUS: hookStatus },
    });
    assert.ifError(result.error);
    return { ...result, requests: fs.readFileSync(log, 'utf8').trim().split('\n') };
  }
  const healthUrl = 'https://stone-square-sign.onrender.com/api/health';
  const readyUrl = 'https://stone-square-sign.onrender.com/api/ready';
  const hourly = rehearse();
  assert.equal(hourly.status, 0, hourly.stderr);
  assert.deepEqual(hourly.requests, [healthUrl, readyUrl], 'delayed hourly event still checks readiness');
  for (const schedule of schedules.filter(value => value !== '0 * * * *')) {
    const frequent = rehearse({ schedule, minute: '00' });
    assert.equal(frequent.status, 0, frequent.stderr);
    assert.deepEqual(frequent.requests, [healthUrl], 'process event starting on the hour does not wake the database');
  }
  const manual = rehearse({ event: 'workflow_dispatch', schedule: '' });
  assert.equal(manual.status, 0, manual.stderr);
  assert.deepEqual(manual.requests, [healthUrl, readyUrl]);
  const unavailableDatabase = rehearse({ ready: '503' });
  assert.equal(unavailableDatabase.status, 1);
  assert.match(unavailableDatabase.stdout, /required service is unavailable/);
  assert.deepEqual(unavailableDatabase.requests, [healthUrl, readyUrl], 'database failure does not restart the web process');
  for (const hookStatus of ['200', '201', '202']) {
    const recovered = rehearse({ healthFailures: 3, hookStatus });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(recovered.requests, [healthUrl, healthUrl, healthUrl, 'https://fixture.invalid/restart', healthUrl, readyUrl]);
    assert.match(recovered.stdout, /dashboard recovered after the production restart/);
  }
  const refusedRestart = rehearse({ healthFailures: 3, hookStatus: '403' });
  assert.equal(refusedRestart.status, 1);
  assert.match(refusedRestart.stdout, /Render refused the recovery request/);
  assert.ok(!refusedRestart.requests.includes(readyUrl));
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log('PASS: GitHub and local deployment accept Render asynchronous 202 responses and retain production drift verification.');
console.log('PASS: delayed hourly and manual events check readiness, frequent events remain process-only, and database failures never trigger recovery.');
