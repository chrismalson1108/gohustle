"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError, requireFreshAdmin, denyResult } from "@/lib/guard";
import { audit, auditRead } from "@/lib/audit";
import { getServerSupabase } from "@/lib/supabaseServer";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/config";

export interface ActionResult {
  ok: boolean;
  message: string;
}

type Ctx = Awaited<ReturnType<typeof requireAdmin>>;

// Same shape as users/[id]/actions.ts: audit the INTENT before the mutation, record
// the outcome after, best-effort. A failed follow-up row must never report an action
// that already happened as failed.
async function run(
  action: string,
  bookingId: string,
  intent: Record<string, unknown>,
  fn: (ctx: Ctx) => Promise<Record<string, unknown> | void>,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireFreshAdmin("finance");
  } catch (e) {
    if (e instanceof AdminAuthError) return denyResult(e);
    throw e;
  }
  try {
    await audit(ctx, action, "booking", bookingId, intent);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const detail = (await fn(ctx)) ?? {};
    const { __message, ...outcome } = detail as Record<string, unknown> & { __message?: string };
    if (Object.keys(outcome).length > 0) {
      await auditRead(ctx, `${action}.outcome`, "booking", bookingId, outcome);
    }
    revalidatePath(`/bookings/${bookingId}`);
    revalidatePath("/bookings");
    return { ok: true, message: __message ?? "Done." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await auditRead(ctx, `${action}.failed`, "booking", bookingId, { error: msg });
    return { ok: false, message: msg };
  }
}

// Call the admin money function as the signed-in admin. It re-verifies the admin
// role server-side — the console's own check is not evidence to the edge runtime.
async function callPaymentAction(payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const supa = await getServerSupabase();
  const {
    data: { session },
  } = await supa.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-payment-action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
    // A stall here would leave the admin staring at "Working…" with no idea whether
    // money moved. Bounded, and the failure is reported as unknown rather than as "no".
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, body };
}

// admin-payment-action requires the second factor to have been satisfied in the last
// 300s (it issues refunds and voids holds). Surface that as the SAME machine-readable
// string the console's own step-up actions return, so InterventionPanel can show a code
// prompt and retry instead of printing an error nobody can act on. Creating a
// dead-ended denial would be worse than no step-up at all: the operator would conclude
// refunds are broken.
function asStaleMfa(body: Record<string, unknown>): boolean {
  return body?.error === "stale_mfa";
}

// ── Booking lifecycle intervention ──────────────────────────────────────────
// Mutual completion (earner_done AND poster_done) is deliberate and correct, but it
// means a one-sided booking sits forever with nobody at fault while the ~7-day Stripe
// authorization ticks down. guard_bookings_write early-returns for service_role, so
// the console can write these columns directly — the guard is there to constrain
// PARTIES, not operators.

export async function forceComplete(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required — it's the only record of why." };

  return run("booking.force_complete", bookingId, { reason }, async (ctx) => {
    const { data: b, error: readErr } = await ctx.service
      .from("bookings").select("status, earner_done, poster_done").eq("id", bookingId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!b) throw new Error("Booking not found.");
    if (!["confirmed", "completed"].includes(b.status)) {
      throw new Error(`A "${b.status}" booking can't be force-completed.`);
    }
    const { error } = await ctx.service
      .from("bookings")
      .update({ earner_done: true, poster_done: true, status: "completed" })
      .eq("id", bookingId);
    if (error) throw new Error(error.message);
    return {
      was: { status: b.status, earner_done: b.earner_done, poster_done: b.poster_done },
      __message:
        "Marked complete on both sides. This does NOT capture the money — verify the booking or refund it separately.",
    };
  });
}

