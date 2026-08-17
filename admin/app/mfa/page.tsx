"use client";

// ─────────────────────────────────────────────────────────────────────────────
// TOTP gate. Every admin session must reach AAL2 here before the console renders
// anything (enforced server-side in lib/guard.ts — this page is just the way through).
// First login: enroll (QR + verify + recovery codes). Later logins: challenge.
//
// Rewritten 2026-08-17 after an invited admin got stuck on it. Four defects, all of
// them the same shape: this page was written as the happy path of the mobile and web
// screens and inherited none of what those two learned.
//
// ── 1. A FAILED listFactors() ENROLLED A SECOND FACTOR ──────────────────────
// `const { data: factors } = await supabase.auth.mfa.listFactors()` dropped the error.
// listFactors is a NETWORK call that returns { data: null, error } rather than throwing,
// so a request that merely FAILS produced `factors = null`, `verified = undefined`, and
// fell straight through to enroll() — handing whoever holds the password a brand-new
// authenticator, and aal2 the moment they verify it. Blocking one XHR is a devtools
// checkbox.
//
// Nothing stopped it: the app enrols as friendlyName 'GoHustlr' (src/lib/mfa.js:96) and
// this page as 'GoHustlr Admin', so the uniqueness constraint that would have collided
// does not, and gotrue is happy to hold both. web/app/mfa/page.tsx carries this exact
// guard with a comment recording that the same bug made airplane mode a 2FA bypass on
// mobile. The console never got it. A lookup that FAILED tells us nothing about whether
// a factor exists, so it must leave the gate closed.
//
// ── 2. NO WAY OFF THE PAGE ──────────────────────────────────────────────────
// No sign-out, no "not you?". Every redirect here is router.replace(), which writes no
// history entry, so Back lands on /login — where the session is still live, so signing
// in returns you to this screen. An admin without the code was in a loop with no exit
// and no way to reach the login form as somebody else. Both the app and web screens
// have carried a Sign out button since they were written.
//
// ── 3. ENROLMENT MINTED NO RECOVERY CODES ───────────────────────────────────
// CLAUDE.md: "Recovery codes are generated AT enrollment, not offered later — 2FA
// without a way back in turns a lost phone into a lost account." That is what
// SecurityScreen does. This page enrolled a factor and stopped, so every admin who
// enrolled through the console has zero codes and no recovery path at all — which is
// precisely how today's lockout became unrecoverable without database access.
//
// ── 4. THE CHALLENGE NEVER SAID WHAT IT WAS CHALLENGING ─────────────────────
// The person is asked for a code from an authenticator the screen will not name or
// date. The console and the app share one Supabase auth project, so the factor may have
// been enrolled on either — and if it was enrolled by neither, that is a compromised
// password rather than a forgotten one. Showing when the factor appeared is the only
// way the human on the other end can tell those apart.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabaseBrowser";
import { signOutAction } from "../auth-actions";

type Mode = "loading" | "enroll" | "challenge" | "recovery" | "codes" | "blocked";

