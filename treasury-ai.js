import { TREASURY_REPORT_RULES } from './report-rules.js';
import { organizeTreasury, normalizeTreasury, money, dollars, validDate } from './treasury.js';
import { applyTreasuryMeetingCycle } from './treasury-period.js';

const amountFields = ['openingBalance', 'statementBalance', 'bookBalance', 'receipts', 'disbursements', 'transfersIn', 'transfersOut', 'depositsInTransit', 'outstandingChecks', 'bankHold'];
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });
const claim = object({ value: { type: ['string', 'null'] }, evidence: { type: 'string', maxLength: 6000 } });
const kindClaim = object({ value: { type: ['string', 'null'], enum: ['receipt', 'payment', 'transfer_in', 'transfer_out', 'review', null] }, evidence: { type: 'string', maxLength: 6000 } });

export const TREASURY_AI_SCHEMA = object({
  periodStart: claim, periodEnd: claim, presentedOn: claim, bankName: claim,
  accounts: list(object({ id: { type: 'string', maxLength: 40 }, name: claim, ...Object.fromEntries(amountFields.map(field => [field, claim])) }), 6),
  transactions: list(object({ date: claim, account: claim, kind: kindClaim, description: claim, amount: claim, reference: claim, category: claim }), 500),
  funds: list(object({ name: claim, account: claim, amount: claim, restriction: claim }), 50),
  obligations: list(object({ name: claim, dueDate: claim, amount: claim, note: claim }), 100),
  remarks: claim,
});

const instructions = TREASURY_REPORT_RULES;

const invalidResponse = () => Object.assign(new Error('The banking information could not be organized into the report. Please try again or prepare the report manually.'), { statusCode: 502, code: 'TREASURY_AI_RESPONSE_INVALID' });
function checkShape(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(type) || (schema.enum && !schema.enum.includes(value))) throw invalidResponse();
  if (type === 'object') {
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(value, key))) throw invalidResponse();
    for (const [key, child] of Object.entries(schema.properties)) checkShape(value[key], child);
  } else if (type === 'array') {
    if (value.length > schema.maxItems) throw invalidResponse();
    value.forEach(item => checkShape(item, schema.items));
  } else if (type === 'string' && schema.maxLength && value.length > schema.maxLength) throw invalidResponse();
}

