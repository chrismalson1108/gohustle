"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Everything here is admin-only. A promotion spends real margin, and the budget field
// is the only thing standing between a typo and an uncapped giveaway — that is not a
// support-tier decision.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1, ambiguous to read aloud

function mintCode(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export async function createPromotion(formData: FormData): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "fee_override");
  const feePct = Number(formData.get("fee_pct"));
  const bonusDollars = Number(formData.get("bonus_dollars"));
  const discountDollars = Number(formData.get("discount_dollars"));
  const uses = Number(formData.get("uses_allowed") ?? 1);
  const budgetDollars = Number(formData.get("budget_dollars") ?? 250);
  const maxRedemptions = Number(formData.get("max_redemptions") ?? 100);
  const days = Number(formData.get("days") ?? 30);

  if (!name) return { ok: false, message: "Give it a name you'll recognise in three months." };
  if (!["fee_override", "bonus", "poster_discount"].includes(kind)) return { ok: false, message: "Bad kind." };
  if (!Number.isFinite(budgetDollars) || budgetDollars <= 0) {
    return { ok: false, message: "Budget must be a positive amount — an uncapped promotion is an incident." };
  }
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return { ok: false, message: "Run length must be 1–365 days. Something that never ends is something you'll forget." };
  }
  if (kind === "fee_override" && (!Number.isFinite(feePct) || feePct < 0 || feePct > 30)) {
    return { ok: false, message: "Fee must be 0–30%." };
  }
  if (kind === "bonus" && (!Number.isFinite(bonusDollars) || bonusDollars <= 0 || bonusDollars > 500)) {
    return { ok: false, message: "Bonus must be $0.01–$500." };
  }
  if (kind === "poster_discount" && (!Number.isFinite(discountDollars) || discountDollars <= 0 || discountDollars > 500)) {
    return { ok: false, message: "Discount must be $0.01–$500." };
  }

  try {
    const ctx = await requireAdmin("admin");
    const row = {
      name,
      kind,
      status: "draft" as const,
      fee_bps: kind === "fee_override" ? Math.round(feePct * 100) : null,
      bonus_cents: kind === "bonus" ? Math.round(bonusDollars * 100) : null,
      poster_discount_cents: kind === "poster_discount" ? Math.round(discountDollars * 100) : null,
      uses_allowed: kind === "fee_override" ? Math.max(1, Math.min(20, Math.round(uses))) : 1,
      budget_cents: Math.round(budgetDollars * 100),
      max_redemptions: Math.max(1, Math.round(maxRedemptions)),
      ends_at: new Date(Date.now() + days * 86400_000).toISOString(),
      created_by: ctx.user.id,
    };
    const { data, error } = await ctx.service.from("promotions").insert(row).select("id").single();
    if (error) return { ok: false, message: error.message };

    await audit(ctx, "promotion.create", "promotion", data.id, row);
    revalidatePath("/promotions");
    // Created as DRAFT on purpose: nothing spends until someone deliberately
    // activates it, so a mistyped budget is caught before it can cost anything.
    return { ok: true, message: `Created as a draft. Review the budget, then activate.` };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not create that promotion." };
  }
}

export async function setPromotionStatus(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id) return { ok: false, message: "Missing id." };
  if (!["draft", "active", "paused", "ended"].includes(status)) {
    return { ok: false, message: "Bad status." };
  }

  try {
    const ctx = await requireAdmin("admin");
    const { error } = await ctx.service.from("promotions").update({ status }).eq("id", id);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "promotion.status", "promotion", id, { status });
    revalidatePath("/promotions");
    // Grants already held keep working — the benefit was snapshotted onto them, and
    // onto any booking already pinned. Ending a campaign must never re-price agreed work.
    return {
      ok: true,
      message:
        status === "active"
          ? "Live. It will stop on its own at the end date."
          : `Set to ${status}. Bookings already pinned keep the rate they were given.`,
    };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not change that promotion." };
  }
}

export async function mintCodes(formData: FormData): Promise<ActionResult> {
  const promotionId = String(formData.get("promotionId") ?? "");
  const count = Math.max(1, Math.min(200, Number(formData.get("count") ?? 1)));
  const seatsEach = Math.max(1, Math.min(1000, Number(formData.get("seats") ?? 1)));
  if (!promotionId) return { ok: false, message: "Missing promotion." };

  try {
    const ctx = await requireAdmin("admin");
    const rows = Array.from({ length: count }, () => ({
      promotion_id: promotionId,
      code: mintCode(),
      max_redemptions: seatsEach,
      source: "manual",
    }));
    const { error } = await ctx.service.from("promo_codes").insert(rows);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "promotion.mint_codes", "promotion", promotionId, { count, seatsEach });
    revalidatePath("/promotions");
    return { ok: true, message: `Minted ${count} code${count === 1 ? "" : "s"}, ${seatsEach} use(s) each.` };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not mint codes." };
  }
}

// ── Editing a live campaign ──────────────────────────────────────────────────
// Safe because a grant SNAPSHOTS its benefit and a booking PINS it: an edit reaches
// future claims only and can never re-price what someone already holds. So the guards
// here are arithmetic (never let spent exceed budget) rather than record-freezing.

