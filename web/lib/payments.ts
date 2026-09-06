// ─────────────────────────────────────────────────────────────────────────────
// The money ledger, web side — the two Supabase reads, and nothing else.
//
// The website had NO ledger at all until 2026-09-05: no web/lib/payments.ts, no
// /transactions route, and a repo-wide grep of web/ for `.from("…")` listed neither
// `payments` nor `stripe_payouts`. A poster who hired through gohustlr.com and had a
// gig settled at 50% after a dispute could not see what was actually charged, the
// rate pinned for that booking, or the refund line. Meanwhile Hustlr AI — ONE system
// prompt, served identically to the app and to the widget mounted in this app's
// layout — told every user "You → Payments & payouts → Transactions … exportable as
// CSV" and pointed them at "the Bank deposits list on that same screen", while its
// own rule says never invent a screen.
//
// ⚠️ THE ARITHMETIC IS NOT HERE, AND MUST NOT BE COPIED HERE. It lives in
// shared/ledger.js, the same module src/lib/payments.js re-exports, so both clients
// restate a payment identically. Money maths is the last place to keep two copies:
// the fee is PINNED per booking, the refund share differs by side, and a partial
// capture deliberately leaves amount_cents at the full authorization — three rules a
// hand-ported second copy gets wrong in different ways from the first. Only the
// queries differ, because only the client differs.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "./supabaseClient";
import { toEntry, payoutState } from "@gohustlr/shared";

export {
  paymentState,
  payoutState,
  PAYOUT_STATE,
  settledGrossCents,
  earnerRefundShareCents,
  summarize,
  RANGES,
  rangeBounds,
  STATUS_FILTERS,
  filterEntries,
  stats,
  monthlyTotals,
  byMonth,
  ledgerCsv,
  receiptLines,
} from "@gohustlr/shared";

export type LedgerSide = "earner" | "poster";

/** One normalized ledger entry — the shape shared/ledger.js `toEntry` produces. */
export interface LedgerEntry {
  id: string;
  bookingId: string;
  side: LedgerSide;
  title: string;
  status: string;
  at: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  cancelledAt: string | null;
  grossCents: number;
  feeCents: number;
  feeBps: number;
  feeLabel: string;
  tipCents: number;
  refundedCents: number;
  refundShareCents: number;
  refundedAt: string | null;
  refundReason: string | null;
  discountCents: number;
  feeCreditCents: number;
  netCents: number;
  settled: boolean;
  pending: boolean;
}

export interface Deposit {
  id: string;
  amountCents: number;
  status: string;
  arrivalAt: string | null;
  createdAt: string | null;
  failureMessage: string | null;
  label: string;
  tone: string;
  verb: string;
}

interface BookingRow {
  id: string;
  job_id: string | null;
  tip_amount: number | string | null;
  jobs?: { id: string; title: string; poster_id: string } | null;
}

/**
 * Every payment the signed-in user is a party to, newest first.
 *
 * TWO queries rather than one, exactly as the mobile module does it: RLS exposes a
 * payment through either the earner policy or the poster policy, and a single select
 * cannot tell which side the reader is on — that is the difference between "you
 * earned $54" and "you paid $60".
 */
export async function fetchLedger(userId: string | null | undefined): Promise<LedgerEntry[]> {
  if (!userId) return [];

  const [asEarner, asPoster] = await Promise.all([
    supabase.from("bookings").select("id, job_id, tip_amount").eq("earner_id", userId),
    supabase
      .from("bookings")
      .select("id, job_id, tip_amount, jobs!bookings_job_id_fkey!inner(id, title, poster_id)")
      .eq("jobs.poster_id", userId),
  ]);

  // ⚠️ CHECK BOTH. `?? []` on an errored response turns a failed read into "you have
  // no transactions" — and this page's whole job is answering "where is my money".
  if (asEarner.error) throw asEarner.error;
  if (asPoster.error) throw asPoster.error;

  const earnerBookings = (asEarner.data ?? []) as unknown as BookingRow[];
  const posterBookings = (asPoster.data ?? []) as unknown as BookingRow[];

  const sideOf: Record<string, LedgerSide> = {};
  earnerBookings.forEach((b) => { sideOf[b.id] = "earner"; });
  // Poster wins a tie the same way it does on mobile: booking your own gig is blocked
  // by guard_bookings_write, so the two sets cannot legitimately overlap anyway.
  posterBookings.forEach((b) => { sideOf[b.id] = "poster"; });

  const bookingsById: Record<string, BookingRow> = {};
  [...earnerBookings, ...posterBookings].forEach((b) => { bookingsById[b.id] = b; });
  const ids = Object.keys(sideOf);
  if (!ids.length) return [];

  // Titles: the poster query already embedded them; the earner side needs a lookup.
  const jobsById: Record<string, { id: string; title: string }> = {};
  posterBookings.forEach((b) => { if (b.jobs) jobsById[b.jobs.id] = b.jobs; });
  const missing = [
    ...new Set(earnerBookings.map((b) => b.job_id).filter((j): j is string => Boolean(j) && !jobsById[j as string])),
  ];
  if (missing.length) {
    const { data } = await supabase.from("jobs").select("id, title").in("id", missing);
    ((data ?? []) as { id: string; title: string }[]).forEach((j) => { jobsById[j.id] = j; });
  }

  const { data: rows, error } = await supabase
    .from("payments")
    .select(
      "id, booking_id, amount_cents, fee_cents, earner_amount_cents, status, " +
        "authorized_at, captured_at, cancelled_at, created_at, " +
        "refunded_cents, refunded_at, refund_reason, earner_refunded_cents, " +
        "fee_bps, fee_credit_cents, poster_discount_cents",
    )
    .in("booking_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw error;

  return ((rows ?? []) as unknown as { booking_id: string }[])
    .map(
      (r) =>
        toEntry(
          r as unknown as Record<string, unknown>,
          sideOf[r.booking_id],
          jobsById,
          bookingsById as unknown as Record<string, Record<string, unknown>>,
        ) as unknown as LedgerEntry,
    )
    .filter((e) => e.side)
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

/**
 * This user's bank deposits, newest first.
 *
 * Reads OUR table rather than calling Stripe, so a page people open when they are
 * anxious about money never waits on a third party or shows nothing during an outage.
 * It deliberately does NOT claim which gig is in which deposit — Stripe batches many
 * transfers into one payout.
 */
export async function fetchPayouts(userId: string | null | undefined, limit = 20): Promise<Deposit[]> {
  if (!userId) return [];
  const { data, error } = await supabase
    .from("stripe_payouts")
    .select("id, payout_id, amount_cents, currency, status, arrival_date, failure_message, created_at")
    .eq("user_id", userId)
    .order("arrival_date", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as {
    id: string;
    amount_cents: number;
    status: string;
    arrival_date: string | null;
    failure_message: string | null;
    created_at: string | null;
  }[]).map((p) => ({
    id: p.id,
    amountCents: p.amount_cents,
    status: p.status,
    // Estimated while pending, actual once paid — Stripe overwrites it on payout.paid.
    arrivalAt: p.arrival_date,
    createdAt: p.created_at,
    failureMessage: p.failure_message,
    ...(payoutState(p.status) as { label: string; tone: string; verb: string }),
  }));
}
