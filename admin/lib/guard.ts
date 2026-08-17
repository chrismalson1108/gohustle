import "server-only";
import { redirect } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerSupabase } from "./supabaseServer";
import { getServiceClient } from "./serviceClient";

// RANKED, not orthogonal: admin ⊃ finance/trust ⊃ support.
//
// A flat capability matrix is more precise, but it needs a permissions UI to stay
// honest and an unmaintained permissions UI drifts into everyone-is-admin. Ranks are
// checkable in one line and cannot silently rot.
//
//   support  tickets, and a user's own context. NOT bulk PII, NOT all payments.
//   trust    moderation + disputes, WITH resolve authority — that authority is what
//            unblocks an earner's payout, so withholding it makes one person's
//            availability a money-harm control.
//   finance  payments, refunds, payout intervention, escrow.
//   admin    everything, plus team, flags, pricing and promotions.
//
// trust and finance are siblings: neither outranks the other, and both outrank
// support. requireAdmin("trust") therefore admits trust and admin, not finance.
export type AdminRole = "admin" | "finance" | "trust" | "support";

// Who satisfies a given minimum. Explicit sets rather than numeric ranks, because
// trust and finance are peers and a number would force a false ordering between them.
const SATISFIES: Record<AdminRole, ReadonlySet<AdminRole>> = {
  admin: new Set<AdminRole>(["admin"]),
  finance: new Set<AdminRole>(["admin", "finance"]),
  trust: new Set<AdminRole>(["admin", "trust"]),
  support: new Set<AdminRole>(["admin", "finance", "trust", "support"]),
};

export function roleSatisfies(role: AdminRole, minRole: AdminRole): boolean {
  return SATISFIES[minRole]?.has(role) ?? false;
}

export interface AdminContext {
  user: User;
  role: AdminRole;
  service: SupabaseClient;
}

export type DenyReason = "unauthenticated" | "mfa" | "forbidden" | "stale_mfa";

export class AdminAuthError extends Error {
  constructor(public readonly reason: DenyReason) {
    super(`admin auth failed: ${reason}`);
  }
}

// Read the AAL claim straight from the access-token JWT (local decode, no
// network round-trip). The token in the cookie is re-issued at aal2 after
// mfa.verify, so its claim is authoritative for "did this session pass MFA".
function aalFromToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return (JSON.parse(json).aal as string) ?? null;
  } catch {
    return null;
  }
}

// ── Step-up authentication ───────────────────────────────────────────────────
//
// AAL2 proves MFA happened at SOME point in this session. It does not prove the person
// at the keyboard right now is the one who passed it — a stolen laptop, a hijacked
// cookie, or a borrowed unlocked screen all satisfy it. For actions that move money or
// grant privilege, that is not enough: the whole point of a second factor is defeated
// if it is only ever demanded once a day.
//
// So sensitive actions additionally require a RECENT factor. Supabase puts an `amr`
// (authentication methods reference) array in the access token, one entry per method
// with the unix timestamp it was satisfied. We read the newest MFA-ish entry.
//
// FAILS CLOSED. If amr is absent, malformed, or carries no MFA method, this returns
// stale — so the worst case is being asked to re-enter a code, never being let through
// unverified.
const MFA_METHODS = new Set(["totp", "mfa/totp", "webauthn", "mfa/webauthn"]);

// Twelve hours: a working day. Long enough that nobody re-verifies mid-task, short
// enough that a session left open overnight on an unattended machine is not still a
// console in the morning. Deliberately far coarser than the 5-minute step-up window —
// they answer different questions ("is this still the same day?" vs "is the person at
// the keyboard right now the one who passed the factor?").
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export function mfaAgeSeconds(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const amr = JSON.parse(json).amr as { method?: string; timestamp?: number }[] | undefined;
    if (!Array.isArray(amr)) return null;
    const stamps = amr
      .filter((a) => a?.method && MFA_METHODS.has(String(a.method)))
      .map((a) => Number(a.timestamp))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!stamps.length) return null;
    return Math.max(0, Math.floor(Date.now() / 1000) - Math.max(...stamps));
  } catch {
    return null;
  }
}

/**
 * Like requireAdmin, but ALSO demands the second factor was satisfied recently.
 *
 * Use for anything that moves money, changes pricing, or grants access. The caller
 * catches AdminAuthError("stale_mfa") and asks for a code; verifying it mints a token
 * with a fresh amr timestamp and the retry passes.
 */
