"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { deleteUserCascade } from "@/lib/deleteUser";
import { getServerSupabase } from "@/lib/supabaseServer";
import { USER_APP_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/config";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Every mutation: requireAdmin('admin') → act → audit (fail-closed) →
// revalidate. Errors come back as { ok:false } instead of throwing so the
// panel can show them; an AdminAuthError still reports as a plain denial.
type Ctx = Awaited<ReturnType<typeof requireAdmin>>;

// Guard destructive/moderation actions from foot-guns on a tiny trusted team:
// no acting on your own account, and no acting on a fellow admin_users member.
// (Manage admins directly in the DB — deliberately not a console feature.)
async function assertActionableTarget(ctx: Ctx, userId: string): Promise<void> {
  if (userId === ctx.user.id) {
    throw new Error("You can't run admin actions on your own account.");
  }
  const { data: peer } = await ctx.service
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (peer) {
    throw new Error("This user is an admin — manage admin accounts in the database, not here.");
  }
}

async function run(
  action: string,
  targetId: string,
  fn: (ctx: Ctx) => Promise<Record<string, unknown> | void>,
  opts: { guardTarget?: boolean } = { guardTarget: true },
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    if (opts.guardTarget !== false) await assertActionableTarget(ctx, targetId);
    const detail = (await fn(ctx)) ?? {};
    // An action can set __message for a custom success string; it's stripped
    // from the audited detail.
    const { __message, ...auditDetail } = detail as Record<string, unknown> & { __message?: string };
    await audit(ctx, action, "user", targetId, auditDetail);
    revalidatePath(`/users/${targetId}`);
    return { ok: true, message: __message ?? "Done." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

export async function suspendUser(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.suspend", userId, async (ctx) => {
    const { error } = await ctx.service.auth.admin.updateUserById(userId, {
      ban_duration: "876000h", // ~100 years; lifted explicitly via unsuspend
    });
    if (error) throw new Error(`ban failed: ${error.message}`);
    const { error: pErr } = await ctx.service
      .from("profiles")
      .update({ suspended_at: new Date().toISOString(), suspension_reason: reason || null })
      .eq("id", userId);
    if (pErr) throw new Error(`profile flag failed: ${pErr.message}`);
    // Kill live sessions so the ban bites immediately rather than at token
    // refresh (~1h). Best-effort: the ban is authoritative, so a revoke hiccup
    // shouldn't fail a safety-critical suspension — record the outcome instead.
    const { data: revoked, error: rErr } = await ctx.service.rpc("admin_revoke_sessions", {
      target: userId,
    });
    return {
      reason,
      sessions_revoked: rErr ? `error: ${rErr.message}` : revoked,
      __message:
        "Suspended. New logins are blocked immediately; if they're currently signed in, " +
        "that session ends when its token expires (up to ~1h).",
    };
  });
}

export async function unsuspendUser(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.unsuspend", userId, async (ctx) => {
    const { error } = await ctx.service.auth.admin.updateUserById(userId, {
      ban_duration: "none",
    });
    if (error) throw new Error(`unban failed: ${error.message}`);
    const { error: pErr } = await ctx.service
      .from("profiles")
      .update({ suspended_at: null, suspension_reason: null })
      .eq("id", userId);
    if (pErr) throw new Error(`profile flag failed: ${pErr.message}`);
  });
}

export async function forceSignOut(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.force_signout", userId, async (ctx) => {
    // Delete the user's refresh sessions (admin_revoke_sessions RPC). This never
    // touches banned_until, so it can't clobber an existing suspension. Access
    // JWTs already minted stay valid until they expire (~1h, Supabase-inherent);
    // no new tokens can be issued.
    const { data: revoked, error } = await ctx.service.rpc("admin_revoke_sessions", {
      target: userId,
    });
    if (error) throw new Error(`session revoke failed: ${error.message}`);
    return {
      sessions_revoked: revoked,
      __message:
        `Revoked ${revoked ?? 0} session(s). They can't get a new token, but their ` +
        `current one stays valid until it expires (up to ~1h) — Supabase can't kill an active JWT instantly.`,
    };
  });
}

export async function setVerified(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const verified = formData.get("verified") === "true";
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.set_verified", userId, async (ctx) => {
    const { error } = await ctx.service
      .from("profiles")
      .update({
        verified,
        id_verification_status: verified ? "verified" : "none",
      })
      .eq("id", userId);
    if (error) throw new Error(error.message);
    return { verified };
  });
}

