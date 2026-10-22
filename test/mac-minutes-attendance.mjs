import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attendanceCoverageIssues } from '../public/minutes-attendance.js';

const native = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MeetingMinutes.swift', import.meta.url), 'utf8');
const modelSource = native.slice(native.indexOf('struct MinutesSection:'), native.indexOf('struct MinutesChange:'));
assert.ok(modelSource.includes('func reviewComplete(requiringCoverage:'), 'Exercise the actual native model, not a copied implementation');
assert.match(native, /draft\.officerAttendance\.allSatisfy \{ \$0\.reviewComplete\(requiringCoverage: stationCoverageRequired\) \}/, 'Native preparer action uses the coverage gate');
assert.match(native, /record\.status == "draft", \(draft\.officerAttendanceVersion \?\? 0\) < 2/, 'Only unsubmitted drafts upgrade on save');
assert.match(native, /Text\("No, the regular officer arrived"\)/, 'A partial assignment answer explicitly confirms the regular officer arrival');
assert.match(native, /Button\("Clear conflicting coverage"\)/, 'Saved contradictory coverage has a visible native recovery action');
assert.match(native, /row\.hasStationCoverageValues \{/, 'Saved contradictory coverage stays visible');
assert.ok(!/\.frame\(width: 120\)/.test(native.slice(native.indexOf('private func officerText('), native.indexOf('private var metadata:'))), 'Attendance controls must not use a fixed narrow width');
assert.match(native, /MinutesAttendanceWorkflow\.requiresPreparerConfirmation\(status: workspace\.selected\?\.status/, 'Preparation confirmations depend on the actual record and viewer');
assert.match(native, /GroupBox\("Recorded attendance"\)/, 'Review starts with recorded attendance');
assert.match(native, /if preparingAttendance && model\.user\?\.can\("minutes\.prepare"\) == true \{\s*Button\(actionLabel\("preparer-attest"\)\)/, 'Only the actual preparer receives the preparation attestation action');
assert.match(native, /DisclosureGroup\("Change attendance", isExpanded: \$changingAttendance\)/, 'Review corrections remain optional');
assert.match(native, /private func resetOfficerConfirmation\(\) \{\s*guard preparingAttendance else \{ return \}/, 'Review corrections cannot require a second confirmation');
const attendanceFields = native.slice(native.indexOf('private var attendanceFields:'), native.indexOf('private var attendanceSummary:'));
assert.equal((attendanceFields.match(/if preparingAttendance \{/g) || []).length, 3, 'Each confirmation toggle is preparer-only');
assert.match(native, /Text\(MinutesAttendanceWorkflow\.statusLabel\("not_recorded", preparing: preparingAttendance\)\)/, 'Unknown status does not ask the WM to confirm an officer again');


const base = { name: 'Xavier M. White', title: 'Senior Warden', status: 'excused' };
const cases = [
  { label: 'legacy excused row', row: base, version: 1, ready: true },
  { label: 'absent without coverage', row: { ...base, status: 'absent' }, version: 2, ready: false },
  { label: 'excused without coverage', row: base, version: 2, ready: false },
  { label: 'late without coverage', row: { ...base, status: 'arrived_late' }, version: 2, ready: false },
  { label: 'not recorded', row: { ...base, status: 'not_recorded' }, version: 2, ready: false },
  { label: 'present ordinary officer', row: { ...base, status: 'present' }, version: 2, ready: true },
  { label: 'vacant station for absent officer', row: { ...base, status: 'absent', stationCoverage: 'vacant' }, version: 2, ready: true },
  { label: 'vacant station until late arrival', row: { ...base, status: 'arrived_late', stationCoverage: 'vacant' }, version: 2, ready: true },
  { label: 'acting name required', row: { ...base, stationCoverage: 'filled', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'blank acting name', row: { ...base, stationCoverage: 'filled', actingName: ' \n ', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'duration answer required', row: { ...base, stationCoverage: 'filled', actingName: 'PM Mobley' }, version: 2, ready: false },
  { label: 'whole meeting substitute', row: { ...base, stationCoverage: 'filled', actingName: 'PM Mobley', actingWholeMeeting: true }, version: 2, ready: true },
  { label: 'partial coverage until White arrived', row: { ...base, status: 'arrived_late', stationCoverage: 'filled', actingName: 'PM Mobley', actingWholeMeeting: false }, version: 2, ready: true },
  { label: 'partial coverage cannot imply arrival for excused officer', row: { ...base, stationCoverage: 'filled', actingName: 'PM Mobley', actingWholeMeeting: false }, version: 2, ready: false },
  { label: 'partial coverage cannot imply arrival for absent officer', row: { ...base, status: 'absent', stationCoverage: 'filled', actingName: 'PM Mobley', actingWholeMeeting: false }, version: 2, ready: false },
  { label: 'vacant cannot carry an acting name', row: { ...base, stationCoverage: 'vacant', actingName: 'PM Mobley' }, version: 2, ready: false },
  { label: 'vacant cannot carry a duration', row: { ...base, stationCoverage: 'vacant', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'present cannot carry station assignment', row: { ...base, status: 'present', stationCoverage: 'filled', actingName: 'PM Mobley', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'present cannot carry residual duration', row: { ...base, status: 'present', actingWholeMeeting: false }, version: 2, ready: false },
  { label: 'self substitution is invalid', row: { ...base, stationCoverage: 'filled', actingName: 'Xavier M. White', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'self substitution title variation is invalid', row: { ...base, stationCoverage: 'filled', actingName: 'Brother Xavier M White, PM', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'self substitution without middle initial is invalid', row: { ...base, stationCoverage: 'filled', actingName: 'Xavier White', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'self substitution full middle name is invalid', row: { ...base, stationCoverage: 'filled', actingName: 'Bro. Xavier Marshall White', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'self substitution suffix omission is invalid', row: { ...base, name: 'John B. Brown III, PM', stationCoverage: 'filled', actingName: 'Brother John Brown', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'different Brother with same surname can cover', row: { ...base, stationCoverage: 'filled', actingName: 'James White', actingWholeMeeting: true }, version: 2, ready: true },
  { label: 'office surname alias is self substitution', row: { ...base, stationCoverage: 'filled', actingName: 'SW White', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'reverse office surname alias is self substitution', row: { ...base, name: 'SW White', stationCoverage: 'filled', actingName: 'Xavier M White', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'office hyphenated surname alias is self substitution', row: { ...base, name: 'W. Aaron Dixon-Saunders', stationCoverage: 'filled', actingName: 'WM Dixon-Saunders', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'generic PM surname is not an identity assumption', row: { ...base, name: 'James Mobley', stationCoverage: 'filled', actingName: 'PM Mobley', actingWholeMeeting: true }, version: 2, ready: true },
  { label: 'full Past Master honorific is self substitution', row: { ...base, name: 'John B. Brown III, PM', stationCoverage: 'filled', actingName: 'Past Master John Brown', actingWholeMeeting: true }, version: 2, ready: false },
  { label: 'empty officer name remains incomplete', row: { ...base, status: 'present', name: ' ' }, version: 2, ready: false },
];
for (const item of cases) {
  const basicComplete = !!item.row.name.trim() && ['present', 'excused', 'absent', 'arrived_late'].includes(item.row.status);
  const sharedComplete = basicComplete && !attendanceCoverageIssues({ officerAttendanceVersion: item.version, officerAttendance: [item.row] }).length;
  assert.equal(sharedComplete, item.ready, `Shared contract: ${item.label}`);
}
if (process.platform !== 'darwin') {
  console.log('PASS: shared attendance fixtures; native compiled checks run on macOS.');
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-minutes-attendance-'));
try {
  const fixture = path.join(scratch, 'cases.json');
  const source = path.join(scratch, 'attendance.swift');
  const binary = path.join(scratch, 'attendance');
  fs.writeFileSync(fixture, JSON.stringify(cases));
  fs.writeFileSync(source, `import Foundation\n${modelSource}\n
struct Fixture: Decodable { let label: String; let row: MinutesAttendance; let version: Int; let ready: Bool }
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
for item in try JSONDecoder().decode([Fixture].self, from: data) {
    precondition(item.row.reviewComplete(requiringCoverage: item.version >= 2) == item.ready, item.label)
    let decoded = try JSONDecoder().decode(MinutesAttendance.self, from: JSONEncoder().encode(item.row))
    precondition(decoded == item.row, item.label + " round trip")
}
var row = MinutesAttendance(name: "Xavier M. White", title: "Senior Warden", status: "excused")
row.setCoverage("filled"); row.actingName = "PM Mobley"; row.setWholeMeeting(false)
precondition(row.status == "arrived_late" && row.actingWholeMeeting == false && row.reviewComplete(requiringCoverage: true), "Explicit partial choice records arrival")
row.setStatus("absent")
precondition(row.stationCoverage == "filled" && row.actingName == "PM Mobley" && row.actingWholeMeeting == nil, "Removing a later arrival clears only the incompatible partial duration")
row.setStatus("excused")
precondition(row.stationCoverage == "filled" && row.actingName == "PM Mobley", "Correcting absence preserves the covering Brother")
row.setStatus("arrived_late")
precondition(row.stationCoverage == "filled" && row.actingName == "PM Mobley", "Recording a later arrival preserves the covering Brother")
row.setWholeMeeting(false); row.setStatus("present")
precondition(row.stationCoverage == nil && row.actingName == nil && row.actingWholeMeeting == nil, "Present status clears all station coverage")
row.setStatus("absent"); row.setCoverage("filled"); row.actingName = "PM Mobley"; row.setWholeMeeting(true); row.setStatus("not_recorded")
precondition(row.stationCoverage == nil && row.actingName == nil && row.actingWholeMeeting == nil, "Unconfirmed status clears all station coverage")
row.setStatus("absent"); row.setCoverage("filled"); row.actingName = "PM Mobley"; row.setWholeMeeting(true); row.setCoverage("vacant")
precondition(row.actingName == nil && row.actingWholeMeeting == nil && row.reviewComplete(requiringCoverage: true), "Vacant choice clears substitute")
row.setCoverage(nil)
precondition(!row.reviewComplete(requiringCoverage: true), "Clearing coverage requires another answer")
row.status = "present"; row.stationCoverage = "filled"; row.actingName = "PM Mobley"; row.actingWholeMeeting = true
precondition(row.hasStationCoverageValues && !row.reviewComplete(requiringCoverage: true), "Conflicting saved coverage remains detectable")
row.setCoverage(nil)
precondition(!row.hasStationCoverageValues && row.reviewComplete(requiringCoverage: true), "Clear conflicting coverage restores a present officer's valid state")
let preparer = MinutesAttendanceWorkflow.requiresPreparerConfirmation
precondition(preparer("draft", 2, 1, 2), "Assigned Secretary confirms attendance while preparing")
precondition(!preparer("draft", 2, 1, 1), "WM observing a Secretary draft is not asked to confirm")
precondition(!preparer("draft", 2, 1, 3), "Another officer does not confirm the assigned preparer's roll")
precondition(preparer("draft", nil, 2, 2), "Legacy draft uses its creator as the preparer")
precondition(preparer("draft", 1, 1, 1), "Owner preparing his own draft still completes preparation")
precondition(!preparer("awaiting_master_attestation", 2, 2, 1), "WM submitted review has no preparation confirmation")
precondition(!preparer("ready_for_distribution", 2, 2, 1), "Finalized minutes never receive fresh preparation controls")
precondition(!preparer("draft", nil, nil, 1), "Missing identity cannot create confirmation authority")
precondition(MinutesAttendanceWorkflow.statusLabel("not_recorded", preparing: false) == "Not recorded", "Review unknowns remain unknown without an action prompt")
precondition(MinutesAttendanceWorkflow.statusLabel("not_recorded", preparing: true) == "Needs confirmation", "Preparer unknowns keep their required prompt")
let sourceReminder = "Confirm attendance for Xavier M. White: the source mentions the officer but does not establish an attendance status."
let originalWarnings = [sourceReminder, "Confirm the meeting date from the source."]
let presentOfficer = MinutesAttendance(name: "Xavier M. White", title: "Senior Warden", status: "present")
precondition(MinutesAttendanceWorkflow.visibleReminders(originalWarnings, officers: [presentOfficer], preparing: false) == [originalWarnings[1]], "Only an obsolete resolved attendance reminder is hidden in review")
let unknownOfficer = MinutesAttendance(name: "Xavier M. White", title: "Senior Warden", status: "not_recorded")
precondition(MinutesAttendanceWorkflow.visibleReminders(originalWarnings, officers: [unknownOfficer], preparing: false) == ["The preparing officer still needs to record attendance for Xavier M. White.", originalWarnings[1]], "Unfinished attendance stays with the preparer while unrelated reminders remain")
precondition(MinutesAttendanceWorkflow.visibleReminders(originalWarnings, officers: [presentOfficer], preparing: true) == originalWarnings, "Preparation reminders are retained")
precondition(originalWarnings[0] == sourceReminder, "Presentation does not rewrite saved warnings")
var covered = MinutesAttendance(name: "Xavier M. White", title: "Senior Warden", status: "arrived_late", stationCoverage: "filled", actingName: "PM Mobley", actingWholeMeeting: false)
precondition(MinutesAttendanceWorkflow.coverageSummary(covered) == "Covered by PM Mobley until the regular officer arrived.", "Review shows partial coverage plainly")
covered.status = "absent"
precondition(MinutesAttendanceWorkflow.coverageSummary(covered) == "Partial coverage is recorded, but the regular officer's arrival is not recorded.", "Malformed legacy partial coverage never invents a later arrival")
covered.status = "arrived_late"
covered.actingWholeMeeting = true
precondition(MinutesAttendanceWorkflow.coverageSummary(covered) == "Covered by PM Mobley for the whole meeting.", "Review preserves a whole-meeting assignment")
covered.actingWholeMeeting = nil
precondition(MinutesAttendanceWorkflow.coverageSummary(covered) == "Covered by PM Mobley; duration not recorded.", "Unknown duration stays unknown")
covered.setCoverage("vacant")
precondition(MinutesAttendanceWorkflow.coverageSummary(covered) == "Station remained vacant until the regular officer arrived.", "Review preserves a temporary vacancy")
covered.setStatus("present")
precondition(MinutesAttendanceWorkflow.coverageSummary(covered) == nil, "Ordinary presence does not invent coverage")
let legacyJSON = #"{"meetingType":"Stated Communication","present":[],"excused":[],"visitors":[],"officerAttendance":[{"name":"Xavier M. White","title":"Senior Warden","status":"excused"}],"income":[],"expenses":[],"sections":[],"warnings":[],"sensitiveReview":[],"actionItems":[]}"#
let legacy = try JSONDecoder().decode(MinutesDraft.self, from: Data(legacyJSON.utf8))
precondition(legacy.officerAttendanceVersion == nil && legacy.officerAttendance[0].stationCoverage == nil && legacy.officerAttendance[0].actingName == nil && legacy.officerAttendance[0].actingWholeMeeting == nil, "Legacy records decode without new fields")
print("PASS: 31 native attendance fixtures, preparer-only workflow, recorded summaries, warning projection, Codable preservation and legacy decoding")
`);
  const build = spawnSync('swiftc', [source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [fixture], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
