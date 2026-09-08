// ─────────────────────────────────────────────────────────────────────────────
// Two-factor, on the web — the data half of src/lib/mfa.js.
//
// The web could FORCE you through two-factor and could not help you manage it:
// web/app/mfa/page.tsx has challenged every web sign-in since it was written, and there
// was no page anywhere on gohustlr.com to turn 2FA on, off, or mint recovery codes. The
// only surface that could was the mobile app.
//
// That is not a cosmetic gap. It bit on 2026-08-17: an admin needed recovery codes, the
// simulator's dev client was a stale SDK 54 binary, and the answer to "just generate
// them" turned out to be "you can't, from here, at all". Anyone without a current build
// of the app was in the same position.
//
// ── WHAT DIFFERS FROM MOBILE, AND WHY ───────────────────────────────────────
// The QR is the PRIMARY route here, which is the exact reverse of the app. A phone has
// one screen and cannot photograph itself, so mobile leads with the otpauth:// deep link
// and treats the QR as a fallback for scanning from another device. On a laptop the
// second screen is the whole point — the QR is what works, and the setup key is the
// fallback for a password manager that would rather be pasted into.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "./supabaseClient";

export class MfaError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export interface MfaFactorSummary {
  id: string;
  name: string | null;
  createdAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE ACCOUNT CAN HOLD TWO VERIFIED FACTORS, AND THAT IS THE STEADY STATE.
//
// This page and the app enrol as "GoHustlr"; the admin console enrols as
// "GoHustlr Admin". /team already refuses to alert on two factors for that reason. So
// "the factor" is the wrong model: unenrolling factors[0] and announcing "password-only"
// leaves the OTHER one still gating every sign-in, and a code from the wrong entry is
// rejected outright, because challengeAndVerify is scoped to the factorId it is handed.
//
// Mirrors factorLabel / factorOrigin / preferredFactor in src/lib/mfa.js.
// ─────────────────────────────────────────────────────────────────────────────

/** What the app and the website enrol as — the entry a normal user has. */
export const APP_FACTOR_NAME = "GoHustlr";
/** What the admin console enrols as. Present only on staff accounts. */
export const ADMIN_FACTOR_NAME = "GoHustlr Admin";

/** The name the entry carries in the authenticator's list. */
export function factorLabel(factor: { name?: string | null } | null | undefined): string {
  return String(factor?.name ?? "").trim() || APP_FACTOR_NAME;
}

/** Which surface enrolled it, in words a person can act on. */
export function factorOrigin(factor: { name?: string | null } | null | undefined): string {
  return factorLabel(factor) === ADMIN_FACTOR_NAME
    ? "set up on the admin console"
    : "set up in the app or here";
}

/** The factor a surface should act on by default — this one's own entry, not the console's. */
export function preferredFactor<T extends { name?: string | null }>(
  factors: readonly T[] | null | undefined,
): T | null {
  const list = (factors ?? []).filter(Boolean);
  return list.find((f) => factorLabel(f) === APP_FACTOR_NAME) ?? list[0] ?? null;
}

export interface MfaStatus {
  enabled: boolean;
  factors: MfaFactorSummary[];
  currentLevel: string | null;
  nextLevel: string | null;
  recovery: { remaining: number; total: number; generatedAt: string | null };
}

/** Current 2FA state for the signed-in user. Mirrors fetchMfaStatus in src/lib/mfa.js. */
export async function fetchMfaStatus(): Promise<MfaStatus> {
  const [{ data: factors, error: fErr }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  // The error is load-bearing, same as on the challenge screen: listFactors is a network
  // call that returns { data: null, error } rather than throwing, and treating a failed
  // lookup as "no factors" is what turns a dropped request into a screen that offers to
  // enrol a SECOND authenticator on an account that already has one.
  if (fErr) throw new MfaError("Could not check your security settings.", "list_failed");

  const verified = (factors?.totp ?? []).filter((f) => f.status === "verified");

  let recovery = { remaining: 0, total: 0, generatedAt: null as string | null };
  try {
    const { data } = await supabase.from("my_mfa_recovery_status").select("*").maybeSingle();
    if (data) {
      recovery = {
        remaining: data.remaining ?? 0,
        total: data.total ?? 0,
        generatedAt: data.generated_at ?? null,
      };
    }
  } catch {
    // A recovery-status hiccup must not make 2FA look off when it is on.
  }

  return {
    enabled: verified.length > 0,
    factors: verified.map((f) => ({
      id: f.id,
      name: f.friendly_name ?? null,
      createdAt: f.created_at ?? null,
    })),
    currentLevel: aal?.currentLevel ?? null,
    nextLevel: aal?.nextLevel ?? null,
    recovery,
  };
}

export interface Enrollment {
  factorId: string;
  qr: string | null;
  secret: string | null;
  uri: string | null;
}

/**
 * Begin enrollment.
 *
 * Abandoned half-enrollments are cleared first: Supabase keeps an `unverified` factor
 * around, and its friendly name is unique per user, so a second attempt would collide
 * with the corpse of the first and fail for a reason that reads like nothing.
 */
export async function startEnrollment(): Promise<Enrollment> {
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) {
    if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }

  // The SAME friendly name the app uses. It is how /team reads which surface a factor
  // came from, and enrolling under a third name would make that column lie.
  //
  // `issuer` is separate and NOT optional in practice. friendly_name is stored on our
  // side; the only thing that reaches the authenticator is the otpauth issuer, and when
  // it is omitted GoTrue falls back to the Site URL's HOST. Measured against production
  // 2026-09-09:
  //   omitted → otpauth://totp/gohustlr.com:you@x.com?…&issuer=gohustlr.com
  //   set     → otpauth://totp/GoHustlr:you@x.com?…&issuer=GoHustlr
  // So the website used to file itself under "gohustlr.com" while SecurityScreen and
  // MfaChallengeScreen both tell the user to open the entry called "GoHustlr" — a name
  // that was not in their authenticator.
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: APP_FACTOR_NAME,
    issuer: APP_FACTOR_NAME,
  });
  if (error || !data) throw new MfaError(error?.message ?? "Could not start setup.", "enroll_failed");

  return {
    factorId: data.id,
    qr: data.totp?.qr_code ?? null,
    secret: data.totp?.secret ?? null,
    uri: data.totp?.uri ?? null,
  };
}

