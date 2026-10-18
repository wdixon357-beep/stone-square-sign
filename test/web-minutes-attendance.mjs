import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as minutesAttendance from '../public/minutes-attendance.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// A bounded DOM fixture exercises the actual editor and collection functions.
// No network, generation, signing or production record is involved.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.disabled = false;
    this.classList = {
      add: name => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); },
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const add = force === undefined ? !names.has(name) : force;
        if (add) names.add(name); else names.delete(name);
        this.className = [...names].join(' '); return add;
      },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const field = selector.match(/^\[data-field="([^"]+)"\]$/);
    if (field) return this.dataset.field === field[1];
    const option = selector.match(/^option\[value="([^"]+)"\]$/);
    if (option) return this.tagName === 'option' && this.value === option[1];
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const elements = {
  minutesOfficerRollConfirmed: { checked: true },
  minutesOfficerAttendance: new Element('div'),
};
const state = { minutesOfficerAttendanceEdited: false };
let record = { status: 'draft', draft: {} };
const context = {
  document: { createElement: tag => new Element(tag) },
  $: id => elements[id], minutesAttendance, state, currentMinutes: () => record, scheduleMinutesPreview: () => {},
};
vm.createContext(context);
const editorSource = app.slice(app.indexOf('const officerAttendanceEditor ='), app.indexOf('const minutesAttendanceIssues ='));
const collectionSource = app.slice(app.indexOf('const collectMinutesOfficerAttendance ='), app.indexOf('const collectMinutesDraft ='));
const gateSource = app.match(/const minutesAttendanceIssues = \(draft = collectMinutesDraft\(\)\) => \[[\s\S]*?\]\.filter\(Boolean\);/)?.[0];
assert.ok(editorSource && collectionSource && gateSource);
vm.runInContext(`${editorSource}\n${collectionSource}\n${gateSource}\nthis.edit = officerAttendanceEditor; this.collect = collectMinutesOfficerAttendance; this.version = minutesOfficerAttendanceVersion; this.issues = minutesAttendanceIssues;`, context);

const row = context.edit({ name: 'Xavier M. White', title: 'Senior Warden', status: 'excused' });
elements.minutesOfficerAttendance.append(row);
const control = field => row.querySelector(`[data-field="${field}"]`);
const choose = (field, value) => { control(field).value = value; control(field).emit('change'); };
const type = (field, value) => { control(field).value = value; control(field).emit('input'); };
const noOption = control('actingWholeMeeting').querySelector('option[value="false"]');
assert.equal(noOption.disabled, true, 'No cannot infer that an excused officer arrived');
choose('stationCoverage', 'filled');
assert.equal(row.querySelector('.minutes-officer-replacement').classList.contains('hidden'), false);
type('actingName', '  PM Mobley  ');
choose('actingWholeMeeting', 'true');
let collected = context.collect();
assert.equal(collected.length, 1);
assert.equal(collected[0].name, 'Xavier M. White');
assert.equal(collected[0].title, 'Senior Warden');
assert.equal(collected[0].status, 'excused');
assert.equal(collected[0].actingName, 'PM Mobley');
assert.equal(collected[0].actingWholeMeeting, true);
assert.equal(elements.minutesOfficerRollConfirmed.checked, false);
assert.equal(state.minutesOfficerAttendanceEdited, true);

choose('status', 'arrived_late');
assert.equal(noOption.disabled, false, 'Partial coverage becomes available only after explicit arrival confirmation');
assert.equal(control('actingName').value, '  PM Mobley  ', 'A supported covering Brother survives the explicit arrival update');
choose('actingWholeMeeting', 'false');
collected = context.collect();
assert.equal(collected[0].status, 'arrived_late');
assert.equal(collected[0].actingWholeMeeting, false, 'No is retained as a real Boolean rather than lost as blank');
assert.equal(minutesAttendance.attendanceCoverageIssues({ officerAttendanceVersion: 2, officerAttendance: collected }).length, 0);
assert.match(minutesAttendance.stationCoverageText(collected[0]), /PM Mobley.*until Xavier M\. White arrived/);

