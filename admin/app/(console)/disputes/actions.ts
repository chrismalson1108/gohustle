"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireFreshAdmin, AdminAuthError, denyResult } from "@/lib/guard";
import { audit, auditRead } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const STATUSES = ["open", "investigating", "resolved", "rejected"] as const;
type Status = (typeof STATUSES)[number];

// Resolving a dispute is not paperwork: earner-claim-payment refuses to settle a
// booking with any OPEN dispute, so until this exists the worker on that booking
// cannot be paid at all. Closing the dispute is what reopens their payout path.
export async function setDisputeStatus(formData: FormData): Promise<ActionResult> {
  const disputeId = String(formData.get("disputeId") ?? "");
  const status = String(formData.get("status") ?? "") as Status;
  const note = String(formData.get("note") ?? "").trim();

  if (!disputeId) return { ok: false, message: "Missing dispute id." };
  if (!STATUSES.includes(status)) return { ok: false, message: "Bad status." };
  // A resolution with no explanation is unreviewable later — by an appeal, by the
  // other party, or by whoever inherits the queue.
  if ((status === "resolved" || status === "rejected") && !note) {
    return { ok: false, message: "Write what you decided and why before closing this." };
  }

  let ctx;
  try {
    ctx = await requireAdmin("trust");
  } catch (e) {
    if (e instanceof AdminAuthError) return denyResult(e);
    throw e;
  }

  // ── Closing must never outrun the money ────────────────────────────────────
  // `resolved_at` is the column earner-claim-payment gates on, and that path captures
  // in FULL. Before the two-party model this was harmless: a dispute row only ever
  // existed AFTER stripe-capture-payment had already partially captured, so there was
  // nothing left to release and closing genuinely only unblocked bookkeeping.
  //
  // Now the poster's tap leaves the authorization standing and settle-disputes captures
  // it later. Closing an unsettled dispute would hand the earner a "claim my payment"
  // button that collects 100% — silently overriding a 70% decision, or pre-empting a
  // proposal the earner never answered. So while the escrow is still held, the way out
  // of this queue is decideDispute, not a status change.
  if (status === "resolved" || status === "rejected") {
    const { data: d } = await ctx.service
      .from("disputes").select("pct_paid, booking_id, proposed_pct").eq("id", disputeId).maybeSingle();
    if (d && d.pct_paid == null) {
      const { data: pay } = await ctx.service
        .from("payments").select("status").eq("booking_id", d.booking_id).maybeSingle();
      if (pay?.status === "authorized") {
        return {
          ok: false,
          message: `The escrow on this booking is still held — closing this would let the earner claim the full amount in-app before any decision is applied. Decide a percentage instead (${d.proposed_pct ?? 100}–100%); that is what releases the money and closes this.`,
        };
      }
    }
  }

  try {
    await audit(ctx, `dispute.${status}`, "dispute", disputeId, { note: note || null });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  try {
    const closing = status === "resolved" || status === "rejected";
    const patch: Record<string, unknown> = {
      status,
      assigned_to: ctx.user.id,
      // Preserve the previous decision when re-opening: nulling it destroyed the only
      // record of why a dispute was closed, which is exactly what an appeal reviews.
      // Only overwrite when the operator actually wrote something.
      ...(note ? { resolution_note: note } : {}),
      // resolved_at is the column earner-claim-payment gates on, so it must track
      // the OPEN/CLOSED distinction exactly — not merely the label.
      resolved_at: closing ? new Date().toISOString() : null,
      resolved_by: closing ? ctx.user.id : null,
    };

    const { data, error } = await ctx.service
      .from("disputes").update(patch).eq("id", disputeId).select("id, booking_id");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error("Dispute not found — it may have been deleted.");

    await auditRead(ctx, `dispute.${status}.outcome`, "dispute", disputeId, { booking_id: data[0].booking_id });
    revalidatePath("/disputes");
    revalidatePath(`/bookings/${data[0].booking_id}`);

    return {
      ok: true,
      message: closing
        ? "Closed. The earner's payout path on this booking is unblocked — they can claim it in-app, or you can settle it from the booking page."
        : `Marked ${status}. The booking stays blocked from self-settlement while this is open.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Decide what percentage this booking settles at.
 *
 * This is the adjudication half of the two-party model: the poster's tap is now a
 * PROPOSAL that leaves the escrow standing, the earner gets 48 hours to accept or
 * contest, and when they contest, nothing moves until this action runs — or until the
 * authorization nears expiry, at which point public.dispute_settlement_pct captures in
 * full rather than let the hold lapse and pay nobody.
 *
 * Three properties, each of them load-bearing:
 *
 *  1. THE FLOOR IS THE POSTER'S OWN ASK. `resolution_pct` is bounded to
 *     [proposed_pct, 100] because a partial capture is irreversible — Stripe releases
 *     the uncaptured remainder to the poster and `stripe.transfers.create` appears
 *     nowhere in this repo, so there is no way to pay an earner MORE afterwards. A full
 *     capture, by contrast, is refundable through admin-payment-action. Adjudication may
 *     therefore only ever move money toward the earner; the other direction is a decision
 *     nobody can walk back, and it is not one the poster even asked for.
 *
 *  2. IT DOES NOT MOVE THE MONEY, AND IT DOES NOT SET resolved_at. The hourly sweep
 *     dispatches settle-disputes, which asks the database for the outcome and captures.
 *     Writing `resolved_at` here would unblock earner-claim-payment BEFORE the decision
 *     was applied — and that path captures in FULL, so a 70% decision would be silently
 *     overridden by the earner tapping "claim my payment" in the app.
 *
 *  3. IT REFUSES A SETTLED DISPUTE, with a CAS on `pct_paid` as well as the read, so a
 *     decision written in the same minute the sweep settles cannot land on a row whose
 *     money has already moved.
 */
export async function decideDispute(formData: FormData): Promise<ActionResult> {
  const disputeId = String(formData.get("disputeId") ?? "");
  const pct = Number(String(formData.get("pct") ?? "").trim());
  const note = String(formData.get("note") ?? "").trim();

  if (!disputeId) return { ok: false, message: "Missing dispute id." };
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    return { ok: false, message: "Enter a whole percentage between 0 and 100." };
  }
  // Both parties' money turns on this, and an appeal reviews the reasoning, not the
  // number. The same rule setDisputeStatus applies to closing.
  if (!note) return { ok: false, message: "Write what you decided and why before applying it — both parties see this note." };

  let ctx;
  try {
    // STEP-UP. This decides how much money moves, which is the guard.ts doctrine's
    // first clause. `trust` is the tier that owns this queue — the same tier
    // setDisputeStatus takes — so gating it at `admin` would re-create exactly the
    // money-harm control trust was created to remove.
    ctx = await requireFreshAdmin("trust");
  } catch (e) {
    if (e instanceof AdminAuthError) return denyResult(e);
    throw e;
  }

  try {
    const { data: d, error: readErr } = await ctx.service
      .from("disputes")
      .select("id, booking_id, proposed_pct, pct_paid, resolution_pct, settle_after, responded_at, response_stance")
      .eq("id", disputeId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!d) return { ok: false, message: "Dispute not found — it may have been deleted." };
    if (d.pct_paid != null) {
      return {
        ok: false,
        message: `Already settled at ${Number(d.pct_paid)}% — the money has moved. Any further adjustment is a refund, from the booking page.`,
      };
    }

    const floor = d.proposed_pct ?? 100;
    if (pct < floor) {
      return {
        ok: false,
        message: `The poster asked to pay ${floor}%, so you can decide ${floor}–100%. Going lower would capture less than either party asked for, and a partial capture cannot be topped up afterwards — Stripe has already returned the remainder to the poster.`,
      };
    }

    await audit(ctx, "dispute.decide", "dispute", disputeId, {
      pct,
      proposed_pct: d.proposed_pct,
      previous_decision: d.resolution_pct,
      response_stance: d.response_stance,
      note,
    });

    const { data, error } = await ctx.service
      .from("disputes")
      .update({
        resolution_pct: pct,
        resolution_note: note,
        assigned_to: ctx.user.id,
        // Deliberately NOT resolved_at / resolved_by / status — settle-disputes stamps
        // those when the capture actually succeeds. A dispute that reads "resolved"
        // while the money is still held is the one state this queue must never show.
      })
      .eq("id", disputeId)
      .is("pct_paid", null)
      .select("id, booking_id");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      return { ok: false, message: "That dispute settled while you were deciding. Reload to see the outcome." };
    }

    revalidatePath("/disputes");
    revalidatePath(`/disputes/${disputeId}`);
    revalidatePath(`/bookings/${data[0].booking_id}`);

    return {
      ok: true,
      message: `Recorded: settle at ${pct}%. The hourly sweep captures it (it runs at :05 past the hour) and tells both parties. Nothing else is needed from you.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
