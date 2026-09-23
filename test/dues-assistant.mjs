import assert from 'node:assert/strict';
import { prepareManualDuesPayment } from '../dues-assistant.js';

const ledger = { rows: [
  { rosterId: 11, name: 'Bro. James Smith', assessedCents: 17500, paidCents: 5000, remainingCents: 12500 },
  { rosterId: 12, name: 'Bro. James Jones', assessedCents: 17500, paidCents: 0, remainingCents: 17500 },
] };
const result = overrides => ({ brotherName: 'James Smith', amount: '75.00', effectiveDate: '2026-09-23', paymentMethod: 'Check', sourceReference: '1042', note: '', needsClarification: '', ...overrides });
let calls = 0;
const model = response => async request => { calls++; assert.equal(request.purpose, 'dues'); assert.equal(request.schemaName, 'stone_square_manual_dues_payment'); return response; };

const note = 'Brother James Smith paid $75 by check 1042 on September 23, 2026.';
const proposal = await prepareManualDuesPayment(note, ledger, model(result()));
assert.equal(proposal.rosterId, 11);
assert.equal(proposal.amount, '75.00');
assert.equal(proposal.currentBalanceCents, 12500);
assert.equal(proposal.projectedBalanceCents, 5000);
assert.deepEqual(proposal.warnings, []);
assert.equal(ledger.rows[0].paidCents, 5000, 'preparation must not change the ledger');

const unmatched = await prepareManualDuesPayment('Brother James paid $75 by check 1042 on September 23, 2026.', ledger, model(result({ brotherName: 'James' })));
assert.equal(unmatched.rosterId, null);
assert.match(unmatched.warnings.join(' '), /not matched/i);

const inventedName = await prepareManualDuesPayment('Brother Peter Jones paid $75 by check 1042 on September 23, 2026.', ledger, model(result()));
assert.equal(inventedName.rosterId, null);
assert.match(inventedName.warnings.join(' '), /original note/i);

const hallucinatedAmount = await prepareManualDuesPayment('Brother James Smith paid by check 1042 on September 23, 2026.', ledger, model(result()));
assert.equal(hallucinatedAmount.amount, '');
assert.equal(hallucinatedAmount.projectedBalanceCents, null);
assert.match(hallucinatedAmount.warnings.join(' '), /amount/i);

await assert.rejects(prepareManualDuesPayment('Brother James Smith paid $75 via Zeffy on September 23, 2026.', ledger, model(result({ paymentMethod: 'Other' }))), { statusCode: 409 });

const incomplete = await prepareManualDuesPayment('Brother James Smith paid $75 on September 23, 2026.', ledger, model(result({ paymentMethod: 'Unknown', effectiveDate: '2026-09-31' })));
assert.equal(incomplete.paymentMethod, '');
assert.equal(incomplete.effectiveDate, '');
assert.match(incomplete.warnings.join(' '), /date/i);

await assert.rejects(prepareManualDuesPayment('too short', ledger, model(result())), { statusCode: 400 });
await assert.rejects(prepareManualDuesPayment(note, ledger, null), { statusCode: 503 });
assert.equal(calls, 5);
console.log('8 manual dues assistance checks passed.');
