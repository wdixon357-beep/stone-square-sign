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
  buildingNav: 'building',
  calendarNav: 'lodgeCalendar',
  proposalsNav: 'proposalReview',
  reportsNav: 'reportGenerator',
  correspondenceNav: 'correspondence',
  receivedReportsNav: 'receivedReports',
  minutesNav: 'minutes',
  agendaNav: 'agenda',
  treasuryNav: 'treasury',
  activityNav: 'activity',
  memberAccessNav: 'memberAccess',
  queueNav: 'documents',
  builderNav: 'createDispensation',
  duesNav: 'dues',
  myDuesNav: 'myDues',
  suggestionsNav: 'suggestions',
  approvalsNav: 'approvals',
  proposalReviewNav: 'proposalReview',
  profileButton: 'profile',
  settingsNav: 'settings',
  accessNav: 'access',
};

/* Deliberate asymmetries. Each needs a reason, so the list stays honest. */
const WEB_ONLY = {};

const MAC_ONLY = {
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
const macMinutes = read('macos/Sources/StoneSquareSign/MeetingMinutes.swift');
const macBuildingCalendar = read('macos/Sources/StoneSquareSign/BuildingCalendar.swift');
const webBuildingCalendar = read('public/building-calendar.js');
check('both clients open building requests through the authenticated shared service',
  macBuildingCalendar.includes('model.request("/api/building/requests")')
  && webBuildingCalendar.includes("this.api('/api/building/requests')")
  && macViews.includes('case .building: BuildingRequestsView()'));
check('both clients require building decision permission and server approval access',
  macBuildingCalendar.includes('model.user?.can("building.decide") == true')
  && macBuildingCalendar.includes('canDecide')
  && webBuildingCalendar.includes("this.can('building.decide')")
  && webBuildingCalendar.includes('result.canDecide'));
check('both clients expose the Lodge Calendar with manager-only source-aware editing',
  macViews.includes('case .lodgeCalendar: LodgeCalendarView()')
  && macBuildingCalendar.includes('model.user?.can("calendar.manage") == true')
  && macBuildingCalendar.includes('event.editable')
  && webBuildingCalendar.includes("this.can('calendar.manage')")
  && webBuildingCalendar.includes('event?.editable'));
check('both clients send the saved calendar revision for editing and removal',
  macBuildingCalendar.includes('revision = event.revision')
  && macBuildingCalendar.includes('event.revision.map { ["revision": $0] }')
  && macBuildingCalendar.includes('method: "DELETE", body: body')
  && webBuildingCalendar.includes('event.revision=this.editingEvent.revision')
  && webBuildingCalendar.includes('JSON.stringify({revision:event.revision})'));
check('Wardens can prepare proposals natively while the owner retains the review workspace',
  macViews.includes('MyDispensationProposalsView()')
  && macViews.includes('model.user?.showsPersonalProposals == true')
  && models.includes('role != "owner" && canProposeDispensation'));

check('the Mac app defaults to the hosted service, not localhost',
  /let defaultServerAddress = "https:\/\//.test(client) && !/\?\? "http:\/\/localhost/.test(client));
check('the Mac app consumes the same live event stream as the web page',
  client.includes('/api/events') && read('public/app.js').includes('/api/events'));
check('both clients separate the full dues ledger from each Brother personal dues screen',
  models.includes('can("dues.ledger")') && models.includes('can("dues.self")')
  && read('public/app.js').includes("can('dues.ledger', user)") && read('public/app.js').includes("can('dues.self', user)")
  && models.includes('if let permissions { return permissions.contains(capability) }')
  && read('public/app.js').includes('user?.permissions?.includes(permission)'));
check('both clients separate minutes preparation from final record viewing',
  models.includes('can("minutes.view") || can("minutes.prepare")')
  && macViews.includes('model.user?.can("minutes.prepare") == true')
  && read('public/app.js').includes("if (!can('minutes.prepare')) return;")
  && read('public/app.js').includes('/api/minutes/${item.id}/pdf')
  && read('server.js').includes("app.post('/api/minutes/generate', requireAuth, requireMinutesAccess"));
check('both clients show secured historical minutes and treasurer archives inside the Dashboard',
  read('public/app.js').includes('/api/archives/minutes')
  && read('public/treasury.js').includes('/api/archives/treasury')
  && read('macos/Sources/StoneSquareSign/FinalReportBrowser.swift').includes('/api/archives/\\(kind.rawValue)')
  && read('macos/Sources/StoneSquareSign/FinalReportBrowser.swift').includes('Close report'));
check('both clients file signed minutes under history and highlight their availability',
  read('public/app.js').includes("const activeMinutes = state.minutes.filter(item => !finalizedStatuses.has(item.status))")
  && read('public/app.js').includes('Meeting minutes are available to view')
  && read('macos/Sources/StoneSquareSign/MeetingMinutes.swift').includes('Signed minutes are filed under Finalized in Dashboard.')
  && read('macos/Sources/StoneSquareSign/FinalReportBrowser.swift').includes('Meeting minutes are available to view'));
check('both clients use the complete Meeting Minutes, Month Day, Year title',
  read('public/app.js').includes('Meeting Minutes, ${minutesDateLabel(item)}')
  && read('macos/Sources/StoneSquareSign/MinutesDates.swift').includes('Meeting Minutes, \\(monthDayYear(raw))'));
check('both clients place Secretary distribution controls beside historical signed minutes',
  read('public/app.js').includes('WM review complete, ready to send to the Craft')
  && read('public/app.js').includes('Share signed PDF')
  && read('public/app.js').includes('Mark as sent to the Craft')
  && read('macos/Sources/StoneSquareSign/FinalReportBrowser.swift').includes('Share signed PDF')
  && read('macos/Sources/StoneSquareSign/FinalReportBrowser.swift').includes('Mark as sent to the Craft'));
check('treasurer archive previews return to the list without opening a browser tab',
  read('public/treasury.js').includes('data-treasury="back"')
  && !read('public/treasury.js').includes('target="_blank"'));
check('both clients keep the owner capable of administering all areas',
  models.includes('if role == "owner" { return true }')
  && read('public/app.js').includes("user?.role === 'owner' ||"));
check('the Mac app opens the authenticated minutes workspace',
  macMinutes.includes("/api/minutes")
  && macMinutes.includes('forHTTPHeaderField: "Authorization"')
  && !macMinutes.includes("WKWebView")
  && macViews.includes('MeetingMinutesView(workspace: minutesWorkspace, onExit:'));

const builder = read('public/index.html');
const macBuilder = macViews;
/* William settled this on 2026-08-25: the Lodge no longer picks a Secretary. Every dispensation
 * goes to both and whoever signs first completes it. The gate is now that NEITHER client offers
 * the choice, and both say so plainly. The invite dropdown is a different control and still
 * lets him choose which office he is inviting a Brother into, so this looks for the picker
 * itself rather than for the word anywhere on the page. */
check('neither client still offers a Secretary picker on the builder',
  !/id="dispSignerRole"[^>]*>\s*<option/.test(builder) && !/Picker\("Send to"/.test(macBuilder));
check('both clients say it goes to both Secretaries, whoever signs first',
  /Both Secretaries\. Whoever signs it first/.test(builder)
  && /both Secretaries\. Whoever signs it first/.test(macBuilder));
check('both clients send the officer list rather than a single officer',
  read('public/app.js').includes('signerRoles:') && macBuilder.includes('signerRoles:')
  && read('macos/Sources/StoneSquareSign/APIClient.swift').includes('"signerRoles"'));
check('both clients default a new dispensation to both Secretaries',
  /SIGNER_CHOICES\.both/.test(read('public/app.js'))
  && /signerChoice = "both"/.test(macBuilder));

check('both clients can open a document already sent to one Secretary',
  read('public/app.js').includes('/offer-to-both')
  && read('macos/Sources/StoneSquareSign/APIClient.swift').includes('/offer-to-both')
  && /Let either Secretary sign/.test(read('public/app.js'))
  && /Let either Secretary sign/.test(macViews));

check('both clients can send a signed dispensation to the District Deputy',
  read('public/app.js').includes('/submit')
  && read('macos/Sources/StoneSquareSign/APIClient.swift').includes('/submit')
  && /Send to the District Deputy/.test(read('public/app.js'))
  && /Send to the District Deputy/.test(macViews));
check('both clients say plainly when a dispensation did NOT reach the District Deputy',
  /NOT sent to the District Deputy/.test(read('public/app.js'))
  && /NOT sent to the District Deputy/.test(macViews));

check('both clients can open a draft to the District Deputy in the Master\'s own mail app',
  read('public/app.js').includes('/submission-draft')
  && read('macos/Sources/StoneSquareSign/APIClient.swift').includes('/submission-draft')
  && /Draft in my mail app/.test(read('public/app.js'))
  && /Draft in my mail app/.test(macViews));

check('both clients show an invited officer as pending rather than still needing one',
  /Pending, invited and not signed in yet/.test(read('public/app.js'))
  && /Pending, invited and not signed in yet/.test(read('macos/Sources/StoneSquareSign/Models.swift'))
  && read('public/app.js').includes('pendingByRole')
  && read('macos/Sources/StoneSquareSign/APIClient.swift').includes('pendingInvitations'));

check('both clients say plainly when an approval has no endorsed copy behind it',
  /No approval document on file/.test(read('public/app.js'))
  && /No approval document on file/.test(macViews));

check('both clients show a Brother invited as a viewer, not only the two Secretaries',
  /\['viewer','warden','member'(?:,'treasury_preparer')?(?:,'officer')?\]\.includes\(invite.role\)/.test(read('public/app.js'))
  && /\["viewer","member","warden"(?:,"treasury_preparer")?(?:,"officer")?\]\.contains\(\$0.role\)/.test(macViews)
  && macViews.includes('pendingInvitations.filter'));

/* A workspace section has to live inside <div class="content">. Put one outside and it
 * still exists, showWorkspaceSection still un-hides it, every test still passes, and the
 * Warden sees an empty pane with his form stranded at the foot of the page. Both new
 * warden sections shipped that way. */
const appJsSource = read('public/app.js');
const contentStart = html.indexOf('<div class="content">');
const contentEnd = html.indexOf('class="modal', contentStart);  /* the modals begin where the content pane ends */
const toggled = [...appJsSource.matchAll(/\$\('(\w+Section)'\)\.classList\.toggle\('hidden'/g)]
  .map((m) => m[1]);
const stranded = toggled.filter((id) => {
  const at = html.indexOf(`id="${id}"`);
  return at < contentStart || at > contentEnd;
});
check('every workspace section sits inside the content pane',
  stranded.length === 0,
  stranded.length ? `outside <div class="content">: ${stranded.join(', ')}` : '');

/* Every $('id') the dashboard reaches for must exist in the page. A bare $() returns
 * null, and app.js binds its listeners at the top level, so ONE missing element throws
 * before initialize() ever runs and the whole web dashboard is dead on load. That is
 * not hypothetical: the Approvals section shipped on 17 August with its nav button, its
 * app.js and its server route, and no section markup at all. The web app had been dead
 * since. Nothing caught it because the e2e suite talks to the API and never opens a page.
 * Optional ones, $('id')?., are the author saying it may legitimately be absent. */
const pageIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const appJs = read('public/app.js');
const required = [...appJs.matchAll(/\$\('([a-zA-Z][\w-]*)'\)(\??)/g)]
  .filter(([, , optional]) => optional !== '?')
  .map(([, id]) => id);
const missing = [...new Set(required)].filter((id) => !pageIds.has(id));
check('every element app.js binds without ?. actually exists in index.html',
  missing.length === 0,
  missing.length ? `missing from index.html: ${missing.join(', ')}` : '');

/* This repository is public. A Brother's personal address is his, not the Lodge's to
 * publish, and one went in with the Warden feature before anybody noticed. Addresses
 * belong in the environment. Only the Lodge's own domain and example.org may appear in
 * the source. */
const PERSONAL_ADDRESS = /[A-Za-z0-9._%+-]+@(?!stonesquare22pha\.org|example\.(?:org|com)|[^\s"'`]*\.local)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const sourcesToCheck = ['building-calendar.js', 'public/building-calendar.js', 'macos/Sources/StoneSquareSign/BuildingCalendar.swift', 'server.js', 'db.js', 'dues.js', 'public/app.js', 'public/index.html',
  'test/e2e.mjs', 'test/parity.mjs', 'render.yaml', '.env.example',
  'macos/Sources/StoneSquareSign/APIClient.swift', 'macos/Sources/StoneSquareSign/Models.swift',
  'macos/Sources/StoneSquareSign/Views.swift'];
const leaked = sourcesToCheck.flatMap((file) => {
  let text = '';
  try { text = read(file); } catch { return []; }
  return (text.match(PERSONAL_ADDRESS) || [])
    .filter((address) => !/@(sentry|schemas|www)\./i.test(address))
    .map((address) => `${file}: ${address}`);
});
check('no personal email address is committed to this public repository',
  leaked.length === 0, leaked.join('; '));

const plist = read('macos/Resources/Info.plist');
const title = html.match(/<title>([^<]*)<\/title>/)?.[1] || '';
check('the Mac bundle name matches the web page title',
  plist.includes(`<string>${title}</string>`), `page says "${title}"`);

console.log(failures === 0
  ? '\nWeb and Mac are in step.\n'
  : `\n${failures} parity failure(s). One side has moved without the other.\n`);
process.exit(failures === 0 ? 0 : 1);
