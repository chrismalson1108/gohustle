"use server";

import { revalidatePath } from "next/cache";
import { requireFreshAdmin, AdminAuthError, denyResult } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
  /** exportConfirmed returns the CSV body here; the client turns it into a download. */
  csv?: string;
  filename?: string;
}

// STEP-UP on every action in this file, via the shared helper — the same posture as
// /access, and for the same reason: inviting somebody GRANTS ACCESS. Two of these three
// write straight into beta_allowlist, which is the difference between a private beta
// and public signup, and the third exports every address on the list to a file.
//
// guard.ts states the rule as "anything that moves money, changes pricing, or grants
// access". Splitting the doctrine by blast radius is how the exception grows back.
async function adminCtx() {
  return requireFreshAdmin("admin");
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_INVITE = 500;

/**
 * Invite a cohort.
 *
 * The order here is the whole point, and it is: WRITE THE GATE FIRST, then stamp.
 *
 * An invite is a promise made in an email and kept by a row in beta_allowlist. If the
 * stamp landed and the allowlist write did not, the console would show "invited" while
 * handle_new_user refuses their signup with `signup_not_allowlisted` — a server-side
 * rollback with no message, which reads to them as the app being broken.
 * ctl_waitlist_invite_broken exists to catch exactly that state; this ordering is what
 * stops it happening in the first place.
 *
 * It routes through the SAME upsert /access uses rather than a second write path, so
 * there is one way into the gate table and re-closing the beta stays a one-row delete.
 */
export async function inviteCohort(formData: FormData): Promise<ActionResult> {
  const ids = String(formData.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const wave = String(formData.get("wave") ?? "").trim().slice(0, 40) || null;
  if (ids.length === 0) return { ok: false, message: "Select at least one person." };
  if (ids.length > MAX_INVITE) {
    return { ok: false, message: `That's ${ids.length} people. Invite at most ${MAX_INVITE} at a time.` };
  }

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return denyResult(e);
    throw e;
  }

  try {
    const { data: rows, error: readErr } = await ctx.service
      .from("waitlist")
      .select("id, email, unsubscribed_at, invited_at")
      .in("id", ids);
    if (readErr) throw new Error(readErr.message);

    // Somebody who opted out is excluded HERE, server-side, and the count is reported.
    // Filtering this in the UI would mean an operator who selected "all" mails people
    // who asked us not to — the one thing on this page with a legal shape.
    const optedOut = (rows ?? []).filter((r) => r.unsubscribed_at);
    const eligible = (rows ?? []).filter((r) => !r.unsubscribed_at && EMAIL_RE.test(r.email));
    if (eligible.length === 0) {
      return { ok: false, message: "Nobody in that selection can be invited (all unsubscribed or invalid)." };
    }

    await audit(ctx, "waitlist.invite", "waitlist", undefined, {
      count: eligible.length,
      skipped_unsubscribed: optedOut.length,
      wave,
    });

    // 1. THE GATE. If this fails, nothing is stamped and nobody was told anything.
    const { error: gateErr } = await ctx.service
      .from("beta_allowlist")
      .upsert(
        eligible.map((r) => ({ email: r.email, note: wave ? `waitlist ${wave}` : "waitlist" })),
        { onConflict: "email" },
      );
    if (gateErr) throw new Error(`allowlist write failed, nothing was invited: ${gateErr.message}`);

    // 2. Only now record it.
    const { error: stampErr } = await ctx.service
      .from("waitlist")
      .update({ invited_at: new Date().toISOString(), invite_wave: wave })
      .in("id", eligible.map((r) => r.id));
    if (stampErr) {
      // The gate is open and the stamp is missing — the SAFE direction (they can sign
      // up; we just do not know we told them). Say so plainly rather than reporting a
      // clean success.
      throw new Error(
        `Allowlisted ${eligible.length} address${eligible.length === 1 ? "" : "es"}, but recording the invite failed: ${stampErr.message}. They can sign up; the list will still show them as un-invited.`,
      );
    }

    revalidatePath("/waitlist");
    const skipped = optedOut.length ? ` ${optedOut.length} skipped (unsubscribed).` : "";
    return {
      ok: true,
      message: `${eligible.length} address${eligible.length === 1 ? "" : "es"} allowlisted${wave ? ` as ${wave}` : ""}.${skipped} They can create an account now — send them the email from your mail tool.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Export the invitable list as CSV.
 *
 * The PREDICATE is in the query, not in a tab the operator happened to be looking at:
 * confirmed, not unsubscribed, not already invited. An export whose contents depend on
 * UI state is how somebody mails the opt-outs.
 */
export async function exportWaitlist(formData: FormData): Promise<ActionResult> {
  const scope = String(formData.get("scope") ?? "invitable");

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return denyResult(e);
    throw e;
  }

  try {
    let q = ctx.service
      .from("waitlist")
      .select("email, role_intent, in_launch_area, source, confirmed_at, invited_at, invite_wave, created_at")
      // NEVER an opted-out address, in any scope. This is not a filter, it is the
      // one line on this page that must not have an exception.
      .is("unsubscribed_at", null)
      // And never an UNCONFIRMED one, in any scope either. The confirmation email says
      // in as many words: "Didn't sign up? Ignore this email and nothing happens — we
      // won't write again." Somebody who ignored it has been promised silence in
      // writing, and an export scope that includes them is how that promise gets
      // broken by an operator doing what the button says.
      .not("confirmed_at", "is", null)
      .order("created_at", { ascending: true })
      .limit(10000);
    // The scope now decides only one thing: have we already invited them.
    if (scope === "invitable") q = q.is("invited_at", null);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) return { ok: false, message: "Nothing to export in that scope." };

    await audit(ctx, "waitlist.export", "waitlist", undefined, { scope, count: rows.length });

    const cols = ["email", "role_intent", "in_launch_area", "source", "confirmed_at", "invited_at", "invite_wave", "created_at"];
    // Quote every field and double any embedded quote. `source` is user-supplied (it is
    // a ?src= parameter), and a value beginning = + - @ is executed as a formula by
    // Excel and Sheets — so those are prefixed with a quote as well. The trigger already
    // strips source to [A-Za-z0-9_.-], which makes this belt-and-braces rather than the
    // only defence; the belt is here because the column set will grow.
    const cell = (v: unknown) => {
      const s = v == null ? "" : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])).join(","))].join("\n");

    return {
      ok: true,
      message: `${rows.length} row${rows.length === 1 ? "" : "s"} exported.`,
      csv,
      filename: `waitlist-${scope}.csv`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Delete one entry — an erasure request from somebody with no account.
 *
 * Unsubscribing SCRUBS and keeps the address as a suppression record, which is the
 * right default. This is the other request: "remove me entirely". It is a real delete,
 * and the operator is told the consequence.
 */
export async function deleteEntry(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, message: "Missing id." };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return denyResult(e);
    throw e;
  }

  try {
    await audit(ctx, "waitlist.delete", "waitlist", id);
    const { data, error } = await ctx.service.from("waitlist").delete().eq("id", id).select("email");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return { ok: false, message: "That entry no longer exists." };
    revalidatePath("/waitlist");
    return {
      ok: true,
      message: `${data[0].email} removed. Note this also clears the suppression record — if they join again they will be treated as new.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
