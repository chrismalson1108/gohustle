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
  const uses = Number(formData.get("uses_allowed") ?? 1);
  const budgetDollars = Number(formData.get("budget_dollars") ?? 250);
  const maxRedemptions = Number(formData.get("max_redemptions") ?? 100);
  const days = Number(formData.get("days") ?? 30);

  if (!name) return { ok: false, message: "Give it a name you'll recognise in three months." };
  if (kind !== "fee_override" && kind !== "bonus") return { ok: false, message: "Bad kind." };
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

  try {
    const ctx = await requireAdmin("admin");
    const row = {
      name,
      kind,
      status: "draft" as const,
      fee_bps: kind === "fee_override" ? Math.round(feePct * 100) : null,
      bonus_cents: kind === "bonus" ? Math.round(bonusDollars * 100) : null,
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
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
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
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
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
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "Could not mint codes." };
  }
}
