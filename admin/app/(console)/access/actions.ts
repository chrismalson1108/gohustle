"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function adminCtx() {
  return requireAdmin("admin");
}

// Invite one or many. Pasting a list is the actual workflow — you invite a cohort,
// not a person — and doing that one form submit at a time is how testers get missed.
export async function inviteEmails(formData: FormData): Promise<ActionResult> {
  const raw = String(formData.get("emails") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  const emails = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (emails.length === 0) return { ok: false, message: "Enter at least one email." };

  const bad = emails.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) {
    return { ok: false, message: `Not valid email addresses: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}` };
  }
  // '*' is the open-beta switch and must only ever be set through openBeta() below,
  // which is confirmed and audited as its own distinct action.
  if (emails.includes("*")) return { ok: false, message: "Use the open/close control for '*'." };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  try {
    await audit(ctx, "access.invite", "beta_allowlist", undefined, { emails, count: emails.length, note: note || null });
    // Only write `note` when one was given. Upserting note:null wiped the annotation
    // on any address already on the list (including the seeded 'founder' row) while
    // reporting a clean "Invited N addresses".
    const rows = emails.map((email) => (note ? { email, note } : { email }));
    const { error } = await ctx.service
      .from("beta_allowlist")
      .upsert(rows, { onConflict: "email" });
    if (error) throw new Error(error.message);
    revalidatePath("/access");
    return { ok: true, message: `Invited ${emails.length} address${emails.length === 1 ? "" : "es"}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function revokeEmail(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { ok: false, message: "Missing email." };
  if (email === "*") return { ok: false, message: "Use the open/close control for '*'." };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    await audit(ctx, "access.revoke", "beta_allowlist", email);
    // Match case-insensitively: handle_new_user compares with lower(), so a row
    // stored as 'Foo@Bar.com' still grants access but an .eq() on the lowercased
    // input would not delete it — and the action would report success having
    // revoked nothing.
    const { data, error } = await ctx.service
      .from("beta_allowlist").delete().ilike("email", email).select("email");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      return { ok: false, message: `${email} isn't on the invite list — nothing to revoke.` };
    }
    revalidatePath("/access");
    // Say what this does NOT do. Revoking only closes the door to a future signup;
    // an operator who reads "revoked" as "removed from the beta" will not think to
    // also suspend the account they already have.
    return { ok: true, message: `${email} can no longer sign up. Any account they already created is unaffected — suspend it separately if that's the intent.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// The '*' row is the real open/closed switch: handle_new_user treats it as "allow
// every email". This is the single highest-consequence control in the console —
// it is the difference between a private beta and public signup.
export async function setOpenBeta(formData: FormData): Promise<ActionResult> {
  const open = formData.get("open") === "true";
  const confirmation = String(formData.get("confirmation") ?? "");
  const expected = open ? "OPEN" : "CLOSE";
  if (confirmation !== expected) return { ok: false, message: `Type ${expected} to confirm.` };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    await audit(ctx, open ? "access.open_beta" : "access.close_beta", "beta_allowlist", "*");
    if (open) {
      const { error } = await ctx.service
        .from("beta_allowlist")
        .upsert({ email: "*", note: "open signups — all emails allowed" }, { onConflict: "email" });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await ctx.service.from("beta_allowlist").delete().eq("email", "*");
      if (error) throw new Error(error.message);
    }
    revalidatePath("/access");
    return {
      ok: true,
      message: open
        ? "Signups are OPEN to everyone."
        : "Signups are now INVITE-ONLY. Existing accounts are unaffected.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
