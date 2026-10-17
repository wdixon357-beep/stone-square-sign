import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { attendanceReviewIssues, UNCITED_PRESIDING_WARNING } from '../minutes-format.js';
import { CURRENT_OFFICERS } from '../minutes-layout.js';

const web = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functionSource = web.match(/const minutesAttendanceIssues = \(draft = collectMinutesDraft\(\)\) => \[[\s\S]*?\]\.filter\(Boolean\);/)?.[0];
assert.ok(functionSource, 'Use the actual web preparer gate');
const webIssues = vm.runInNewContext(`${functionSource}\nminutesAttendanceIssues`);
const native = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MeetingMinutes.swift', import.meta.url), 'utf8');
const property = native.match(/var presidingReviewComplete: Bool \{[\s\S]*?\n    \}/)?.[0];
assert.ok(property, 'Use the actual native draft review gate');
assert.match(native, /return review\.officerRoll && review\.otherPresent && review\.otherExcused\s+&& draft\.presidingReviewComplete/, 'Native attestation must use the verified property');

const cases = [
  { label: 'legacy optional blank', presiding: null, warnings: [], ready: true },
  { label: 'uncited blank', presiding: null, warnings: [UNCITED_PRESIDING_WARNING], ready: false },
  { label: 'uncited whitespace', presiding: ' \n ', warnings: [UNCITED_PRESIDING_WARNING], ready: false },
  { label: 'officer verified entry', presiding: 'WM Example', warnings: [UNCITED_PRESIDING_WARNING], ready: true },
  { label: 'unrelated warning', presiding: null, warnings: ['Check the event date.'], ready: true },
];
for (const item of cases) {
  const draft = { ...item, attendanceReview: { officerRoll: true, otherPresent: true, otherExcused: true },
    officerAttendance: CURRENT_OFFICERS.map(officer => ({ ...officer, status: 'present' })) };
  assert.equal(attendanceReviewIssues(draft).length === 0, item.ready, `Service: ${item.label}`);
  assert.equal(webIssues(draft).length === 0, item.ready, `Website: ${item.label}`);
}

if (process.platform === 'darwin') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-presiding-review-'));
  try {
    const source = path.join(scratch, 'review.swift');
    const fixture = path.join(scratch, 'cases.json');
    const binary = path.join(scratch, 'review');
    fs.writeFileSync(fixture, JSON.stringify(cases));
    fs.writeFileSync(source, `import Foundation\nstruct MinutesDraft: Decodable { var presiding: String?; var warnings: [String]; ${property} }\nstruct Case: Decodable { let label: String; let ready: Bool; let presiding: String?; let warnings: [String] }\nlet data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))\nfor item in try JSONDecoder().decode([Case].self, from: data) { let draft = MinutesDraft(presiding:item.presiding,warnings:item.warnings); precondition(draft.presidingReviewComplete == item.ready, item.label) }\nprint("PASS: native presiding review matches service and website in five cases")\n`);
    const build = spawnSync('swiftc', [source, '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const result = spawnSync(binary, [fixture], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
} else console.log('Native compiled gate is exercised by the Mac smoke run.');
console.log('PASS: missing presiding evidence requires confirmation consistently without blocking legacy drafts');
