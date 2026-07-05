"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function resolveReport(formData: FormData): Promise<ActionResult> {
  const reportId = String(formData.get("reportId") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim() || "reviewed";
  if (!reportId) return { ok: false, message: "Missing report id." };

  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { error } = await ctx.service
      .from("reports")
      .update({ resolved_at: new Date().toISOString(), resolved_by: ctx.user.id, resolution })
      .eq("id", reportId);
    if (error) throw new Error(error.message);
    await audit(ctx, "report.resolve", "report", reportId, { resolution });
    revalidatePath("/moderation");
    return { ok: true, message: "Resolved." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function reopenReport(formData: FormData): Promise<ActionResult> {
  const reportId = String(formData.get("reportId") ?? "");
  if (!reportId) return { ok: false, message: "Missing report id." };
  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { error } = await ctx.service
      .from("reports")
      .update({ resolved_at: null, resolved_by: null, resolution: null })
      .eq("id", reportId);
    if (error) throw new Error(error.message);
    await audit(ctx, "report.reopen", "report", reportId);
    revalidatePath("/moderation");
    return { ok: true, message: "Reopened." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
