import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { formatEasternClockRange, formatEasternTimestamp } from '../public/eastern-time.js';
import { agendaContinueIssues } from '../public/agenda-review.js';
import { agendaIssues } from '../agenda.js';

// The worksheet modules share the dashboard's browser PDF dependency. Run
// their actual editing and save handlers with synthetic controls and requests.
async function loadWorkspace(file, identifier) {
  const source = await fs.readFile(new URL('../public/' + file, import.meta.url), 'utf8');
  return vm.runInNewContext(
    source.replace(/^import .*$/gm, '').replace('export class', 'class') + '\n' + identifier,
    { formatEasternClockRange, formatEasternTimestamp, agendaContinueIssues, structuredClone, queueMicrotask },
  );
}

const AgendaWorkspace = await loadWorkspace('agenda.js', 'AgendaWorkspace');
const TreasuryWorkspace = await loadWorkspace('treasury.js', 'TreasuryWorkspace');
const updatedAt = '2026-11-19T20:00:00.000Z';

function worksheet(Workspace, draftProperty) {
  const workspace = Object.create(Workspace.prototype);
  const calls = [], updates = [], notices = [], fieldsets = [{ disabled: false }], listeners = {};
  const preparer = { value: '8', disabled: false };
  const button = () => ({ isConnected: true, disabled: false });
  const root = {
    addEventListener: (name, callback) => { listeners[name] = callback; },
    querySelector: selector => selector === '#treasuryPreparer' ? preparer : null,
    querySelectorAll: selector => selector === 'fieldset' ? fieldsets : [],
  };
  let accountId = 5, prepare = true, listVisits = 0, opened;
  const responseKey = Workspace === AgendaWorkspace ? 'agenda' : 'report';

  Object.assign(workspace, {
    root,
    user: () => Workspace === AgendaWorkspace
      ? { id: accountId, role: 'owner' }
      : { id: accountId, role: 'treasurer', permissions: prepare ? ['treasury.prepare'] : ['treasury.view'] },
    record: { id: 'example', revision: 1, status: 'draft', preparerUserId: 5, updatedAt },
    draft: { [draftProperty]: 'Original draft text' },
    workspaceUserId: 5,
    list: () => { listVisits++; },
    api: (path, options) => new Promise((resolve, reject) => {
      calls.push({ path, options, sent: JSON.parse(options.body), resolve, reject });
    }),
    saveState: value => updates.push(value ?? workspace.savedLabel()),
    message: (value, error = false) => notices.push({ value, error }),
    open: record => { opened = record; workspace.record = record; },
    schedule: () => {},
  });

  if (Workspace === TreasuryWorkspace) workspace.bind();

  return {
    workspace, calls, updates, notices, fieldsets, preparer,
    get listVisits() { return listVisits; },
    get opened() { return opened; },
    switchAccount: () => { accountId = 12; },
    removePreparation: () => { prepare = false; },
    edit: value => {
      if (Workspace === AgendaWorkspace) {
        workspace.changed({ target: { dataset: { field: draftProperty }, value } });
      } else {
        listeners.input({ target: { dataset: { path: draftProperty }, value } });
      }
    },
    run: action => workspace.run(action, button()),
    resolveSave: (index, revision) => {
      const call = calls[index];
      call.resolve({ [responseKey]: { ...workspace.record, draft: call.sent.draft, revision, updatedAt } });
    },
  };
}