const compact = text => String(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const monthNumber = text => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(text.slice(0, 3).toLowerCase()) + 1;
function quotedDates(quote) {
  const dates = new Set();
  const add = (year, month, day) => {
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (validDate(candidate)) dates.add(candidate);
  };
  for (const match of quote.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(match[1], match[2], match[3]);
  for (const match of quote.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) add(match[3].length === 2 ? `20${match[3]}` : match[3], match[1], match[2]);
  for (const match of quote.matchAll(/\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gi)) add(match[3], monthNumber(match[1]), match[2]);
  // A row's omitted year can come only from one explicit year in its cited
  // statement context. No current year or report date is supplied by the clock.
  const years = [...new Set([...quote.matchAll(/\b20\d{2}\b/g)].map(match => match[0]))];
  if (years.length === 1) {
    for (const match of quote.matchAll(/\b(\d{1,2})\/(\d{1,2})(?![\d/])/g)) add(years[0], match[1], match[2]);
  }
  return dates;
}

function quotedAmounts(quote) {
  return [...quote.matchAll(/(?<![\w./-])(?:\(?-?\$\s*\d[\d,]*(?:\.\d{1,2})?\)?|\(?-?\d[\d,]*(?:\.\d{1,2})?\)?)(?![\w/-]|\.\d)/g)]
    .map(match => money(match[0])).filter(value => value !== null);
}

function retainedSource(source) {
  // Pack rather than truncate. The source reader permits 180,000 characters;
  // chunks below the normalizer's 1,000-character limit retain every detail.
  const chunks = [];
  let remaining = source;
  while (remaining.length) {
    let end = Math.min(950, remaining.length);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf('\n', end);
      if (newline > 400) end = newline + 1;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

export async function generateTreasuryDraft(sourceText, { generateStructured, sourceNames = [], sourceNotes = [], meetingCycle = null } = {}) {
  const source = String(sourceText ?? '');
  if (source.length > 180000) throw Object.assign(new Error('This source is too long. Use a single reporting period.'), { statusCode: 400 });
  if (!generateStructured) {
    const organized = organizeTreasury(source, { sourceNames, extractionNotes: sourceNotes });
    return normalizeTreasury(meetingCycle ? applyTreasuryMeetingCycle(organized, meetingCycle) : organized);
  }
  if (typeof generateStructured !== 'function') throw new TypeError('generateStructured must be a function');
  const cycleInstruction = meetingCycle ? `\nThe application has fixed this report to bank-posted activity from ${meetingCycle.periodStart} through ${meetingCycle.periodEnd}, inclusive. This ending date is the date the report was prepared. Do not include, total, summarize, infer, or use transactions outside that range. Do not use a transaction date, check date, monthly statement period, or pending date to replace the bank-posted date. Do not treat a full-statement total or balance as a reporting-window total unless the source explicitly identifies it at the fixed boundary. Leave periodStart, periodEnd and presentedOn null because the application controls the reporting window and the actual presentation date.` : '';
  const response = await generateStructured({
    purpose: 'treasury', schemaName: 'treasury_source_extraction', schema: TREASURY_AI_SCHEMA, instructions: instructions + cycleInstruction,
    input: JSON.stringify({ sourceText: source, sourceNames, sourceNotes, meetingCycle }),
  });
  checkShape(response, TREASURY_AI_SCHEMA);
  let rejected = 0;
  const fieldPaths = new WeakMap();
  const acceptedEvidence = new Set();
  const evidencePositions = new WeakMap();
  const sourceLines = source.split('\n');
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') lineStarts.push(index + 1);
  const lineAt = offset => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (lineStarts[middle] <= offset) low = middle; else high = middle; }
    return low;
  };
  const occurrenceCache = new Map();
  const occurrences = quote => {
    if (occurrenceCache.has(quote)) return occurrenceCache.get(quote);
    const positions = [];
    for (let start = source.indexOf(quote); start !== -1; start = source.indexOf(quote, start + Math.max(1, quote.length))) positions.push(start);
    occurrenceCache.set(quote, positions);
    return positions;
  };
  const indexFields = (value, path = '') => {
    if (Array.isArray(value)) value.forEach((item, index) => indexFields(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') {
      if (Object.hasOwn(value, 'value') && Object.hasOwn(value, 'evidence')) fieldPaths.set(value, path);
      else Object.entries(value).forEach(([key, item]) => indexFields(item, path ? `${path}.${key}` : key));
    }
  };
  indexFields(response);
  const accepted = (field, value) => { acceptedEvidence.add(field); return value; };
  const evidence = field => {
    if (field.value === null || field.value.trim() === '') return null;
    if (!field.evidence.trim() || !source.includes(field.evidence)) { rejected += 1; return null; }
    return field.evidence;
  };
  const text = field => {
    const quote = evidence(field);
    if (quote === null) return '';
    if (!compact(quote).includes(compact(field.value))) { rejected += 1; return ''; }
    return accepted(field, field.value.trim());
  };
  const amount = (field, absolute = false, accountId) => {
    const quote = evidence(field);
    if (quote === null) return null;
    const value = money(field.value);
    const supported = value !== null && (quotedAmounts(quote).some(candidate => candidate === value || (absolute && Math.abs(candidate) === value))
      || (value === 0 && /\b(?:none|zero)\b/i.test(quote) && !/\b(?:not|unknown|unsure)\b/i.test(quote)));
    if (!supported) { rejected += 1; return null; }
    if (accountId) {
      const supportedPositions = occurrences(quote).map(start => {
        const context = new Set(lineAccounts.slice(lineAt(start), lineAt(start + quote.length - 1) + 1).filter(Boolean));
        return { start, context };
      // Preserve exact monetary support for ungrouped statement layouts, while
      // rejecting a quote whose known account context contradicts this field.
      }).filter(({ context }) => context.size === 0 || (context.size === 1 && context.has(accountId)))
        .sort((left, right) => right.context.size - left.context.size);
      if (!supportedPositions.length) { rejected += 1; return null; }
      evidencePositions.set(field, supportedPositions[0].start);
    }
    return accepted(field, dollars(value));
  };
  const date = (field, periodField) => {
    const quote = evidence(field);
    if (quote === null) return '';
    const value = validDate(field.value);
    const periodValue = periodField ? organizeTreasury(quote)[periodField] : '';
    if (!value || (!quotedDates(quote).has(value) && value !== periodValue)) { rejected += 1; return ''; }
    return accepted(field, value);
  };
  const ids = new Set();
  const names = new Map();
  const accountHeaders = response.accounts.map((account, index) => {
    const id = /^[a-z][a-z0-9_-]{0,39}$/.test(account.id) ? account.id : `account${index + 1}`;
    if (ids.has(id)) throw invalidResponse();
    ids.add(id);
    const name = text(account.name);
    names.set(id, name);
    return { id, name: name || `Account ${index + 1}`, activityComplete: false };
  });
  // A short quote such as "checking" can identify "Checking account" only
  // when the verified source names make that alias unique. Model-created IDs
  // are never treated as source evidence on their own.
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliases = new Map([...names].map(([id, name]) => [id, [...new Set([
    compact(name), compact(name).replace(/\b(?:bank\s+)?accounts?\b/g, '').trim(),
    ...compact(name).match(/\b(?:checking|savings|money market)\b/g) ?? [],
  ])].filter(Boolean)]));
  const mentionedAccounts = value => {
    const matches = [...aliases].flatMap(([id, candidates]) => candidates.flatMap(alias =>
      [...compact(value).matchAll(new RegExp(`(?<![a-z0-9])${escape(alias)}(?![a-z0-9])`, 'gi'))].map(match => ({ id, start: match.index, end: match.index + match[0].length }))));
    // Prefer a full source name over an alias contained in that same span;
    // equal short aliases shared by two accounts remain ambiguous.
    return new Set(matches.filter(match => !matches.some(other => other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start)).map(match => match.id));
  };
  const ambiguousAccount = Symbol('ambiguous source accounts');
  let currentAccount = null;
  const lineAccounts = sourceLines.map(line => {
    const mentioned = mentionedAccounts(line);
    const heading = compact(line).replace(/^(?:bank\s+)?account(?:\s+name)?\s*:\s*/, '');
    const leading = new Set([...aliases].filter(([, candidates]) => candidates.some(alias => new RegExp(`^${escape(alias)}(?=$|[\\s.:,;(])`, 'i').test(heading))).map(([id]) => id));
    if (leading.size) currentAccount = mentioned.size === 1 && leading.has([...mentioned][0]) ? [...mentioned][0] : ambiguousAccount;
    return mentioned.size === 1 ? [...mentioned][0] : mentioned.size > 1 ? ambiguousAccount : currentAccount;
  });
  const accounts = accountHeaders.map((account, index) => ({ ...account,
    ...Object.fromEntries(amountFields.map(field => [field, amount(response.accounts[index][field], !['openingBalance', 'statementBalance', 'bookBalance'].includes(field), account.id)])) }));
  const accountReference = (field, row) => {
    const quote = evidence(field);
    if (quote === null) return '';
    const named = mentionedAccounts(quote);
    if (named.size !== 1 || !named.has(field.value)) { rejected += 1; return ''; }
    let candidateLines = null;
    for (const key of ['date', 'description', 'amount', 'reference', 'name']) {
      const anchor = row?.[key];
      if (!anchor?.value || !anchor.evidence || !source.includes(anchor.evidence)) continue;
      const lines = new Set(occurrences(anchor.evidence).flatMap(start => {
        const first = lineAt(start), last = lineAt(start + anchor.evidence.length - 1);
        return Array.from({ length: last - first + 1 }, (_, index) => first + index);
      }));
      candidateLines = candidateLines === null ? lines : new Set([...candidateLines].filter(line => lines.has(line)));
    }
    if (candidateLines !== null) {
      const context = new Set([...candidateLines].map(line => lineAccounts[line]).filter(Boolean));
      const fullNameQuoted = compact(quote).includes(compact(names.get(field.value)));
      if ((context.size && (context.size !== 1 || !context.has(field.value))) || (!context.size && !fullNameQuoted)) { rejected += 1; return ''; }
      const matchingPosition = occurrences(quote).find(start => candidateLines.has(lineAt(start)));
      if (matchingPosition !== undefined) evidencePositions.set(field, matchingPosition);
    }
    return accepted(field, field.value);
  };
  const direction = field => {
    const quote = evidence(field);
    if (quote === null) return 'review';
    if (field.value === 'review') return accepted(field, 'review');
    const patterns = {
      receipt: /\b(?:receipts?|deposits?|credits?|income|dividends?|interest earned)\b/i,
      payment: /\b(?:payments?|withdrawals?|debits?|expenses?|disbursements?|paid|fees?|checks?|drafts?)\b/i,
      transfer_in: /\btransfer(?:red|s)?\b[^\n]*\b(?:from|in|into)\b/i,
      transfer_out: /\btransfer(?:red|s)?\b[^\n]*\b(?:to|out)\b/i,
    };
    if (!patterns[field.value]?.test(quote)) { rejected += 1; return 'review'; }
    return accepted(field, field.value);
  };
  const postedDateEvidence = field => {
    const quote = field?.evidence || '';
    return /\b(?:posted|posting date)\b/i.test(quote) && !/\b(?:pending|scheduled|authorization date|transaction date|check date)\b/i.test(quote);
  };
  const draft = {
    periodStart: date(response.periodStart, 'periodStart'), periodEnd: date(response.periodEnd, 'periodEnd'), presentedOn: date(response.presentedOn), bankName: text(response.bankName), accounts,
    transactions: response.transactions.map(row => ({ date: date(row.date), postedDateConfirmed: postedDateEvidence(row.date), account: accountReference(row.account, row), kind: direction(row.kind), description: text(row.description), amount: amount(row.amount, true), reference: text(row.reference), category: text(row.category) })),
    funds: response.funds.map(row => ({ name: text(row.name), account: accountReference(row.account, row), amount: amount(row.amount), restriction: text(row.restriction) })),
    obligations: response.obligations.map(row => ({ name: text(row.name), dueDate: date(row.dueDate), amount: amount(row.amount), note: text(row.note) })),
    remarks: text(response.remarks), sourceReviewed: false, fundsReviewed: false, obligationsReviewed: false,
    sourceNames, extractionNotes: [...sourceNotes, 'Terra (GPT-5.6) organized this draft; source verification is required.', 'Terra retained the imported source text for a complete officer review.'], unmappedLines: retainedSource(source),
  };
  if (rejected) draft.extractionNotes.push(`Terra: ${rejected} extracted ${rejected === 1 ? 'entry did' : 'entries did'} not match the cited source and need review.`);
  // Keep field-level references with the saved draft. The full original source
  // stays above; review notes contain locations rather than repeated bank data.
  // A quote repeated in the source points explicitly to its first occurrence.
  let note = '';
  for (const field of acceptedEvidence) {
    const start = evidencePositions.get(field) ?? source.indexOf(field.evidence);
    const end = start + field.evidence.length - 1;
    const firstLine = lineAt(start) + 1;
    const lastLine = lineAt(end) + 1;
    const location = firstLine === lastLine ? `line ${firstLine}` : `lines ${firstLine} through ${lastLine}`;
    const repeated = occurrences(field.evidence).length > 1 ? evidencePositions.has(field) ? ' (matching account context)' : ' (first matching occurrence)' : '';
    const reference = `Source evidence: ${fieldPaths.get(field)} → ${location}${repeated}.`;
    if (note && note.length + reference.length + 1 > 1000) { draft.extractionNotes.push(note); note = ''; }
    note += `${note ? '\n' : ''}${reference}`;
  }
  if (note) draft.extractionNotes.push(note);
  return normalizeTreasury(meetingCycle ? applyTreasuryMeetingCycle(draft, meetingCycle) : draft);
}
