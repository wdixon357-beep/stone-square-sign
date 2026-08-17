/* Fails when the web dashboard and the Mac app drift apart.
 *
 * The Mac app is a separate native implementation, not a window onto the web page, so
 * a feature added to one does not appear in the other. That already happened once: the
 * app kept its old name, still pointed at localhost, and had no dues, while the web
 * side had all three. Nobody noticed until William did.
 *
 * This makes drift a build failure instead of a discovery. Every area the web offers
 * must have a Mac counterpart here, or be listed in WEB_ONLY with a reason. Adding to
 * WEB_ONLY is deliberate and visible in review; forgetting is not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* web element id -> Mac AppSection case */
const PAIRS = {
  homeNav: 'home',
  queueNav: 'documents',
  builderNav: 'createDispensation',
  duesNav: 'dues',
  profileButton: 'profile',
};

/* Deliberate asymmetries. Each needs a reason, so the list stays honest. */
const WEB_ONLY = {
  // none today
};
const MAC_ONLY = {
  settings: 'the Mac app has to be told which server to talk to; the web page is served by it',
  access: 'officer access is a panel on the web home screen rather than its own section',
  candidateTracker: 'the web side links out to the Tracker instead of embedding it',
};

const html = read('public/index.html');
const models = read('macos/Sources/StoneSquareSign/Models.swift');
const macViews = read('macos/Sources/StoneSquareSign/Views.swift');

const webSections = [...html.matchAll(/id="([a-zA-Z]+(?:Nav|Button))"/g)].map((m) => m[1]);
const macSections = (models.match(/enum AppSection: Hashable \{ case ([^}]+)\}/)?.[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const macRouted = [...macViews.matchAll(/tag\(AppSection\.([a-zA-Z]+)\)/g)].map((m) => m[1]);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`);
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
};

console.log('\nWeb and Mac feature parity');

for (const web of webSections) {
  if (WEB_ONLY[web]) { console.log(`  skip  ${web} is web only: ${WEB_ONLY[web]}`); continue; }
  const mac = PAIRS[web];
  check(`web "${web}" has a Mac counterpart`, Boolean(mac),
    'add it to PAIRS, or to WEB_ONLY with a reason');
  if (mac) {
    check(`  Mac AppSection.${mac} exists`, macSections.includes(mac), macSections.join(', '));
    check(`  Mac AppSection.${mac} is reachable in the sidebar`, macRouted.includes(mac),
      'declared but never given a Label tag, so no one can open it');
  }
}

for (const mac of macSections) {
  if (MAC_ONLY[mac]) { console.log(`  skip  ${mac} is Mac only: ${MAC_ONLY[mac]}`); continue; }
  check(`Mac "${mac}" has a web counterpart`, Object.values(PAIRS).includes(mac),
    'add it to PAIRS, or to MAC_ONLY with a reason');
}

/* Things that must be true of the Mac app whatever sections exist. */
console.log('\nMac app configuration');
const client = read('macos/Sources/StoneSquareSign/APIClient.swift');
check('the Mac app defaults to the hosted service, not localhost',
  /let defaultServerAddress = "https:\/\//.test(client) && !/\?\? "http:\/\/localhost/.test(client));
check('the Mac app consumes the same live event stream as the web page',
  client.includes('/api/events') && read('public/app.js').includes('/api/events'));
check('both clients honour the same dues roles',
  /owner", "secretary", "assistant_secretary"/.test(macViews)
  && /'owner', 'secretary', 'assistant_secretary'/.test(read('public/app.js')));

const builder = read('public/index.html');
const macBuilder = macViews;
check('both clients let a dispensation go to both Secretaries at once',
  /<option value="both"/.test(builder) && /\.tag\("both"\)/.test(macBuilder));
check('both clients send the officer list rather than a single officer',
  read('public/app.js').includes('signerRoles:') && macBuilder.includes('signerRoles:')
  && read('macos/Sources/StoneSquareSign/APIClient.swift').includes('"signerRoles"'));
check('both clients default a new dispensation to both Secretaries',
  /SIGNER_CHOICES\.both/.test(read('public/app.js'))
  && /signerChoice = "both"/.test(macBuilder));

const plist = read('macos/Resources/Info.plist');
const title = html.match(/<title>([^<]*)<\/title>/)?.[1] || '';
check('the Mac bundle name matches the web page title',
  plist.includes(`<string>${title}</string>`), `page says "${title}"`);

console.log(failures === 0
  ? '\nWeb and Mac are in step.\n'
  : `\n${failures} parity failure(s). One side has moved without the other.\n`);
process.exit(failures === 0 ? 0 : 1);
