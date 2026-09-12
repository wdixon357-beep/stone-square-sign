import assert from 'node:assert/strict';
import { organizeTreasury, calculateTreasury, normalizeTreasury, money } from '../treasury.js';
const notes=`Period: August 2026
Bank: Example Credit Union
Checking
Beginning balance: $1,000.00
Ending balance: $1,125.00
Book balance: $1,125.00
Deposits in transit: $0.00
Outstanding checks: $0.00
Bank hold: $0.00
08/03/2026 Deposit Zeffy $200.00
08/04/2026 Payment Utilities $50.00
08/05/2026 Transfer to savings $25.00
Savings
Beginning balance: $100.00
Ending balance: $125.00
Book balance: $125.00
Deposits in transit: $0.00
Outstanding checks: $0.00
Bank hold: $5.00
08/05/2026 Transfer from checking $25.00
Fenced funds
Education Fund $100.00
Upcoming bills
Insurance $40.00
Remarks: A receipt needs to be retained.`;
const d=organizeTreasury(notes);
assert.equal(d.periodStart,'2026-08-01');assert.equal(d.periodEnd,'2026-08-31');
assert.equal(d.accounts.length,2);assert.equal(d.transactions.length,4);assert.equal(d.funds.length,1);assert.equal(d.obligations.length,1);
assert.equal(d.accounts[0].statementBalance,'1125.00');assert.equal(d.transactions[2].kind,'transfer_out');assert.equal(d.transactions[3].kind,'transfer_in');
assert.equal(calculateTreasury(d).ready,false);
Object.assign(d,{sourceReviewed:true,fundsReviewed:true,obligationsReviewed:true});d.accounts.forEach(a=>a.activityComplete=true);
let calc=calculateTreasury(d);assert.deepEqual(calc.issues,[]);assert.equal(calc.accounts[0].receipts,20000);assert.equal(calc.accounts[0].disbursements,5000);assert.equal(calc.cash,125000);assert.equal(calc.unrestricted,114500);assert.equal(calc.afterObligations,110500);
const bad=structuredClone(d);bad.accounts[0].bookBalance='1100.00';assert.match(calculateTreasury(bad).issues.join(' '),/differ by \$25.00/);
bad.accounts[0].statementBalance=null;assert.equal(calculateTreasury(bad).cash,null);assert.equal(calculateTreasury(bad).ready,false);
bad.transactions.push({...bad.transactions[0],date:'2026-09-01'});assert.match(calculateTreasury(bad).issues.join(' '),/outside the report period/);
assert.equal(money('not supplied'),null);assert.equal(money('0'),0);assert.equal(money('$1,234.56'),123456);assert.equal(money('(25.00)'),-2500);assert.equal(money('1.001'),null);
assert.equal(normalizeTreasury({periodEnd:'2026-02-30'}).periodEnd,'');
const blank=calculateTreasury({});assert.equal(blank.cash,null);assert.equal(blank.fenced,null);assert.equal(blank.obligations,null);assert.equal(blank.unrestricted,null);
const unknown=organizeTreasury('Checking\nSome banking item $80.00\nNo amount is supplied for a second item.');assert.equal(unknown.transactions[0].kind,'review');assert.ok(unknown.unmappedLines.some(l=>l.includes('second item')));
console.log('Treasurer organization, cent arithmetic, transfer separation, missing inputs and reconciliation tests passed.');
export { notes, d as completeTreasuryFixture };
