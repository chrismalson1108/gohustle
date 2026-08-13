// ─────────────────────────────────────────────────────────────────────────────
// Two-factor authentication for the app.
//
// WHY AN APP LIKE THIS NEEDS IT: a GoHustlr account is attached to a bank payout
// destination and a saved card. Taking one over is not reading someone's messages,
// it is redirecting their earnings — and the victim finds out on payday.
//
// ── ENROLLING ON THE DEVICE YOU ARE ENROLLING FROM ──────────────────────────
//
// Every 2FA guide shows a QR code because it assumes two screens: a laptop showing
// the code and a phone scanning it. On a phone there is one screen, and it cannot
// photograph itself. Handing someone a QR they physically cannot scan is the single
// most common way mobile 2FA setup fails.
//
// So the order here is deliberately the reverse of the web:
//   1. DEEP LINK  — otpauth:// handed to the OS, which offers every installed
//                   authenticator (Google Authenticator, 1Password, Authy, Duo…).
//                   One tap, secret transferred, nothing typed.
//   2. COPY KEY   — for password managers that do not register the scheme, or for
//                   someone who prefers to paste.
//   3. QR         — last, and labelled for what it is actually good for: scanning
//                   from a DIFFERENT device.
//
// ── ABOUT THE LOGO IN THE AUTHENTICATOR APP ─────────────────────────────────
//
// A common and reasonable assumption is that scanning the QR transfers our logo. It
// does not. An otpauth:// URI carries only the issuer, the account label, the secret
// and the algorithm — there is no image field in the spec, and the QR is just that
// text encoded. Authenticators that show logos (1Password, Authy, Microsoft
// Authenticator) match the ISSUER STRING against their own icon catalogues; Google
// Authenticator shows no logo at all.
//
// What we control is that the issuer reads exactly "GoHustlr" and the account line
// shows their email, so the entry is unmistakable in a list of twenty. Getting an
// actual icon means being added to those apps' catalogues, which is a submission to
// each vendor, not something the code can do.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase';

export class MfaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Current 2FA state for the signed-in user. */
export async function fetchMfaStatus() {
  const [{ data: factors, error: fErr }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (fErr) throw new MfaError('Could not check your security settings.', 'list_failed');

  const verified = (factors?.totp ?? []).filter((f) => f.status === 'verified');
  let recovery = { remaining: 0, total: 0, generatedAt: null };
  try {
    const { data } = await supabase.from('my_mfa_recovery_status').select('*').maybeSingle();
    if (data) {
      recovery = { remaining: data.remaining ?? 0, total: data.total ?? 0, generatedAt: data.generated_at };
    }
  } catch (_) {
    // A recovery-status hiccup must not make 2FA look off when it is on.
  }

  return {
    enabled: verified.length > 0,
    factors: verified.map((f) => ({ id: f.id, name: f.friendly_name, createdAt: f.created_at })),
    currentLevel: aal?.currentLevel ?? null,
    nextLevel: aal?.nextLevel ?? null,
    // True when this session has a factor but has not satisfied it yet.
    challengeRequired: Boolean(aal && aal.nextLevel === 'aal2' && aal.currentLevel === 'aal1'),
    recovery,
  };
}

/**
 * Begin enrollment. Returns everything the three setup routes need.
 *
 * Abandoned half-enrollments are cleared first: Supabase keeps an `unverified`
 * factor if someone backs out, and a second attempt would otherwise fail with
 * "factor already exists" and strand them with a broken setup screen.
 */
export async function startEnrollment() {
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    // What the authenticator app will LIST it as. Worth being deliberate: this is the
    // only branding we can actually put in there.
    friendlyName: 'GoHustlr',
    issuer: 'GoHustlr',
  });
  if (error) {
    throw new MfaError(
      /already exists/i.test(error.message)
        ? 'Two-factor is already being set up. Close this and try again.'
        : error.message || 'Could not start two-factor setup.',
      'enroll_failed',
    );
  }
  return {
    factorId: data.id,
    // otpauth://totp/GoHustlr:you@example.com?secret=…&issuer=GoHustlr
    uri: data.totp?.uri ?? null,
    secret: data.totp?.secret ?? null,
    qrSvg: data.totp?.qr_code ?? null,
  };
}

/** Confirm the 6-digit code, which is what actually turns 2FA on. */
export async function confirmEnrollment(factorId, code) {
  const clean = String(code ?? '').replace(/\D/g, '');
  if (clean.length !== 6) throw new MfaError('Enter the 6-digit code.', 'bad_code');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: clean });
  if (error) {
    throw new MfaError(
      // The overwhelmingly likely cause, and the one people never think of.
      'That code was not accepted. Codes change every 30 seconds — try the current one, and check your phone’s clock is set automatically.',
      'verify_failed',
    );
  }
}

/** Satisfy an existing factor at sign-in. */
export async function verifyChallenge(factorId, code) {
  return confirmEnrollment(factorId, code);
}

/** Turn 2FA off. Requires a current code, so a borrowed session cannot do it. */
export async function disableMfa(factorId, code) {
  await confirmEnrollment(factorId, code);
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw new MfaError('Could not turn off two-factor.', 'unenroll_failed');
}

/** Fresh recovery codes. Shown ONCE; generating again retires the previous set. */
export async function generateRecoveryCodes() {
  const { data, error } = await supabase.rpc('generate_mfa_recovery_codes', { p_count: 10 });
  if (error) throw new MfaError('Could not create recovery codes.', 'codes_failed');
  return data ?? [];
}

/**
 * Spend a recovery code when the authenticator is gone.
 *
 * A code cannot mint AAL2 — only the TOTP secret can — so this REMOVES the factor and
 * drops the account to password-only. The user signs in normally and enrols a new
 * device. Returning a bare boolean is deliberate: a distinct "no such code" would let
 * someone probe which codes exist.
 */
export async function redeemRecoveryCode(code) {
  const { data, error } = await supabase.rpc('redeem_mfa_recovery_code', { p_code: String(code ?? '').trim() });
  if (error) throw new MfaError('Could not check that code.', 'redeem_failed');
  return data === true;
}

/** Formats a code the way people read it back: ABCD-EFGH. */
export function formatRecoveryCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
