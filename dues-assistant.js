const schema = {
  type: 'object', additionalProperties: false,
  required: ['brotherName', 'amount', 'effectiveDate', 'paymentMethod', 'sourceReference', 'note', 'needsClarification'],
  properties: {
    brotherName: { type: 'string' },
    amount: { type: 'string' },
    effectiveDate: { type: 'string' },
    paymentMethod: { type: 'string', enum: ['Cash', 'Check', 'Money order', 'Bank transfer', 'Other', 'Unknown'] },
    sourceReference: { type: 'string' },
    note: { type: 'string' },
    needsClarification: { type: 'string' },
  },
};

const normalize = value => String(value || '').toLowerCase().replace(/\b(brother|bro|pm|past master|iii|ii|jr|sr)\b/g, '').replace(/[^a-z]/g, '');
const cents = value => {
  const text = String(value || '').replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return amount > 0 && amount <= 10_000_000 ? amount : null;
};
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
const easternToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export async function prepareManualDuesPayment(source, ledger, generateStructured) {
  const text = String(source || '').trim();
  if (text.length < 12 || text.length > 2000) throw Object.assign(new Error('Describe one payment in 12 to 2,000 characters.'), { statusCode: 400 });
  if (/\bzeffy\b/i.test(text)) throw Object.assign(new Error('Zeffy payments sync automatically. Check the ledger before making any manual adjustment.'), { statusCode: 409 });
  if (!generateStructured) throw Object.assign(new Error('Payment assistance is unavailable. You can still enter the payment manually.'), { statusCode: 503 });
  const today = easternToday();
  const result = await generateStructured({
    purpose: 'dues', schemaName: 'stone_square_manual_dues_payment', schema,
    instructions: `Extract ONE non-Zeffy dues payment from the officer's text. Return only stated facts. If multiple payments are described, set needsClarification to say one payment at a time and leave uncertain fields empty. Never invent a Brother, an amount, a method, a reference or a date. An unstated date may be set to today's Eastern calendar date (${today}) but the officer must review it. If the source calls a payment Zeffy, set needsClarification to say Zeffy payments already sync automatically. Return the amount as dollars with exactly two decimal places, without a currency symbol. Convert a clearly stated amount such as 175 dollars to 175.00. Use Unknown when the method is missing. Put a check number or receipt ID in sourceReference. Keep the note concise. Do not infer ticket purchases from dues payments.`,
    input: text,
  });
  const amountCents = cents(result.amount);
  const normalizedName = normalize(result.brotherName);
  const nameInSource = normalizedName.length > 3 && normalize(text).includes(normalizedName);
  const matches = nameInSource ? ledger.rows.filter(row => {
    const parts = row.name.replace(/^(?:Bro\.?|PM\.?|Past Master)\s+/i, '').trim().split(/\s+/);
    return normalizedName && (normalize(row.name) === normalizedName || normalize(`${parts[0]} ${parts.at(-1)}`) === normalizedName);
  }) : [];
  const matched = matches.length === 1 ? matches[0] : null;
  const mentionedAmount = amountCents != null && [...text.matchAll(/\$?\d[\d,]*(?:\.\d{1,2})?/g)].some(match => cents(match[0]) === amountCents);
  const warnings = [];
  if (result.needsClarification.trim()) warnings.push(result.needsClarification.trim().slice(0, 300));
  if (!matched) warnings.push(!nameInSource ? 'The suggested Brother name was not found in the original note. Select the correct Brother.' : matches.length > 1 ? 'More than one Brother matches this name. Select the correct roster record.' : 'The Brother was not matched to the Lodge roster. Select the correct Brother.');
  if (!mentionedAmount) warnings.push('Confirm the amount against the original note. It was not found as a number in the text.');
  if (!validDate(result.effectiveDate)) warnings.push('Select the payment date.');
  if (result.paymentMethod === 'Unknown') warnings.push('Select how the payment was received.');
  const amount = mentionedAmount ? (amountCents / 100).toFixed(2) : '';
  return {
    brotherName: String(result.brotherName || '').slice(0, 160),
    rosterId: matched?.rosterId ?? null,
    rosterName: matched?.name ?? null,
    amount,
    effectiveDate: validDate(result.effectiveDate) ? result.effectiveDate : '',
    paymentMethod: result.paymentMethod === 'Unknown' ? '' : result.paymentMethod,
    sourceReference: String(result.sourceReference || '').slice(0, 160),
    note: String(result.note || '').slice(0, 500),
    currentPaidCents: matched?.paidCents ?? null,
    currentBalanceCents: matched?.remainingCents ?? null,
    projectedPaidCents: matched && amount ? matched.paidCents + amountCents : null,
    projectedBalanceCents: matched && amount ? Math.max(0, matched.assessedCents - matched.paidCents - amountCents) : null,
    warnings,
  };
}