choose('status', 'absent');
assert.equal(control('actingWholeMeeting').value, '', 'A late-arrival duration is cleared when the officer is marked absent');
assert.equal(noOption.disabled, true);
assert.ok(minutesAttendance.attendanceCoverageIssues({ officerAttendanceVersion: 2, officerAttendance: context.collect() }).length);
choose('stationCoverage', 'vacant');
assert.equal(control('actingName').value, '');
assert.equal(control('actingWholeMeeting').value, '');
assert.equal(row.querySelector('.minutes-officer-replacement').classList.contains('hidden'), true);
assert.equal(minutesAttendance.attendanceCoverageIssues({ officerAttendanceVersion: 2, officerAttendance: context.collect() }).length, 0);

choose('stationCoverage', 'filled'); type('actingName', 'PM Example'); choose('actingWholeMeeting', 'true');
choose('status', 'present');
assert.equal(control('stationCoverage').value, '');
assert.equal(control('actingName').value, '');
assert.equal(control('actingWholeMeeting').value, '');
assert.equal(row.querySelector('.minutes-officer-coverage').classList.contains('hidden'), true);
assert.equal(context.collect()[0].stationCoverage, null);
assert.equal(context.collect()[0].actingWholeMeeting, null);

const conflicted = context.edit({ name: 'Regular Example', title: 'Example office', status: 'present', stationCoverage: 'filled', actingName: 'Other Brother', actingWholeMeeting: true });
assert.equal(conflicted.querySelector('.minutes-officer-coverage').classList.contains('hidden'), false, 'Conflicting stored coverage remains visible for recovery');
assert.equal(conflicted.querySelector('.minutes-officer-conflict').classList.contains('hidden'), false);
conflicted.querySelector('.minutes-officer-clear').emit('click');
assert.equal(conflicted.querySelector('[data-field="actingName"]').value, '');
assert.equal(conflicted.querySelector('.minutes-officer-coverage').classList.contains('hidden'), true);
assert.equal(state.minutesEditorDirty, true, 'Explicit conflict recovery remains an unsaved, reviewable correction');

state.minutesOfficerAttendanceEdited = false;
assert.equal(context.version(), 2, 'A preparer completes version two for an unfinished draft');
record = { status: 'awaiting_master_attestation', draft: {} };
assert.equal(context.version(), 1, 'Opening a legacy preparer-attested record does not force the WM to redo the roll');
state.minutesOfficerAttendanceEdited = true;
assert.equal(context.version(), 2, 'Editing attendance explicitly adopts the new review');
state.minutesOfficerAttendanceEdited = false;
record.draft.officerAttendanceVersion = 2;
assert.equal(context.version(), 2, 'New review versions survive reopening');

const confirmed = { officerRoll: true, otherPresent: true, otherExcused: true };
const absentDraft = { officerAttendanceVersion: 2, attendanceReview: confirmed,
  officerAttendance: [{ name: 'Regular Officer', title: 'Example office', status: 'absent' }] };
assert.ok(context.issues(absentDraft).some(issue => issue.includes('covered the station')));
assert.equal(context.issues({ ...absentDraft, officerAttendanceVersion: 1 }).length, 0, 'Legacy attested drafts retain their original completion requirements');
assert.match(app, /Promise\.all\(\[minutesDatesReady, minutesAttendanceReady\]\)/, 'The attendance controls must load before the dashboard initializes');
assert.match(html, /station coverage and any late arrivals/);
assert.doesNotMatch(html, /PM Mobley|SW White/, 'Meeting examples must not become template defaults');
console.log('PASS: web officer coverage, late arrivals, duration, stale-data clearing, saved values and legacy review compatibility');
