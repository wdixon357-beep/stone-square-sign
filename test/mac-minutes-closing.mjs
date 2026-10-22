import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const native = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MeetingMinutes.swift', import.meta.url), 'utf8');
const modelSource = native.slice(native.indexOf('struct MinutesSection:'), native.indexOf('struct MinutesChange:'));
assert.match(modelSource, /var closingFormatVersion: Int\?/, 'New closing format is optional for legacy decoding');
assert.match(modelSource, /var prayerRequested: Bool\?/, 'Preserve the legacy prayer request value');
assert.doesNotMatch(native, /prayerPicker\([^\n]*key: \\\.prayerRequested\)/, 'No separate WM prayer-request picker remains');
assert.match(native, /prayerPicker\([^\n]*key: \\\.closingPrayerGiven\)/, 'The actual closing prayer remains a separate confirmation');
assert.match(native, /TextField\("Closing time", text: text\(\\\.closingTime\)\)/, 'Keep the closing time field');
assert.match(native.slice(native.indexOf('func save() async'), native.indexOf('func remove(')), /draft\.closingFormatVersion = 3/, 'An explicit editable save upgrades current formatting without rewriting captured snapshots');
assert.doesNotMatch(native.slice(native.indexOf('func save() async'), native.indexOf('func remove(')), /prayerRequested\s*=/, 'Saving must never overwrite a legacy prayer-request value');

if (process.platform !== 'darwin') {
  console.log('PASS: native closing form and legacy-preservation contracts; compiled checks run on macOS.');
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-minutes-closing-'));
try {
  const source = path.join(scratch, 'closing.swift');
  const binary = path.join(scratch, 'closing');
  fs.writeFileSync(source, `import Foundation\n${modelSource}\n
let original: [String: Any] = ["meetingType":"Stated Communication", "present":[], "excused":[], "visitors":[], "officerAttendance":[], "income":[], "expenses":[], "sections":[], "warnings":[], "sensitiveReview":[], "actionItems":[]]
for value in [true, false] {
    var object = original; object["prayerRequested"] = value
    let legacy = try JSONDecoder().decode(MinutesDraft.self, from: JSONSerialization.data(withJSONObject: object))
    precondition(legacy.prayerRequested == value && legacy.closingFormatVersion == nil, "Legacy prayer request preserved")
    var edited = legacy; edited.closingFormatVersion = 2
    let saved = try JSONDecoder().decode(MinutesDraft.self, from: JSONEncoder().encode(edited))
    precondition(saved.prayerRequested == value && saved.closingFormatVersion == 2, "Draft format upgrade preserves recorded prayer request")
}
let absent = try JSONDecoder().decode(MinutesDraft.self, from: JSONSerialization.data(withJSONObject: original))
let savedAbsent = try JSONDecoder().decode(MinutesDraft.self, from: JSONEncoder().encode(absent))
precondition(savedAbsent.prayerRequested == nil && savedAbsent.closingFormatVersion == nil, "Unrecorded prayer request stays unknown")
print("PASS: native closing controls and true/false/unknown legacy prayer values survive Codable round trips")
`);
  const build = spawnSync('swiftc', [source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