/** Finish enrollment with a code from the authenticator. */
export async function confirmEnrollment(factorId: string, code: string): Promise<void> {
  const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
  if (chErr || !ch) throw new MfaError("Could not start the check. Please try again.", "challenge_failed");
  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: ch.id,
    code: String(code ?? "").trim(),
  });
  if (error) throw new MfaError("That code wasn't accepted. Codes expire quickly — try the current one.", "verify_failed");
}

/**
 * Remove ONE factor. Requires a current code from THAT factor, so a stolen session alone
 * cannot do it — and so the caller must be deliberate about which entry it removes.
 *
 * Two-factor is off only once the last one is gone. Callers must re-read the status
 * rather than announcing "password-only" on the strength of having called this.
 */
export async function disableMfa(factorId: string, code: string): Promise<void> {
  await confirmEnrollment(factorId, code);
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw new MfaError("Could not turn off two-factor.", "unenroll_failed");
}

/**
 * Fresh recovery codes, shown ONCE.
 *
 * The previous set stays VALID until confirmRecoveryCodes() runs. Generation used to
 * delete first and then return the new codes, so a lost response — a dropped connection,
 * a closed tab — left the old set destroyed and the new one existing only as hashes
 * nobody had ever seen. Zero usable codes, on the one feature whose entire job is being
 * the way back in.
 */
export async function generateRecoveryCodes(): Promise<string[]> {
  const { data, error } = await supabase.rpc("generate_mfa_recovery_codes", { p_count: 10 });
  if (error) throw new MfaError("Could not create recovery codes.", "codes_failed");
  return (data as string[]) ?? [];
}

/**
 * "I have received and saved these" — retires the PREVIOUS batch.
 *
 * Delivery, not generation, is the point of no return. Deliberately non-throwing: by the
 * time it runs the user already HAS their new codes, and the only consequence of failure
 * is that the previous batch lives a little longer. Surfacing an error here would tell
 * someone staring at a valid set of codes that something went wrong with them.
 */
export async function confirmRecoveryCodes(): Promise<boolean> {
  const { error } = await supabase.rpc("confirm_mfa_recovery_codes");
  return !error;
}
