// ─────────────────────────────────────────────────────────────────────────────
// The money ledger — every transaction a user has been part of, both sides.
//
// `payments` has always held enough for a real statement (authorized/captured/
// failed/cancelled, fee, net, refunds, timestamps, and the fee rate PINNED at
// booking time) and RLS already lets each party read their own rows — earners via
// payments_earner_select, posters via payments_poster_select. Nothing in the app
// had ever selected from it. Users saw one aggregate "earnings" number and posters
// saw nothing at all: no record of what they were charged, when, or what came back.
//
// "Where is my money" is the single most common support ticket any marketplace
// gets, and the honest fix is not a better reply macro — it is a screen that
// already answers it.
//
// ── BANK ARRIVAL: now known, and still not over-claimed ─────────────────────
//
// This used to say we could not tell an earner when money reached their bank, and
// that was true: capture is a destination charge, so funds land in their Stripe
// Connect account immediately and Stripe pays out on that account's own schedule,
// which we did not record. stripe_payouts now stores those payout.* events, so
// arrival dates are real Stripe data rather than a guess.
//
// What is still NOT claimed is which gig sits in which deposit. Stripe batches many
// transfers into one payout, so a payment says "released on <date>" and a deposit
// says "$X arrived <date>" — both true — instead of a per-gig bank date that would
// be invented.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';
import { DEFAULT_FEE_BPS, feeLabel, platformFeeCents, effectiveFeeLabel } from '../../shared/pricing';

export const LEDGER_CACHE_KEY = 'ledger:v1';

// ── Plain language, per side ────────────────────────────────────────────────
// The same row means different things to the two parties: 'captured' is "you were
// paid" to an earner and "you were charged" to a poster. Competitors that get this
// right (Uber's earnings vs a rider's receipt) never show one party the other's
// wording, and the wording is the whole product here — a status nobody can read is
// a support ticket.
const STATE = {
  earner: {
    authorized: { label: 'In escrow', tone: 'hold', note: 'Held by the poster. Released to you when they verify the work.' },
    captured:   { label: 'Released',  tone: 'good', note: 'Sent to your payout account. It reaches your bank in the next deposit — see Bank deposits for the date.' },
    failed:     { label: 'Payment failed', tone: 'bad', note: 'The poster\'s card was declined. Nothing was transferred.' },
    cancelled:  { label: 'Hold released', tone: 'muted', note: 'The booking ended before the work started, so nothing was charged.' },
  },
  poster: {
    authorized: { label: 'On hold',   tone: 'hold', note: 'Authorized on your card but not charged. You are charged when you verify the work.' },
    captured:   { label: 'Charged',   tone: 'good', note: 'Charged to your card and released to the hustler.' },
    failed:     { label: 'Card declined', tone: 'bad', note: 'Your card was declined, so nothing was charged.' },
    cancelled:  { label: 'Not charged', tone: 'muted', note: 'The hold was released. Your card was never charged.' },
  },
};

export function paymentState(status, side) {
  return STATE[side]?.[status] ?? { label: status || 'unknown', tone: 'muted', note: '' };
}

const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// bookings.tip_amount is numeric(_,2) — DOLLARS, not cents — and PostgREST returns
// numerics as STRINGS ('3.00'). Running it through cents() therefore did not merely
// misplace the decimal point, it returned 0 on the typeof check: every tip an earner
// received rendered as $0.00 on their own statement. tip_ledger.amount_cents is the
// integer-cents column; this one is not.
const dollarsToCents = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * What Stripe actually charged for this payment.
 *
 * `amount_cents` is the AUTHORIZED hold and is deliberately never overwritten —
 * stripe-capture-payment keeps it as the audit record precisely so a retry cannot
 * scale an already-reduced fee a second time. On a partial capture (a dispute
 * resolved below 100%) it therefore stays at the full hold while Stripe only ever
 * charges `earner_amount_cents + fee_cents`, and NO refund is recorded, because
 * nothing was ever taken to refund.
 *
 * Reading amount_cents on a captured row consequently bills the poster's receipt
 * for money that never left their card — on the disputed booking, which is the one
 * they are most likely to check against their statement. On a full capture the two
 * agree by construction (earner = amount − fee), so deriving from the split is
 * correct everywhere and only differs where amount_cents is wrong.
 */
