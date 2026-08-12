"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Acknowledging a finding is NOT the same as it going away. run_control() auto-resolves
// anything the check stops returning, so a finding closed here while the underlying
// condition still holds will simply re-open on the next sweep — deliberately. The only
// way to clear a real violation permanently is to fix the thing.
//
// That makes this action narrower than it looks: it is for findings you have judged
// benign or already handled out of band, and it REQUIRES a note, because a queue full
// of silently-closed findings is indistinguishable from a queue nobody read.
export async function resolveFinding(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("findingId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!id) return { ok: false, message: "Missing finding id." };
  if (!note) return { ok: false, message: "Say why you are closing this — it re-opens on the next sweep if the condition still holds." };

  try {
    const ctx = await requireAdmin("support");
    const { data: before } = await ctx.service
      .from("control_findings")
      .select("control_key, entity_id, severity")
      .eq("id", id)
      .maybeSingle();

    const { error } = await ctx.service
      .from("control_findings")
      .update({ resolved_at: new Date().toISOString(), resolved_by: ctx.user.id, note })
      .eq("id", id)
      .is("resolved_at", null);
    if (error) return { ok: false, message: error.message };

    await audit(ctx, "control_finding.resolve", "control_finding", id, {
      control_key: before?.control_key, entity_id: before?.entity_id, severity: before?.severity, note,
    });
    revalidatePath("/controls");
    return { ok: true, message: "Closed. It will re-open on the next sweep if the condition still holds." };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "Could not close that finding." };
  }
}

// Turning a control off is a real operational lever — a noisy or broken check that
// pages every hour trains people to ignore the channel. It is admin-only and audited
// because a disabled control is a blind spot, and a blind spot nobody chose is how
// this whole class of failure starts.
export async function setControlEnabled(formData: FormData): Promise<ActionResult> {
  const key = String(formData.get("key") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "1";
  if (!key) return { ok: false, message: "Missing control key." };

  try {
    const ctx = await requireAdmin("admin");
    const { error } = await ctx.service.from("controls").update({ enabled }).eq("key", key);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, enabled ? "control.enable" : "control.disable", "control", key, { enabled });
    revalidatePath("/controls");
    return { ok: true, message: enabled ? `${key} enabled.` : `${key} disabled — you are no longer being told about this.` };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "Could not change that control." };
  }
}

// Run the sweep now, without waiting for the hourly cron. Useful right after fixing
// something, to confirm the finding actually clears rather than assuming it did.
export async function runSweepNow(): Promise<ActionResult> {
  try {
    const ctx = await requireAdmin("support");
    const { error } = await ctx.service.rpc("run_all_controls");
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "control.sweep", "control", "*", {});
    revalidatePath("/controls");
    return { ok: true, message: "Sweep complete." };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "Could not run the sweep." };
  }
}
