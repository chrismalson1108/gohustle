"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
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
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
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
    const { error } = await ctx.service
      .from("bookings")
      .update({ status: "confirmed", earner_done: false, poster_done: false })
      .eq("id", bookingId);
    if (error) throw new Error(error.message);
    return { was: b.status, __message: "Re-opened as confirmed. Both done-flags cleared." };
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
      .from("bookings").select("status").eq("id", bookingId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!b) throw new Error("Booking not found.");
    if (b.status === "verified") {
      throw new Error("This booking is already settled — refund it instead of cancelling.");
    }

    // Release the escrow hold FIRST. Cancelling the booking while an authorization is
    // still live would leave the poster's card holding funds against a gig that no
    // longer exists, and nothing else in the system would ever release it.
    let holdNote = "no open hold to release";
    const { data: pay } = await ctx.service
      .from("payments").select("status").eq("booking_id", bookingId).maybeSingle();
    if (pay?.status === "authorized") {
      const { ok, body } = await callPaymentAction({ bookingId, op: "release_hold", reason });
      if (!ok) throw new Error(`Could not release the escrow hold: ${body.message ?? body.error}. Booking NOT cancelled.`);
      holdNote = "escrow hold released";
    }

    const { error } = await ctx.service.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
    if (error) throw new Error(`Hold released but the booking update failed: ${error.message}`);
    return { was: b.status, hold: holdNote, __message: `Cancelled — ${holdNote}.` };
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
    if (!ok) throw new Error(String(body.message ?? body.error ?? "Release failed."));
    return { released_cents: body.released_cents, __message: "Hold released. The poster was never charged." };
  });
}

export async function refundPayment(formData: FormData): Promise<ActionResult> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
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
    const { ok, body } = await callPaymentAction({ bookingId, op: "refund", reason, amountCents });
    if (!ok) throw new Error(String(body.message ?? body.error ?? "Refund failed."));
    const cents = Number(body.refunded_cents ?? 0);
    return {
      refunded_cents: cents,
      refund_id: body.refund_id,
      __message: `Refunded $${(cents / 100).toFixed(2)}. It also reverses the earner's transfer and our platform fee.`,
    };
  });
}
