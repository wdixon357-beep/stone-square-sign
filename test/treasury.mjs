import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { readFile } from 'node:fs/promises';
import { organizeTreasury, calculateTreasury, normalizeTreasury, money } from '../treasury.js';
import { buildTreasuryPdf } from '../treasury-pdf.js';
import { clearCollectionReviewEvidence } from '../public/treasury-review.js';
const notes=`Period: August 2026
Bank: Example Credit Union
Checking
Beginning balance: $1,000.00
Ending balance: $1,125.00
Book balance: $1,125.00
Deposits in transit: $0.00
Outstanding checks: $0.00
Bank hold: $0.00
Posted transactions
08/03/2026 Deposit Zeffy: $200.00
08/04/2026 Payment Utilities $50.00
08/05/2026 Transfer to savings $25.00
Savings
Beginning balance: $100.00
Ending balance: $125.00
Book balance: $125.00
Deposits in transit: $0.00
Outstanding checks: $0.00
Bank hold: $5.00
Posted transactions
08/05/2026 Transfer from checking $25.00
Fenced funds
Education Fund - Savings: $100.00 - Scholarship awards only.
Upcoming bills
Insurance - Due September 15, 2026: $40.00
Remarks: A receipt needs to be retained.`;
const d=organizeTreasury(notes);
assert.equal(d.periodStart,'2026-08-01');assert.equal(d.periodEnd,'2026-08-31');
assert.equal(d.accounts.length,2);assert.equal(d.transactions.length,4);assert.equal(d.funds.length,1);assert.equal(d.obligations.length,1);
assert.equal(d.accounts[0].statementBalance,'1125.00');assert.equal(d.transactions[2].kind,'transfer_out');assert.equal(d.transactions[3].kind,'transfer_in');
assert.equal(d.transactions[0].description,'Deposit Zeffy');
assert.equal(d.funds[0].name,'Education Fund');assert.equal(d.funds[0].account,'savings');assert.equal(d.funds[0].restriction,'Scholarship awards only.');
assert.equal(d.obligations[0].name,'Insurance');assert.equal(d.obligations[0].dueDate,'2026-09-15');
assert.equal(calculateTreasury(d).ready,false);
Object.assign(d,{sourceReviewed:true,fundsReviewed:true,obligationsReviewed:true});d.accounts.forEach(a=>a.activityComplete=true);
let calc=calculateTreasury(d);assert.deepEqual(calc.issues,[]);assert.equal(calc.accounts[0].receipts,20000);assert.equal(calc.accounts[0].disbursements,5000);assert.equal(calc.cash,125000);assert.equal(calc.unrestricted,115000);assert.equal(calc.afterObligations,111000);
const layoutDraft=structuredClone(d);
layoutDraft.transactions.push(...['Receipt details reviewed','Payment details reviewed','Transfer details reviewed'].map((description,i)=>({date:`2026-08-${String(20+i).padStart(2,'0')}`,postedDateConfirmed:true,account:'checking',kind:'receipt',description,amount:'0.00',reference:'',category:''})));
layoutDraft.funds.push({name:'Building Fund',account:'checking',amount:'0.00',restriction:'Building expenses only.'});
layoutDraft.obligations.push({name:'Printing invoice',dueDate:'2026-09-10',amount:'0.00',note:''});
layoutDraft.remarks='Fictional figures created only to test the report layout.\nSynthetic test record. No real account or Lodge funds.';
const layoutBytes=await buildTreasuryPdf({draft:layoutDraft,preparedBy:'Fictional Test Preparer',preparerRole:'owner'});
const layoutPdf=await PDFDocument.load(layoutBytes);
assert.equal(layoutPdf.getPageCount(),4,'the established account sections and activity tables should render without crowding');
const parser=new PDFParse({data:layoutBytes});const layoutText=(await parser.getText()).text;await parser.destroy();
for(const heading of ['Receipts','Disbursements','Monthly Summary','Account Reconciliation','Outstanding Obligations','Fenced Money','Position at August 31, 2026','Account Activity: August 31, 2026'])assert.ok(layoutText.includes(heading),`PDF should include ${heading}`);
for(const removed of ['Financial Position','Bank membership shares and holds','Fenced and Restricted Funds','Receipts, Payments and Transfers'])assert.ok(!layoutText.includes(removed),`PDF should not include the retired ${removed} category`);
assert.ok(layoutText.includes('-$50.00')&&layoutText.includes('-$25.00'),'Account Activity should print disbursements and transfers out as negative amounts');
const [webTreasury,macTreasury]=await Promise.all([readFile(new URL('../public/treasury.js',import.meta.url),'utf8'),readFile(new URL('../macos/Sources/StoneSquareSign/Treasury.swift',import.meta.url),'utf8')]);
for(const client of [webTreasury,macTreasury])for(const label of ['Receipts, Disbursements and Transfers','Fenced Money','Outstanding Obligations','Total Disbursements'])assert.ok(client.includes(label),`both clients should use ${label}`);
assert.ok(!webTreasury.includes("transactions.${i}.category")&&!macTreasury.includes('reviewedField("Category"'),'neither client should show a separate generated transaction category');
const bad=structuredClone(d);bad.accounts[0].bookBalance='1100.00';assert.match(calculateTreasury(bad).issues.join(' '),/differ by \$25.00/);
bad.accounts[0].statementBalance=null;assert.equal(calculateTreasury(bad).cash,null);assert.equal(calculateTreasury(bad).ready,false);
bad.transactions.push({...bad.transactions[0],date:'2026-09-01'});assert.match(calculateTreasury(bad).issues.join(' '),/outside the fixed reporting period/);
const undated=structuredClone(d);undated.transactions.push({...undated.transactions[0],date:'',amount:'9999.00'});const undatedCalc=calculateTreasury(undated);assert.match(undatedCalc.issues.join(' '),/Confirm the bank-posted date/);assert.equal(undatedCalc.accounts[0].receipts,20000);
const unconfirmed=structuredClone(d);unconfirmed.transactions[0].postedDateConfirmed=false;const unconfirmedCalc=calculateTreasury(unconfirmed);assert.match(unconfirmedCalc.issues.join(' '),/uses the bank-posted date/);assert.equal(unconfirmedCalc.accounts[0].receipts,0);
const pendingSource=organizeTreasury('Checking\nPosted transactions\nPending 08/06/2026 Card authorization $500.00');assert.equal(pendingSource.transactions.length,0);assert.ok(pendingSource.unmappedLines.some(line=>/Pending/.test(line)));
const pendingSection=organizeTreasury('Checking\nPosted transactions\n08/05/2026 Deposit $25.00\nPending transactions\n08/06/2026 Card authorization $500.00');assert.equal(pendingSection.transactions.length,1);assert.equal(pendingSection.transactions[0].postedDateConfirmed,true);assert.ok(pendingSection.unmappedLines.some(line=>/08\/06\/2026/.test(line)));
assert.equal(money('not supplied'),null);assert.equal(money('0'),0);assert.equal(money('$1,234.56'),123456);assert.equal(money('(25.00)'),-2500);assert.equal(money('1.001'),null);
assert.equal(normalizeTreasury({periodEnd:'2026-02-30'}).periodEnd,'');
const reviewed=normalizeTreasury({accounts:[{id:'checking',name:'Checking',openingBalance:'10.00'}],extractionNotes:['Source evidence: accounts[0].openingBalance → line 1.']});assert.equal(reviewed.fieldReviews['accounts.0.openingBalance'],'matched');assert.equal(reviewed.fieldReviews['accounts.0.statementBalance'],'unresolved');reviewed.fieldReviews['accounts.0.statementBalance']='corrected';assert.equal(normalizeTreasury(reviewed).fieldReviews['accounts.0.statementBalance'],'unresolved');reviewed.accounts[0].statementBalance='12.00';assert.equal(normalizeTreasury(reviewed).fieldReviews['accounts.0.statementBalance'],'corrected');reviewed.accounts[0].openingBalance='not a number';reviewed.fieldReviews['accounts.0.openingBalance']='matched';assert.equal(normalizeTreasury(reviewed).fieldReviews['accounts.0.openingBalance'],'unresolved');
const invalidCorrections=normalizeTreasury({accounts:[{id:'checking',name:'Checking'}],transactions:[{date:'2026-09-05',postedDateConfirmed:true,account:'unknown',kind:'payment',amount:'-10.00',description:'Invalid correction',reference:'x',category:'test'}],fieldReviews:{'transactions.0.account':'corrected','transactions.0.amount':'corrected'}});assert.equal(invalidCorrections.fieldReviews['transactions.0.account'],'unresolved');assert.equal(invalidCorrections.fieldReviews['transactions.0.amount'],'unresolved');
const shifted={fieldReviews:{'transactions.0.amount':'matched','transactions.1.amount':'matched'},extractionNotes:['Source evidence: transactions[0].amount → line 1.\nSource evidence: transactions[1].amount → line 2.'],transactions:[{amount:'10.00'},{amount:'20.00'}]};clearCollectionReviewEvidence(shifted,'transactions');shifted.transactions.splice(0,1);const shiftedNormalized=normalizeTreasury({accounts:[{id:'checking',name:'Checking'}],transactions:[{date:'2026-09-05',postedDateConfirmed:true,account:'checking',kind:'receipt',amount:shifted.transactions[0].amount,description:'Remaining row',reference:'x',category:'test'}],fieldReviews:shifted.fieldReviews,extractionNotes:shifted.extractionNotes});assert.equal(shiftedNormalized.fieldReviews['transactions.0.amount'],'unresolved');
const blank=calculateTreasury({});assert.equal(blank.cash,null);assert.equal(blank.fenced,null);assert.equal(blank.obligations,null);assert.equal(blank.unrestricted,null);
const unknown=organizeTreasury('Checking\nSome banking item $80.00\nNo amount is supplied for a second item.');assert.equal(unknown.transactions[0].kind,'review');assert.ok(unknown.unmappedLines.some(l=>l.includes('second item')));
const summary=organizeTreasury('Checking\nPayments: $0.00\nPayments: $0.00');
assert.equal(summary.accounts[0].disbursements,'0.00');assert.equal(summary.transactions.length,0);
assert.equal(organizeTreasury('Checking\nTotal payments: $125.00').accounts[0].disbursements,'125.00');
console.log('Treasurer organization, cent arithmetic, transfer separation, missing inputs and reconciliation tests passed.');
export { notes, d as completeTreasuryFixture };
