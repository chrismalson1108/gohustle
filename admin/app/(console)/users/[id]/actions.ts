"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit, auditRead } from "@/lib/audit";
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
  // FAIL CLOSED. This used to destructure only `{ data: peer }` and drop the
  // error, so a timed-out admin_users lookup produced peer === null and the guard
  // silently PASSED — i.e. the one condition under which we cannot tell whether
  // the target is a colleague was the condition under which we'd suspend, take
  // over the email of, or permanently delete them. guard.ts:64 and
  // deleteUser.ts already fail closed on this exact query; this is the outlier.
  const { data: peer, error } = await ctx.service
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Couldn't verify whether this user is an admin (${error.message}). Refusing to act — retry in a moment.`,
    );
  }
  if (peer) {
    throw new Error("This user is an admin — manage admin accounts in the database, not here.");
  }
}

// `intent` is audited BEFORE the mutation runs; `fn` returns only outcome facts
// the intent could not know (how many sessions actually died, whether the push
// left the building), which are appended as a second row.
//
// WHY BEFORE: audit() throws when it can't write, and this used to run AFTER the
// mutation, so a failed audit insert turned an action that had ALREADY COMMITTED
// into `{ok:false, message:"audit write failed"}` — the admin reads that as "it
// didn't happen", re-runs it, and meanwhile the ban/email-change is live and
// unrecorded. Auditing first makes the README's fail-closed claim true for every
// action rather than only deleteAccount: no accountability row, no mutation.
async function run(
  action: string,
  targetId: string,
  intent: Record<string, unknown>,
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
    await audit(ctx, action, "user", targetId, intent);
  } catch (e) {
    // Nothing has been mutated yet, so reporting failure here is honest.
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const detail = (await fn(ctx)) ?? {};
    // An action can set __message for a custom success string; it's stripped
    // from the audited detail.
    const { __message, ...outcome } = detail as Record<string, unknown> & { __message?: string };
    // Best-effort: the mutation has already happened, so a failed follow-up row
    // must not be reported as a failed action — that's the bug this fix exists for.
    // /audit filters by action PREFIX (ilike `${action}%`), so searching
    // "user.suspend" still returns the intent row and its outcome together.
    if (Object.keys(outcome).length > 0) {
      await auditRead(ctx, `${action}.outcome`, "user", targetId, outcome);
    }
    revalidatePath(`/users/${targetId}`);
    return { ok: true, message: __message ?? "Done." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The intent row is already on the record; note that it didn't complete so the
    // log doesn't imply a change that never landed.
    await auditRead(ctx, `${action}.failed`, "user", targetId, { error: msg });
    return { ok: false, message: msg };
  }
}