for (const [Workspace, property] of [[AgendaWorkspace, 'subtitle'], [TreasuryWorkspace, 'remarks']]) {
  const fixture = worksheet(Workspace, property);
  const { workspace, calls, updates, notices } = fixture;
  fixture.edit('The entry that went into the save');
  const saving = fixture.run('save');
  assert.equal(updates.at(-1), 'Saving draft…');
  assert.deepEqual(calls[0].sent, { revision: 1, draft: { [property]: 'The entry that went into the save' } });
  fixture.edit('The latest edit made during the save');
  const openDraft = workspace.draft;
  workspace.resumeOrList();
  assert.equal(fixture.listVisits, 0, 'returning from a different section resumes the open draft');
  assert.strictEqual(workspace.draft, openDraft);
  fixture.resolveSave(0, 2);
  await saving;
  assert.strictEqual(workspace.draft, openDraft, 'an older response leaves the newer draft in the same editor');
  assert.equal(workspace.draft[property], 'The latest edit made during the save');
  assert.equal(workspace.record.revision, 2);
  assert.equal(workspace.dirty, true);
  assert.equal(updates.at(-1), 'Unsaved changes');
  assert.match(notices.at(-1).value, /latest edits are still open/);

  const retry = fixture.run('save');
  assert.equal(calls[1].sent.revision, 2, 'the eventual next save uses the accepted server revision');
  assert.equal(calls[1].sent.draft[property], 'The latest edit made during the save');
  fixture.resolveSave(1, 3);
  await retry;
  assert.equal(workspace.dirty, false);
  assert.match(updates.at(-1), /^Last saved .*3:00 PM EST$/);

  fixture.edit('Retain this through a failed write');
  const failed = fixture.run('save');
  calls[2].reject(new Error('Draft changed. Reopen it.'));
  await failed;
  assert.equal(workspace.draft[property], 'Retain this through a failed write');
  assert.equal(workspace.dirty, true);
  assert.equal(updates.at(-1), 'Unsaved changes');
  assert.equal(notices.at(-1).error, true);

  fixture.switchAccount();
  workspace.resumeOrList();
  assert.equal(fixture.listVisits, 1, 'another account cannot reopen the previous account’s in-memory draft');
}

for (const action of ['assign', 'preparer-attest']) {
  const fixture = worksheet(TreasuryWorkspace, 'remarks');
  fixture.edit('A treasury entry before save');
  const submitting = fixture.run(action);
  fixture.edit('A later treasury entry');
  fixture.resolveSave(0, 2);
  await submitting;
  assert.equal(fixture.calls.length, 1, 'the action stops after saving when an edit is still pending');
  assert.equal(fixture.workspace.draft.remarks, 'A later treasury entry');
  assert.equal(fixture.workspace.dirty, true);
  assert.equal(fixture.notices.at(-1).error, true);
}

const reassignment = worksheet(TreasuryWorkspace, 'remarks');
reassignment.edit('A change that must be saved before reassignment');
const assigning = reassignment.run('assign');
reassignment.preparer.value = '9';
reassignment.resolveSave(0, 2);
await assigning;
assert.equal(reassignment.calls.length, 1, 'a selection change requires a fresh handoff action');

const treasury = worksheet(TreasuryWorkspace, 'remarks');
treasury.edit('A report ready for review');
const attesting = treasury.run('preparer-attest');
treasury.resolveSave(0, 2);
await new Promise(resolve => setImmediate(resolve));
assert.equal(treasury.calls[1].path, '/api/treasury/example/preparer-attest');
assert.deepEqual(treasury.calls[1].sent, { revision: 2 });
assert.equal(treasury.fieldsets[0].disabled, true, 'editing locks for the submitted revision');
treasury.edit('An input event cannot change a draft after final submission starts');
assert.equal(treasury.workspace.draft.remarks, 'A report ready for review');
treasury.calls[1].reject(new Error('A review requirement remains.'));
await attesting;
assert.equal(treasury.fieldsets[0].disabled, false, 'an unsuccessful action unlocks fields for correction');
assert.equal(treasury.opened, undefined);
treasury.removePreparation();
treasury.workspace.resumeOrList();
assert.equal(treasury.listVisits, 1, 'a change to view-only access invalidates draft resume');

