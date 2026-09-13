import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { generationStatusText, showGenerationStatus } from '../public/generation-status.js';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../public/app.js'), html = read('../public/index.html');
const gates = app.slice(app.indexOf("document.querySelectorAll('.owner-only')"), app.indexOf("  showWorkspaceSection(requestedWorkspaceSection"));
function visibility(role) {
  const results = {}, line = {};
  vm.runInNewContext(gates, { user: { role }, $: id => ({ classList: { toggle: (_, hidden) => { results[id] = !hidden; } } }), document: {
    querySelectorAll: selector => [{ classList: { toggle: (_, hidden) => { results[selector] = !hidden; } } }],
    querySelector: () => line,
  } });
  return results;
}
const warden = visibility('warden');
for (const selector of ['.warden-only', '.signer-only', '.dues-only']) assert.equal(warden[selector], true, selector);
for (const selector of ['.owner-only', '.minutes-only', '.preparer-only']) assert.equal(warden[selector], false, selector);
assert.equal(warden.approvalsNav, false);
assert.equal(visibility('owner').approvalsNav, true);
assert.match(app, /const approvals = section === 'approvals' && state.user\?\.role !== 'warden'/);
assert.match(app, /if \(\['viewer', 'warden'\]\.includes\(state.user\?\.role\)\) actions.replaceChildren\(\)/);
assert.equal(visibility('owner')['.owner-only'], true);
assert.equal(visibility('viewer')['.dues-only'], false);
assert.equal(visibility('secretary')['.minutes-only'], true);
const signing = app.match(/const CAN_SIGN = new Set\((\[[^;]+)\);/)[1];
assert.equal(vm.runInNewContext(`new Set(${signing}).has('warden')`), true);
assert.match(html, /id="proposalsNav"[^>]+>[\s\S]*?My Dispensation Proposals<\/button>/);
assert.match(html, /<h2>My Dispensation Proposals<\/h2>/);
assert.match(html, /id="proposalReviewNav" class="nav-item owner-only"/);
assert.match(html, /class="document-menu-card signer-only" href="https:\/\/tracker.stonesquare22pha.org/);
const sensitive = { configured: true, remainingDollars: 4.15, model: 'gpt-5.6-terra', cost: 0.85 };
for (const role of [undefined, 'warden', 'member', 'secretary', 'assistant_secretary', 'viewer', 'treasurer', 'assistant_treasurer', 'treasury_preparer']) {
  for (const payload of [sensitive, { configured: false }, null]) {
    assert.doesNotMatch(generationStatusText(payload, role), /Terra|OpenAI|gpt-|\$|allowance|model|cost/i);
    const element = {}; await showGenerationStatus(element, async () => payload, role);
    assert.doesNotMatch(element.textContent, /Terra|OpenAI|gpt-|\$|allowance|model|cost/i);
  }
}
assert.match(generationStatusText(sensitive, 'owner'), /Terra/);
assert.match(generationStatusText(sensitive, 'owner'), /\$4.15/);
assert.doesNotMatch(read('../public/report-assistant.html'), /Terra|OpenAI|gpt-|allowance/i);
assert.doesNotMatch(read('../public/treasury.js'), /does not use Terra/);
console.log('PASS: warden read surfaces and signature profile, private administrative controls, proposal labels, owner-only generation details across all roles.');
