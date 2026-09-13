import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const localDeploy = fs.readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');

for (const [name, source] of [['GitHub workflow', workflow], ['local deployment script', localDeploy]]) {
  for (const status of ['200', '201', '202']) {
    assert.match(source, new RegExp(`code.*${status}`), `${name} must accept Render HTTP ${status}`);
  }
}
assert.match(workflow, /check-production\.mjs .*--track-main/);
console.log('PASS: GitHub and local deployment accept Render asynchronous 202 responses and retain production drift verification.');
