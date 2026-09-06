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
import { factorLabel, preferredFactor } from "@/lib/mfa";

// /browse, not "/". The root route is the MARKETING landing page — it has no session
// check and renders the signed-out hero — so every navigation on this screen dropped a
// freshly-verified user onto a page that looks logged out. Reported 2026-08-17: "typed in
// MFA, it took me back to home screen, but when I clicked sign in it took me right back
// logged in", which is /login line 49 seeing the session it already had.
//
// Every other gate — login, onboarding, consent, and the app layout — already lands on
// /browse. This screen was the only one of the five that did not, in all four of its
// navigations.
const HOME = "/browse";

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
  // Which entry in the authenticator we are about to challenge, so the copy can NAME it.
  // Presentational only — submitCode does its own authoritative, fail-closed lookup.
  const [entry, setEntry] = useState<{ label: string; count: number } | null>(null);

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
    else if (!needsMfaChallenge) router.replace(HOME);
  }, [session, needsMfaChallenge, router]);
  // Names the entry BEFORE the first attempt, so an admin holding two is not left
  // guessing which of them this gate wants. A failed lookup simply leaves the copy
  // generic; it must not change what the screen does, and the gate holds either way.
  useEffect(() => {
    if (stranded) return;
    let alive = true;
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (!alive || error) return;
      const verified = (data?.totp ?? []).filter((f) => f.status === "verified");
      const picked = preferredFactor(verified.map((f) => ({ ...f, name: f.friendly_name ?? null })));
      if (picked) setEntry({ label: factorLabel(picked), count: verified.length });
    })();
    return () => { alive = false; };
  }, [stranded]);

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
      // preferredFactor, not "whichever GoTrue listed first". An account can hold two
      // verified TOTP factors — this site and the app enrol as "GoHustlr", the admin
      // console as "GoHustlr Admin" — and the copy above names the entry to open, so
      // picking by list order challenged one entry while naming the other. The code only
      // verifies against the factor it is challenged with, so the result was a correct
      // code reading as wrong.
      const verified = (factors?.totp ?? []).filter(
        (f: { id: string; status: string }) => f.status === "verified",
      );
      const factor = preferredFactor(
        verified.map((f: { id: string; friendly_name?: string | null }) => ({ ...f, name: f.friendly_name ?? null })),
      );
      if (!factor) { clearMfaPending(); router.replace(HOME); return; }
      setEntry({ label: factorLabel(factor), count: verified.length });

      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (chErr || !ch) { setErr("Couldn't start the check. Please try again."); return; }
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: factor.id, challengeId: ch.id, code: code.trim(),
      });
      if (vErr) { setErr("That code wasn't accepted. Codes expire quickly — try the current one."); setCode(""); return; }

      clearMfaPending();
      router.replace(HOME);
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
      // The factor is gone in the database, but THIS BROWSER'S stored session still
      // remembers it. getAuthenticatorAssuranceLevel() derives nextLevel from the cached
      // `user.factors` and currentLevel from the JWT's aal claim, and the RPC updates
      // neither — so clearMfaPending() below lifts the gate for this render only. Reload
      // the tab, or open a second one, and the AAL effect in lib/auth.tsx re-reads the
      // stale user, computes "has a factor, hasn't satisfied it" again, and (app)/layout
      // sends them back here. With the authenticator gone their only route is another
      // code, out of a ten-code set that is already the last resort.
      //
      // Refreshing re-reads the user server-side, where the factor list is now empty; the
      // new access token also re-keys that effect, so the gate re-derives itself instead
      // of resting on the optimistic clear. Same fix as src/lib/mfa.js and the console.
      //
      // Never fail the redemption over this: the code is spent and 2FA is off either way,
      // and throwing here would show a failure message for the thing that just worked.
      await supabase.auth.refreshSession().catch(() => {});

      // The code removed the factor server-side, so this session is no longer waiting
      // on one. They are password-only now and the Security screen says so.
      clearMfaPending();
      router.replace(HOME);
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
          : `Open your authenticator app and enter the 6-digit code for “${entry?.label ?? "GoHustlr"}”.`}
      </p>

      {/* Only when there IS more than one entry — saying it to everyone sends a normal
          user hunting for a second GoHustlr they do not have. */}
      {!recovery && (entry?.count ?? 0) > 1 && (
        <p className="mt-2 text-sm font-semibold leading-relaxed text-ink-soft">
          You have more than one GoHustlr entry — this sign-in needs the one named
          “{entry?.label}”.
        </p>
      )}

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
