import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function expectedProduction(root = ROOT) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const names = (await readdir(path.join(root, 'public'))).filter(name => /\.(?:js|css|html)$/.test(name));
  const assets = Object.fromEntries(await Promise.all(names.map(async name =>
    ['/' + name, await readFile(path.join(root, 'public', name), 'utf8')])));
  assets['/'] = assets['/index.html'].replaceAll('__APP_VERSION__', version);
  return { version, assets };
}

export async function checkProduction({ expected, commit, base = 'https://stone-square-sign.onrender.com', fetcher = fetch }) {
  const issues = [];
  const get = async pathname => {
    try {
      const response = await fetcher(new URL(pathname, base), { signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      issues.push(`${pathname}: ${error.message}`);
      return null;
    }
  };
  await Promise.all(Object.entries(expected.assets).map(async ([pathname, content]) => {
    const live = await get(pathname);
    if (live !== null && hash(live) !== hash(content)) issues.push(`${pathname}: live content does not match this release.`);
  }));
  const versionText = await get('/api/version');
  if (versionText !== null) {
    try {
      const live = JSON.parse(versionText);
      if (live.version !== expected.version) issues.push(`Server version is ${live.version}; expected ${expected.version}.`);
      if (live.commit !== commit) issues.push(`Server commit is ${live.commit || 'not reported'}; expected ${commit}.`);
    } catch { issues.push('/api/version: invalid version response.'); }
  }
  // Check required static bindings as well as matching bytes. Optional bindings
  // deliberately allow controls which are not on every page.
  const required = new Set([...expected.assets['/app.js'].matchAll(/\$\('([^']+)'\)(?!\?\.)/g)].map(match => match[1]));
  for (const id of required) if (!expected.assets['/'].includes(`id="${id}"`)) issues.push(`Dashboard markup is missing required control #${id}.`);
  return issues;
}

export async function waitForProduction({ check, waitMs = 0, intervalMs = 30000, current = () => true, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), progress = () => {} }) {
  const deadline = now() + waitMs;
  while (true) {
    if (!await current()) return { superseded: true, issues: [] };
    const issues = await check();
    // A newer push can arrive while the requests are running.
    if (!await current()) return { superseded: true, issues: [] };
    if (!issues.length || now() >= deadline) return { superseded: false, issues };
    progress(issues);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const expected = await expectedProduction();
  const trackMain = process.argv.includes('--track-main');
  const current = () => !trackMain || execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).trim().split(/\s/)[0] === commit;
  const result = await waitForProduction({
    check: () => checkProduction({ expected, commit, base: option('base') }),
    waitMs: Number(option('wait-ms') || 0), current,
    progress: issues => console.log(`Waiting for the release to finish (${issues.length} checks still differ).`),
  });
  if (result.superseded) console.log('A newer main commit is being deployed. Its own run will verify it.');
  else if (result.issues.length) {
    for (const issue of result.issues) console.error(`::error::${issue}`);
    process.exitCode = 1;
  } else console.log(`Production verified: ${expected.version}, commit ${commit}, ${Object.keys(expected.assets).length} page and asset checks.`);
}
