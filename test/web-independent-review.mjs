import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const candidateSource = app.slice(app.indexOf('const CANDIDATE_TRACKER_ORIGIN'), app.indexOf('const showWorkspaceSection'));
const candidateSetup = ({ returnedUrl = 'https://tracker.stonesquare22pha.org/api/sso?assertion=signed' } = {}) => {
  const messages = [];
  const calls = [];
  const context = {
    URL,
    apiFetch: async (...args) => { calls.push(['api', ...args]); return { url: returnedUrl }; },
    setMessage: (_element, text, error = false) => messages.push({ text, error }),
    $: () => ({}),
    window: { location: { assign: url => calls.push(['assign', url]) } },
  };
  vm.createContext(context);
  vm.runInContext(`${candidateSource}\nthis.openCandidateTrackerForTest = openCandidateTracker;`, context);
  return { context, calls, messages };
};

let candidate = candidateSetup();
await candidate.context.openCandidateTrackerForTest();
assert.equal(candidate.calls.filter(call => call[0] === 'api').length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(candidate.calls.find(call => call[0] === 'api').slice(1))), ['/api/tracker/handoff', { method: 'POST' }]);
assert.equal(candidate.calls.find(call => call[0] === 'assign')[1], 'https://tracker.stonesquare22pha.org/api/sso?assertion=signed');

candidate = candidateSetup({ returnedUrl: 'https://evil.example/steal' });
await candidate.context.openCandidateTrackerForTest();
assert.equal(candidate.calls.some(call => call[0] === 'assign'), false);
assert.equal(candidate.messages.at(-1).error, true);

candidate = candidateSetup({ returnedUrl: 'https://tracker.stonesquare22pha.org/unrelated' });
await candidate.context.openCandidateTrackerForTest();
assert.equal(candidate.calls.some(call => call[0] === 'assign'), false);

const dirtySource = app.slice(app.indexOf('const hasUnsavedWorkspace'), app.indexOf("document.addEventListener('keydown'"));
const accessControls = { dirtyAccessKeys: new Set(['officer-4']) };
const dirtyContext = {
  state: { proposalDirty: false, dispensationDirty: false, minutesSourceDirty: false },
  treasuryWorkspace: null,
  correspondenceWorkspace: { dirty: true },
  buildingCalendarWorkspace: null,
  $: id => id === 'accessControls' ? accessControls : null,
};
vm.createContext(dirtyContext);
vm.runInContext(`${dirtySource}\nthis.hasUnsavedWorkspaceForTest = hasUnsavedWorkspace;`, dirtyContext);
assert.equal(dirtyContext.hasUnsavedWorkspaceForTest('queue'), true);
accessControls.dirtyAccessKeys.clear();
assert.equal(dirtyContext.hasUnsavedWorkspaceForTest('queue'), false);
assert.equal(dirtyContext.hasUnsavedWorkspaceForTest('correspondence'), true);
assert.match(app, /beforeunload[\s\S]*hasUnsavedWorkspace\(state\.activeSection\)/);

const dateSource = app.slice(app.indexOf('const formatDate ='), app.indexOf('/* An event date'));
const dateContext = { Intl, Date, Number };
vm.createContext(dateContext);
vm.runInContext(`${dateSource}\nthis.formatDateForTest = formatDate;`, dateContext);
assert.equal(dateContext.formatDateForTest(null), 'Date unavailable');
assert.equal(dateContext.formatDateForTest('not-a-date'), 'Date unavailable');
assert.doesNotMatch(dateContext.formatDateForTest(null), /1970/);
assert.match(app, /session\.lastSeenAt \|\| session\.createdAt/);
assert.match(app, /Last used time unavailable/);

assert.match(html, /id="candidateMenuCard"[^>]+type="button"/);
assert.doesNotMatch(html, /candidate-only" href=/);
console.log('PASS: Candidate Tracker uses a same-session secure handoff, access edits block data loss, missing session timestamps stay honest, and calendar times use a consistent 12-hour clock.');
