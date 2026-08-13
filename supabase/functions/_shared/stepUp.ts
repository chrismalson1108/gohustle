// ─────────────────────────────────────────────────────────────────────────────
// Step-up for the actions that can REDIRECT someone's money.
//
// ── WHY NOT "REQUIRE MFA FOR PAYMENTS" ──────────────────────────────────────
//
// Blocking a payout on whether the earner set up an authenticator strands their
// money for our benefit. They did the work; withholding it because of our security
// posture is the wrong party bearing the cost, and it rebuilds the "where is my
// money" support queue. On the poster side a fraudulent charge is bounded and
// reversible through the card network. Neither is the real threat.
//
// ── WHAT THE REAL THREAT IS ─────────────────────────────────────────────────
//
// An attacker holding a session cannot easily pull money OUT — captured funds move
// to a Stripe Connect account they do not control. What they can do is change where
// future money goes:
//
//   steal session → mint an Express dashboard link → change the bank → wait for payday
//
// Four steps, no friction, and the victim finds out when a payout does not arrive.
// This is the documented account-takeover pattern across gig platforms, and the
// dashboard link was mintable from any valid token.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
// IF the account has a verified factor, the session must have satisfied it (aal2).
// If it has no factor, the request proceeds — nobody is locked out of their own bank
// details for not having enrolled, which would be the same "our posture, their cost"
// mistake in a different place. The app prompts hard for enrolment at exactly this
// moment instead, which is when the account first becomes worth stealing.
//
// So MFA stays optional, and is enforced where it actually protects money.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** The `aal` claim, read straight from the access token (local decode, no round-trip). */
export function aalFromToken(token: string): string | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return (JSON.parse(atob(b64 + pad)).aal as string) ?? null;
  } catch {
    return null;
  }
}

export interface StepUpResult {
  ok: boolean;
  status?: number;
  body?: Record<string, unknown>;
}

/**
 * Enforce step-up for a money-redirecting action.
 *
 * FAILS CLOSED on a lookup error. If we cannot tell whether this account has a
 * factor, we must not assume it does not — that is precisely the answer an attacker
 * benefits from, and the cost of being wrong the other way is one retry.
 */
export async function requireStepUp(
  service: SupabaseClient,
  userId: string,
  token: string,
): Promise<StepUpResult> {
  const { data: factors, error } = await service
    .schema('auth')
    .from('mfa_factors')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'verified')
    .limit(1);

  if (error) {
    console.error('stepUp: factor lookup failed — refusing (fail-closed):', error);
    return {
      ok: false,
      status: 503,
      body: { error: 'mfa_check_unavailable', message: 'Could not verify your account security. Try again in a moment.' },
    };
  }

  // No factor: proceed. See the header — refusing here would lock someone out of
  // their own payout details for a choice we told them was optional.
  if (!factors || factors.length === 0) return { ok: true };

  if (aalFromToken(token) !== 'aal2') {
    return {
      ok: false,
      status: 403,
      body: {
        // The app keys on this to route to the code prompt rather than showing a
        // dead-end error.
        error: 'MFA_REQUIRED',
        message: 'Enter your authenticator code to change payout details.',
      },
    };
  }

  return { ok: true };
}

/** Service-role client for the lookup above. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}
