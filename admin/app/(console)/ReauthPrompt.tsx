"use client";

import { useState, useTransition } from "react";
import { createBrowserClient } from "@supabase/ssr";

// Step-up re-authentication.
//
// Shown when a sensitive action comes back with "stale_mfa" — the session is valid and
// the role is right, but the second factor was satisfied too long ago to prove the
// person at the keyboard is still the one who passed it. A stolen laptop, a hijacked
// cookie, or a borrowed unlocked screen all satisfy AAL2; none of them survive being
// asked for a code that is only on the operator's phone.
//
// Verifying mints a token with a fresh amr timestamp, so the retry passes without the
// operator re-entering anything else.
export default function ReauthPrompt({
  onVerified,
  onCancel,
}: {
  onVerified: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const verify = () =>
    start(async () => {
      setErr(null);
      try {
        const supa = createBrowserClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        );
        const { data: factors, error: fErr } = await supa.auth.mfa.listFactors();
        if (fErr) throw fErr;
        const totp = factors?.totp?.[0];
        if (!totp) throw new Error("No TOTP factor enrolled on this account.");
        const { error } = await supa.auth.mfa.challengeAndVerify({
          factorId: totp.id,
          code: code.trim(),
        });
        if (error) throw error;
        onVerified();
      } catch (e) {
        setErr((e as Error)?.message ?? "That code did not verify.");
      }
    });

  return (
    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="text-xs font-semibold text-amber-900">Confirm it&rsquo;s you</div>
      <p className="mt-0.5 text-xs text-amber-900">
        This action moves money or changes access, so it needs a current code from your
        authenticator — not just a valid session.
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          className="w-24 rounded border border-[var(--line)] px-2 py-1 text-sm tracking-widest"
        />
        <button
          type="button"
          disabled={pending || code.length < 6}
          onClick={verify}
          className="rounded bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          {pending ? "Verifying…" : "Verify & retry"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-[var(--muted)] underline">
          cancel
        </button>
      </div>
      {err && <p className="mt-1 text-xs text-red-700">{err}</p>}
    </div>
  );
}