export function settledGrossCents(row) {
  const authorized = cents(row?.amount_cents);
  // Guard a legacy row that was captured before the split columns were populated:
  // falling through to `0 + 0` would show a real payment as $0.00.
  const hasSplit = row?.earner_amount_cents != null && row?.fee_cents != null;
  if (row?.status !== 'captured' || !hasSplit) return authorized;
  return cents(row.earner_amount_cents) + cents(row.fee_cents);
}

/**
 * How much of a refund came out of the EARNER's payout.
 *
 * Must stay byte-for-byte equivalent to record_refund's own debit, because that is the
 * figure `debit_earnings` actually takes off profiles.earnings_*:
 *
 *   round(p_cents::numeric * earner_amount_cents / (earner_amount_cents + fee_cents))
 *
 * The earner never held the platform fee, so a $30 refund on a $60 capture
 * (earner $55.80 + fee $4.20) costs them $27.90, not $30.00. Subtracting the whole
 * refund made Transactions disagree with the earnings dashboard on every partial refund
 * — and the earnings dashboard was the correct one.
 *
 * __tests__/ledger.test.js parses the SQL off disk and fails if the two drift, the same
 * guard pricing.test.js applies to the fee.
 */
export function earnerRefundShareCents(refundedCents, earnerAmountCents, feeCents) {
  const refunded = cents(refundedCents);
  const earner = cents(earnerAmountCents);
  const capturedTotal = earner + cents(feeCents);
  // No captured total to apportion against (a legacy or malformed row): fall back to
  // the whole refund rather than silently reporting no loss at all.
  if (capturedTotal <= 0) return refunded;
  return Math.round((refunded * earner) / capturedTotal);
}

/**
 * One ledger entry, normalized so the UI never re-derives money.
 *
 * The amounts come from the payment row, NOT from the current rate card. A
 * booking's fee was pinned when it was made, and showing a past transaction at
 * today's rate would misstate what the person actually paid or received — the
 * disclosure trap called out in CLAUDE.md.
 */
function toEntry(row, side, jobsById, bookingsById) {
  const b = bookingsById[row.booking_id] ?? {};
  const job = jobsById[b.job_id] ?? {};
  const gross = settledGrossCents(row);
  const fee = cents(row.fee_cents);
  const refunded = cents(row.refunded_cents);
  const tip = dollarsToCents(b.tip_amount);
  const feeBps = typeof row.fee_bps === 'number' ? row.fee_bps : DEFAULT_FEE_BPS;

  // A refund is not the same size on both sides of the transaction.
  //
  // The poster gets the whole refund back. The earner never held the platform fee, so
  // only their proportional share of the capture comes off their payout — which is
  // exactly what record_refund debits:
  //
  //   round(refunded * earner_amount_cents / (earner_amount_cents + fee_cents))
  //
  // Subtracting the FULL refund from the earner's side overstated their loss by the
  // fee's share of it, so Transactions and the earnings dashboard disagreed on every
  // partial refund: a $30 refund on a $60 capture (earner $55.80, fee $4.20) showed the
  // earner losing $30.00 while debit_earnings took $27.90. The formula is duplicated
  // here rather than derived from the debit because the debit is not on this row —
  // __tests__/ledger.test.js pins the two together.
  const earnerRefundShare = earnerRefundShareCents(refunded, cents(row.earner_amount_cents), fee);
  // What came off THIS reader's money. Every figure describing the user's own position
  // uses this; `refundedCents` stays the true refund on the payment, because "was this
  // refunded at all" is a different question from "how much of it was mine".
  const refundShare = side === 'earner' ? earnerRefundShare : refunded;

  // What actually moved, after any partial refund. A refund AFTER capture leaves
  // refunded_cents on the row; the ledger must show the settled number, because
  // that is the one the user is reconciling against their bank.
  const settledGross = Math.max(0, gross - refunded);
  const net = side === 'earner'
    ? Math.max(0, cents(row.earner_amount_cents) - earnerRefundShare) + tip
    : settledGross + tip;

  return {
    id: row.id,
    bookingId: row.booking_id,
    side,
    title: job.title || 'Gig',
    status: row.status,
    // The date the money did its last meaningful thing, which is what a person
    // scanning a statement is looking for.
    at: row.captured_at || row.cancelled_at || row.authorized_at || row.created_at,
    authorizedAt: row.authorized_at || row.created_at,
    capturedAt: row.captured_at,
    cancelledAt: row.cancelled_at,
    grossCents: gross,
    feeCents: fee,
    feeBps,
    feeLabel: feeLabel(feeBps),
    tipCents: tip,
    refundedCents: refunded,
    refundShareCents: refundShare,
    refundedAt: row.refunded_at,
    refundReason: row.refund_reason,
    discountCents: cents(row.poster_discount_cents),
    feeCreditCents: cents(row.fee_credit_cents),
    netCents: net,
    // Only a released payment is money that has actually moved.
    settled: row.status === 'captured',
    pending: row.status === 'authorized',
  };
}

