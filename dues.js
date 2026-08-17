/* Dues ledger. Reconciles live Zeffy payments against the Lodge roster.
 *
 * Ported from the Lodge website's zeffy-client.ts and dues-ledger.ts, with one
 * structural change that matters: this repository is PUBLIC, so neither the Zeffy
 * key nor the 46 Brothers' names and addresses can sit in source the way they do
 * there. Configuration comes from the environment and the roster lives in Postgres,
 * seeded once by scripts/seed-roster.mjs from a machine that already holds it.
 *
 * Who may see this: the Worshipful Master, the Secretary and the Assistant Secretary.
 * A dues ledger names the men who are behind, which is not a thing a viewer sees.
 */

import { dbAll } from './db.js';

export const DUES_ROLES = new Set(['owner', 'secretary', 'assistant_secretary']);

const API_BASE = process.env.ZEFFY_API_BASE || 'https://api.zeffy.com/api/v1';
const API_KEY = process.env.ZEFFY_API_KEY || '';
const CAMPAIGN_ANNUAL = process.env.ZEFFY_DUES_CAMPAIGN_ID || '';
const CAMPAIGN_CUSTOM = process.env.ZEFFY_CUSTOM_DUES_CAMPAIGN_ID || '';
const CAMPAIGN_STALE = process.env.ZEFFY_STALE_CAMPAIGN_ID || '';
const DUES_RATE_CENTS = Number(process.env.DUES_RATE_CENTS || 17500);
const DUES_YEAR = process.env.DUES_YEAR || '2026-2027';

export const duesConfigured = () => Boolean(API_KEY && CAMPAIGN_ANNUAL);

/* Zeffy's edge silently 403s a request with a bare or scripted user agent even when
 * the key is valid, so every call carries an explicit one. Confirmed 2026-07-15. */
const zeffyFetch = async (path) => {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'StoneSquareLodge22-DuesSync/1.0 (+stonesquare22pha.org)',
    },
  });
  if (!res.ok) throw new Error(`Zeffy API ${path} returned HTTP ${res.status}`);
  return res;
};

/* Zeffy does not filter by campaign server side. Passing campaign_id to /payments
 * returns other campaigns' payments mixed in, tested and confirmed, so everything is
 * fetched and filtered here. Cursor paging, capped at 20 pages. The Lodge is nowhere
 * near 2,000 payments, so hitting the cap would itself mean something is wrong. */
export const fetchAllPayments = async () => {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const qs = cursor ? `?limit=100&starting_after=${cursor}` : '?limit=100';
    const data = await (await zeffyFetch(`/payments${qs}`)).json();
    out.push(...(data.data || []));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
};

const forCampaign = (all, id) =>
  id ? all.filter((p) => p.campaign_id === id && p.status === 'succeeded') : [];

const normalize = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
const toISODate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export const loadRoster = () =>
  dbAll('SELECT first_name, last_name, title, prefix, emails FROM roster ORDER BY last_name, first_name');

const SELF_ANSWERS = ['myself', 'me', 'self', 'my own', 'my dues'];

/* A Brother may pay another Brother's dues, so the form asks who the payment is for.
 * That answer outranks the card holder's name, otherwise the money credits the wrong
 * man and somebody gets chased for dues he already paid. */
const whoIsThisFor = (payment) =>
  payment.buyer_questions?.find((q) => /who is this (payment|for)/i.test(q.question))?.answer?.trim();

export const resolveBrother = (payment, roster) => {
  const byEmail = (email) => {
    const e = String(email || '').trim().toLowerCase();
    return e ? roster.find((r) => (r.emails || []).includes(e)) : undefined;
  };
  const byName = (first, last) => {
    const nf = normalize(first);
    const nl = normalize(last);
    return roster.find((r) => normalize(r.last_name) === nl && normalize(r.first_name) === nf);
  };

  const answer = whoIsThisFor(payment);
  if (answer && !SELF_ANSWERS.includes(answer.toLowerCase())) {
    const compact = normalize(answer);
    const hit = roster.find((r) => {
      const full = normalize(`${r.first_name}${r.last_name}`);
      return compact === full || (compact.length > 3 && full.includes(compact));
    });
    if (hit) return { entry: hit, matchedVia: 'payment question' };
  }
  const email = byEmail(payment.buyer?.email);
  if (email) return { entry: email, matchedVia: 'buyer email' };
  const name = byName(payment.buyer?.first_name, payment.buyer?.last_name);
  if (name) return { entry: name, matchedVia: 'buyer name' };
  return null;
};

