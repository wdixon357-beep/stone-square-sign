import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../macos/Sources/StoneSquareSign/StoneSquareSignApp.swift');
const updater = read('../macos/Sources/StoneSquareSign/AppUpdater.swift');
const received = read('../macos/Sources/StoneSquareSign/ReceivedReports.swift');
const views = read('../macos/Sources/StoneSquareSign/Views.swift');

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

console.log('PASS: Mac windows remain on-screen and Received Reports reflows without clipping.');
