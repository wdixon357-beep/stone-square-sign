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
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name,value) { (this.attributes ||= {})[name] = value; }
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
const state = { minutesOfficerAttendanceEdited: false, user: {id: 2, role: 'assistant_secretary'} };
let record = { status: 'draft', createdByUserId: 2, preparerUserId: 2, draft: {} };
const context = {
  document: { createElement: tag => new Element(tag) },
  $: id => elements[id], minutesAttendance, state, currentMinutes: () => record, scheduleMinutesPreview: () => {},
};
vm.createContext(context);
const presentationSource = app.slice(app.indexOf('const minutesAttendanceNeedsPreparerConfirmation ='), app.indexOf('const officerAttendanceEditor ='));
const editorSource = app.slice(app.indexOf('const officerAttendanceEditor ='), app.indexOf('const minutesAttendanceIssues ='));
const collectionSource = app.slice(app.indexOf('const collectMinutesOfficerAttendance ='), app.indexOf('const collectMinutesDraft ='));
const gateSource = app.match(/const minutesAttendanceIssues = \(draft = collectMinutesDraft\(\)\) => \[[\s\S]*?\]\.filter\(Boolean\);/)?.[0];
assert.ok(editorSource && collectionSource && gateSource);
vm.runInContext(`${presentationSource}\n${editorSource}\n${collectionSource}\n${gateSource}\nthis.edit = officerAttendanceEditor; this.collect = collectMinutesOfficerAttendance; this.version = minutesOfficerAttendanceVersion; this.issues = minutesAttendanceIssues; this.needsPreparerConfirmation = minutesAttendanceNeedsPreparerConfirmation; this.isReview = minutesAttendanceIsReview; this.displayWarnings = minutesAttendanceDisplayWarnings; this.presentAttendance = updateMinutesAttendancePresentation;`, context);

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

