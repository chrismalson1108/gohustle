"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
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
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
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
      resolution_note: note || null,
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
