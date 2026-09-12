// All arithmetic uses integer cents. Unknown values remain unknown.
export const TREASURY_ROLES = new Set(['owner', 'treasurer', 'assistant_treasurer', 'treasury_preparer', 'secretary', 'assistant_secretary']);
export const TREASURY_OFFICES = { owner: 'Worshipful Master', treasurer: 'Treasurer', assistant_treasurer: 'Assistant Treasurer', treasury_preparer: 'Treasury Report Preparer', secretary: 'Secretary', assistant_secretary: 'Assistant Secretary' };
const text = (v, max = 1500) => String(v ?? '').trim().slice(0, max);
export const money = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const raw = String(v).trim().replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const n = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(n) && Math.abs(n) <= 1e12 ? n : null;
};
export const dollars = cents => cents === null || cents === undefined ? null : (cents / 100).toFixed(2);
export const currency = cents => cents === null || cents === undefined ? 'Needs review' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v ? v : '';
const amount = v => dollars(money(v));
const accountFields = ['openingBalance', 'statementBalance', 'bookBalance', 'receipts', 'disbursements', 'transfersIn', 'transfersOut', 'depositsInTransit', 'outstandingChecks', 'bankHold'];
export const emptyAccount = (id = 'checking', name = 'Checking') => Object.fromEntries([['id', id], ['name', name], ['activityComplete', false], ...accountFields.map(k => [k, null])]);
export function normalizeTreasury(input = {}) {
  for (const [key,limit] of [['accounts',6],['transactions',500],['funds',50],['obligations',100],['unmappedLines',1000]]) if (Array.isArray(input[key]) && input[key].length > limit) throw Object.assign(new Error(`This report has too many ${key}. Use a smaller reporting period.`), { statusCode:400 });
  const accounts = (Array.isArray(input.accounts) ? input.accounts : [emptyAccount(), emptyAccount('savings', 'Savings')]).slice(0, 6).map((a, i) => ({ id: text(a.id || `account${i}`, 40), name: text(a.name || `Account ${i + 1}`, 80), activityComplete: a.activityComplete === true, ...Object.fromEntries(accountFields.map(k => [k, amount(a[k])])) }));
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw Object.assign(new Error('Each account must have a unique identifier.'), { statusCode: 400 });
  const rows = (key, max = 500) => (Array.isArray(input[key]) ? input[key] : []).slice(0, max);
  return { version: 1, periodStart: validDate(input.periodStart), periodEnd: validDate(input.periodEnd), presentedOn: validDate(input.presentedOn), bankName: text(input.bankName, 120), accounts,
    transactions: rows('transactions').map(t => ({ date: validDate(t.date), account: text(t.account, 40), kind: ['receipt', 'payment', 'transfer_in', 'transfer_out'].includes(t.kind) ? t.kind : 'review', description: text(t.description, 500), amount: amount(t.amount), reference: text(t.reference, 80), category: text(t.category, 80) })),
    funds: rows('funds', 50).map(f => ({ name: text(f.name, 120), account: text(f.account, 40), amount: amount(f.amount), restriction: text(f.restriction, 300) })),
    obligations: rows('obligations', 100).map(o => ({ name: text(o.name, 150), dueDate: validDate(o.dueDate), amount: amount(o.amount), note: text(o.note, 400) })),
    fundsReviewed: input.fundsReviewed === true, obligationsReviewed: input.obligationsReviewed === true, sourceReviewed: input.sourceReviewed === true,
    remarks: text(input.remarks, 10000), unmappedLines: rows('unmappedLines', 1000).map(l => text(l, 1000)), sourceNames: rows('sourceNames', 5).map(n => text(n, 150)), extractionNotes: rows('extractionNotes', 50).map(n => text(n, 400)) };
}
const sum = values => values.some(v => v === null) ? null : values.reduce((a, b) => a + b, 0);
export function calculateTreasury(input) {
  const draft = normalizeTreasury(input), issues = [], accountIds = new Set(draft.accounts.map(a => a.id));
  if (!draft.periodStart || !draft.periodEnd) issues.push('Enter the beginning and ending dates of this report.');
  if (draft.periodStart && draft.periodEnd && draft.periodStart > draft.periodEnd) issues.push('The report ending date is before its beginning date.');
  if (!draft.accounts.length) issues.push('Include at least one bank account.');
  if (!draft.sourceReviewed) issues.push('Review the imported text and confirm that the financial entries were captured correctly.');
  if (!draft.fundsReviewed) issues.push('Confirm the fenced and restricted funds, including any grants.');
  if (!draft.obligationsReviewed) issues.push('Confirm unpaid bills and upcoming obligations.');
  for (const [i, t] of draft.transactions.entries()) {
    if (!accountIds.has(t.account) || t.kind === 'review' || money(t.amount) === null || money(t.amount) < 0) issues.push(`Review the account, direction and amount on activity row ${i + 1}.`);
    if (t.date && ((draft.periodStart && t.date < draft.periodStart) || (draft.periodEnd && t.date > draft.periodEnd))) issues.push(`Activity row ${i + 1} is outside the report period.`);
  }
  for (const [i, f] of draft.funds.entries()) if (!accountIds.has(f.account) || money(f.amount) === null || money(f.amount) < 0) issues.push(`Review fenced fund ${i + 1}.`);
  for (const [i, o] of draft.obligations.entries()) if (!o.name || money(o.amount) === null || money(o.amount) < 0) issues.push(`Review obligation ${i + 1}.`);
  const accounts = draft.accounts.map(a => {
    for (const field of accountFields.filter(k => !['openingBalance','statementBalance','bookBalance'].includes(k))) if (money(a[field]) !== null && money(a[field]) < 0) issues.push(`${a.name}: ${field.replace(/([A-Z])/g, ' $1').toLowerCase()} must not be negative. Record the direction separately.`);
    const entries = draft.transactions.filter(t => t.account === a.id);
    const flow = (field, kind) => {
      const rows = entries.filter(t => t.kind === kind), total = sum(rows.map(t => money(t.amount))), stated = money(a[field]);
      if (a.activityComplete && stated !== null && total !== stated) issues.push(`${a.name}: ${field.replace(/([A-Z])/g, ' $1').toLowerCase()} total does not match the listed activity.`);
      return stated !== null ? stated : a.activityComplete ? total : null;
    };
    const receipts = flow('receipts', 'receipt'), disbursements = flow('disbursements', 'payment'), transfersIn = flow('transfersIn', 'transfer_in'), transfersOut = flow('transfersOut', 'transfer_out');
    const opening = money(a.openingBalance), statement = money(a.statementBalance), book = money(a.bookBalance), transit = money(a.depositsInTransit), outstanding = money(a.outstandingChecks), hold = money(a.bankHold);
    const complete = [opening, receipts, disbursements, transfersIn, transfersOut].every(n => n !== null);
    const calculated = complete ? opening + receipts - disbursements + transfersIn - transfersOut : null;
    const adjusted = [statement, transit, outstanding].every(n => n !== null) ? statement + transit - outstanding : null;
    const difference = adjusted !== null && book !== null ? adjusted - book : null;
    if (!complete) issues.push(`${a.name}: complete the opening balance and receipt, payment and transfer totals, or confirm that all activity is listed.`);
    if ([statement, book, transit, outstanding, hold].some(n => n === null)) issues.push(`${a.name}: confirm the statement balance, book balance, deposits in transit, outstanding checks and bank hold. Enter 0 only when none applies.`);
    if (calculated !== null && statement !== null && calculated !== statement) issues.push(`${a.name}: beginning balance plus bank activity differs from the statement ending balance by ${currency(calculated - statement)}.`);
    if (difference !== null && difference !== 0) issues.push(`${a.name}: the adjusted bank balance and book balance differ by ${currency(difference)}.`);
    const fenced = draft.fundsReviewed ? sum(draft.funds.filter(f => f.account === a.id).map(f => money(f.amount))) : null;
    if (fenced !== null && book !== null && fenced > book) issues.push(`${a.name}: fenced funds exceed the book balance.`);
    return { id: a.id, name: a.name, opening, receipts, disbursements, transfersIn, transfersOut, calculated, statement, book, transit, outstanding, hold, adjusted, difference, fenced };
  });
  const total = k => sum(accounts.map(a => a[k]));
  const cash = total('statement'), bookCash = total('book'), hold = total('hold'), fenced = draft.fundsReviewed ? sum(draft.funds.map(f => money(f.amount))) : null, obligations = draft.obligationsReviewed ? sum(draft.obligations.map(o => money(o.amount))) : null;
  const ti = total('transfersIn'), to = total('transfersOut');
  if (accounts.length > 1 && ti !== null && to !== null && ti !== to) issues.push('Transfers between the included accounts do not balance. Confirm both sides or identify an account outside this report.');
  const unrestricted = [bookCash, hold, fenced].every(n => n !== null) ? bookCash - hold - fenced : null;
  const afterObligations = unrestricted !== null && obligations !== null ? unrestricted - obligations : null;
  return { accounts, cash, bookCash, hold, fenced, obligations, unrestricted, afterObligations, issues: [...new Set(issues)], ready: issues.length === 0 };
}

