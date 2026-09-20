import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../macos/Sources/StoneSquareSign/StoneSquareSignApp.swift');
const updater = read('../macos/Sources/StoneSquareSign/AppUpdater.swift');
const received = read('../macos/Sources/StoneSquareSign/ReceivedReports.swift');
const views = read('../macos/Sources/StoneSquareSign/Views.swift');
const treasury = read('../macos/Sources/StoneSquareSign/Treasury.swift');
const minutes = read('../macos/Sources/StoneSquareSign/MeetingMinutes.swift');
const agenda = read('../macos/Sources/StoneSquareSign/AgendaCreator.swift');
const reportGenerator = read('../macos/Sources/StoneSquareSign/ReportGenerator.swift');
const finalBrowser = read('../macos/Sources/StoneSquareSign/FinalReportBrowser.swift');
const buildingCalendar = read('../macos/Sources/StoneSquareSign/BuildingCalendar.swift');
const allWorkspaceSources = [views, received, treasury, minutes, agenda, reportGenerator, finalBrowser, buildingCalendar].join('\n');

assert.match(app, /minWidth:\s*720/, 'the app must fit smaller Mac displays and split-screen windows');
assert.doesNotMatch(app, /minWidth:\s*1120/, 'the former oversized minimum must not return');
assert.match(updater, /visibleFrame/, 'restored windows must use the current screen bounds');
assert.match(updater, /didChangeScreenParametersNotification/, 'windows must be corrected after display changes');
assert.match(updater, /window\.setFrame\(frame, display: true, animate: false\)/, 'off-screen windows must be moved fully into view');
assert.match(received, /available\.size\.width < 760/, 'Received Reports must switch to a compact layout');
assert.doesNotMatch(received, /HSplitView/, 'Received Reports must not use the nested split control that displaces report titles');
assert.match(received, /reportList\.frame\(width: min\(max\(available\.size\.width \* 0\.32, 260\), 380\)\)/, 'the report list must have a bounded responsive width');
assert.match(received, /\.frame\(width: available\.size\.width, height: available\.size\.height\)[\s\S]*\.clipped\(\)/, 'Received Reports must stay inside its assigned pane');
assert.doesNotMatch(received, /LodgeDocumentPreview\(data: model\.pdf\)\.frame\(minWidth: 500\)/, 'the PDF preview must not force the workspace off-screen');
assert.match(views, /GeometryReader \{ available in[\s\S]*\.clipped\(\)/, 'every workspace page must remain bounded by the shared detail area');
assert.doesNotMatch(allWorkspaceSources, /HSplitView/, 'no Dashboard workspace may use the split control that can displace content under the sidebar');
assert.match(views, /struct AdaptiveWorkspaceSplit/, 'all two-pane workspaces must share one responsive layout');
assert.match(views, /available\.size\.width < 820/, 'the shared layout must change to one pane at compact widths');
assert.match(views, /struct AdaptiveControlBar/, 'dense action and filter rows must have a compact fallback');
assert.match(views, /LazyVGrid\(columns: \[GridItem\(\.adaptive\(minimum: 150\)/, 'dues summary tiles must wrap instead of clipping');
assert.doesNotMatch(views, /frame\(minWidth: 920/, 'document previews must be allowed to fit smaller Mac windows');
assert.match(buildingCalendar, /AdaptiveControlBar[\s\S]*calendarNavigation[\s\S]*scopePicker/, 'the calendar toolbar must stack at compact widths');
assert.doesNotMatch(buildingCalendar, /frame\(width: 790, height: 760\)/, 'the building request sheet must not force a fixed oversized window');
for (const [name, source] of Object.entries({ treasury, minutes, agenda, reportGenerator, finalBrowser, buildingCalendar })) {
  assert.match(source, /AdaptiveWorkspaceSplit/, `${name} must use the bounded shared workspace layout`);
}
assert.match(minutes, /AdaptiveControlBar[\s\S]*recordSummary\(record\)[\s\S]*recordActions\(record\)/, 'minutes handoff rows must reflow at compact widths');
assert.match(minutes, /recordActions[\s\S]*ViewThatFits\(in: \.horizontal\)[\s\S]*recordActionControls/, 'minutes status and claim controls must stack before they clip');

console.log('PASS: every Mac split workspace remains on-screen, bounded, and usable at compact widths.');
