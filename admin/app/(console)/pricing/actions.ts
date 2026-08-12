"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError, requireFreshAdmin } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Changing the standing take rate is the single highest-leverage write in the product:
// it applies to every booking made from that moment on. Admin-only, audited, and
// typed-confirmation gated — the same treatment the beta signup switch gets.

export async function setPlatformRate(formData: FormData): Promise<ActionResult> {
  const pct = Number(formData.get("fee_pct"));
  const confirm = String(formData.get("confirm") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const whenRaw = String(formData.get("effective_from") ?? "").trim();

  if (!Number.isFinite(pct) || pct < 5 || pct > 30) {
    // The DB CHECK is [500,3000] bps; refuse here too so the operator gets a sentence
    // rather than a constraint violation.
    return { ok: false, message: "Rate must be between 5% and 30%." };
  }
  if (confirm !== "CHANGE RATE") {
    return { ok: false, message: 'Type CHANGE RATE to confirm. This affects every booking made from then on.' };
  }
  if (!note) {
    return { ok: false, message: "Write why. In six months this row is the only record of the reason." };
  }

  // Future-dating is allowed and encouraged: it lets a rate change be announced before
  // it bites, which the Terms' "prospectively with notice" language assumes.
  const effective = whenRaw ? new Date(whenRaw) : new Date();
  if (Number.isNaN(effective.getTime())) return { ok: false, message: "Bad date." };
  if (effective.getTime() < Date.now() - 60_000) {
    // Back-dating would silently re-price nothing (bookings are pinned) but would make
    // the history lie about what was true when.
    return { ok: false, message: "Effective date can't be in the past — history has to stay true." };
  }

  try {
    const ctx = await requireFreshAdmin("admin");
    const feeBps = Math.round(pct * 100);
    const { error } = await ctx.service.from("platform_rates").insert({
      fee_bps: feeBps,
      effective_from: effective.toISOString(),
      note,
      created_by: ctx.user.id,
    });
    if (error) return { ok: false, message: error.message };

    await audit(ctx, "pricing.set_rate", "platform_rate", String(feeBps), {
      fee_bps: feeBps, effective_from: effective.toISOString(), note,
    });
    revalidatePath("/pricing");
    return {
      ok: true,
      message:
        `Rate set to ${pct}% from ${effective.toLocaleString()}. Bookings already made keep the rate ` +
        `they were struck at — this only affects new ones.`,
    };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not set the rate." };
  }
}

export async function setTier(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "1";
  if (!id) return { ok: false, message: "Missing tier." };
  try {
    const ctx = await requireFreshAdmin("admin");
    const { error } = await ctx.service.from("fee_tiers").update({ enabled }).eq("id", id);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, enabled ? "pricing.tier_enable" : "pricing.tier_disable", "fee_tier", id, { enabled });
    revalidatePath("/pricing");
    return {
      ok: true,
      // Tiers are standing policy with no budget and no end date, so enabling one is a
      // permanent margin decision, not a campaign.
      message: enabled
        ? "Enabled. This is standing policy — it has no budget and no end date."
        : "Disabled. Bookings already pinned keep the rate they were given.",
    };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not change that tier." };
  }
}

export async function grantToUsers(formData: FormData): Promise<ActionResult> {
  const promotionId = String(formData.get("promotionId") ?? "");
  const raw = String(formData.get("emails") ?? "").trim();
  if (!promotionId) return { ok: false, message: "Pick a promotion." };
  if (!raw) return { ok: false, message: "Paste some emails." };

  const emails = raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return { ok: false, message: "No usable emails." };
  if (emails.length > 500) return { ok: false, message: "500 at a time, max." };

  try {
    const ctx = await requireFreshAdmin("admin");
    // Resolve through auth.users via the admin API surface the console already uses
    // for team management; profiles has no email column.
    const { data: profs, error: pErr } = await ctx.service
      .from("profiles").select("id, username").in("username", emails);
    let ids = (profs ?? []).map((p) => p.id);

    if (!ids.length) {
      // Fall back to matching auth emails through the service role.
      const { data: authUsers } = await ctx.service.auth.admin.listUsers({ perPage: 1000 });
      const byEmail = new Map((authUsers?.users ?? []).map((u) => [String(u.email ?? "").toLowerCase(), u.id]));
      ids = emails.map((e) => byEmail.get(e)).filter(Boolean) as string[];
    }
    if (pErr && !ids.length) return { ok: false, message: pErr.message };
    if (!ids.length) return { ok: false, message: "None of those matched a user." };

    const { data: n, error } = await ctx.service.rpc("grant_promotion_to_users", {
      p_promotion: promotionId, p_user_ids: ids,
    });
    if (error) return { ok: false, message: error.message };

    await audit(ctx, "promotion.grant_direct", "promotion", promotionId, { granted: n, requested: emails.length });
    revalidatePath("/pricing");
    return {
      ok: true,
      message: `Granted to ${n} of ${emails.length}. Anyone already holding it was skipped.`,
    };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not issue those grants." };
  }
}

