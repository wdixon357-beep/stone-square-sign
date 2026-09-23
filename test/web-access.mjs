import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { generationStatusText, showGenerationStatus } from '../public/generation-status.js';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../public/app.js'), html = read('../public/index.html');
const gates = app.slice(app.indexOf("document.querySelectorAll('.owner-only')"), app.indexOf("  return { maySeeTreasury, maySeeMinutes }"));
function visibility(role, permissions = role === 'warden' ? ['proposals.create','documents.status','dues.self','dues.ledger','suggestions.create','minutes.view','treasury.view','signature.manage','settings.manage','reports.create','candidates.view'] : role === 'secretary' ? ['minutes.prepare','dues.self','dues.ledger','dues.manage','suggestions.create'] : []) {
  const results = {}, line = {};
  vm.runInNewContext(gates, { user: { role, permissions }, can: (key, user) => role === 'owner' || permissions.includes(key), $: id => ({ classList: { toggle: (_, hidden) => { results[id] = !hidden; } } }), document: {
    querySelectorAll: selector => [{ classList: { toggle: (_, hidden) => { results[selector] = !hidden; } } }],
    querySelector: () => line,
  } });
  results.landingCopy = line.textContent;
  return results;
}
const warden = visibility('warden');
for (const selector of ['.warden-only', '.signer-only', '.dues-ledger-only', '.dues-self-only', '.suggestions-only', '.minutes-only', '.candidate-only']) assert.equal(warden[selector], true, selector);
for (const selector of ['.owner-only', '.preparer-only']) assert.equal(warden[selector], false, selector);
assert.equal(warden.approvalsNav, false);
assert.equal(visibility('owner').approvalsNav, true);
assert.equal(visibility('officer', ['documents.status']).approvalsNav, false);
assert.match(app, /if \(\['viewer', 'warden'\]\.includes\(state.user\?\.role\)\) actions.replaceChildren\(\)/);
assert.match(app, /Read finalized meeting minutes/);
assert.match(app, /Read finalized treasurer reports/);
assert.doesNotMatch(app, /before opening the live document queue/);
assert.equal(visibility('owner')['.owner-only'], true);
assert.equal(visibility('owner')['.warden-only'], false);
assert.equal(visibility('owner').landingCopy, 'Choose the area you want to open.');
assert.match(html, /id="accessNav" class="nav-item owner-only"/);
assert.match(app, /\$\('officerPanel'\)\.focus\(\{ preventScroll: true \}\)/);
assert.equal(visibility('viewer')['.dues-ledger-only'], false);
assert.equal(visibility('secretary')['.minutes-only'], true);
assert.match(app, /!can\('signature.manage', user\)/);
assert.match(app, /if \(!can\('minutes.prepare'\)\) return/);
assert.match(app, /api\/minutes\/\$\{item.id\}\/pdf/);
assert.equal(visibility('officer', ['minutes.view'])['.preparer-only'], false);
assert.equal(visibility('officer', ['minutes.prepare'])['.preparer-only'], true);
assert.match(html, /id="proposalsNav"[^>]+>[\s\S]*?My Dispensation Proposals<\/button>/);
assert.match(html, /<h2>My Dispensation Proposals<\/h2>/);
assert.match(html, /id="proposalReviewNav" class="nav-item owner-only"/);
assert.match(html, /id="candidateMenuCard" class="document-menu-card candidate-only" type="button"/);
assert.match(app, /api\/tracker\/handoff/);
assert.doesNotMatch(html, /href="https:\/\/tracker\.stonesquare22pha\.org/);
const sensitive = { configured: true, administratorDetails: true, remainingDollars: 4.15, model: 'gpt-5.6-luna', cost: 0.85 };
for (const role of [undefined, 'warden', 'member', 'secretary', 'assistant_secretary', 'viewer', 'treasurer', 'assistant_treasurer', 'treasury_preparer']) {
  for (const payload of [sensitive, { configured: false }, null]) {
    assert.doesNotMatch(generationStatusText(payload, role), /Terra|Luna|OpenAI|gpt-|\$|allowance|model|cost/i);
    const element = {}; await showGenerationStatus(element, async () => payload, role);
    assert.doesNotMatch(element.textContent, /Terra|Luna|OpenAI|gpt-|\$|allowance|model|cost/i);
  }
}
assert.match(generationStatusText(sensitive, 'owner'), /Luna/);
assert.match(generationStatusText(sensitive, 'owner'), /\$4.15/);
assert.doesNotMatch(generationStatusText({ ...sensitive, administratorDetails: false }, 'owner'), /Terra|Luna|OpenAI|gpt-|\$|allowance|model|cost/i);
assert.doesNotMatch(read('../public/report-assistant.html'), /Terra|Luna|OpenAI|gpt-|allowance/i);
assert.doesNotMatch(read('../public/treasury.js'), /does not use Terra/);
console.log('PASS: warden read surfaces and signature profile, private administrative controls, proposal labels, owner-only generation details across all roles.');
