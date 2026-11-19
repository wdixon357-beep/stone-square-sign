import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const native = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MeetingMinutes.swift', import.meta.url), 'utf8');
const modelSource = native.slice(native.indexOf('struct MinutesSection:'), native.indexOf('struct MinutesChange:'));
const save = native.slice(native.indexOf('func save() async'), native.indexOf('func remove('));
const closingControls = native.slice(native.indexOf('Text("Prayer and closing")'), native.indexOf('if preparingAttendance && !meetingDetailsReady'));
assert.match(modelSource, /var closingFormatVersion: Int\?/, 'New closing format is optional for legacy decoding');
assert.match(modelSource, /var prayerRequested: Bool\?/, 'Preserve the legacy prayer request value');
assert.doesNotMatch(closingControls, /prayerRequested|Needs confirmation/, 'A routine prayer does not require a confirmation');
assert.match(closingControls, /status == "draft" \|\| \(workspace\.draft\?\.closingFormatVersion \?\? 0\) >= 4/);
assert.match(closingControls, /Toggle\("Chaplain did not give the closing prayer", isOn: Binding\(\s*get: \{ workspace\.draft\?\.closingPrayerGiven == false \},\s*set: \{ workspace\.draft\?\.closingPrayerGiven = !\$0 \}/, 'Only an explicit negative turns on the exception');
assert.match(closingControls, /else \{\s*Picker\("Chaplain gave the closing prayer"[\s\S]*Text\("Not recorded"\)/, 'Legacy review can still represent an unknown prayer');
assert.match(native, /LodgeClockField\(title: "Closing time", value: text\(\\\.closingTime\)\)/, 'Keep the closing time field');
assert.match(save, /if record\.status == "draft" \{ draft\.closingFormatVersion = 4 \}/, 'Only the working draft save changes the format');
assert.doesNotMatch(save, /(?:prayerRequested|closingPrayerGiven)\s*=/, 'Saving preserves recorded prayer answers and lets the service handle defaults');

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
for version: Int? in [nil, 3, 4] {
    for value: Bool? in [nil, true, false] {
        var object = original
        object["closingFormatVersion"] = version
        object["prayerRequested"] = value
        object["closingPrayerGiven"] = value
        let draft = try JSONDecoder().decode(MinutesDraft.self, from: JSONSerialization.data(withJSONObject: object))
        let saved = try JSONDecoder().decode(MinutesDraft.self, from: JSONEncoder().encode(draft))
        precondition(saved.prayerRequested == value, "Recorded legacy prayer request preserved")
        precondition(saved.closingPrayerGiven == value, "Recorded closing prayer preserved")
        precondition(saved.closingFormatVersion == version, "Captured closing format preserved")
    }
}
print("PASS: native closing controls and true/false/unknown prayer values survive Codable round trips")
`);
  const build = spawnSync('swiftc', [source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
