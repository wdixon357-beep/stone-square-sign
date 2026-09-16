import { TREASURY_REPORT_RULES } from '../report-rules.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateTreasuryDraft, TREASURY_AI_SCHEMA } from '../treasury-ai.js';
import { organizeTreasury, calculateTreasury } from '../treasury.js';

const source = `Period: August 2026
Bank: Example Credit Union
Checking
Opening balance: $1,000.00
Closing balance: $1,150.00
Posted transactions
08/03 Deposit Zeffy $200.00
08/04 Payment Utilities ($50.00)
Savings
Restricted education fund: $125.00
Unpaid insurance bill: $40.00 due 2026-09-15
Bank hold is unknown.
Keep the receipt with the report.`;
const cite = (value, evidence) => ({ value, evidence });
const empty = schema => schema.type === 'object' ? Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, empty(child)]))
  : schema.type === 'array' ? [] : Array.isArray(schema.type) && schema.type.includes('null') ? null : '';
const response = () => {
  const draft = empty(TREASURY_AI_SCHEMA);
  draft.periodStart = cite('2026-08-01', 'Period: August 2026');
  draft.periodEnd = cite('2026-08-31', 'Period: August 2026');
  draft.bankName = cite('Example Credit Union', 'Bank: Example Credit Union');
  const checking = empty(TREASURY_AI_SCHEMA.properties.accounts.items);
  checking.id = 'checking'; checking.name = cite('Checking', 'Checking');
  checking.openingBalance = cite('1000.00', 'Opening balance: $1,000.00');
  checking.statementBalance = cite('1150.00', 'Closing balance: $1,150.00');
  draft.accounts = [checking];
  const transaction = empty(TREASURY_AI_SCHEMA.properties.transactions.items);
  transaction.date = cite('2026-08-03', source.slice(0, source.indexOf('\n08/04')));
  transaction.account = cite('checking', source.slice(source.indexOf('Checking'), source.indexOf('\nSavings')));
  transaction.kind = cite('receipt', '08/03 Deposit Zeffy $200.00');
  transaction.description = cite('Deposit Zeffy', '08/03 Deposit Zeffy $200.00');
  transaction.amount = cite('200.00', '08/03 Deposit Zeffy $200.00');
  draft.transactions = [transaction];
  return draft;
};
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed += 1; console.log(`PASS: ${name}`); };

function strictObjects(schema) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort());
    Object.values(schema.properties).forEach(strictObjects);
  } else if (schema.type === 'array') strictObjects(schema.items);
}
strictObjects(TREASURY_AI_SCHEMA);
check('every extraction object has a strict complete schema', true);

const fallback = await generateTreasuryDraft(source, { sourceNames: ['synthetic.txt'], sourceNotes: ['Synthetic OCR review note.'] });
assert.deepEqual(fallback, organizeTreasury(source, { sourceNames: ['synthetic.txt'], extractionNotes: ['Synthetic OCR review note.'] }));
check('without a model callback the existing deterministic parser is used unchanged', true);

const cycleFiltered = await generateTreasuryDraft(`${source}\n09/05/2026 Deposit Fall event $75.00`, {
  meetingCycle: { previousMeeting:'2026-09-03', periodStart:'2026-09-04', periodEnd:'2026-09-17' },
});
check('fixed-window generation keeps checking and savings while excluding statement activity and monthly totals outside the period', cycleFiltered.periodStart === '2026-09-04' && cycleFiltered.periodEnd === '2026-09-17' && cycleFiltered.transactions.every(row => row.date >= '2026-09-04' && row.date <= '2026-09-17') && cycleFiltered.accounts.every(account => account.openingBalance === null && account.statementBalance === null) && ['checking','savings'].every(id=>cycleFiltered.accounts.some(account=>account.id===id)));

let fixedWindowRequest;
const fixedWindowOutput = await generateTreasuryDraft(source, {
  meetingCycle: { previousMeeting:'2026-09-03', periodStart:'2026-09-04', periodEnd:'2026-09-15' },
  generateStructured: async value => { fixedWindowRequest=value; return response(); },
});
check('structured processing cannot calculate from material outside the fixed preparation-date window', fixedWindowRequest.instructions.includes('Do not include, total, summarize, infer, or use transactions outside that range') && fixedWindowRequest.instructions.includes('2026-09-04 through 2026-09-15') && fixedWindowOutput.accounts[0].openingBalance === null && fixedWindowOutput.accounts[0].statementBalance === null && fixedWindowOutput.fieldReviews['accounts.0.openingBalance'] === 'unresolved' && fixedWindowOutput.fieldReviews['accounts.0.statementBalance'] === 'unresolved');

