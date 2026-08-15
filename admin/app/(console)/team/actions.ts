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
    // Surface stale_mfa as its own sentinel so the caller can offer a code prompt and
    // retry. Collapsing it into "Not authorized." — as this did — made every step-up
    // action here a dead end no matter what the UI offered, because the reason the UI
    // keys on never reached it. Genuine denials still read as denials.
    if (e instanceof AdminAuthError) {
      return { ok: false, message: e.reason === "stale_mfa" ? "stale_mfa" : "Not authorized." };
    }
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
    // ── "Add" must never DOWNGRADE an existing member ────────────────────────
    //
    // This was an upsert that always wrote status:'pending'. requireAdmin refuses any row
    // that is not 'active' (lib/guard.ts), so re-adding someone who is already active —
    // to correct a role, or fix a typo in a note — knocked them straight out, and their
    // next request 403s. With a single admin in production that is a total console
    // lockout, recoverable only with direct Supabase credentials, which
    // 20260804030000_admin_team_lifecycle.sql calls "exactly the wrong dependency".
    //
    // The two siblings below already guard this shape: setTeamStatus refuses
    // self-targeting AND calls assertNotLastAdmin; setTeamRole refuses self-targeting.
    // Add was the one path with neither.
    if (userId === c.user.id) {
      throw new Error("You are already on the team — use Change role rather than Add.");
    }

    const { data: existing } = await c.service
      .from("admin_users").select("status").eq("user_id", userId).maybeSingle();

    if (existing) {
      // Update the editable fields and LEAVE STATUS ALONE. An active member stays active;
      // a pending one stays pending.
      const { error: updErr } = await c.service
        .from("admin_users")
        .update({ role, note: note || null })
        .eq("user_id", userId);
      if (updErr) throw new Error(updErr.message);
      return {
        __message:
          `${email} is already on the team — role set to ${role}, status left as ` +
          `${existing.status}. Adding someone twice no longer demotes them.`,
      };
    }

    const { error } = await c.service.from("admin_users").insert(
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
    // Demoting the last admin is the same lockout as disabling them — and it is not only
    // 'support' that does it. finance and trust are peers of each other, NOT of admin
    // (lib/guard.ts roleSatisfies), so demoting the last admin to either strands the
    // console just as completely. The check is "no longer admin", not "is support".
    if (role !== "admin") await assertNotLastAdmin(ctx, userId);

    const { data, error } = await ctx.service
      .from("admin_users").update({ role }).eq("user_id", userId).select("user_id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("No such team member.");
    return { __message: `Role set to ${role}.` };
  });
}
