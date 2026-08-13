"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The code prompt at sign-in, on the web. Mirrors src/screens/MfaChallengeScreen.js.
//
// This page is the entire reason two-factor is worth anything on gohustlr.com. A
// password sign-in on an account with a verified factor returns a REAL session at
// aal1, and (app)/layout.tsx would otherwise let it straight through — which it did,
// until today. Enrolling on the phone protected the phone only.
//
// It carries the way back in too. "I've lost my phone" is not an edge case; it is the
// most common reason people are locked out of their own money, and a 2FA screen with
// no exit is how a support queue fills with cases nobody can verify.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabaseClient";

function formatRecoveryCode(raw: string): string {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export default function MfaPage() {
  const { session, needsMfaChallenge, clearMfaPending, signOut } = useAuth();
  const router = useRouter();

  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const recovery = mode === "recovery";

  // Nothing owed — do not strand someone on a dead prompt.
  //
  // In an EFFECT, not during render. Calling router.replace() in the render body runs
  // during Next's prerender, where there is no `location` — the build failed with
  // "ReferenceError: location is not defined". Same reason (app)/layout.tsx routes from
  // an effect and renders a spinner meanwhile.
  const stranded = !session || !needsMfaChallenge;
  useEffect(() => {
    if (!session) router.replace("/login");
    else if (!needsMfaChallenge) router.replace("/");
  }, [session, needsMfaChallenge, router]);
  if (stranded) return null;

  const submitCode = async () => {
    setBusy(true); setErr(null);
    try {
      // The `error` here is load-bearing. listFactors() is a NETWORK call, and on a
      // failed fetch it returns { data: null, error } rather than throwing. With the
      // error dropped, `factors` is null, `factor` undefined, and the next line takes
      // the "no factor after all" branch — clearing the gate WITHOUT a code. On mobile
      // that made airplane mode a 2FA bypass. A lookup that FAILED tells us nothing
      // about whether a factor exists, so it must leave the gate closed.
      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) {
        setErr("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      const factor = (factors?.totp ?? []).find((f: { id: string; status: string }) => f.status === "verified");
      if (!factor) { clearMfaPending(); router.replace("/"); return; }

      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (chErr || !ch) { setErr("Couldn't start the check. Please try again."); return; }
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: factor.id, challengeId: ch.id, code: code.trim(),
      });
      if (vErr) { setErr("That code wasn't accepted. Codes expire quickly — try the current one."); setCode(""); return; }

      clearMfaPending();
      router.replace("/");
    } catch (e) {
      setErr((e as Error).message || "Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };

  const submitRecovery = async () => {
    setBusy(true); setErr(null);
    try {
      const { data, error } = await supabase.rpc("redeem_mfa_recovery_code", { p_code: code.trim() });
      if (error) { setErr("Could not check that code."); return; }
      if (data !== true) {
        // Deliberately ONE message for "wrong code", "already used" and "too many
        // tries" — distinguishing them tells someone probing which codes exist.
        setErr("That code was not accepted. Each code works once.");
        return;
      }
      // The code removed the factor server-side, so this session is no longer waiting
      // on one. They are password-only now and the Security screen says so.
      clearMfaPending();
      router.replace("/");
    } catch (e) {
      setErr((e as Error).message || "Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };

  const disabled = busy || (recovery ? code.length < 9 : code.length !== 6);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-6 flex size-16 items-center justify-center rounded-full bg-primary/10 text-3xl">🛡️</div>

      <h1 className="text-2xl font-extrabold text-ink">
        {recovery ? "Use a recovery code" : "Enter your code"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        {recovery
          ? "Enter one of the codes you saved when you turned on two-factor. Each works once, and using one turns two-factor off so you can set it up again on your new phone."
          : "Open your authenticator app and enter the 6-digit code for GoHustlr."}
      </p>

      <input
        value={code}
        onChange={(e) =>
          setCode(recovery ? formatRecoveryCode(e.target.value) : e.target.value.replace(/\D/g, "").slice(0, 6))
        }
        inputMode={recovery ? "text" : "numeric"}
        autoComplete={recovery ? "off" : "one-time-code"}
        autoFocus
        placeholder={recovery ? "ABCD-EFGH" : "000000"}
        maxLength={recovery ? 9 : 6}
        onKeyDown={(e) => { if (e.key === "Enter" && !disabled) (recovery ? submitRecovery : submitCode)(); }}
        className="mt-6 w-full rounded-xl bg-white py-4 text-center text-2xl tracking-[0.4em] text-ink shadow-sm outline-none ring-1 ring-line focus:ring-2 focus:ring-primary"
      />

      {err && <p className="mt-3 text-center text-sm font-semibold text-urgent">{err}</p>}

      <button
        onClick={recovery ? submitRecovery : submitCode}
        disabled={disabled}
        className="mt-5 w-full cursor-pointer rounded-full bg-primary py-4 text-base font-extrabold text-white transition hover:opacity-90 disabled:opacity-45"
      >
        {busy ? "Checking…" : "Continue"}
      </button>

      <button
        onClick={() => { setMode(recovery ? "code" : "recovery"); setCode(""); setErr(null); }}
        className="mt-6 cursor-pointer text-sm font-bold text-primary"
      >
        {recovery ? "I have my authenticator — enter a code" : "I've lost my phone"}
      </button>

      <button onClick={() => signOut()} className="mt-7 cursor-pointer text-[13px] font-semibold text-ink-soft">
        Sign out
      </button>
    </main>
  );
}