const broadBoundarySource = `Checking\nAugust opening balance: $1,000.00\nUnrelated report note dated 2026-09-15`;
const broadBoundaryResponse = response();
broadBoundaryResponse.periodStart = cite(null, ''); broadBoundaryResponse.periodEnd = cite(null, ''); broadBoundaryResponse.transactions = [];
broadBoundaryResponse.accounts[0].openingBalance = cite('1000.00', broadBoundarySource);
const broadBoundaryOutput = await generateTreasuryDraft(broadBoundarySource, { meetingCycle:{previousMeeting:'2026-09-03',periodStart:'2026-09-04',periodEnd:'2026-09-15'}, generateStructured:async()=>broadBoundaryResponse });
check('an unrelated boundary date elsewhere in a broad citation cannot validate an old balance', broadBoundaryOutput.accounts[0].openingBalance === null && broadBoundaryOutput.fieldReviews['accounts.0.openingBalance'] === 'unresolved');

const boundarySource = `Checking\nOpening balance on 2026-09-04: $1,000.00\nStatement balance on 2026-09-15: $1,150.00\nReceipts from 2026-09-04 through 2026-09-15: $150.00`;
const boundaryResponse = response();
boundaryResponse.periodStart = cite(null, ''); boundaryResponse.periodEnd = cite(null, ''); boundaryResponse.transactions = [];
boundaryResponse.accounts[0].openingBalance = cite('1000.00', 'Opening balance on 2026-09-04: $1,000.00');
boundaryResponse.accounts[0].statementBalance = cite('1150.00', 'Statement balance on 2026-09-15: $1,150.00');
boundaryResponse.accounts[0].receipts = cite('150.00', 'Receipts from 2026-09-04 through 2026-09-15: $150.00');
const boundaryOutput = await generateTreasuryDraft(boundarySource, { meetingCycle:{previousMeeting:'2026-09-03',periodStart:'2026-09-04',periodEnd:'2026-09-15'}, generateStructured:async()=>boundaryResponse });
check('account figures remain matched only when their citations include the applicable fixed boundary dates', boundaryOutput.accounts[0].openingBalance === '1000.00' && boundaryOutput.accounts[0].statementBalance === '1150.00' && boundaryOutput.accounts[0].receipts === '150.00' && ['openingBalance','statementBalance','receipts'].every(field=>boundaryOutput.fieldReviews[`accounts.0.${field}`] === 'matched'));

let request;
const output = await generateTreasuryDraft(source, { sourceNames: ['synthetic.png'], sourceNotes: ['Synthetic screenshot was read with OCR. Check every amount.'], generateStructured: async value => { request = value; return response(); } });
assert.equal(request.instructions, TREASURY_REPORT_RULES);
check('callback receives treasury routing and exact source text', request.purpose === 'treasury' && request.schemaName === 'treasury_source_extraction' && JSON.parse(request.input).sourceText === source);
check('supported source figures keep existing normalized dollar strings', output.accounts[0].openingBalance === '1000.00' && output.accounts[0].statementBalance === '1150.00' && output.transactions[0].amount === '200.00');
check('source-matched fields carry green review states and retired categories do not create correction work', output.fieldReviews['accounts.0.openingBalance'] === 'matched' && output.fieldReviews['accounts.0.statementBalance'] === 'matched' && !Object.hasOwn(output.fieldReviews,'accounts.0.bankHold') && !Object.hasOwn(output.fieldReviews,'transactions.0.category') && output.fieldReviews['transactions.0.amount'] === 'matched');
check('structured processing confirms only a source-supported bank-posted date', output.transactions[0].postedDateConfirmed === true);
check('explicit reporting month and cited statement year are resolved deterministically', output.periodStart === '2026-08-01' && output.periodEnd === '2026-08-31' && output.transactions[0].date === '2026-08-03');
check('missing balances remain unknown and officer confirmations remain unset', output.accounts[0].bankHold === null && output.accounts[0].bookBalance === null && !output.accounts[0].activityComplete && !output.sourceReviewed && !output.fundsReviewed && !output.obligationsReviewed);
check('unmapped source content is retained for officer review', output.unmappedLines.join('\n').includes('Bank hold is unknown.') && output.unmappedLines.join('\n').includes('Keep the receipt with the report.'));
check('original source names and OCR review notes survive extraction', output.sourceNames[0] === 'synthetic.png' && output.extractionNotes.includes('Synthetic screenshot was read with OCR. Check every amount.'));
check('Terra provenance is identifiable when reorganizing original source', output.extractionNotes.some(note => note.startsWith('Terra (GPT-5.6)')));
check('accepted fields retain exact source line references for review', output.extractionNotes.join('\n').includes('Source evidence: accounts[0].openingBalance → line 4.') && output.extractionNotes.join('\n').includes('Source evidence: transactions[0].date → lines 1 through 7.'));
check('existing reconciliation still requires review and missing data', !calculateTreasury(output).ready && calculateTreasury(output).accounts[0].calculated === null);