export async function requireFreshAdmin(
  minRole: AdminRole = "admin",
  maxAgeSeconds = 300,
): Promise<AdminContext> {
  const ctx = await requireAdmin(minRole);
  const supa = await getServerSupabase();
  const { data: { session } } = await supa.auth.getSession();
  const age = mfaAgeSeconds(session?.access_token);
  if (age === null || age > maxAgeSeconds) {
    throw new AdminAuthError("stale_mfa");
  }
  return ctx;
}

// THE enforcement point. Every server component page and every server action
// calls this before touching data. Chain: authentic session (getUser hits the
// auth server, not just cookie parsing) → TOTP MFA satisfied this session
// (AAL2, read from the JWT claim) → admin_users membership → role tier.
// proxy.ts only does UX redirects; nothing is protected unless it passes here.
export async function requireAdmin(minRole: AdminRole = "support"): Promise<AdminContext> {
  const supa = await getServerSupabase();

  const {
    data: { user },
    error,
  } = await supa.auth.getUser();
  if (error || !user) throw new AdminAuthError("unauthenticated");

  // getSession reads the cookie locally (no auth-server call); getUser above
  // already proved the token authentic, so trusting its aal claim is sound.
  const {
    data: { session },
  } = await supa.auth.getSession();
  if (aalFromToken(session?.access_token) !== "aal2") throw new AdminAuthError("mfa");

  // ── Absolute session cap ──────────────────────────────────────────────────
  //
  // AAL2 proves the factor was satisfied at SOME point. Supabase rotates the refresh
  // token indefinitely, so without this a console session — holding the service-role
  // key — stays live forever on whatever laptop it was opened on. Step-up already
  // time-boxes money and privilege actions to 5 minutes; this bounds the session itself.
  //
  // RE-VERIFICATION, NOT SIGN-OUT, and that distinction is the whole design. Signing
  // someone out mid-task loses their place and trains them to resent the control;
  // asking for six digits costs seconds and keeps them where they were. It reuses
  // mfaAgeSeconds rather than adding a second notion of freshness, so there is one
  // definition of "when did this person last prove who they are".
  //
  // Enforced HERE rather than by a client timer. A timer in the browser is a suggestion:
  // it looks like security and is defeated by a client that ignores it.
  //
  // Fails closed on an unreadable amr, same as requireFreshAdmin — the cost is being
  // asked for a code, never being let through unverified.
  const sessionAge = mfaAgeSeconds(session?.access_token);
  if (sessionAge === null || sessionAge > SESSION_MAX_AGE_SECONDS) {
    throw new AdminAuthError("stale_mfa");
  }

  const service = getServiceClient();
  const { data: row, error: lookupErr } = await service
    .from("admin_users")
    .select("role, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (lookupErr) throw new Error(`admin_users lookup failed: ${lookupErr.message}`);
  if (!row) throw new AdminAuthError("forbidden");

  // STATUS, not just membership. A row added from /team starts 'pending' and grants
  // nothing until an existing admin activates it — which they do only after the
  // person has enrolled TOTP and confirmed the factor out of band.
  //
  // This is what closes the trust-on-first-use window: app/mfa/page.tsx will happily
  // enroll a fresh authenticator for whoever presents valid credentials, so seeding
  // a membership before enrollment used to mean a password-only compromise walked
  // into a service-role console. Now winning that race gets you a pending row and a
  // denial. 'disabled' keeps the row for audit attribution while revoking access.
  if (row.status !== "active") throw new AdminAuthError("forbidden");

  const role = row.role as AdminRole;
  if (!roleSatisfies(role, minRole)) throw new AdminAuthError("forbidden");

  return { user, role, service };
}

// Page wrapper: turns deny reasons into the right redirect instead of a 500.
export async function requireAdminPage(minRole: AdminRole = "support"): Promise<AdminContext> {
  try {
    return await requireAdmin(minRole);
  } catch (e) {
    if (e instanceof AdminAuthError) {
      if (e.reason === "unauthenticated") redirect("/login");
      if (e.reason === "mfa") redirect("/mfa");
      // stale_mfa from the session cap. WITHOUT the ?reauth flag this loops forever:
      // /mfa short-circuits an aal2 session straight back to "/", the guard rejects it
      // again, and the two bounce off each other. The flag tells the gate to challenge
      // an already-aal2 session on purpose.
      if (e.reason === "stale_mfa") redirect("/mfa?reauth=1");
      redirect("/denied");
    }
    throw e;
  }
}