// The person preparing the draft keeps the existing confirmation workflow.
// The owner can glance over that same record without acquiring those tasks.
for (const id of ['minutesAttendanceSummary','minutesAttendanceReview','minutesAttendanceEyebrow','minutesAttendanceTitle','minutesAttendanceBadge','minutesAttendanceReviewNote','minutesAttendancePreparerInstructions','minutesOfficerAttendanceInstructions','minutesOfficerRollConfirmation','minutesOtherPresentConfirmation','minutesOtherExcusedConfirmation','minutesAttendanceFields','toggleMinutesAttendanceEdit']) elements[id] = new Element('div');
const displayedText = element => [element.textContent || '',...element.children.map(displayedText)].filter(Boolean).join(' ');
record = {status:'draft',createdByUserId:2,preparerUserId:2,draft:{officerAttendance:[{name:'Officer Example',title:'Example Office',status:'present'}],present:['Other Brother'],excused:[],visitors:[]}};
state.user={id:2,role:'assistant_secretary'};
context.presentAttendance(record);
assert.equal(context.needsPreparerConfirmation(record),true);
assert.equal(elements.minutesAttendanceSummary.classList.contains('hidden'),true);
assert.equal(elements.minutesAttendanceFields.classList.contains('hidden'),false);
for (const id of ['minutesOfficerRollConfirmation','minutesOtherPresentConfirmation','minutesOtherExcusedConfirmation']) assert.equal(elements[id].classList.contains('hidden'),false);
state.user={id:1,role:'owner'};
context.presentAttendance(record);
assert.equal(context.needsPreparerConfirmation(record),false);
assert.equal(elements.minutesAttendanceSummary.classList.contains('hidden'),false);
assert.equal(elements.minutesAttendanceFields.classList.contains('hidden'),true);
assert.match(displayedText(elements.minutesAttendanceSummary),/Officer Example.*Present.*Other Brother/);
assert.match(elements.minutesAttendanceReviewNote.textContent,/Secretary's Office is completing attendance/);
for (const id of ['minutesOfficerRollConfirmation','minutesOtherPresentConfirmation','minutesOtherExcusedConfirmation','minutesAttendancePreparerInstructions','minutesOfficerAttendanceInstructions']) assert.equal(elements[id].classList.contains('hidden'),true);
assert.equal(elements.toggleMinutesAttendanceEdit.classList.contains('hidden'),false);
const preparerRecord={...record,createdByUserId:1,preparerUserId:1};
context.presentAttendance(preparerRecord);
assert.equal(context.needsPreparerConfirmation(preparerRecord),true,'The owner acting as actual preparer still completes preparation requirements');
assert.equal(elements.minutesOfficerRollConfirmation.classList.contains('hidden'),false);
assert.equal(context.needsPreparerConfirmation({...preparerRecord,preparerUserId:3}),false,'The assigned preparer identity takes precedence over the original creator');
assert.equal(context.needsPreparerConfirmation({...preparerRecord,preparerUserId:null}),true,'Older draft identity falls back to the recorded preparing creator');
record.status='awaiting_master_attestation';state.minutesAttendanceEditing=true;
context.presentAttendance(record);
assert.equal(elements.minutesAttendanceSummary.classList.contains('hidden'),true);
assert.equal(elements.minutesAttendanceFields.classList.contains('hidden'),false);
assert.equal(elements.toggleMinutesAttendanceEdit.attributes['aria-expanded'],'true');
assert.equal(elements.toggleMinutesAttendanceEdit.textContent,'Done editing attendance');
for (const id of ['minutesOfficerRollConfirmation','minutesOtherPresentConfirmation','minutesOtherExcusedConfirmation']) assert.equal(elements[id].classList.contains('hidden'),true,'Optional master corrections never reveal preparer confirmation controls');
elements.minutesOfficerRollConfirmed.checked=true;
const masterRow=context.edit({name:'Officer Example',title:'Example Office',status:'present'});
masterRow.querySelector('[data-field="status"]').value='absent';masterRow.querySelector('[data-field="status"]').emit('change');
assert.equal(elements.minutesOfficerRollConfirmed.checked,false,'An optional master correction does not fabricate a new preparer confirmation');
assert.equal(masterRow.querySelector('[data-field="status"]').querySelector('option[value="not_recorded"]').textContent,'Not recorded','The master sees a recorded-state label, not a per-person confirmation task');
record.status='ready_for_distribution';context.presentAttendance(record);
assert.equal(elements.minutesAttendanceSummary.classList.contains('hidden'),false);
assert.equal(elements.minutesAttendanceFields.classList.contains('hidden'),true);
assert.equal(elements.toggleMinutesAttendanceEdit.classList.contains('hidden'),true,'Signed records retain the recorded view without an edit action');
assert.doesNotMatch(elements.minutesAttendanceReviewNote.textContent,/can edit|make a correction/,'Finalized attendance does not promise an unavailable edit');
context.presentAttendance(record,{...record.draft,officerAttendance:[{name:'Regular Example',title:'Example Office',status:'absent',stationCoverage:'filled',actingName:'Covering Example',actingWholeMeeting:false}]});
const inconsistentText=displayedText(elements.minutesAttendanceSummary);
assert.match(inconsistentText,/Covering Example.*Partial coverage is recorded, but the regular officer's arrival is not recorded/);
assert.doesNotMatch(inconsistentText,/until .* arrived/,'A malformed legacy partial duration never invents the regular officer arrival');
const generatedWarning='Confirm attendance for Officer Example: the source mentions the officer but does not establish an attendance status.';
const warningDraft={warnings:[generatedWarning,'Keep this substantive unresolved meeting question.'],officerAttendance:[{name:'Officer Example',status:'present'}]};
assert.deepEqual(Array.from(context.displayWarnings(warningDraft)),['Keep this substantive unresolved meeting question.']);
assert.deepEqual(warningDraft.warnings,[generatedWarning,'Keep this substantive unresolved meeting question.'],'Warning projection does not rewrite the retained draft');
warningDraft.officerAttendance[0].status='not_recorded';
assert.deepEqual(Array.from(context.displayWarnings(warningDraft)),['The preparing officer still needs to record attendance for Officer Example.','Keep this substantive unresolved meeting question.']);
state.user={id:2,role:'assistant_secretary'};record.status='draft';
assert.deepEqual(Array.from(context.displayWarnings(warningDraft)),warningDraft.warnings,'The preparer still receives the original required attendance reminder');
assert.match(html,/id="toggleMinutesAttendanceEdit"[^>]*aria-expanded="false"[^>]*aria-controls="minutesAttendanceFields"/);
assert.match(app,/updateMinutesAttendancePresentation\(item, collectMinutesDraft\(\)\)/,'Returning to the glance view displays the current unsaved corrections');
console.log('PASS: preparer-only confirmations, owner glance view, optional corrections, truthful warning projection and finalized read-only attendance');