/**
 * Every payment the signed-in user is a party to, newest first.
 *
 * Two queries rather than one: RLS exposes a payment through either the earner
 * policy or the poster policy, and a single select cannot tell us WHICH side the
 * reader is on — that is the difference between "you earned $54" and "you paid
 * $60". So each side is fetched against its own booking set.
 */
export async function fetchLedger(userId) {
  if (!userId) return [];

  const [asEarner, asPoster] = await Promise.all([
    supabase.from('bookings').select('id, job_id, tip_amount').eq('earner_id', userId),
    supabase
      .from('bookings')
      .select('id, job_id, tip_amount, jobs!bookings_job_id_fkey!inner(id, title, poster_id)')
      .eq('jobs.poster_id', userId),
  ]);

  // ⚠️ CHECK BOTH. `?? []` on an errored response turns a failed read into "you have
  // no transactions" — and this screen's whole job is answering "where is my money".
  // An earner whose booking query 500s would have been shown an authoritative empty
  // statement rather than the error card the screen already has. The payments query
  // below has always thrown; these two silently did not.
  if (asEarner.error) throw asEarner.error;
  if (asPoster.error) throw asPoster.error;

  const earnerBookings = asEarner.data ?? [];
  const posterBookings = asPoster.data ?? [];
  const sideOf = {};
  earnerBookings.forEach((b) => { sideOf[b.id] = 'earner'; });
  posterBookings.forEach((b) => { sideOf[b.id] = 'poster'; });

  const bookingsById = {};
  [...earnerBookings, ...posterBookings].forEach((b) => { bookingsById[b.id] = b; });
  const ids = Object.keys(sideOf);
  if (!ids.length) return [];

  // Titles: the poster query already embedded them; the earner side needs a lookup.
  const jobsById = {};
  posterBookings.forEach((b) => { if (b.jobs) jobsById[b.jobs.id] = b.jobs; });
  const missing = [...new Set(earnerBookings.map((b) => b.job_id).filter((j) => j && !jobsById[j]))];
  if (missing.length) {
    const { data } = await supabase.from('jobs').select('id, title').in('id', missing);
    (data ?? []).forEach((j) => { jobsById[j.id] = j; });
  }

  const { data: rows, error } = await supabase
    .from('payments')
    .select(
      'id, booking_id, amount_cents, fee_cents, earner_amount_cents, status, ' +
      'authorized_at, captured_at, cancelled_at, created_at, ' +
      'refunded_cents, refunded_at, refund_reason, fee_bps, fee_credit_cents, poster_discount_cents',
    )
    .in('booking_id', ids)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (rows ?? [])
    .map((r) => toEntry(r, sideOf[r.booking_id], jobsById, bookingsById))
    .filter((e) => e.side)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

// ── Bank deposits ───────────────────────────────────────────────────────────
// The last leg. Capture is a destination charge, so money reaches the earner's
// Stripe account immediately and Stripe pays out to their bank on its own schedule.
// stripe_payouts is filled by the payout.* webhook events; this reads OUR table
// rather than calling Stripe, so a screen people open when they are anxious about
// money never waits on a third party or shows nothing during an outage.
export const PAYOUT_STATE = {
  paid:       { label: 'In your bank',  tone: 'good',  verb: 'Arrived' },
  in_transit: { label: 'On its way',    tone: 'hold',  verb: 'Expected' },
  pending:    { label: 'Scheduled',     tone: 'hold',  verb: 'Expected' },
  failed:     { label: 'Failed',        tone: 'bad',   verb: 'Failed' },
  canceled:   { label: 'Cancelled',     tone: 'muted', verb: 'Cancelled' },
};

export function payoutState(status) {
  return PAYOUT_STATE[status] ?? { label: status || 'unknown', tone: 'muted', verb: '' };
}

/** This user's bank deposits, newest first. */
export async function fetchPayouts(userId, limit = 20) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('stripe_payouts')
    .select('id, payout_id, amount_cents, currency, status, arrival_date, failure_message, created_at')
    .eq('user_id', userId)
    .order('arrival_date', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((p) => ({
    id: p.id,
    amountCents: p.amount_cents,
    status: p.status,
    // Estimated while pending, actual once paid — Stripe overwrites it on payout.paid.
    arrivalAt: p.arrival_date,
    createdAt: p.created_at,
    failureMessage: p.failure_message,
    ...payoutState(p.status),
  }));
}

/** Year-to-date rollup for one side. `held` is the number people actually chase. */
export function summarize(entries, side, year) {
  const y = year ?? new Date().getFullYear();
  const mine = entries.filter((e) => e.side === side && new Date(e.at ?? 0).getFullYear() === y);
  return {
    year: y,
    count: mine.filter((e) => e.settled).length,
    settledCents: mine.filter((e) => e.settled).reduce((s, e) => s + e.netCents, 0),
    heldCents: mine.filter((e) => e.pending).reduce((s, e) => s + e.netCents, 0),
    feesCents: side === 'earner' ? mine.filter((e) => e.settled).reduce((s, e) => s + e.feeCents, 0) : 0,
    refundedCents: mine.reduce((s, e) => s + (e.refundShareCents ?? e.refundedCents), 0),
  };
}

// ── Filtering ───────────────────────────────────────────────────────────────
// A statement you cannot slice is a list, not a statement. The ranges below are
// the ones people actually ask for: a tax year, a recent window, and everything.
export const RANGES = [
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'ytd', label: 'This year' },
  { key: 'last', label: 'Last year' },
  { key: 'all', label: 'All time' },
];

