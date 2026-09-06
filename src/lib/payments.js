// ─────────────────────────────────────────────────────────────────────────────
// The money ledger, mobile side — the two Supabase reads and nothing else.
//
// `payments` has always held enough for a real statement (authorized/captured/
// failed/cancelled, fee, net, refunds, timestamps, and the fee rate PINNED at
// booking time) and RLS already lets each party read their own rows — earners via
// payments_earner_select, posters via payments_poster_select.
//
// ⚠️ THE ARITHMETIC MOVED. Everything pure — paymentState, settledGrossCents,
// earnerRefundShareCents, toEntry, summarize, filterEntries, stats, monthlyTotals,
// byMonth, ledgerCsv, receiptLines, the payout states — now lives in
// shared/ledger.js and is re-exported below, so this module's public surface is
// unchanged. It moved because the WEBSITE had no ledger at all and porting it would
// have meant a second hand-written copy of money maths whose fee is pinned per
// booking and whose refund split differs by side. CLAUDE.md's rule covers exactly
// this: shared/ is the single source, logic goes there rather than into one client.
// Edit shared/ledger.js, not a copy.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';
import { toEntry } from '../../shared/ledger';

export * from '../../shared/ledger';

export const LEDGER_CACHE_KEY = 'ledger:v1';

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
      'refunded_cents, refunded_at, refund_reason, earner_refunded_cents, ' +
      'fee_bps, fee_credit_cents, poster_discount_cents',
    )
    .in('booking_id', ids)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (rows ?? [])
    .map((r) => toEntry(r, sideOf[r.booking_id], jobsById, bookingsById))
    .filter((e) => e.side)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
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