export async function resetProfileFields(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const resetUsername = formData.get("resetUsername") === "on";
  const resetBio = formData.get("resetBio") === "on";
  if (!userId) return { ok: false, message: "Missing user id." };
  if (!resetUsername && !resetBio) return { ok: false, message: "Nothing selected." };
  return run("user.reset_profile_fields", userId, async (ctx) => {
    const patch: Record<string, unknown> = {};
    if (resetUsername) patch.username = `user_${userId.slice(0, 8)}`;
    if (resetBio) patch.bio = null;
    const { error } = await ctx.service.from("profiles").update(patch).eq("id", userId);
    if (error) throw new Error(error.message);
    return { fields: Object.keys(patch) };
  });
}

export async function sendPasswordReset(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.password_reset_email", userId, async (ctx) => {
    // Resolve the email from the target id server-side — never trust a
    // client-supplied address (would let a crafted POST mail a reset elsewhere
    // and poison the audit row).
    const { data, error: lookupErr } = await ctx.service.auth.admin.getUserById(userId);
    const email = data?.user?.email;
    if (lookupErr || !email) throw new Error("No email on file for this user.");
    const { error } = await ctx.service.auth.resetPasswordForEmail(email, {
      redirectTo: `${USER_APP_URL}/reset-password`,
    });
    if (error) throw new Error(error.message);
    return { email };
  });
}

export async function confirmEmail(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.confirm_email", userId, async (ctx) => {
    const { error } = await ctx.service.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw new Error(error.message);
  });
}

export async function changeEmail(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!userId) return { ok: false, message: "Missing user id." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: "Enter a valid email." };
  return run("user.change_email", userId, async (ctx) => {
    // Set + auto-confirm so the user isn't locked out behind a fresh confirmation.
    const { error } = await ctx.service.auth.admin.updateUserById(userId, { email, email_confirm: true });
    if (error) throw new Error(error.message);
    return { email };
  });
}

export async function grantStudent(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.grant_student", userId, async (ctx) => {
    const { error } = await ctx.service
      .from("profiles")
      .update({
        student_verified: true,
        student_status: "student",
        student_verify_method: "manual",
        student_verified_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (error) throw new Error(error.message);
  });
}

export async function notifyUser(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const alsoEmail = formData.get("alsoEmail") === "on";
  if (!userId || !title || !body) return { ok: false, message: "Title and message are required." };
  return run("user.notify", userId, async (ctx) => {
    // In-app alert (notifications table; the app's inbox reads it).
    const { error } = await ctx.service
      .from("notifications")
      .insert({ user_id: userId, type: "admin", title, body });
    if (error) throw new Error(`in-app notify failed: ${error.message}`);

    let emailed = false;
    if (alsoEmail) {
      const { data } = await ctx.service.auth.admin.getUserById(userId);
      const email = data?.user?.email;
      if (email) {
        const supa = await getServerSupabase();
        const {
          data: { session },
        } = await supa.auth.getSession();
        const res = await fetch(`${SUPABASE_URL}/functions/v1/support-reply`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ toEmail: email, subject: title, body }),
        });
        emailed = res.ok;
      }
    }
    return { title, emailed: alsoEmail ? emailed : undefined };
  });
}

export async function addNote(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!userId || !note) return { ok: false, message: "Note is empty." };
  return run("user.note_add", userId, async (ctx) => {
    const { error } = await ctx.service
      .from("admin_user_notes")
      .insert({ user_id: userId, admin_id: ctx.user.id, note });
    if (error) throw new Error(error.message);
  });
}

export async function deleteAccount(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  if (confirmation !== "DELETE") return { ok: false, message: "Type DELETE to confirm." };

  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    await assertActionableTarget(ctx, userId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  // Audit BEFORE the irreversible cascade — after it, the profile row (and any
  // failure context) is gone. Fail-closed: no audit row, no deletion.
  await audit(ctx, "user.delete", "user", userId, { confirmation: true });
  try {
    await deleteUserCascade(ctx.service, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit(ctx, "user.delete_failed", "user", userId, { error: msg });
    return { ok: false, message: msg };
  }
  redirect("/users");
}