const invalid = response();
invalid.accounts[0].bookBalance = cite('1.001', 'Opening balance: $1,000.00');
invalid.accounts[0].receipts = cite('9999.00', '08/03 Deposit Zeffy $200.00');
invalid.accounts[0].bankHold = cite('0.00', 'Bank hold is unknown.');
invalid.presentedOn = cite('2026-08-31', 'Keep the receipt with the report.');
invalid.transactions[0].date = cite('2027-08-03', '08/03 Deposit Zeffy $200.00');
invalid.transactions[0].description = cite('County grant paid in full', '08/03 Deposit Zeffy $200.00');
const rejected = await generateTreasuryDraft(source, { generateStructured: async () => invalid });
check('invalid precision and unsupported totals are not turned into financial entries', rejected.accounts[0].bookBalance === null && rejected.accounts[0].receipts === null);
check('unknown hold is never silently converted to zero', rejected.accounts[0].bankHold === null);
check('missing dates and unsupported years remain blank', rejected.presentedOn === '' && rejected.transactions[0].date === '');
check('unsupported descriptions are not invented from an unrelated quote', rejected.transactions[0].description === '' && rejected.extractionNotes.some(note => note.includes('need review')));
check('rejected fields are not presented as source-supported entries', !rejected.extractionNotes.join('\n').includes('Source evidence: accounts[0].bookBalance') && !rejected.extractionNotes.join('\n').includes('Source evidence: transactions[0].description'));

const fabricated = response();
fabricated.accounts[0].statementBalance = cite('9876.00', 'Closing balance: $9,876.00');
const missingQuote = await generateTreasuryDraft(source, { generateStructured: async () => fabricated });
check('evidence must occur verbatim in the input source', missingQuote.accounts[0].statementBalance === null);

const ambiguous = response();
ambiguous.transactions[0].account = cite('checking', 'Savings');
ambiguous.transactions[0].kind = cite('payment', '08/03 Deposit Zeffy $200.00');
const uncertain = await generateTreasuryDraft(source, { generateStructured: async () => ambiguous });
check('unsupported account and direction stay in review', uncertain.transactions[0].account === '' && uncertain.transactions[0].kind === 'review');

const payment = response();
payment.transactions[0].kind = cite('payment', '08/04 Payment Utilities ($50.00)');
payment.transactions[0].amount = cite('50.00', '08/04 Payment Utilities ($50.00)');
check('negative source payment retains separate direction and positive amount', (await generateTreasuryDraft(source, { generateStructured: async () => payment })).transactions[0].amount === '50.00');

const extra = response(); extra.sourceReviewed = true;
await assert.rejects(generateTreasuryDraft(source, { generateStructured: async () => extra }), error => error.code === 'TREASURY_AI_RESPONSE_INVALID');
check('model cannot add approval or review confirmations to the schema', true);
await assert.rejects(generateTreasuryDraft(source, { generateStructured: async () => ({ accounts: [] }) }), error => error.code === 'TREASURY_AI_RESPONSE_INVALID');
check('incomplete structured output fails with a controlled error', true);