export const buildDuesLedger = async () => {
  const roster = await loadRoster();
  const all = await fetchAllPayments();

  const dues = [
    ...forCampaign(all, CAMPAIGN_ANNUAL).map((p) => ({ p, campaign: 'annual' })),
    ...forCampaign(all, CAMPAIGN_CUSTOM).map((p) => ({ p, campaign: 'custom' })),
  ];
  const stale = forCampaign(all, CAMPAIGN_STALE);

  const rows = new Map();
  for (const r of roster) {
    rows.set(`${normalize(r.last_name)}|${normalize(r.first_name)}`, {
      name: `${r.prefix || 'Bro.'} ${r.first_name} ${r.last_name}`.trim(),
      title: r.title,
      assessedCents: DUES_RATE_CENTS,
      paidCents: 0,
      remainingCents: DUES_RATE_CENTS,
      creditCents: 0,
      status: 'unpaid',
      payments: [],
      lastPaymentISO: null,
      _sortLast: r.last_name,
    });
  }

  const unmatched = [];
  for (const { p, campaign } of dues) {
    const hit = resolveBrother(p, roster);
    if (!hit) {
      unmatched.push({
        dateISO: toISODate(p.created),
        amountCents: p.amount,
        buyerName: `${p.buyer?.first_name || ''} ${p.buyer?.last_name || ''}`.trim(),
        buyerEmail: p.buyer?.email || '',
      });
      continue;
    }
    const row = rows.get(`${normalize(hit.entry.last_name)}|${normalize(hit.entry.first_name)}`);
    if (row) {
      row.payments.push({
        dateISO: toISODate(p.created),
        amountCents: p.amount,
        campaign,
        matchedVia: hit.matchedVia,
      });
    }
  }

  const totals = {
    assessedCents: 0, collectedCents: 0, outstandingCents: 0,
    paidCount: 0, partialCount: 0, unpaidCount: 0,
  };

  const list = [...rows.values()].map((row) => {
    row.payments.sort((a, b) => (a.dateISO < b.dateISO ? 1 : -1));
    row.paidCents = row.payments.reduce((s, p) => s + p.amountCents, 0);
    row.remainingCents = Math.max(0, row.assessedCents - row.paidCents);
    row.creditCents = Math.max(0, row.paidCents - row.assessedCents);
    row.status = row.paidCents === 0 ? 'unpaid' : row.remainingCents === 0 ? 'paid' : 'partial';
    row.lastPaymentISO = row.payments[0]?.dateISO ?? null;

    totals.assessedCents += row.assessedCents;
    totals.collectedCents += row.paidCents;
    totals.outstandingCents += row.remainingCents;
    if (row.status === 'paid') totals.paidCount += 1;
    else if (row.status === 'partial') totals.partialCount += 1;
    else totals.unpaidCount += 1;
    return row;
  });

  /* Needs attention first. A dues page exists to show who to call. */
  const order = { unpaid: 0, partial: 1, paid: 2 };
  list.sort((a, b) => order[a.status] - order[b.status] || a._sortLast.localeCompare(b._sortLast));
  for (const row of list) delete row._sortLast;

  return {
    duesYear: DUES_YEAR,
    rateCents: DUES_RATE_CENTS,
    rows: list,
    unmatched,
    /* Last year's custom campaign is still open and still taking money. Payments
     * landing there are NOT counted above, and they would otherwise inflate this
     * year's collected figure. Surfaced so it gets closed rather than forgotten. */
    staleCampaign: stale.length
      ? { count: stale.length, totalCents: stale.reduce((s, p) => s + p.amount, 0) }
      : null,
    totals,
  };
};
