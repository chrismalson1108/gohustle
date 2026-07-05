"use client";

// TOTP gate. Every admin session must reach AAL2 here before the console
// renders anything (enforced server-side in lib/guard.ts — this page is just
// the way through). First login: enroll (QR + verify). Later logins: challenge.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabaseBrowser";

type Mode = "loading" | "enroll" | "challenge";

export default function MfaPage() {
  const router = useRouter();
  const supabase = getBrowserSupabase();
  // Enroll is not idempotent (friendlyName is unique per user). React strict
  // mode double-invokes effects in dev, and any remount could re-enter — run
  // bootstrap at most once per mount so we never double-enroll and collide.
  const started = useRef(false);

  const [mode, setMode] = useState<Mode>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
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

    const { data: factors } = await supabase.auth.mfa.listFactors();
    const verified = factors?.totp?.find((f) => f.status === "verified");
    if (verified) {
      setFactorId(verified.id);
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
    setBusy(true);
    setError(null);
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
    setBusy(false);
    if (vErr) {
      setError("Invalid code — try again.");
      setCode("");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  const qrSrc = qr?.startsWith("data:") ? qr : qr ? `data:image/svg+xml;utf8,${encodeURIComponent(qr)}` : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">Two-factor authentication</h1>
        {mode === "loading" && <p className="text-sm text-[var(--muted)]">Checking your session…</p>}

        {mode === "enroll" && (
          <>
            <p className="mb-4 text-sm text-[var(--muted)]">
              Admin access requires an authenticator app. Scan this QR code with
              1Password, Google Authenticator, or similar — then enter the 6-digit code.
            </p>
            {qrSrc && (
              // eslint-disable-next-line @next/next/no-img-element
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
          <p className="mb-4 text-sm text-[var(--muted)]">Enter the 6-digit code from your authenticator app.</p>
        )}

        {mode !== "loading" && (
          <form onSubmit={verify}>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-center text-lg tracking-[0.5em] outline-none focus:border-[var(--brand)]"
              placeholder="••••••"
            />
            {error && <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>}
            <button
              type="submit"
              disabled={busy || code.trim().length < 6}
              className="w-full rounded-lg bg-[var(--brand)] py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