export async function suspendUser(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.suspend", userId, { reason }, async (ctx) => {
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
  return run("user.unsuspend", userId, {}, async (ctx) => {
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
  return run("user.force_signout", userId, {}, async (ctx) => {
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
  return run("user.set_verified", userId, { verified }, async (ctx) => {
    const { error } = await ctx.service
      .from("profiles")
      .update({
        verified,
        id_verification_status: verified ? "verified" : "none",
      })
      .eq("id", userId);
    if (error) throw new Error(error.message);
  });
}

export async function resetProfileFields(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const resetUsername = formData.get("resetUsername") === "on";
  const resetBio = formData.get("resetBio") === "on";
  if (!userId) return { ok: false, message: "Missing user id." };
  if (!resetUsername && !resetBio) return { ok: false, message: "Nothing selected." };
  const fields = [resetUsername && "username", resetBio && "bio"].filter(Boolean) as string[];
  return run("user.reset_profile_fields", userId, { fields }, async (ctx) => {
    // Capture what we're about to destroy. Without this the audit row says only
    // that a username was reset — not what it was — so a wrongly-actioned user
    // cannot be restored, and a moderation decision cannot be reviewed against
    // the content that triggered it. Read before the write, record after it lands.
    // Fail closed, like assertActionableTarget above. Dropping this error wrote
    // `previous: { username: null }` into an APPEND-ONLY log as fact — indistinguishable
    // from a user who genuinely had no username, and uncorrectable afterwards. If we
    // can't capture what we're about to destroy, don't destroy it.
    const { data: before, error: readErr } = await ctx.service
      .from("profiles")
      .select("username, bio")
      .eq("id", userId)
      .maybeSingle();
    if (readErr) {
      throw new Error(
        `Couldn't read the current values to record them (${readErr.message}). Nothing was changed — retry in a moment.`,
      );
    }

    const patch: Record<string, unknown> = {};
    if (resetUsername) patch.username = `user_${userId.slice(0, 8)}`;
    if (resetBio) patch.bio = null;
    const { error } = await ctx.service.from("profiles").update(patch).eq("id", userId);
    if (error) throw new Error(error.message);
    return {
      previous: {
        ...(resetUsername ? { username: before?.username ?? null } : {}),
        ...(resetBio ? { bio: before?.bio ?? null } : {}),
      },
    };
  });
}

export async function sendPasswordReset(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.password_reset_email", userId, {}, async (ctx) => {
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
  return run("user.confirm_email", userId, {}, async (ctx) => {
    const { error } = await ctx.service.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw new Error(error.message);
  });
}

export async function changeEmail(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!userId) return { ok: false, message: "Missing user id." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, message: "Enter a valid email." };
  return run("user.change_email", userId, { email }, async (ctx) => {
    // Set + auto-confirm so the user isn't locked out behind a fresh confirmation.
    const { error } = await ctx.service.auth.admin.updateUserById(userId, { email, email_confirm: true });
    if (error) throw new Error(error.message);
  });
}

export async function grantStudent(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.grant_student", userId, {}, async (ctx) => {
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

export async function revokeStudent(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user id." };
  return run("user.revoke_student", userId, {}, async (ctx) => {
    const { error } = await ctx.service
      .from("profiles")
      .update({
        student_verified: false,
        student_status: "none",
        student_verify_method: null,
        student_verified_at: null,
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
  return run("user.notify", userId, { title, alsoEmail }, async (ctx) => {
    // In-app alert (notifications table; the app's inbox reads it).
    const { error } = await ctx.service
      .from("notifications")
      .insert({ user_id: userId, type: "admin", title, body });
    if (error) throw new Error(`in-app notify failed: ${error.message}`);

    // Push the alert to the user's device. Inserting the notifications row alone only
    // fills the in-app inbox — there is no DB trigger behind that table — so without
    // this the user sees nothing until they happen to open Alerts. For a "first warning
    // before you're perma banned" that is the difference between a warning and a
    // surprise ban. Best-effort: a device with no push token must not fail the action.
    // send-push normally requires the caller to SHARE A BOOKING with the recipient
    // (anti-spoof), which an admin never does — and it replaces caller wording with a
    // fixed template until the recipient has agreed to something, which would have
    // turned this warning into "There's an update on one of your gigs". adminNotice
    // opts into a narrow path that re-verifies admin_users server-side, keeps the
    // literal wording, and skips its own inbox insert (we wrote one above).
    const supa = await getServerSupabase();
    const {
      data: { session },
    } = await supa.auth.getSession();
    const adminToken = session?.access_token ?? "";

    let pushed = false;
    let pushError: string | null = null;
    try {
      const pushRes = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          userId,
          title,
          body,
          adminNotice: true,
          data: { tab: "ProfileTab", type: "system" },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      pushed = pushRes.ok;
      if (!pushRes.ok) {
        // Report what actually happened. Blaming "no device registered" for what is
        // really a 403 sends the operator hunting the wrong problem.
        const detail = await pushRes.json().catch(() => null);
        pushError = `push rejected (${detail?.error ?? `http ${pushRes.status}`})`;
      } else {
        const detail = await pushRes.json().catch(() => null);
        if (typeof detail?.sent === "number" && detail.sent === 0) {
          pushError = "no push sent — the user has no registered device";
        }
      }
    } catch (e) {
      pushError = (e as Error)?.name === "TimeoutError" ? "push timed out" : "push request failed";
    }

    let emailed = false;
    let emailError: string | null = null;
    if (alsoEmail) {
      try {
        // TIMEOUT IS LOAD-BEARING: this fetch had none, so any stall left the server
        // action unresolved and the form stuck on "Sending…" forever, with the admin
        // unable to tell whether the warning had gone out.
        //
        // We name the USER, not an address. support-reply resolves the mailbox from
        // the id server-side and refuses anything else, so this endpoint can never be
        // driven into mailing an arbitrary recipient from the GoHustlr Support
        // identity. Contacting someone who opened no ticket is admin-tier there too,
        // which matches this action's own requireAdmin('admin').
        const res = await fetch(`${SUPABASE_URL}/functions/v1/support-reply`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ userId, subject: title, body }),
          signal: AbortSignal.timeout(15_000),
        });
        emailed = res.ok;
        if (!res.ok) {
          // Report the REAL reason. "check Resend" is actively misleading when the
          // cause is a 403 from the AAL2/MFA gate or an unset RESEND_API_KEY.
          const detail = await res.json().catch(() => null);
          const code = detail?.error ?? `http ${res.status}`;
          emailError =
            code === "mfa_required"
              ? "email refused: your admin session isn't MFA-verified (AAL2)"
              : code === "admin_check_unavailable"
                ? "couldn't verify your admin role just now — retry in a moment"
                : code === "forbidden"
                ? "email refused: this needs the admin role, not support"
                : code === "user_has_no_email"
                  ? "that account has no email address"
                  : code === "email_not_configured"
                    ? "email is not configured (RESEND_API_KEY unset)"
                    : `email failed (${code})`;
        }
      } catch (e) {
        emailError = (e as Error)?.name === "TimeoutError" ? "email timed out" : "email request failed";
      }
    }

    // The in-app row is saved by here; push and email are the legs that can still fail.
    // Never fall through to the default "Done." while one of them silently didn't —
    // the admin would believe a warning was delivered when it never left the building.
    const problems: string[] = [];
    if (pushError) problems.push(pushError);
    if (emailError) problems.push(emailError);
    const __message = problems.length
      ? `Saved to their in-app inbox, but ${problems.join("; ")}.`
      : undefined;
    return { title, emailed: alsoEmail ? emailed : undefined, pushed, __message };
  });
}

export async function addNote(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!userId || !note) return { ok: false, message: "Note is empty." };
  return run("user.note_add", userId, {}, async (ctx) => {
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