/** [start, end) for a range key. Nulls mean unbounded. */
export function rangeBounds(key, now = new Date()) {
  const r = RANGES.find((x) => x.key === key);
  if (!r || key === 'all') return { start: null, end: null };
  if (r.days) {
    const s = new Date(now);
    s.setDate(s.getDate() - r.days);
    return { start: s, end: null };
  }
  const y = now.getFullYear() - (key === 'last' ? 1 : 0);
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
}

// Status groupings in the user's terms, not Stripe's. "Refunded" is not a status
// on the row at all — it is a non-zero refunded_cents on an otherwise captured
// payment — but it is absolutely a thing people filter for.
export const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'held', label: 'In escrow', match: (e) => e.pending },
  { key: 'settled', label: 'Completed', match: (e) => e.settled && !e.refundedCents },
  { key: 'refunded', label: 'Refunded', match: (e) => e.refundedCents > 0 },
  { key: 'failed', label: 'Declined', match: (e) => e.status === 'failed' },
  { key: 'cancelled', label: 'Cancelled', match: (e) => e.status === 'cancelled' },
];

export function filterEntries(entries, { side, range = 'ytd', status = 'all', query = '' } = {}) {
  const { start, end } = rangeBounds(range);
  const q = query.trim().toLowerCase();
  const st = STATUS_FILTERS.find((s) => s.key === status);
  return entries.filter((e) => {
    if (side && e.side !== side) return false;
    const t = e.at ? new Date(e.at) : null;
    if (start && (!t || t < start)) return false;
    if (end && (!t || t >= end)) return false;
    if (st?.match && !st.match(e)) return false;
    if (q && !String(e.title ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * Everything worth knowing about a filtered set, computed once.
 *
 * Deliberately reports gross AND net AND what came out in between, because "why is
 * this $54 when the gig was $60" is a support ticket the screen should answer by
 * itself. `avg` uses settled transactions only — averaging in a cancelled booking
 * would quietly drag it toward zero.
 */
export function stats(entries) {
  const settled = entries.filter((e) => e.settled);
  const grossCents = settled.reduce((s, e) => s + e.grossCents, 0);
  const netCents = settled.reduce((s, e) => s + e.netCents, 0);
  return {
    count: entries.length,
    settledCount: settled.length,
    grossCents,
    netCents,
    heldCents: entries.filter((e) => e.pending).reduce((s, e) => s + e.netCents, 0),
    feesCents: settled.reduce((s, e) => s + e.feeCents, 0),
    tipsCents: settled.reduce((s, e) => s + e.tipCents, 0),
    refundedCents: entries.reduce((s, e) => s + (e.refundShareCents ?? e.refundedCents), 0),
    discountCents: entries.reduce((s, e) => s + e.discountCents, 0),
    declinedCount: entries.filter((e) => e.status === 'failed').length,
    avgCents: settled.length ? Math.round(netCents / settled.length) : 0,
  };
}

/** Trailing-N-month totals for a trend strip. Empty months are kept — a gap is data. */
export function monthlyTotals(entries, months = 6, now = new Date()) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const cents = entries
      .filter((e) => e.settled && e.at && new Date(e.at) >= d && new Date(e.at) < next)
      .reduce((s, e) => s + e.netCents, 0);
    out.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: 'short' }), cents });
  }
  return out;
}