const monthNumber = value => ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(value.slice(0, 3).toLowerCase()) + 1;
function parseDate(value, year = '') {
  let m = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return validDate(m[0]);
  m = value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) { let y = m[3] || year; if (y.length === 2) y = `20${y}`; return y ? validDate(`${y}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`) : ''; }
  m = value.match(/\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(20\d{2}))?/i);
  return m && (m[3] || year) ? validDate(`${m[3] || year}-${String(monthNumber(m[1])).padStart(2,'0')}-${m[2].padStart(2,'0')}`) : '';
}
const moneyTokens = line => [...line.matchAll(/(?:\(?-?\$\s*\d[\d,]*(?:\.\d{2})?\)?|\(?-?\d[\d,]*\.\d{2}\)?)/g)].map(m => ({ raw: m[0], cents: money(m[0]), index: m.index })).filter(m => m.cents !== null);
export function organizeTreasury(source, options = {}) {
  const draft = normalizeTreasury({ sourceNames: options.sourceNames, extractionNotes: options.extractionNotes });
  const lines = String(source).replace(/\r/g, '').split(/\n|;\s*/).map(l => l.trim()).filter(Boolean);
  let account = '', section = '', year = '', pending = '';
  const seen = new Set();
  const inferAccount = line => /\bchecking\b|share\s*0070\b/i.test(line) ? 'checking' : /\bsavings\b|prime share|share\s*0001\b/i.test(line) ? 'savings' : '';
  for (const raw of lines) {
    const line = raw.replace(/^[*•\s]+/, '').replace(/[*]+$/, '').replace(/-{2,}/g,' ');
    const named = inferAccount(line);
    const dates = [...line.matchAll(/20\d{2}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+\d{1,2},?\s+20\d{2}/gi)].map(m => parseDate(m[0])).filter(Boolean);
    if (/^(?:period|reporting period|statement period|period covered)\b/i.test(line)) {
      const range = line.match(/\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\s+(?:through|to|-)\s+(?:(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+)?(\d{1,2}),?\s+(20\d{2})/i);
      if (range) { year=range[6];draft.periodStart=parseDate(`${range[1]} ${range[2]}, ${range[3]||year}`);draft.periodEnd=parseDate(`${range[4]||range[1]} ${range[5]}, ${year}`);continue; }
      if (dates.length >= 2 && !/presented/i.test(line)) { [draft.periodStart, draft.periodEnd] = dates; year = draft.periodStart.slice(0,4); continue; }
      const mo = line.match(/\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(20\d{2})\b/i);
      if (mo) { const m = monthNumber(mo[1]); year = mo[2]; draft.periodStart = `${year}-${String(m).padStart(2,'0')}-01`; draft.periodEnd = new Date(Date.UTC(+year,m,0)).toISOString().slice(0,10); continue; }
    }
    if (/^(?:date presented|presented on|presentation date)/i.test(line) && dates[0]) { draft.presentedOn = dates[0]; continue; }
    if (/^bank(?: name)?\s*:/i.test(line)) { draft.bankName = line.replace(/^bank(?: name)?\s*:/i,'').trim(); continue; }
    if (/dexsta federal credit union/i.test(line)) draft.bankName = 'DEXSTA Federal Credit Union';
    const amounts = moneyTokens(line), last = amounts.at(-1)?.cents;
    if (named && !/transfer(?:red)?\s+(?:to|from)|transfer in|transfer out/i.test(line)) account = named;
    if (/^(?:checking|savings|prime share savings)(?:\s+account)?(?:\s+number\s*:.*|\s*:?(?:\s+\d{4})?)$/i.test(line)) { account = named; section = ''; continue; }
    if (/^Account Name:/i.test(line)) { section='';continue; }
    if (/^(?:fenced money|fenced funds|restricted funds)/i.test(line)) { section = 'funds'; if (last === undefined) continue; }
    if (/^(?:outstanding obligations|upcoming bills|unpaid bills|bills due)/i.test(line)) { section = 'obligations'; if (last === undefined || /^(?:outstanding obligations|unpaid bills)\s*\$?\s*0(?:\.00)?$/i.test(line)) continue; }
    if (/^(?:monthly summary|account reconciliation|position at|financial position|account activity|checking account activity|savings account activity)/i.test(line)) { section = /activity/i.test(line)?'activity':'summary';continue; }
    if (/^(?:remarks|notes)\s*:/.test(line.toLowerCase())) { section = 'remarks'; draft.remarks += `${draft.remarks ? '\n' : ''}${line.replace(/^[^:]+:\s*/, '')}`; continue; }
    if (section === 'remarks') { draft.remarks += `\n${line}`; continue; }
    if (section === 'funds' && last !== undefined && !/^total/i.test(line)) {
      const name=line.slice(0, amounts.at(-1).index).replace(/^(?:fenced money|fenced funds|restricted funds)\s*:\s*/i,'').replace(/[:.\s-]+$/,'').trim();
      if(name)draft.funds.push({ name, account: named || account || 'savings', amount: dollars(last), restriction: '' }); continue;
    }
    if (section === 'obligations' && last !== undefined && !/^total/i.test(line)) { draft.obligations.push({ name: line.slice(0,amounts.at(-1).index).replace(/[:\s-]+$/,''), amount:dollars(last), dueDate: dates[0] || '', note:'' }); continue; }
    const a = draft.accounts.find(a => a.id === account);
    const fields = [
      ['openingBalance', /^(?:checking\s+|savings\s+)?(?:beginning|opening|previous|starting)(?: bank)? balance(?!.*\bplus\b)|\bstarted (?:with|at)/i],
      ['statementBalance', /(?:ending|closing|current|new)(?: bank| statement)? balance|bank statement ending balance|statement balance/i],
      ['bookBalance', /(?:treasurer.s )?book balance/i], ['depositsInTransit', /deposits? in transit|pending deposits?/i],
      ['outstandingChecks', /outstanding checks?(?: balance| total)?/i], ['bankHold', /bank hold|minimum (?:share|balance) hold|membership share/i],
      ['transfersIn', /^(?:total )?transfers? (?:in|from)|^total transferred from/i], ['transfersOut', /^(?:total )?transfers? (?:out|to)|^total transferred to/i],
      ['receipts', /^(?:plus:\s*)?(?:total )?(?:receipts|deposits|income|credits)(?: total)?\s*[:$-]|^(?:plus:\s*)?total (?:receipts|deposits|income|credits)/i],
      ['disbursements', /^(?:less:\s*)?(?:total )?(?:payments|disbursements|withdrawals|expenses|debits)(?: total)?\s*[:$-]|^(?:less:\s*)?total (?:payments|disbursements|withdrawals|expenses|debits)/i],
    ];
    const field = fields.find(([, re]) => re.test(line));
    if (a && field && (last !== undefined || /\b(?:none|zero)\b/i.test(line))) {
      // A line with two account columns is ambiguous. Preserve it for review.
      if (amounts.length > 1 && !/available/i.test(line)) { draft.unmappedLines.push(raw); continue; }
      a[field[0]] = dollars(last ?? 0); continue;
    }
    if (a && field && last === undefined) { pending = field[0]; continue; }
    if (a && pending && amounts.length === 1 && /^[$\d\s,().-]+$/.test(line)) { a[pending] = dollars(last); pending = ''; continue; }
    pending = '';
    if (/^(?:receipts|income|deposits|credits)\s*:?(?:\s*\/.*)?$/i.test(line)) { section = 'receipt'; continue; }
    if (/^(?:payments|expenses|disbursements|withdrawals|debits)\s*:?(?:\s*\/.*)?$/i.test(line)) { section = 'payment'; continue; }
    if (a && amounts.length && section !== 'summary' && !/^(?:total|balance|account number|dividend.*year.to.date|annual percentage)/i.test(line)) {
      const date = parseDate(line, year), amountIndex = amounts.length > 1 && date ? amounts.length - 2 : amounts.length - 1;
      const value = amounts[amountIndex];
      let kind = /transfer/i.test(line) ? (/\bfrom\b|transfer in/i.test(line) ? 'transfer_in' : /\bto\b|transfer out/i.test(line) ? 'transfer_out' : 'review') : /\bdeposit|\breceipt|\bdividend|\binterest earned|\bincome|\bcredit\b/i.test(line) ? 'receipt' : /\bwithdrawal|\bdraft\s*\d|\bpaid|\bpayment|\bexpense|\bdebit\b|\bfee\b/i.test(line) || value.cents < 0 ? 'payment' : ['receipt','payment'].includes(section) ? section : 'review';
      const reference = line.match(/(?:check|chk|draft)\s*#?\s*(\d{2,8})/i)?.[1] || '';
      const category = /new castle count|county grant/i.test(line) ? 'County grant, restriction needs review' : /zeffy/i.test(line) ? 'Zeffy' : /cash\s*app/i.test(line) ? 'Cash App' : /dividend|interest/i.test(line) ? 'Interest / dividend' : '';
      let description=(line.slice(0,value.index)+line.slice(value.index+value.raw.length)).trim();
      description=description.replace(/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+\d{1,2},?\s+20\d{2})\s*/i,'').replace(/\s+/g,' ').trim();
      const transaction = { date, account, kind, description, amount:dollars(Math.abs(value.cents)), reference, category };
      // Duplicate source rows remain visible. Never silently remove a possible real payment.
      const key = JSON.stringify(transaction); if (seen.has(key)) draft.extractionNotes.push('Repeated activity was found. Review for duplicate source pages or repeated payments.'); seen.add(key);
      draft.transactions.push(transaction); continue;
    }
    draft.unmappedLines.push(raw);
  }
  // Empty accounts may be omitted only when the source clearly identifies another account.
  const used = new Set(draft.transactions.map(t => t.account));
  for (const a of draft.accounts) if (accountFields.some(k => a[k] !== null)) used.add(a.id);
  if (used.size) draft.accounts = draft.accounts.filter(a => used.has(a.id));
  return normalizeTreasury(draft);
}