// ── Tier CRUD ────────────────────────────────────────────────────────────────
// Tiers shipped with only an on/off toggle, which meant changing a threshold or a rate
// required hand-written SQL — the exact thing this page exists to prevent.
//
// Editing a tier is safe for the same reason editing a campaign is: every booking PINS
// its rate at INSERT, so a change reaches future bookings only and can never re-price
// work already agreed.

const BPS_MIN = 0;
const BPS_MAX = 3000;

export async function saveTier(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const minCompleted = Number(formData.get("min_completed"));
  const pct = Number(formData.get("fee_pct"));
  const note = String(formData.get("note") ?? "").trim();

  if (!name) return { ok: false, message: "Name it." };
  if (!Number.isFinite(minCompleted) || minCompleted < 0 || minCompleted > 10000) {
    return { ok: false, message: "Threshold must be 0–10000 completed gigs." };
  }
  if (!Number.isFinite(pct) || pct * 100 < BPS_MIN || pct * 100 > BPS_MAX) {
    return { ok: false, message: "Fee must be 0–30%." };
  }

  try {
    const ctx = await requireFreshAdmin("admin");
    const row = {
      name,
      min_completed: Math.round(minCompleted),
      fee_bps: Math.round(pct * 100),
      note: note || null,
    };
    const { error } = id
      ? await ctx.service.from("fee_tiers").update(row).eq("id", id)
      : await ctx.service.from("fee_tiers").insert({ ...row, enabled: false, created_by: ctx.user.id });
    if (error) {
      // The unique index on min_completed is the likely cause, and the raw message is
      // unreadable. tier_fee_bps picks by highest threshold, so two rungs at the same
      // number means one silently never applies.
      if (error.message.includes("fee_tiers_threshold_uniq")) {
        return { ok: false, message: "Another tier already uses that threshold — each rung needs its own." };
      }
      return { ok: false, message: error.message };
    }
    await audit(ctx, id ? "pricing.tier_update" : "pricing.tier_create", "fee_tier", id || name, row);
    revalidatePath("/pricing");
    return {
      ok: true,
      message: id
        ? "Saved. Bookings already made keep the rate they were pinned at."
        : "Created, switched OFF. Enable it when you mean it.",
    };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not save that tier." };
  }
}

export async function deleteTier(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "Missing tier." };
  try {
    const ctx = await requireFreshAdmin("admin");
    const { data: t } = await ctx.service.from("fee_tiers").select("name, enabled").eq("id", id).maybeSingle();
    if (t?.enabled) {
      // Deleting a live rung silently raises the fee for everyone standing on it.
      // Make that a two-step decision rather than one click.
      return { ok: false, message: "Switch it off first — deleting a live rung raises the fee for everyone on it." };
    }
    const { error } = await ctx.service.from("fee_tiers").delete().eq("id", id);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "pricing.tier_delete", "fee_tier", id, { name: t?.name });
    revalidatePath("/pricing");
    return { ok: true, message: "Deleted." };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not delete that tier." };
  }
}

// Cancel a rate change that has NOT taken effect yet.
//
// platform_rates is append-only for a good reason: "what did we charge on the 3rd?"
// must always have an answer, and bookings pin their rate at insert so rewriting history
// would make the table lie about what was true when. That reasoning applies to rates
// that HAVE been in force. It does not apply to one scheduled for next Tuesday that
// nobody has been charged under — there, append-only just means a typo is permanent.
//
// So this deletes strictly future-dated rows and nothing else. The guard is in the
// query itself (effective_from > now()), not a prior read, so a row that becomes
// effective between the check and the delete is not removed.
//
// Editing a scheduled rate IS cancel-then-set: platform_rates_effective_uniq makes
// effective_from unique, so there is no in-place update that could quietly supersede a
// row and leave two plausible answers for the same instant.
export async function cancelScheduledRate(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, message: "Missing rate id." };

  try {
    const ctx = await requireFreshAdmin("admin");

    // Read it first so the audit row records WHAT was cancelled, not just an id.
    const { data: row } = await ctx.service
      .from("platform_rates")
      .select("fee_bps, effective_from, note")
      .eq("id", id)
      .maybeSingle();
    if (!row) return { ok: false, message: "That rate no longer exists." };
    if (Date.parse(row.effective_from) <= Date.now()) {
      return {
        ok: false,
        message: "That rate is already in effect and is part of the record. Set a new rate instead.",
      };
    }

    // Audit BEFORE the change, the ordering the whole console follows: if we cannot
    // record who cancelled a scheduled rate, we do not cancel it.
    await audit(ctx, "pricing.cancel_scheduled", "platform_rate", id, {
      fee_bps: row.fee_bps, effective_from: row.effective_from, note: row.note,
    });

    const { error, count } = await ctx.service
      .from("platform_rates")
      .delete({ count: "exact" })
      .eq("id", id)
      .gt("effective_from", new Date().toISOString());
    if (error) return { ok: false, message: error.message };
    if (!count) {
      return { ok: false, message: "It just took effect — it is history now. Set a new rate instead." };
    }

    revalidatePath("/pricing");
    return {
      ok: true,
      message: `Cancelled the scheduled ${row.fee_bps / 100}% change. The current rate is unchanged.`,
    };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not cancel that rate." };
  }
}