export async function editPromotion(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const budgetDollars = Number(formData.get("budget_dollars"));
  const maxRedemptions = Number(formData.get("max_redemptions"));
  const extendDays = Number(formData.get("extend_days") ?? 0);
  if (!id) return { ok: false, message: "Missing promotion." };

  try {
    const ctx = await requireAdmin("admin");
    const { data: cur } = await ctx.service
      .from("promotions")
      .select("spent_cents, redemptions_used, ends_at, name")
      .eq("id", id).maybeSingle();
    if (!cur) return { ok: false, message: "Not found." };

    const patch: Record<string, unknown> = {};
    if (name) patch.name = name;

    if (Number.isFinite(budgetDollars) && budgetDollars > 0) {
      const cents = Math.round(budgetDollars * 100);
      // Refused rather than clamped: lowering the ceiling below what is already
      // committed would make the spend check pass again and let an overspent campaign
      // keep spending. The DB CHECK also blocks it; this is the readable message.
      if (cents < cur.spent_cents) {
        return {
          ok: false,
          message: `Budget can't go below the $${(cur.spent_cents / 100).toFixed(2)} already committed.`,
        };
      }
      patch.budget_cents = cents;
    }

    if (Number.isFinite(maxRedemptions) && maxRedemptions > 0) {
      const n = Math.round(maxRedemptions);
      if (n < cur.redemptions_used) {
        return { ok: false, message: `Max uses can't go below the ${cur.redemptions_used} already claimed.` };
      }
      patch.max_redemptions = n;
    }

    if (Number.isFinite(extendDays) && extendDays !== 0) {
      const base = cur.ends_at ? new Date(cur.ends_at).getTime() : Date.now();
      const next = new Date(Math.max(Date.now(), base + extendDays * 86400_000));
      patch.ends_at = next.toISOString();
    }

    if (!Object.keys(patch).length) return { ok: false, message: "Nothing to change." };

    const { error } = await ctx.service.from("promotions").update(patch).eq("id", id);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "promotion.edit", "promotion", id, patch);
    revalidatePath("/promotions");
    return { ok: true, message: "Updated. Grants already held keep the benefit they were given." };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not update that promotion." };
  }
}

// Clone: rerunning last term's winner is the single most common campaign operation and
// there was no way to do it without retyping every field.
export async function clonePromotion(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "Missing promotion." };
  try {
    const ctx = await requireAdmin("admin");
    const { data: src } = await ctx.service.from("promotions").select("*").eq("id", id).maybeSingle();
    if (!src) return { ok: false, message: "Not found." };
    const { id: _drop, created_at: _c, spent_cents: _s, redemptions_used: _r, ...rest } = src;
    const { data: made, error } = await ctx.service.from("promotions").insert({
      ...rest,
      name: `${src.name} (copy)`,
      status: "draft",
      spent_cents: 0,
      redemptions_used: 0,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      created_by: ctx.user.id,
    }).select("id").single();
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "promotion.clone", "promotion", made.id, { from: id });
    revalidatePath("/promotions");
    return { ok: true, message: "Cloned as a fresh draft with a clean budget and a 30-day window." };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not clone that promotion." };
  }
}

// Revoking one person's grant. Pausing a campaign stops NEW claims and does nothing
// about someone already holding one — this is the per-person lever, for abuse or for an
// offer sent to the wrong list.
export async function revokeGrant(formData: FormData): Promise<ActionResult> {
  const grantId = String(formData.get("grantId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!grantId) return { ok: false, message: "Missing grant." };
  if (!reason) return { ok: false, message: "Say why — this takes something away from a named person." };
  try {
    const ctx = await requireAdmin("admin");
    const { error } = await ctx.service
      .from("promo_grants")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq("id", grantId)
      .is("revoked_at", null);
    if (error) return { ok: false, message: error.message };
    await audit(ctx, "promotion.revoke_grant", "promo_grant", grantId, { reason });
    revalidatePath("/promotions");
    return { ok: true, message: "Revoked. Bookings already made with it are untouched." };
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: e.reason };
    return { ok: false, message: "Could not revoke that grant." };
  }
}

export interface CostEstimate {
  perUseCents: number;
  maxTotalCents: number;
  typicalGigCents: number;
  note: string;
}

// Cost preview. Calls the SAME SQL the charge path uses, rather than doing the
// arithmetic again in TypeScript — a preview that re-implements the fee is a preview
// that can disagree with the bill, which is worse than no preview at all.
export async function previewCost(formData: FormData): Promise<CostEstimate | null> {
  try {
    const ctx = await requireAdmin("admin");
    const kind = String(formData.get("kind") ?? "fee_override");
    const { data, error } = await ctx.service.rpc("estimate_campaign_cost", {
      p_kind: kind,
      p_fee_bps: kind === "fee_override" ? Math.round(Number(formData.get("fee_pct") || 0) * 100) : null,
      p_discount_cents: kind === "poster_discount" ? Math.round(Number(formData.get("discount_dollars") || 0) * 100) : null,
      p_bonus_cents: kind === "bonus" ? Math.round(Number(formData.get("bonus_dollars") || 0) * 100) : null,
      p_uses: Math.max(1, Math.round(Number(formData.get("uses_allowed") || 1))),
      p_redemptions: Math.max(1, Math.round(Number(formData.get("max_redemptions") || 1))),
      p_typical_gig_cents: Math.max(1000, Math.round(Number(formData.get("typical_gig") || 50) * 100)),
    });
    if (error || !data) return null;
    const d = data as Record<string, number | string>;
    return {
      perUseCents: Number(d.per_use_cents ?? 0),
      maxTotalCents: Number(d.max_total_cents ?? 0),
      typicalGigCents: Number(d.typical_gig_cents ?? 5000),
      note: String(d.note ?? ""),
    };
  } catch {
    return null;
  }
}