const agendaWithBlankOptionalFields = {
  meetingDate: '2026-11-19', meetingType: 'Stated Communication', startTime: '7:30 PM',
  subtitle: '', officers: [], sections: [{ heading: 'Opening', scheduledTime: '', body: '' }],
};
assert.deepEqual(agendaContinueIssues(agendaWithBlankOptionalFields), [], 'optional agenda fields are not flagged');
const incompleteAgenda = { meetingDate: '', meetingType: '', startTime: '', sections: [{ heading: '' }, { heading: '' }] };
assert.deepEqual(agendaContinueIssues(incompleteAgenda).map(issue => issue.target),
  ['meetingDate', 'meetingType', 'startTime', 'section.0.heading', 'section.1.heading']);
assert.deepEqual(agendaIssues(incompleteAgenda), [
  'Choose the meeting date.', 'Enter the meeting type.', 'Enter the meeting start time.', 'Every agenda section needs a heading.',
]);
assert.equal(agendaContinueIssues({ ...agendaWithBlankOptionalFields, sections: [] })[0].target, 'add-section');

const agenda = worksheet(AgendaWorkspace, 'subtitle');
const jumps = [];
const target = name => ({ dataset: { field: name }, scrollIntoView: () => jumps.push(['scroll', name]), focus: () => jumps.push(['focus', name]) });
const date = target('meetingDate'), heading = target('section.1.heading'), addSection = target('add-section');
const activeAgenda = agenda.workspace.record;
Object.assign(agenda.workspace.draft, { ...agendaWithBlankOptionalFields, sections:[{heading:'Opening'},{heading:''}] });
const originalOpen = agenda.workspace.open;
agenda.workspace.open = record => { originalOpen(record); agenda.workspace.draft = structuredClone(record.draft); };
agenda.workspace.root.querySelector = selector => selector === '[data-agenda="add-section"]' ? addSection : date;
agenda.workspace.root.querySelectorAll = () => [date, heading];
agenda.edit('Unsaved note stays open');
assert.equal(agenda.workspace.continueDraft({ ...activeAgenda }, 'section.1.heading'), true);
assert.deepEqual(jumps, [['scroll', 'section.1.heading'], ['focus', 'section.1.heading']]);
assert.equal(agenda.workspace.draft.subtitle, 'Unsaved note stays open');
assert.equal(agenda.opened, undefined, 'continuing the same agenda keeps the editor instance');
const otherAgenda = { ...activeAgenda, id: 'other-agenda', draft:{...agendaWithBlankOptionalFields,sections:[]} };
assert.equal(agenda.workspace.continueDraft(otherAgenda, 'meetingDate'), false, 'a second draft cannot overwrite unsaved work');
assert.match(agenda.notices.at(-1).value, /Save the open agenda/);
agenda.workspace.dirty = false;
agenda.workspace.busy = true;
assert.equal(agenda.workspace.continueDraft(otherAgenda, 'meetingDate'), false, 'a new agenda waits for an in-flight operation');
agenda.workspace.busy = false;
assert.equal(agenda.workspace.continueDraft(otherAgenda, 'add-section'), true);
assert.equal(agenda.opened, otherAgenda);
assert.deepEqual(jumps.slice(-2), [['scroll', 'add-section'], ['focus', 'add-section']]);
const updatedAgenda = {...otherAgenda, revision:2, draft:{...agendaWithBlankOptionalFields, meetingDate:''}};
assert.equal(agenda.workspace.continueDraft(updatedAgenda, 'add-section'), true);
assert.equal(agenda.opened, updatedAgenda, 'a newer saved revision replaces a clean older editor');
assert.deepEqual(jumps.slice(-2), [['scroll','meetingDate'],['focus','meetingDate']], 'an obsolete issue focuses the actual outstanding field');
agenda.workspace.user = () => ({ id: 5, role: 'treasurer' });
assert.equal(agenda.workspace.continueDraft(otherAgenda, 'meetingDate'), false, 'agenda drafts remain owner-only');
assert.equal(agenda.calls.length, 0, 'continuing does not save or submit an agenda');

console.log('PASS: agenda and treasurer draft resume, pending-save edits, revision retries, and protection of treasury handoff and finalization.');
