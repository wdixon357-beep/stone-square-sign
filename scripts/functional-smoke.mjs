// Run the package's web/shared-service synthetic tests on Linux. Native Mac
// compilation and UI fixtures are verified by a separate macOS check.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const commands = scripts.test.split(/\s*&&\s*/);
if (commands.some(command => !/^node test\/[a-z0-9][a-z0-9-]*\.mjs$/.test(command))) {
  throw new Error('The test command changed; review the private functional rehearsal before running it.');
}
const excluded = new Set([
  'mac-agenda.mjs',
  'mac-layout.mjs',
  'mac-compiles.mjs',
  'mac-session.mjs',
  'mac-minutes-dates.mjs',
  'mac-report.mjs',
]);
const selected = commands.filter(command => !excluded.has(path.basename(command)));
if (selected.length < 35 || !selected.includes('node test/e2e.mjs') ||
    !selected.includes('node test/minutes-ai.mjs') ||
    !selected.includes('node test/treasury-e2e.mjs')) {
  throw new Error('The synthetic web coverage list is unexpectedly incomplete.');
}

for (const command of selected) {
  const testFile = command.slice('node '.length);
  console.log(`\nRehearsing ${testFile}`);
  const result = spawnSync(process.execPath, [testFile], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: '', PGLITE_DIR: '', OPENAI_API_KEY: '',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', ZEFFY_API_KEY: '',
      RENDER_DEPLOY_HOOK: '',
    },
  });
  if (result.status !== 0) {
    throw new Error(`${testFile} failed (${result.signal || `exit ${result.status ?? 'unknown'}`}).`);
  }
}
console.log(`\n${selected.length} isolated web and shared-service suites passed.`);
