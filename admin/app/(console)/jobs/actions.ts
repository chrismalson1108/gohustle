"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Take a listing down (soft-delete = status 'cancelled', same as the poster's
// own delete). Service role bypasses guard_jobs_write. Audited.
export async function setJobStatus(formData: FormData): Promise<ActionResult> {
  const jobId = String(formData.get("jobId") ?? "");
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!jobId || !["cancelled", "open"].includes(status)) return { ok: false, message: "Bad request." };

  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { error } = await ctx.service.from("jobs").update({ status }).eq("id", jobId);
    if (error) throw new Error(error.message);
    await audit(ctx, status === "cancelled" ? "job.takedown" : "job.restore", "job", jobId, { reason: reason || undefined });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    return { ok: true, message: status === "cancelled" ? "Taken down." : "Restored." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