/** Group into month buckets for a statement-style list. */
export function byMonth(entries) {
  const out = [];
  const seen = {};
  entries.forEach((e) => {
    const d = new Date(e.at ?? 0);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!seen[key]) {
      seen[key] = { key, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), data: [] };
      out.push(seen[key]);
    }
    seen[key].data.push(e);
  });
  return out;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  // Neutralize spreadsheet formula injection: a gig titled "=HYPERLINK(...)" must
  // land in Excel as text, not as a live formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** A statement the user can hand to an accountant, or reconcile against a bank feed. */
export function ledgerCsv(entries, side) {
  const money = (c) => (c / 100).toFixed(2);
  const head = side === 'earner'
    ? ['Date', 'Gig', 'Status', 'Gross', 'Platform fee', 'Fee rate', 'Tip', 'Refunded', 'Net to you']
    : ['Date', 'Gig', 'Status', 'Charged', 'Tip', 'Discount', 'Refunded', 'Total'];
  const lines = [head.map(csvCell).join(',')];
  entries.filter((e) => e.side === side).forEach((e) => {
    const st = paymentState(e.status, side).label;
    const d = e.at ? new Date(e.at).toISOString().slice(0, 10) : '';
    const row = side === 'earner'
      ? [d, e.title, st, money(e.grossCents), money(e.feeCents), e.feeLabel, money(e.tipCents), money(e.refundShareCents ?? e.refundedCents), money(e.netCents)]
      : [d, e.title, st, money(e.grossCents), money(e.tipCents), money(e.discountCents), money(e.refundShareCents ?? e.refundedCents), money(e.netCents)];
    lines.push(row.map(csvCell).join(','));
  });
  return lines.join('\n');
}


