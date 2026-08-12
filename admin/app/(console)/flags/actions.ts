"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError, requireFreshAdmin } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Flipping a flag is a platform-wide act — payments off, posting off, the AI
// assistant off. Admin tier only, never support.
export async function setFlag(formData: FormData): Promise<ActionResult> {
  const key = String(formData.get("key") ?? "").trim();
  const enabled = formData.get("enabled") === "true";
  const note = String(formData.get("note") ?? "").trim();
  if (!key) return { ok: false, message: "Missing flag key." };

  let ctx;
  try {
    ctx = await requireFreshAdmin("admin");
  } catch (e) {
    // Surface stale_mfa as its own sentinel so the caller can offer a code prompt and
    // retry. Collapsing it into "Not authorized." — as this did — made every step-up
    // action here a dead end no matter what the UI offered, because the reason the UI
    // keys on never reached it. Genuine denials still read as denials.
    if (e instanceof AdminAuthError) {
      return { ok: false, message: e.reason === "stale_mfa" ? "stale_mfa" : "Not authorized." };
    }
    throw e;
  }

  try {
    // Audit BEFORE the change (the ordering the whole console now follows): if we
    // cannot record who paused payments, we do not pause payments.
    await audit(ctx, enabled ? "flag.enable" : "flag.disable", "flag", key, { note: note || null });

    // Only ever UPDATE a seeded row. A typo'd key must not silently create a flag
    // nothing reads — that would show a switch in the UI that controls nothing,
    // which is worse than having no switch at all.
    const { data, error } = await ctx.service
      .from("app_flags")
      .update({ enabled, updated_by: ctx.user.id, updated_at: new Date().toISOString() })
      .eq("key", key)
      .select("key");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error(`No flag named "${key}". Flags are seeded by migration, not created here.`);
    }

    revalidatePath("/flags");
    return {
      ok: true,
      message: enabled
        ? `${key} is ON — normal behaviour restored.`
        : `${key} is OFF. Users hitting that feature now get a "temporarily paused" message.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
