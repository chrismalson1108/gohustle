"use server";

import { headers } from "next/headers";
import { getServiceClient } from "@/lib/serviceClient";

// ─────────────────────────────────────────────────────────────────────────────
// The admin login throttle existed in SQL and had ZERO callers.
//
// `admin_login_blocked(email, ip)` and `admin_login_attempts` were created by
// 20260806090000_admin_roles.sql, granted to service_role, and then nothing ever called
// either one — the login page went straight to supabase.auth.signInWithPassword from the
// browser. So CLAUDE.md's "5 failures per account / 15 min, or 20 per IP" described
// behaviour that did not exist, and `ctl_admin_login_bruteforce` was permanently blind:
// it counts rows in a table nothing writes to, so it can only ever report zero.
//
// Found by the 2026-08-12 payments audit, which sat unmerged on a branch for three days.
//
// ── WHAT THIS DOES AND DOES NOT GIVE YOU ────────────────────────────────────
//
// The sign-in itself must stay client-side: that is what puts the session in the
// browser. So this cannot stand in front of Supabase's auth endpoint — someone who
// skips our UI entirely and POSTs to Supabase directly is bounded by Supabase's own
// rate limits, not by ours. Claiming otherwise would be the same kind of false
// documentation this is fixing.
//
// What it does give you, both of which were missing:
//   1. RECORDING. Every attempt through the console is written to
//      admin_login_attempts, so ctl_admin_login_bruteforce finally has data and a
//      spray against the console is visible on the controls board.
//   2. A real block on the console path once the threshold trips, so the obvious
//      attack — a script driving this form — stops working rather than continuing
//      silently at full speed.
// ─────────────────────────────────────────────────────────────────────────────

async function callerIp(): Promise<string | null> {
  const h = await headers();
  // Same derivation lib/audit.ts uses, so the two agree about who a request came from.
  return (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
}

/** True when this email or IP is over the threshold and must not be let through. */
export async function loginBlocked(email: string): Promise<boolean> {
  try {
    const { data, error } = await getServiceClient().rpc("admin_login_blocked", {
      p_email: email,
      p_ip: await callerIp(),
    });
    // FAIL OPEN, deliberately. A throttle that locks every admin out of the console when
    // the database hiccups is worse than one that misses a window of guesses — this is
    // the door people come through during an incident. The recording below is what makes
    // the miss visible.
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Record the outcome. This is the half that makes the brute-force control work at all. */
export async function recordLoginAttempt(email: string, ok: boolean): Promise<void> {
  try {
    await getServiceClient().from("admin_login_attempts").insert({
      email,
      ok,
      ip: await callerIp(),
    });
  } catch {
    // Never let bookkeeping break a sign-in. A failure here costs detection, not access.
  }
}