function formatRecoveryCode(raw: string): string {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export default function MfaPage() {
  const router = useRouter();
  const supabase = getBrowserSupabase();
  // Enroll is not idempotent (friendlyName is unique per user). React strict
  // mode double-invokes effects in dev, and any remount could re-enter — run
  // bootstrap at most once per mount so we never double-enroll and collide.
  const started = useRef(false);

  const [mode, setMode] = useState<Mode>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrolledAt, setEnrolledAt] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bootstrap = useCallback(async () => {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!aal || aal.currentLevel === null) {
      router.replace("/login");
      return;
    }
    if (aal.currentLevel === "aal2") {
      router.replace("/");
      router.refresh();
      return;
    }

    const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
    // FAIL CLOSED. See (1) above: treating an unreadable factor list as "no factors"
    // is what turned a dropped request into a fresh authenticator for the caller.
    if (listErr) {
      setError("Couldn't check this account's authenticator. Check your connection and reload — you have not been signed out.");
      setMode("blocked");
      return;
    }

    const verified = factors?.totp?.find((f) => f.status === "verified");
    if (verified) {
      setFactorId(verified.id);
      setEnrolledAt(verified.created_at ?? null);
      setMode("challenge");
      return;
    }

    // Clear abandoned half-enrollments so we always present one fresh QR.
    for (const f of factors?.all ?? []) {
      if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data: enrolled, error: enrollErr } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "GoHustlr Admin",
    });
    if (enrollErr || !enrolled) {
      setError(enrollErr?.message ?? "Could not start enrollment.");
      setMode("blocked");
      return;
    }
    setFactorId(enrolled.id);
    setQr(enrolled.totp.qr_code);
    setSecret(enrolled.totp.secret);
    setMode("enroll");
  }, [router, supabase]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // On-mount sync with the external auth system (all setState happens after
    // awaits, never synchronously in the effect body).
    void bootstrap();
  }, [bootstrap]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    const enrolling = mode === "enroll";
    setBusy(true);
    setError(null);
    // Record which factor this account enrolled, so an existing admin can see on
    // /team what appeared and when before activating the membership. Best-effort and
    // fire-and-forget: it must never block the person from signing in, and it grants
    // nothing on its own — activation is a separate human decision.
    void supabase.rpc("admin_record_mfa_enrollment", { p_factor_id: factorId });

    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr || !challenge) {
      setBusy(false);
      setError(chErr?.message ?? "Challenge failed.");
      return;
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    if (vErr) {
      setBusy(false);
      setError("Invalid code — try again.");
      setCode("");
      return;
    }

    // ── Recovery codes, at enrollment, before they ever leave this screen ────
    //
    // generate_mfa_recovery_codes requires aal2 whenever a verified factor exists
    // (20260813070000) — minting the codes that dismantle 2FA is exactly what an
    // attacker at aal1 would want. verify() has just re-keyed this session to aal2,
    // which is the one moment it is both permitted and owed. Same ordering as
    // SecurityScreen.
    if (enrolling) {
      const { data, error: genErr } = await supabase.rpc("generate_mfa_recovery_codes", { p_count: 10 });
      setBusy(false);
      // A failure here must not block sign-in — the factor is verified and the
      // session is good. It has to be SAID, though: silently continuing is how the
      // console ended up full of admins with no way back in.
      setCodes(Array.isArray(data) ? (data as string[]) : []);
      if (genErr || !Array.isArray(data) || data.length === 0) {
        setError("Signed in, but recovery codes could not be created. Generate them in the GoHustlr app under You → Settings → Security before you lose this device.");
      }
      setMode("codes");
      return;
    }

    setBusy(false);
    router.replace("/");
    router.refresh();
  }

  async function submitRecovery(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: rErr } = await supabase.rpc("redeem_mfa_recovery_code", { p_code: code.trim() });
    if (rErr) {
      setBusy(false);
      setError("Could not check that code.");
      return;
    }
    if (data !== true) {
      setBusy(false);
      // Deliberately ONE message for "wrong code", "already used" and "too many
      // tries" — distinguishing them tells someone probing which codes exist.
      setError("That code was not accepted. Each code works once.");
      setCode("");
      return;
    }
    // The factor is gone server-side, but this session still remembers it: the AAL
    // helpers read the cached user.factors, so without a refresh the gate keeps
    // computing "has a factor, hasn't satisfied it" and burns a second code from a
    // set that is already the last resort. Same fix as src/lib/mfa.js.
    await supabase.auth.refreshSession().catch(() => {});
    setBusy(false);
    setCode("");
    setError(null);
    setFactorId(null);
    setEnrolledAt(null);
    setMode("loading");
    // Re-enter with no factor on the account: bootstrap now takes the enroll branch
    // and hands them a fresh QR, which is the whole point of spending the code.
    await bootstrap();
  }

  async function confirmCodes() {
    setBusy(true);
    // Non-throwing by design: they already HAVE the codes on screen, and the only
    // consequence of failure is that a previous batch lives a little longer.
    await supabase.rpc("confirm_mfa_recovery_codes");
    setBusy(false);
    router.replace("/");
    router.refresh();
  }

  const qrSrc = qr?.startsWith("data:") ? qr : qr ? `data:image/svg+xml;utf8,${encodeURIComponent(qr)}` : null;
  const recovering = mode === "recovery";
  const showForm = mode === "enroll" || mode === "challenge" || mode === "recovery";
  const submitDisabled = busy || (recovering ? code.trim().length < 8 : code.trim().length < 6);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">
          {mode === "codes" ? "Save your recovery codes" : recovering ? "Use a recovery code" : "Two-factor authentication"}
        </h1>

        {mode === "loading" && <p className="text-sm text-[var(--muted)]">Checking your session…</p>}

        {mode === "blocked" && (
          <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>
        )}

        {mode === "enroll" && (
          <>
            <p className="mb-4 text-sm text-[var(--muted)]">
              Admin access requires an authenticator app. Scan this QR code with
              1Password, Google Authenticator, or similar — then enter the 6-digit code.
            </p>
            {qrSrc && (
              <img src={qrSrc} alt="TOTP enrollment QR code" className="mx-auto mb-2 h-44 w-44" />
            )}
            {secret && (
              <p className="mb-4 break-all text-center text-xs text-[var(--muted)]">
                Manual entry: <code>{secret}</code>
              </p>
            )}
          </>
        )}

        {mode === "challenge" && (
          <>
            <p className="mb-2 text-sm text-[var(--muted)]">Enter the 6-digit code from your authenticator app.</p>
            {/* Which authenticator, and from when. Without this the screen asks for a
                code from something it refuses to name, and the person cannot tell a
                forgotten setup from a factor somebody else enrolled with their
                password — which is the failure the pending-membership status exists
                to contain. */}
            <p className="mb-4 text-xs text-[var(--muted)]">
              {enrolledAt
                ? `This account's authenticator was added on ${new Date(enrolledAt).toLocaleString()}. It may have been set up here or in the GoHustlr app — both use the same login. If that wasn't you, don't enter a code: change your password and tell an admin.`
                : "It may have been set up here or in the GoHustlr app — both use the same login."}
            </p>
          </>
        )}

        {mode === "recovery" && (
          <p className="mb-4 text-sm text-[var(--muted)]">
            Enter one of the codes you saved when you turned on two-factor. Each works
            once, and using one turns two-factor off so you can set it up again here.
          </p>
        )}

        {mode === "codes" && (
          <>
            <p className="mb-4 text-sm text-[var(--muted)]">
              Each code works once and gets you back in if you lose your authenticator.
              They are shown here and nowhere else — save them somewhere that is not
              this device.
            </p>
            {codes.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 font-mono text-xs">
                {codes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            )}
            {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}
            <button
              type="button"
              onClick={confirmCodes}
              disabled={busy}
              className="w-full rounded-lg bg-[var(--brand)] py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "I've saved these — continue"}
            </button>
          </>
        )}

        {showForm && (
          <form onSubmit={recovering ? submitRecovery : verify}>
            <input
              inputMode={recovering ? "text" : "numeric"}
              autoComplete={recovering ? "off" : "one-time-code"}
              pattern={recovering ? undefined : "[0-9]*"}
              maxLength={recovering ? 9 : 6}
              required
              value={code}
              onChange={(e) =>
                setCode(recovering ? formatRecoveryCode(e.target.value) : e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-center text-lg tracking-[0.5em] outline-none focus:border-[var(--brand)]"
              placeholder={recovering ? "ABCD-EFGH" : "••••••"}
            />
            {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}
            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full rounded-lg bg-[var(--brand)] py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}

        {(mode === "challenge" || mode === "recovery") && (
          <button
            type="button"
            onClick={() => {
              setMode(recovering ? "challenge" : "recovery");
              setCode("");
              setError(null);
            }}
            className="mt-5 w-full cursor-pointer text-center text-sm font-semibold text-[var(--brand)]"
          >
            {recovering ? "I have my authenticator — enter a code" : "I've lost my authenticator"}
          </button>
        )}

        {/* The exit. Every redirect on this page is router.replace(), so Back reaches
            /login with the session still live and signing in returns straight here —
            without this button an admin who cannot produce a code has no way to reach
            the login form as anybody else. Server action, same as /denied, so the
            cookie the server reads is actually cleared. */}
        {mode !== "codes" && (
          <form action={signOutAction} className="mt-6 border-t border-[var(--line)] pt-4">
            <button type="submit" className="w-full cursor-pointer text-center text-[13px] font-semibold text-[var(--muted)]">
              Sign out and use a different account
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