/**
 * The receipt line items for one ledger entry.
 *
 * Lives here, not in the screen, because it is arithmetic about money and it must be
 * assertable: __tests__/ledger.test.js requires the signed line values to SUM to the
 * printed total for every shape.
 *
 * ── WHY IT IS DERIVED RATHER THAN READ ──────────────────────────────────────
 *
 * Every promotion benefit is already baked into the persisted columns:
 *   amount_cents is net of the poster discount, fee_cents is net of the fee credit.
 * The screen used to render those columns AND a separate "Discount −$X" / "Fee credit
 * +$Y" line, applying each benefit twice — so the items disagreed with the total on the
 * one screen where a user checks whether their incentive worked.
 *
 * Deriving the fee from (gig value − payout) makes the lines sum by construction instead
 * of by three stored columns happening to agree.
 */
export function receiptLines(entry) {
  if (!entry) return { lines: [], totalCents: 0, totalLabel: '' };
  const isEarner = entry.side === 'earner';
  const c = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const gross = c(entry.grossCents);
  const discount = c(entry.discountCents);
  const tip = c(entry.tipCents);
  // The share that came off THIS side, not the gross refund — see toEntry. Falls back
  // to refundedCents so an entry built by older code still renders.
  const refunded = c(entry.refundShareCents ?? entry.refundedCents);
  const net = c(entry.netCents);
  const bps = typeof entry.feeBps === 'number' ? entry.feeBps : DEFAULT_FEE_BPS;

  // What the work was worth, before any poster-side discount.
  const gigTotal = gross + discount;

  if (!isEarner) {
    return {
      totalLabel: 'Total charged',
      totalCents: net,
      lines: [
        { key: 'gross', label: 'Gig total', cents: gigTotal },
        discount > 0 && { key: 'discount', label: 'Discount', cents: -discount, good: true },
        tip > 0 && { key: 'tip', label: 'Tip', cents: tip, dim: true },
        refunded > 0 && { key: 'refund', label: 'Refunded to you', cents: -refunded, good: true },
      ].filter(Boolean),
    };
  }

  // The fee is whatever separates the gig's value from the payout.
  const payoutBeforeExtras = net - tip + refunded;
  const earnerFee = Math.max(0, gigTotal - payoutBeforeExtras);
  // Split it back so the credit stays VISIBLE without being counted twice.
  const grossFee = Math.max(earnerFee, platformFeeCents(gigTotal, bps));
  const creditApplied = Math.max(0, grossFee - earnerFee);
  // null when the Stripe-cost floor set the fee rather than the percentage. Printing
  // "0%" beside a $3.45 charge is wrong, and a 0-bps promotion makes that reachable.
  const rate = effectiveFeeLabel(gigTotal, bps);

  return {
    totalLabel: 'Your payout',
    totalCents: net,
    lines: [
      { key: 'gross', label: 'Gig total', cents: gigTotal },
      grossFee > 0 && {
        key: 'fee', label: rate ? `Platform fee (${rate})` : 'Platform fee', cents: -grossFee, dim: true,
      },
      creditApplied > 0 && { key: 'credit', label: 'Fee credit applied', cents: creditApplied, good: true },
      tip > 0 && { key: 'tip', label: 'Tip', cents: tip, good: true },
      // "Your share of" is doing real work: the poster was refunded more than this.
      // The earner never held the platform fee, so only their part of the capture
      // comes back out of their payout.
      refunded > 0 && { key: 'refund', label: 'Your share of the refund', cents: -refunded, dim: true },
    ].filter(Boolean),
  };
}