export async function reopenBooking(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required." };

  return run("booking.reopen", bookingId, { reason }, async (ctx) => {
    const { data: b, error: readErr } = await ctx.service
      .from("bookings").select("status").eq("id", bookingId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!b) throw new Error("Booking not found.");
    // 'verified' is terminal because money has been captured against it. Re-opening
    // one would leave a settled payment attached to an unsettled booking.
    if (b.status === "verified") {
      throw new Error("A verified booking has already been paid out — refund it instead of re-opening.");
    }
    // The panel disables this for a cancelled booking, but client-side disabling is
    // cosmetic — a crafted POST reaches the action directly. Re-opening a cancelled
    // booking would resurrect it with no escrow behind it (the hold was released on
    // cancel), so the earner would work against nothing.
    if (b.status === "cancelled") {
      throw new Error("This booking was cancelled and its hold released — re-opening it would leave no escrow behind the work.");
    }
    // ── The SAME reasoning, applied to every other status ────────────────────
    // The line above states the invariant and then only checks one status for it.
    // 'confirmed' means "a real Stripe authorization is behind this work" — that is
    // the whole reason accept-booking exists as a service-role edge function rather
    // than a client write, and guard_bookings_write early-returns for service_role, so
    // nothing in the database re-checks it for us here.
    //
    // A 'pending' booking has no hold yet (it is minted when the poster accepts) and a
    // 'declined' one either never had a hold or had it voided by stripe-cancel-payment
    // — both are the shape the cancelled branch refuses, and the panel enabled Re-open
    // for both. So ask the payments row instead of the booking status, and FAIL CLOSED:
    // no row is the pending case and is exactly as unfunded as a voided one.
    //
    // The intended use is unaffected: Re-open's job is undoing a one-sided or forced
    // 'completed', and capture only happens at verify, so those rows are 'authorized'.
    const { data: pay, error: payErr } = await ctx.service
      .from("payments").select("status").eq("booking_id", bookingId).maybeSingle();
    if (payErr) {
      throw new Error(
        `Couldn't check whether this booking still has an escrow hold (${payErr.message}). Nothing was changed — retry in a moment.`,
      );
    }
    if (pay?.status !== "authorized") {
      throw new Error(
        `There is no live escrow hold behind this booking (${pay ? `the payment is "${pay.status}"` : "no payment row"}), so re-opening it would put the earner back to work against nothing. ` +
          "The poster has to accept it again — that is what places the hold.",
      );
    }
    const { error } = await ctx.service
      .from("bookings")
      .update({ status: "confirmed", earner_done: false, poster_done: false })
      .eq("id", bookingId);
    if (error) throw new Error(error.message);
    return { was: b.status, hold: pay.status, __message: "Re-opened as confirmed. Both done-flags cleared." };
  });
}

export async function clearStartedAt(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required." };

  return run("booking.clear_started", bookingId, { reason }, async (ctx) => {
    // started_at ("I'm on site") permanently locks cancellation for both parties via
    // trg_guard_started_booking_cancel. A mis-tap therefore traps a booking forever
    // with no in-app escape — this is the only way out.
    const { error } = await ctx.service.from("bookings").update({ started_at: null }).eq("id", bookingId);
    if (error) throw new Error(error.message);
    return { __message: "Cleared. Both parties can cancel again." };
  });
}

