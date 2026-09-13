// Prepares a feed only from a notarized, signed release. Does not publish or push.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [archiveArg, toolsArg] = process.argv.slice(2);
if (!archiveArg || !toolsArg) throw new Error('Usage: node scripts/prepare-mac-update.mjs RELEASE.zip SPARKLE_BIN_DIRECTORY');
const archive = path.resolve(archiveArg), tools = path.resolve(toolsArg);
const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
const filename = `Stone-Square-Sign-${version}.zip`;
if (path.basename(archive) !== filename) throw new Error(`Expected notarized distribution archive ${filename}; local-only builds are not accepted.`);
const temporary = mkdtempSync(path.join(tmpdir(), 'stone-square-update-'));
try {
  run('/usr/bin/ditto', ['-x', '-k', archive, temporary]);
  const app = path.join(temporary, 'Stone Square Sign.app');
  const plist = path.join(app, 'Contents/Info.plist');
  const value = key => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
  if (value('CFBundleIdentifier') !== 'com.dstechnology.stonesquare.sign' || value('CFBundleShortVersionString') !== version || value('CFBundleVersion') !== version) throw new Error('Archive identity or version does not match this release.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  const publicKey = run(path.join(tools, 'generate_keys'), ['--account', 'stone-square-sign', '-p']);
  if (value('SUPublicEDKey') !== publicKey) throw new Error('The update archive does not trust the release signing key.');
  const signature = run(path.join(tools, 'sign_update'), ['--account', 'stone-square-sign', '-p', archive]);
  run(path.join(tools, 'sign_update'), ['--account', 'stone-square-sign', '--verify', archive, signature]);
  if (!/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error('Invalid archive signature output.');
  const url = `https://github.com/wdixon357-beep/stone-square-sign/releases/download/v${version}/${filename}`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Stone Square Sign updates</title>
    <link>https://stone-square-sign.onrender.com/updates/appcast.xml</link>
    <item>
      <title>Stone Square Sign ${version}</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${version}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure url="${url}" sparkle:edSignature="${signature}" length="${statSync(archive).size}" type="application/octet-stream" />
    </item>
  </channel>
</rss>
`;
  const output = path.join(path.dirname(archive), 'appcast.xml');
  writeFileSync(output, xml);
  console.log(`Verified update feed prepared: ${output}\nPublish the archive as GitHub release v${version}, verify its public download, then copy this feed to public/updates/appcast.xml and deploy it. Never advertise an archive before it is downloadable.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
