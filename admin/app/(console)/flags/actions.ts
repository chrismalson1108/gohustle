"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError, requireFreshAdmin } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { guideFor } from "./guide";

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

  const guide = guideFor(key);

  // A config row's `enabled` bit is read by NOTHING (see guide.ts). Toggling it would
  // change no behaviour while writing an audit entry that says an operator paused
  // something — a switch that controls nothing, which is exactly what the comment below
  // refuses to create by accident. The UI does not offer the toggle; this refuses it
  // anyway, because the UI is not the enforcement.
  if (guide.kind === "config") {
    return {
      ok: false,
      message: `${key} is configuration, not a switch — its \`enabled\` bit is read by nothing. Edit its value instead.`,
    };
  }

  // Muting a pager is the one flip whose effect is invisible from the outside: users
  // notice nothing, the board stays green, and the only trace is this row. Make the
  // operator say why, so the next person reading it at 3am knows whether it is
  // deliberate. The column already exists (20260814100000) and nothing wrote it.
  if (guide.kind === "alert_channel" && !enabled && !note) {
    return { ok: false, message: "Say why you are muting this pager — it is the only record that it is deliberate." };
  }

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
    await audit(ctx, enabled ? "flag.enable" : "flag.disable", "flag", key, {
      note: note || null,
      kind: guide.kind,
    });

    // Only ever UPDATE a seeded row. A typo'd key must not silently create a flag
    // nothing reads — that would show a switch in the UI that controls nothing,
    // which is worse than having no switch at all.
    //
    // `disabled_until` is deliberately NOT written here: on the two alert keys
    // trg_alert_flag_disable_expires stamps the 24-hour deadline itself, and on a kill
    // switch there must be no deadline at all — payments_enabled must never un-pause
    // itself on a timer 24 hours into a Stripe incident.
    const { data, error } = await ctx.service
      .from("app_flags")
      .update({
        enabled,
        disabled_reason: enabled ? null : note || null,
        updated_by: ctx.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("key", key)
      .select("key, disabled_until");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error(`No flag named "${key}". Flags are seeded by migration, not created here.`);
    }

    revalidatePath("/flags");

    // The result sentence comes from the row's own entry, never from a fixed sentence
    // about "features". This used to read `${key} is OFF. Users hitting that feature now
    // get a "temporarily paused" message.` for EVERY key — which, on safety_alert, told
    // an operator the opposite of what they had just done.
    const until = data[0]?.disabled_until as string | null | undefined;
    const lapse =
      !enabled && guide.kind === "alert_channel" && until
        ? ` Paging resumes on its own at ${new Date(until).toLocaleString()}.`
        : "";
    return {
      ok: true,
      message: enabled
        ? `${key} is ON. ${guide.onMeans ?? "Normal behaviour restored."}`
        : `${key} is OFF. ${guide.offMeans}${lapse}`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// stripe_mode is a VALUE, and nothing could write it.
//
// 20260814080000 created the row so ctl_stripe_id_mode_mismatch would stop being a
// structural no-op, and ends: "the control is now armed, and /flags can flip it at
// cutover." /flags could not — the page rendered an `enabled` toggle that the control
// does not read, and no code path in admin/ wrote app_flags.value at all. So the one
// documented step of the live cutover had no implementation.
//
// Flipping to live is what ARMS the check for sandbox ids left in stripe_accounts /
// stripe_customers, and it must happen in the same change that swaps the keys — so it
// gets the pricing page's typed-confirmation treatment rather than a toggle.
// ─────────────────────────────────────────────────────────────────────────────
export async function setStripeMode(formData: FormData): Promise<ActionResult> {
  const mode = String(formData.get("mode") ?? "").trim();
  const confirm = String(formData.get("confirm") ?? "").trim();

  if (mode !== "test" && mode !== "live") {
    return { ok: false, message: 'Mode must be "test" or "live".' };
  }
  const phrase = mode === "live" ? "SWITCH TO LIVE" : "SWITCH TO TEST";
  if (confirm !== phrase) {
    return {
      ok: false,
      message: `Type ${phrase} to confirm. This must happen in the same change that swaps the Stripe keys — a mode that disagrees with the deployed keys makes the control check for the wrong thing.`,
    };
  }

  let ctx;
  try {
    ctx = await requireFreshAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return { ok: false, message: e.reason === "stale_mfa" ? "stale_mfa" : "Not authorized." };
    }
    throw e;
  }

  try {
    await audit(ctx, "flag.set_value", "flag", "stripe_mode", { mode });

    const { data, error } = await ctx.service
      .from("app_flags")
      .update({ value: { mode }, updated_by: ctx.user.id, updated_at: new Date().toISOString() })
      .eq("key", "stripe_mode")
      .select("key");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error(
        "No stripe_mode row. It is seeded by 20260814080000 — restore it before the cutover, or ctl_stripe_id_mode_mismatch cannot evaluate.",
      );
    }

    revalidatePath("/flags");
    return {
      ok: true,
      message:
        mode === "live"
          ? "stripe_mode is LIVE. ctl_stripe_id_mode_mismatch is now armed and will report any test-mode Stripe id still stored. Make sure the deployed keys are live too."
          : "stripe_mode is TEST. ctl_stripe_id_mode_mismatch is a deliberate no-op again — that is correct, not broken.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