export async function forceCancel(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required." };

  return run("booking.force_cancel", bookingId, { reason }, async (ctx) => {
    const { data: b, error: readErr } = await ctx.service
      .from("bookings").select("status, started_at").eq("id", bookingId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!b) throw new Error("Booking not found.");
    if (b.status === "verified") {
      throw new Error("This booking is already settled — refund it instead of cancelling.");
    }

    // FAIL CLOSED. Dropping this error meant a timed-out lookup read as "no hold",
    // and the booking was cancelled while a live authorization stayed on the
    // poster's card with nothing left in the system that would ever release it.
    const { data: pay, error: payErr } = await ctx.service
      .from("payments").select("status").eq("booking_id", bookingId).maybeSingle();
    if (payErr) {
      throw new Error(
        `Couldn't check whether this booking has an escrow hold (${payErr.message}). Nothing was changed — retry in a moment.`,
      );
    }
    // A captured payment is money already taken. Cancelling the booking around it
    // would leave a settled charge attached to a cancelled gig, and the poster with
    // no refund — refund first, deliberately, then cancel.
    if (pay?.status === "captured") {
      throw new Error(
        "This booking's payment is already CAPTURED — the poster has been charged. Refund it first, then cancel.",
      );
    }

    // ── A LIVE ADJUSTMENT STOPS THIS BEFORE ANY WRITE ────────────────────────
    //
    // Force cancel is the THIRD hold-touching operation, and it did not get the guard
    // `settle` and `release_hold` got. The ordering below is deliberate and correct in
    // every other case, but over a live dispute it produced the one state neither order
    // protects against: the booking write succeeds, `release_hold` is then refused by
    // admin-payment-action's `dispute_open`, and the operator is told to press a button
    // that will refuse them too. Cancelled booking, live authorization, live dispute, and
    // settle-disputes still holding a row against a booking that no longer exists as work.
    //
    // So the check moves ahead of both writes. Same predicate as the edge function's, and
    // FAIL CLOSED for the same reason: an unreadable disputes table is not evidence that
    // there is no dispute.
    const { data: liveDispute, error: dispErr } = await ctx.service
      .from("disputes")
      .select("id, proposed_pct, response_stance")
      .eq("booking_id", bookingId)
      .is("pct_paid", null)
      .not("proposed_pct", "is", null)
      .maybeSingle();
    if (dispErr) {
      throw new Error(
        `Couldn't check whether this booking has a live payment adjustment (${dispErr.message}). ` +
          `Nothing was changed — retry in a moment.`,
      );
    }
    if (liveDispute) {
      throw new Error(
        `This booking has a live payment adjustment (${liveDispute.proposed_pct}% proposed` +
          `${liveDispute.response_stance ? `, the worker ${liveDispute.response_stance}ed` : ", awaiting the worker"}). ` +
          `Cancelling would void the hold the adjustment is meant to pay from, and the worker would ` +
          `become unpayable. Decide it at /disputes/${liveDispute.id} first — the hourly sweep then ` +
          `settles it at the agreed amount. Nothing was changed.`,
      );
    }

    // ── The GUARDED booking write FIRST, the irreversible Stripe call SECOND ──
    // This used to void the hold first, so that a cancelled gig never left funds held.
    // But the bookings write can REFUSE: trg_guard_started_booking_cancel raises on
    // `new.status = 'cancelled' and old.started_at is not null`, i.e. on every booking
    // where the earner tapped "I'm on site". So the authorization was voided at Stripe,
    // the write then raised, and the booking stayed confirmed/completed and LIVE for
    // both parties with nothing behind it — capture, settle and the earner's own claim
    // all impossible from that moment on.
    //
    // Both orders can strand something, so strand the RECOVERABLE half. A cancelled
    // booking with a live hold is caught by ctl_money_exposed_on_dead_booking
    // ('hold_never_released', 6h), is fixed by the "Release hold" button right here, and
    // expires at Stripe in ~7 days regardless. A live booking with a dead hold is
    // watched by NO control — ctl_settled_without_captured_payment only looks for a
    // confirmed/completed booking with no payments row at all, and this one has a row.
    // JobsContext.cancelBooking already writes in this order, for this reason.
    const { error } = await ctx.service.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
    if (error) {
      throw new Error(
        `${error.message} Nothing was changed and no money moved.` +
          (b.started_at
            ? ` The earner marked "I'm on site" — clear "started" first if you still mean to cancel.`
            : ""),
      );
    }

    let holdNote = "no open hold to release";
    if (pay?.status === "authorized") {
      const { ok, body } = await callPaymentAction({ bookingId, op: "release_hold", reason });
      if (!ok && asStaleMfa(body)) throw new Error("stale_mfa");
      if (!ok) {
        throw new Error(
          `The booking is CANCELLED but the escrow hold could NOT be released: ${body.message ?? body.error}. ` +
            `The poster's card is still authorized — press "Release hold" now.`,
        );
      }
      holdNote = "escrow hold released";
    }
    return { was: b.status, started_at: b.started_at, hold: holdNote, __message: `Cancelled — ${holdNote}.` };
  });
}

// ── Money ───────────────────────────────────────────────────────────────────

export async function releaseHold(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required." };

  return run("payment.release_hold", bookingId, { reason }, async () => {
    const { ok, body } = await callPaymentAction({ bookingId, op: "release_hold", reason });
      if (!ok && asStaleMfa(body)) throw new Error("stale_mfa");
    if (!ok) throw new Error(String(body.message ?? body.error ?? "Release failed."));
    return { released_cents: body.released_cents, __message: "Hold released. The poster was never charged." };
  });
}

