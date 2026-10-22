import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const native = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MeetingMinutes.swift', import.meta.url), 'utf8');
const modelSource = native.slice(native.indexOf('struct MinutesSection:'), native.indexOf('struct MinutesChange:'));
const detailsSource = native.slice(native.indexOf('struct MinutesMeetingDetails:'), native.indexOf('@MainActor\nfinal class MinutesWorkspace'));
const datesSource = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MinutesDates.swift', import.meta.url), 'utf8');
const configureSource = native.slice(native.indexOf('    func configure(_ model: AppModel) {'), native.indexOf('    func request('));
assert.match(native, /@Published var meetingDetails = MinutesMeetingDetails\(\)/, 'The source intake owns explicit meeting details');
assert.match(native, /let meetingDetails: MinutesMeetingDetails\?/, 'Legacy private local source drafts decode without the new details');
assert.match(native, /func generate\(\) async \{\s*guard meetingDetails.isComplete/, 'Missing meeting details stop before generation');
assert.match(native, /func claim\(_ record: MinutesRecord, meetingDetails: MinutesMeetingDetails\) async \{\s*guard meetingDetails.isComplete/, 'Claiming requires the entered details before a request');
assert.match(native, /sourceUploadBody\(includingMeetingDetails: false\)/, 'Owner source handoff remains source only');
assert.match(native, /MinutesReorganizePayload\(expectedUpdatedAt: record.updatedAt, meetingDetails: details.normalized\)/, 'Reorganization preserves the currently edited details');
assert.match(native, /disabled\(workspace.dirty \|\| !attendanceReady \|\| !meetingDetailsReady\)/, 'Preparer submission includes the eight-field gate');
assert.match(native, /MinutesMeetingDetailsFields\(details: \$workspace.meetingDetails\)/, 'The native intake shows the eight fields');
assert.match(native, /MinutesMeetingDetailsFields\(details: \$claimMeetingDetails\)/, 'The native claim step shows the same eight fields');
assert.match(native, /The \\\(role\) covered the station/, 'Assistant coverage is a visible deliberate choice');
if (process.platform !== 'darwin') {
  console.log('PASS: native explicit intake and assistant coverage contracts; compiled checks run on macOS.');
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-minutes-details-'));
try {
  const source = path.join(scratch, 'details.swift');
  const binary = path.join(scratch, 'details');
  fs.writeFileSync(source, `import Foundation\n${datesSource}\n${modelSource}\n${detailsSource}\n
var details = MinutesMeetingDetails()
precondition(!details.hasValues && details.missingFields.count == 8, "All eight fields start blank without date/type/time defaults")
details.meetingDate = "Thursday, October 15, 2026"; details.meetingType = "Stated Communication"
details.degree = "Third Degree"; details.openingTime = "7:30 PM"; details.closingTime = "9:45 PM"
details.presiding = "WM Test"; details.quorum = "Yes"; details.nextMeeting = "November 5, 2026"
precondition(details.isComplete && details.normalized.meetingDate == "2026-10-15" && details.normalized.nextMeeting == "2026-11-05", "Explicit dates normalize with no inferred year")
let keys = try JSONSerialization.jsonObject(with: JSONEncoder().encode(details.normalized)) as! [String: String]
precondition(keys.count == 8 && keys["openingTime"] == "7:30 PM" && keys["closingTime"] == "9:45 PM", "Exactly eight entered fields are encoded")
for clock in ["7:30 PM", "9 PM", "09:45 pm", "9:45 p.m.", "7 a.m.", "19:30", "00:00", "23:59"] { precondition(MinutesMeetingDetails.validTime(clock), clock) }
for clock in ["945", "0945", "9:45", "24:00", "13 PM", "00 PM", "09:61 PM", "9:45 PM tomorrow", "7:30 PM / 9:45 PM"] { precondition(!MinutesMeetingDetails.validTime(clock), clock) }
for date in ["October 15", "2026-02-30", "2026-10-15 and 2026-11-05", "At 2026-10-15", "", "2026-00-12"] { precondition(MinutesMeetingDetails.dateValue(date) == nil, date) }
for key in ["meetingDate", "meetingType", "degree", "openingTime", "closingTime", "presiding", "quorum", "nextMeeting"] {
    var edited = keys; edited[key] = ""
    let partial = try JSONDecoder().decode(MinutesMeetingDetails.self, from: JSONSerialization.data(withJSONObject: edited))
    precondition(!partial.isComplete && !partial.missingFields.isEmpty, "Clearing any required field prevents submission: " + key)
}
var treasurer = MinutesAttendance(name: "Regular Treasurer", title: "Treasurer", status: "excused")
treasurer.selectAssistant(role: "Assistant Treasurer", name: "Assistant Person")
precondition(treasurer.stationCoverage == "filled" && treasurer.actingRole == "Assistant Treasurer" && treasurer.actingName == "Assistant Person", "Explicit assistant choice retains exact identity and office")
precondition(treasurer.status == "excused" && treasurer.actingWholeMeeting == nil && !treasurer.reviewComplete(requiringCoverage: true), "Assistant choice cannot infer arrival or duration")
treasurer.setWholeMeeting(true)
precondition(treasurer.reviewComplete(requiringCoverage: true), "Explicit duration completes assistant coverage")
var assistantRoster = MinutesAttendance(name: "Assistant Person", title: "Assistant Treasurer", status: "present")
let selectedCoverage = treasurer
precondition(MinutesAttendanceWorkflow.assistantCoverageIssue(treasurer, officers: [treasurer, assistantRoster]) == nil, "Explicit selection matches the recorded assistant identity")
assistantRoster.name = "Different Assistant"
precondition(MinutesAttendanceWorkflow.assistantCoverageIssue(treasurer, officers: [treasurer, assistantRoster]) != nil, "Changing the assistant roster identity invalidates preparation readiness")
precondition(treasurer == selectedCoverage && treasurer.status == "excused" && treasurer.actingWholeMeeting == true, "Validation never rewrites the selected name, status or duration")
precondition(MinutesAttendanceWorkflow.coverageSummary(treasurer) == "Covered by Assistant Treasurer Assistant Person for the whole meeting.", "Summary includes the assistant office and actual name")
var secretary = MinutesAttendance(name: "Regular Secretary", title: "Secretary", status: "absent")
secretary.selectAssistant(role: "Assistant Secretary", name: "Secretary Assistant")
precondition(secretary.actingRole == "Assistant Secretary" && secretary.status == "absent" && secretary.actingWholeMeeting == nil, "Secretary assistant remains a deliberate separate assignment")
secretary.setCoverage("vacant")
precondition(secretary.actingName == nil && secretary.actingRole == nil && secretary.actingWholeMeeting == nil, "Vacancy clears every assistant value")
treasurer.setStatus("present")
precondition(treasurer.actingRole == nil && treasurer.actingName == nil && treasurer.stationCoverage == nil, "Present status clears old coverage")
var otherOffice = MinutesAttendance(name: "Regular Warden", title: "Senior Warden", status: "excused")
otherOffice.selectAssistant(role: "Assistant Treasurer", name: "Assistant Person")
precondition(otherOffice.stationCoverage == nil && otherOffice.actingName == nil && otherOffice.actingRole == nil, "Assistant office cannot be assigned to an unrelated station")
otherOffice.stationCoverage = "filled"; otherOffice.actingName = "Assistant Person"; otherOffice.actingRole = "Assistant Treasurer"; otherOffice.actingWholeMeeting = true
precondition(!otherOffice.reviewComplete(requiringCoverage: true), "Invalid saved assistant role is not accepted")
let legacyJSON = #"{"meetingType":"Stated Communication","present":[],"excused":[],"visitors":[],"officerAttendance":[{"name":"Legacy Officer","title":"Treasurer","status":"excused","stationCoverage":"filled","actingName":"Named Brother","actingWholeMeeting":true}],"income":[],"expenses":[],"sections":[],"warnings":[],"sensitiveReview":[],"actionItems":[]}"#
let legacy = try JSONDecoder().decode(MinutesDraft.self, from: Data(legacyJSON.utf8))
precondition(legacy.meetingDetailsVersion == nil && legacy.officerAttendance[0].actingRole == nil, "Legacy snapshots decode without new markers or office labels")
let roundTrip = try JSONDecoder().decode(MinutesDraft.self, from: JSONEncoder().encode(legacy))
precondition(roundTrip == legacy, "Existing named coverage and saved metadata remain exact")
struct ConfigurationUser { let id: Int }
struct AppModel { let serverAddress: String; let webSessionToken: String?; let user: ConfigurationUser? }
final class ConfigurationProbe {
    var baseURL: URL? = URL(string: "https://synthetic.invalid"); var token = "synthetic"
    var configuredUserID: Int? = 1; var accountEpoch: UInt64 = 0; var busy = true
    var generationStatus: String? = "Owner private allowance"; var message = "Old account message"; var messageIsWarning = true
    var restoringLocalDraft = false; var source = "Old original source"; var sourceType = "auto"
    var fileURL: URL?; var sourceFileName = ""; var meetingDetails = MinutesMeetingDetails(); var localDraftSaved = true
    var retainedUnsavedEditor = "Keep the exact unsaved editor"; var loads: [Int] = []
    func loadLocalSourceDraft(for id: Int) { loads.append(id); source = "Private source for account " + String(id) }
${configureSource}
}
let probe = ConfigurationProbe()
probe.configure(AppModel(serverAddress: "https://synthetic.invalid", webSessionToken: "synthetic", user: ConfigurationUser(id: 1)))
precondition(probe.generationStatus == "Owner private allowance" && probe.message == "Old account message" && probe.busy && probe.loads.isEmpty, "Ordinary same-account configuration preserves status and input")
probe.configure(AppModel(serverAddress: "https://synthetic.invalid", webSessionToken: "synthetic", user: ConfigurationUser(id: 2)))
precondition(probe.generationStatus == nil && probe.message.isEmpty && !probe.messageIsWarning && !probe.busy && probe.accountEpoch == 1, "Actual account change clears only stale status and invalidates outstanding operation context")
precondition(probe.retainedUnsavedEditor == "Keep the exact unsaved editor" && probe.loads == [2] && probe.source == "Private source for account 2", "Configure retains unsaved editor bytes and uses the correct private source account")
print("PASS: native eight-field intake, date/time validation, explicit assistant choices and legacy Codable preservation")
`);
  const build = spawnSync('swiftc', [source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
