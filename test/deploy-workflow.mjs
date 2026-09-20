import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const monitor = fs.readFileSync(new URL('../.github/workflows/keep-awake.yml', import.meta.url), 'utf8');
const localDeploy = fs.readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');

for (const [name, source] of [['GitHub workflow', workflow], ['local deployment script', localDeploy]]) {
  for (const status of ['200', '201', '202']) {
    assert.match(source, new RegExp(`code.*${status}`), `${name} must accept Render HTTP ${status}`);
  }
}
assert.match(workflow, /check-production\.mjs .*--track-main/);
assert.match(monitor, /0,30 4-9 \* \* \*/, 'production must still be monitored while William\'s Mac is asleep');
assert.match(monitor, /RENDER_DEPLOY_HOOK/);
assert.match(monitor, /\/api\/ready/);
assert.match(monitor, /date -u \+%M/, 'database readiness should be hourly rather than consuming compute every ten minutes');
assert.match(monitor, /did not recover within eight minutes/);
assert.doesNotMatch(localDeploy, /BASE_URL="\$\{APP_BASE_URL:/, 'local deployment must not watch a development localhost');
assert.match(localDeploy, /PRODUCTION_BASE_URL:-https:\/\/stone-square-sign\.onrender\.com/);
console.log('PASS: GitHub and local deployment accept Render asynchronous 202 responses and retain production drift verification.');