// The lever support was already being told to use.
//
// A gig posted with the "Flexible — Contact to Schedule" slot carries no starts_at, so
// shared/lifecycle returns false, EarnScreen renders no Claim button, and
// earner-claim-payment refuses with NO_SCHEDULE telling the worker to contact support to
// settle it. Support had no way to settle anything: the console offered release (nobody
// paid), refund (poster paid, then unpaid) and record-chargeback — no capture. So the
// worker's money sat until Stripe voided the hold at ~7 days and they were paid nothing
// for work they did.
//
// FULL capture only. A reduced settlement is a dispute outcome and belongs to the poster's
// own Verify sheet, which records a disputes row naming who asked for it.
export async function settleHold(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required." };

  return run("payment.settle", bookingId, { reason }, async () => {
    const { ok, body } = await callPaymentAction({ bookingId, op: "settle", reason });
    if (!ok && asStaleMfa(body)) throw new Error("stale_mfa");
    if (!ok) throw new Error(String(body.message ?? body.error ?? "Settle failed."));
    const cents = Number(body.captured_cents ?? 0);
    const earner = Number(body.earner_cents ?? 0);
    return {
      captured_cents: cents,
      __message:
        `Charged the poster $${(cents / 100).toFixed(2)} and credited the earner ` +
        `$${(earner / 100).toFixed(2)}. The booking is now verified.`,
    };
  });
}

// For a chargeback we LOST: the money is already gone from the platform balance and
// Stripe refuses a refund on a disputed charge, so the ledger has to be told directly.
export async function recordReversal(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A reason is required (e.g. 'chargeback lost, case dp_123')." };

  return run("payment.record_reversal", bookingId, { reason }, async () => {
    const { ok, body } = await callPaymentAction({ bookingId, op: "record_reversal", reason });
      if (!ok && asStaleMfa(body)) throw new Error("stale_mfa");
    if (!ok) throw new Error(String(body.message ?? body.error ?? "Failed."));
    const cents = Number(body.refunded_cents ?? 0);
    return {
      reversed_cents: cents,
      // WHAT IT ACTUALLY DOES. This said "GMV, fees and the earner's earnings now reflect
      // it" — but the edge function passes `p_debit_earner: false` on purpose
      // (20260813160000: the platform absorbs a destination-charge reversal), so the
      // earner's earnings are deliberately untouched. Describing the opposite of what the
      // button does, on the money action with the fewest undo paths, is how an operator
      // reconciles the wrong side.
      __message: `Recorded $${(cents / 100).toFixed(2)} as reversed. GMV and platform fees now reflect it. The earner's earnings are deliberately NOT reduced — the platform absorbs a destination-charge reversal — so if the money was genuinely recovered from them, reconcile that separately. No Stripe call was made; the money already moved.`,
    };
  });
}

export async function refundPayment(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  // Stable across retries of the SAME composed attempt (the panel rotates it only on
  // success), so admin-payment-action can key Stripe's idempotency on operator intent
  // instead of on our running refunded_cents — which moves the moment attempt 1 commits
  // and made the retry issue a second REAL refund.
  const requestId = String(formData.get("requestId") ?? "").trim();
  if (!bookingId) return { ok: false, message: "Missing booking id." };
  if (!reason) return { ok: false, message: "A refund reason is required." };

  // Blank = refund everything still refundable. Otherwise dollars -> cents.
  let amountCents: number | null = null;
  if (amountRaw) {
    const n = Number(amountRaw);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, message: "Enter a valid refund amount in dollars." };
    amountCents = Math.round(n * 100);
  }

  return run("payment.refund", bookingId, { reason, amount_cents: amountCents }, async () => {
    const { ok, body } = await callPaymentAction({ bookingId, op: "refund", reason, amountCents, requestId });
      if (!ok && asStaleMfa(body)) throw new Error("stale_mfa");
    if (!ok) throw new Error(String(body.message ?? body.error ?? "Refund failed."));
    const cents = Number(body.refunded_cents ?? 0);
    return {
      refunded_cents: cents,
      refund_id: body.refund_id,
      __message: `Refunded $${(cents / 100).toFixed(2)}. It also reverses the earner's transfer and our platform fee.`,
    };
  });
}
