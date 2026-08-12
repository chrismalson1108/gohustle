"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError, requireFreshAdmin } from "@/lib/guard";
import { audit, auditRead } from "@/lib/audit";

const ADMIN_ROLES: readonly string[] = ["admin", "finance", "trust", "support"];

export interface ActionResult {
  ok: boolean;
  message: string;
}

type Ctx = Awaited<ReturnType<typeof requireAdmin>>;

// Managing who can reach a service-role console is the most privileged thing in the
// product. Admin tier only, every action audited before it happens.
async function run(
  action: string,
  targetId: string,
  intent: Record<string, unknown>,
  fn: (ctx: Ctx) => Promise<Record<string, unknown> | void>,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireFreshAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    await audit(ctx, action, "admin_user", targetId, intent);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const detail = (await fn(ctx)) ?? {};
    const { __message, ...outcome } = detail as Record<string, unknown> & { __message?: string };
    if (Object.keys(outcome).length > 0) {
      await auditRead(ctx, `${action}.outcome`, "admin_user", targetId, outcome);
    }
    revalidatePath("/team");
    return { ok: true, message: __message ?? "Done." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await auditRead(ctx, `${action}.failed`, "admin_user", targetId, { error: msg });
    return { ok: false, message: msg };
  }
}

// Never let the console strand itself with nobody able to sign in.
async function assertNotLastAdmin(ctx: Ctx, userId: string): Promise<void> {
  const { data: target } = await ctx.service
    .from("admin_users").select("role, status").eq("user_id", userId).maybeSingle();
  if (target?.role !== "admin" || target?.status !== "active") return;

  const { data: count, error } = await ctx.service.rpc("admin_active_admin_count");
  if (error) throw new Error(`Couldn't count active admins (${error.message}). Refusing to act.`);
  if ((count ?? 0) <= 1) {
    throw new Error("This is the last active admin — promote or activate someone else first, or you'll lock everyone out.");
  }
}

export async function addTeamMember(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "support");
  const note = String(formData.get("note") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: "Enter a valid email." };
  // Four tiers now (20260806090000). assertNotLastAdmin still guards only the "admin"
  // tier, which is correct: trust and finance cannot manage the team, so demoting the
  // last admin to finance would still strand the console.
  if (!ADMIN_ROLES.includes(role)) {
    return { ok: false, message: `Role must be one of: ${ADMIN_ROLES.join(", ")}.` };
  }

  let ctx;
  try {
    ctx = await requireFreshAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  // The account must already exist. This grants console access to a person who has
  // signed up normally; it deliberately cannot create an account, so there is no path
  // here that mints a new identity with elevated access.
  const { data: userId, error: lookupErr } = await ctx.service.rpc("admin_find_user_id", { p_email: email });
  if (lookupErr) return { ok: false, message: `Lookup failed: ${lookupErr.message}` };
  if (!userId) {
    return {
      ok: false,
      message: `No GoHustlr account for ${email}. They need to sign up in the app first — this grants access to an existing account, it doesn't create one.`,
    };
  }

  return run("team.add", String(userId), { email, role, note: note || null }, async (c) => {
    const { error } = await c.service.from("admin_users").upsert(
      {
        user_id: userId,
        role,
        // PENDING, always. The row grants nothing until someone activates it — which
        // is what closes the enrollment window: /mfa will enroll a TOTP factor for
        // whoever presents valid credentials, so an attacker who wins the password
        // race against a newly-added teammate still lands on a denial.
        status: "pending",
        created_by: c.user.id,
        note: note || null,
        disabled_at: null,
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return {
      __message:
        `${email} added as ${role}, PENDING. They can't reach anything yet. Have them sign in and enrol ` +
        `their authenticator, confirm the enrolment time with them directly, then Activate.`,
    };
  });
}

export async function setTeamStatus(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  if (!["pending", "active", "disabled"].includes(status)) return { ok: false, message: "Bad status." };

  return run("team.set_status", userId, { status }, async (ctx) => {
    if (userId === ctx.user.id && status !== "active") {
      throw new Error("You can't disable your own access — ask another admin to do it.");
    }
    if (status !== "active") await assertNotLastAdmin(ctx, userId);

    const { data, error } = await ctx.service
      .from("admin_users")
      .update({ status, disabled_at: status === "disabled" ? new Date().toISOString() : null })
      .eq("user_id", userId)
      .select("user_id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("No such team member.");

    return {
      __message:
        status === "active"
          ? "Activated. Their next sign-in reaches the console."
          : status === "disabled"
            ? "Access revoked. Their row is kept so past audit entries still attribute correctly. Any current token stays valid for up to ~1h."
            : "Set back to pending — access refused until activated again.",
    };
  });
}

export async function setTeamRole(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  // Four tiers now (20260806090000). assertNotLastAdmin still guards only the "admin"
  // tier, which is correct: trust and finance cannot manage the team, so demoting the
  // last admin to finance would still strand the console.
  if (!ADMIN_ROLES.includes(role)) {
    return { ok: false, message: `Role must be one of: ${ADMIN_ROLES.join(", ")}.` };
  }

  return run("team.set_role", userId, { role }, async (ctx) => {
    if (userId === ctx.user.id) {
      throw new Error("You can't change your own role — ask another admin.");
    }
    // Demoting the last admin to support is the same lockout as disabling them.
    if (role === "support") await assertNotLastAdmin(ctx, userId);

    const { data, error } = await ctx.service
      .from("admin_users").update({ role }).eq("user_id", userId).select("user_id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("No such team member.");
    return { __message: `Role set to ${role}.` };
  });
}
