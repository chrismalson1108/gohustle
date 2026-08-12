// Shared admin-caller gate for the edge functions the admin console calls with
// the signed-in admin's own Supabase user JWT (support-reply, support-ai-draft,
// send-push's adminNotice path).
//
// WHY THIS EXISTS: each of those functions grew its own copy of `isAdminCaller`,
// and all three checked admin_users MEMBERSHIP only — `select('user_id')` — while
// the console gates the equivalent capability by ROLE. `admin/lib/guard.ts`
// requireAdmin('admin') is what stands between a support-tier helper and, say,
// "Notify user"; but a support user's browser holds a perfectly valid AAL2 token,
// so posting it straight at the function bypassed the tier the UI enforces. The
// role has to be asserted where the capability actually lives, not only in the UI
// that usually reaches it.
//
// Mirrors admin/lib/guard.ts exactly: authentic token (getUser hits the auth
// server) → AAL2/TOTP from the JWT claim → admin_users membership → role tier.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

export type AdminRole = 'admin' | 'support';

export interface AdminCaller {
  user: User;
  role: AdminRole;
  /** Service-role client — already authorised by the checks above. */
  service: SupabaseClient;
}

export interface AdminDenial {
  /** HTTP status to return. */
  status: number;
  /** Stable machine-readable code; the console maps these to operator-facing copy. */
  error: 'unauthenticated' | 'mfa_required' | 'stale_mfa' | 'forbidden' | 'admin_check_unavailable';
}

// Read the AAL claim straight from the (already-authenticated) access-token JWT.
// Local decode, no network round-trip: the console re-issues the token at aal2
// after mfa.verify, so this claim is authoritative for "did this session pass
// MFA". Signature verification is not needed here because getUser() below already
// proved the token authentic against the auth server.
// How long ago the second factor was actually satisfied, from the `amr`
// (authentication methods reference) array in the token — one entry per method with
// the unix timestamp it was met.
//
// AAL2 alone only proves MFA happened at SOME point in the session. It does not prove
// the person at the keyboard now is the one who passed it: a stolen laptop, a hijacked
// cookie or a borrowed unlocked screen all satisfy it. admin-payment-action ISSUES
// REFUNDS AND VOIDS HOLDS — real money leaving on a token that could be hours old and
// in someone else's hands.
//
// FAILS CLOSED: absent, malformed or MFA-free amr returns null, which callers treat as
// stale. Worst case is being asked for a code; never a silent pass.
const MFA_METHODS = new Set(['totp', 'mfa/totp', 'webauthn', 'mfa/webauthn']);

function mfaAgeSeconds(token: string): number | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const amr = JSON.parse(atob(b64 + pad)).amr as { method?: string; timestamp?: number }[] | undefined;
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

function aalFromToken(token: string): string | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return (JSON.parse(atob(b64 + pad)).aal as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * Authorise an admin-console caller at `minRole` or higher.
 *
 * `minRole: 'support'` — the ticket queue: replying and drafting are a support
 * agent's whole job, matching `ctxOrFail()` in support/actions.ts.
 * `minRole: 'admin'`  — anything that reaches a user outside a ticket they
 * opened, or that touches money/config. Matches `requireAdmin('admin')`.
 *
 * Returns the caller on success, or a denial to hand straight back to the client.
 * FAIL CLOSED: any lookup error is a denial, never a pass.
 */
export async function requireAdminCaller(
  req: Request,
  minRole: AdminRole = 'admin',
  /**
   * Seconds. When set, the second factor must ALSO have been satisfied within this
   * window — step-up authentication. Pass it from anything that moves money;
   * admin-payment-action issues refunds and voids holds and previously accepted any
   * AAL2 token of any age, which made the console's step-up gating decorative for the
   * one function where it mattered most.
   */
  maxMfaAgeSeconds?: number,
): Promise<{ ok: true; caller: AdminCaller } | { ok: false; denial: AdminDenial }> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '').trim() ?? '';
  if (!token) return { ok: false, denial: { status: 401, error: 'unauthenticated' } };

  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: { user }, error: userErr } = await service.auth.getUser(token);
  if (userErr || !user) return { ok: false, denial: { status: 401, error: 'unauthenticated' } };

  if (aalFromToken(token) !== 'aal2') {
    return { ok: false, denial: { status: 403, error: 'mfa_required' } };
  }

  if (typeof maxMfaAgeSeconds === 'number') {
    const age = mfaAgeSeconds(token);
    if (age === null || age > maxMfaAgeSeconds) {
      // A DISTINCT code from mfa_required: the console must show a code prompt and
      // retry, not tell a fully-enrolled admin to go set up MFA they already have.
      return { ok: false, denial: { status: 403, error: 'stale_mfa' } };
    }
  }

  const { data: row, error: lookupErr } = await service
    .from('admin_users')
    .select('role, status')
    .eq('user_id', user.id)
    .maybeSingle();
  // A dropped lookup must not read as "not an admin" OR as "is an admin" — deny,
  // and say so distinctly enough that the operator does not chase a phantom
  // permissions problem.
  if (lookupErr) {
    // A DISTINCT code, not 'forbidden'. Callers surface only denial.error, so
    // reusing 'forbidden' told a full admin "this needs the admin role" during a
    // transient DB outage — sending them to chase a permission they already have,
    // which is exactly what this branch's comment claims to prevent. send-push
    // already returns 'admin_check_unavailable' for the identical condition; match it
    // so both legs of a Notify-user report the same outage the same way.
    console.error('adminAuth: admin_users lookup failed — denying (fail-closed):', lookupErr);
    return { ok: false, denial: { status: 503, error: 'admin_check_unavailable' } };
  }
  if (!row) return { ok: false, denial: { status: 403, error: 'forbidden' } };
  // Mirrors admin/lib/guard.ts: a pending or disabled membership is not access.
  // Enforced here too because these functions are reachable with the admin's own
  // JWT, without going through the console.
  if (row.status !== 'active') return { ok: false, denial: { status: 403, error: 'forbidden' } };

  const role = row.role as AdminRole;
  if (minRole === 'admin' && role !== 'admin') {
    return { ok: false, denial: { status: 403, error: 'forbidden' } };
  }

  return { ok: true, caller: { user, role, service } };
}