const longSource = source + '\n' + Array.from({ length: 300 }, (_, index) => `Unclassified synthetic row ${index}: review this text and its source context.`).join('\n');
const retained = await generateTreasuryDraft(longSource, { generateStructured: async () => response() });
check('long source text is packed rather than truncated by the existing row limits', retained.unmappedLines.join('').replace(/\s/g, '') === longSource.replace(/\s/g, '') && retained.unmappedLines.every(line => line.length <= 1000));
const many = response();
many.transactions = Array.from({length:500}, () => structuredClone(many.transactions[0]));
const packed = await generateTreasuryDraft(source, {generateStructured: async () => many});
check('references for the maximum activity rows survive normalizer limits', packed.extractionNotes.join('\n').includes('Source evidence: transactions[499].amount → line 7.') && packed.extractionNotes.length <= 1000 && packed.extractionNotes.every(note => note.length <= 1000));

const synthetic = JSON.parse(readFileSync(new URL('./fixtures/treasury-terra-synthetic.json', import.meta.url), 'utf8'));
const replay = async (source = synthetic.source, response = structuredClone(synthetic.response)) => generateTreasuryDraft(source, { generateStructured: async () => response });
const replayed = await replay();
check('cached synthetic provider response retains all four sentence-terminated balances', replayed.accounts[0].openingBalance === '1000.00' && replayed.accounts[0].statementBalance === '1150.00' && replayed.accounts[1].openingBalance === '500.00' && replayed.accounts[1].statementBalance === '500.00');
check('unique short account evidence resolves within each actual transaction row', replayed.transactions.every(row => row.account === 'checking') && replayed.extractionNotes.join('\n').includes('transactions[1].account → line 5'));
const wrongBalance = structuredClone(synthetic.response);
wrongBalance.accounts[0].openingBalance = cite('$500.00', 'Opening balance: $500.00.');
check('balance from a different account cannot be assigned using a valid but unrelated quote', (await replay(synthetic.source, wrongBalance)).accounts[0].openingBalance === null);
const wrongAccount = structuredClone(synthetic.response);
wrongAccount.transactions[0].account = cite('savings', 'Savings account.');
check('transaction account must agree with its source-row context', (await replay(synthetic.source, wrongAccount)).transactions[0].account === '');
const twoChecking = structuredClone(synthetic.response);
twoChecking.accounts[1].name = cite('Business checking account', 'Business checking account.');
const ambiguousSource = synthetic.source.replace('Savings account.', 'Business checking account.');
check('short checking alias stays unresolved when two source accounts share that word', (await replay(ambiguousSource, twoChecking)).transactions.every(row => row.account === ''));
const excessivePrecision = structuredClone(synthetic.response);
excessivePrecision.accounts[0].openingBalance = cite('$1000.00', 'Opening balance: $1,000.009.');
check('sentence punctuation support does not round or truncate excessive monetary precision', (await replay(synthetic.source.replace('Opening balance: $1,000.00.', 'Opening balance: $1,000.009.'), excessivePrecision)).accounts[0].openingBalance === null);
const dateFragment = structuredClone(synthetic.response);
dateFragment.accounts[0].openingBalance = cite('9', '2026-09-04.');
check('date components are never accepted as monetary evidence', (await replay(synthetic.source.replace('Opening balance: $1,000.00.', '2026-09-04.'), dateFragment)).accounts[0].openingBalance === null);
for (const prefix of ['Account:', 'Bank Account:', 'Account name:']) {
  const prefixed = structuredClone(synthetic.response);
  prefixed.accounts = [prefixed.accounts[0]]; prefixed.transactions = [];
  prefixed.accounts[0].name = cite('Test Checking', `${prefix} Test Checking`);
  const prefixedSource = `${prefix} Test Checking\nOpening balance: $1,000.00.\nClosing statement balance: $1,150.00.`;
  const prefixedOutput = await replay(prefixedSource, prefixed);
  check(`${prefix} source heading preserves explicitly quoted account balances`, prefixedOutput.accounts[0].openingBalance === '1000.00' && prefixedOutput.accounts[0].statementBalance === '1150.00');
}
const ungrouped = structuredClone(synthetic.response);
ungrouped.accounts = [ungrouped.accounts[0]]; ungrouped.transactions = [];
ungrouped.accounts[0].name = cite('Test Checking', 'Test Checking');
const ungroupedOutput = await replay('Opening balance: $1,000.00.\nClosing statement balance: $1,150.00.\nStatement account is Test Checking.', ungrouped);
check('existing exact monetary support is preserved when source layout has no preceding account heading', ungroupedOutput.accounts[0].openingBalance === '1000.00' && ungroupedOutput.accounts[0].statementBalance === '1150.00');
console.log(`${passed} treasury structured extraction checks passed.`);
