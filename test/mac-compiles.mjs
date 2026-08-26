/* parity.mjs greps the Swift source; it cannot tell whether that source COMPILES.
 * decideProposal shipped passing a dictionary where the request helper wants Data, so
 * the Master's Mac side of the Warden feature could never have been built, and every
 * text-matching check still said the two clients were in step. Compile it. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const macos = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'macos');

if (spawnSync('swift', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.log('\n  skip  Mac app not compiled: no swift toolchain on this machine\n');
  process.exit(0);
}

console.log('\nMac app compiles');
const build = spawnSync('swift', ['build'], { cwd: macos, encoding: 'utf8' });
if (build.status === 0) {
  console.log('  ok    swift build\n');
  process.exit(0);
}
console.log(`  FAIL  swift build\n\n${build.stdout || ''}${build.stderr || ''}`);
process.exit(1);
