import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Native minutes date checks require macOS.');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'sign-minutes-dates-'));
try {
  const binary = path.join(scratch, 'minutes-dates');
  const build = spawnSync('swiftc', [
    'macos/Sources/StoneSquareSign/MinutesDates.swift', 'test/mac-minutes-dates.swift', '-o', binary,
  ], { cwd: root, stdio: 'inherit' });
  process.exitCode = build.status === 0 ? (spawnSync(binary, [], { cwd: root, stdio: 'inherit' }).status ?? 1) : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
