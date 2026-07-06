"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { getRecoveryClient } from "@/lib/supabaseClient";
import { friendlyAuthError } from "@/lib/authErrors";
import Logo from "@/components/Logo";
import Button from "@/components/ui/Button";
import { Label, FieldError } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { FullPageSpinner } from "@/components/ui/Spinner";

// Reached via the password-reset email link. The reset email was requested with
// the IMPLICIT-flow recovery client, so the link carries the recovery tokens in
// the URL hash (#access_token=…&refresh_token=…&type=recovery) and works in ANY
// browser/device (it is not PKCE-bound to the requesting browser).
//
// We consume that hash with the SAME implicit recovery client. Its session lives
// under an isolated storageKey and is deliberately NEVER promoted to the app's
// main session — a stolen/opened recovery link therefore cannot browse the app;
// it can only set a new password. After a successful reset we clear that isolated
// session and send the user to /login to sign in fresh with the new password.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // null = still verifying the link; true = valid recovery session established;
  // false = link invalid/expired/already used.
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const client = getRecoveryClient();
      const hash =
        typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
      const params = new URLSearchParams(hash);

      // Supabase appends error params (in the hash) for an expired or already-used
      // link — surface the invalid state immediately, no spinner delay.
      if (params.get("error") || params.get("error_code")) {
        if (active) setHasSession(false);
        return;
      }

      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (access_token && refresh_token) {
        const { data, error } = await client.auth.setSession({ access_token, refresh_token });
        // Strip the tokens from the address bar so they aren't left in history.
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", window.location.pathname);
        }
        if (active) setHasSession(!error && !!data?.session);
        return;
      }

      // No tokens and no error in the URL → nothing to verify against.
      const { data } = await client.auth.getSession();
      if (active) setHasSession(!!data.session);
    })();
    return () => {
      active = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      const client = getRecoveryClient();
      // Time the call out so the button never spins forever on a dead network.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("updateUser timed out")), 15000),
      );
      const { error } = await Promise.race([
        client.auth.updateUser({ password }),
        timeout,
      ]);
      if (error) {
        setError(friendlyAuthError(error));
        return;
      }
      // Clear the isolated recovery session — it is never promoted to a full login.
      await client.auth.signOut().catch(() => {});
      setDone(true);
      setTimeout(() => router.replace("/login?reset=1"), 1500);
    } catch {
      setError(
        "That took too long to go through — your reset link may have expired. Request a fresh reset link and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-5 py-10">
      <Link href="/" className="mb-6">
        <Logo />
      </Link>
      <div className="w-full max-w-md rounded-3xl bg-white p-7 shadow-[var(--shadow-soft)] ring-1 ring-line">
        <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary-light text-primary">
          <KeyRound className="size-7" />
        </div>
        <h1 className="text-2xl font-black text-ink">Set a new password</h1>

        {done ? (
          <p className="mt-3 font-medium text-success" role="status">
            Password updated — taking you to sign in…
          </p>
        ) : hasSession === null ? (
          <div className="mt-6">
            <FullPageSpinner label="Verifying your reset link…" />
          </div>
        ) : hasSession === false ? (
          <p className="mt-3 text-sm text-ink-soft">
            This reset link can&apos;t be verified — it may have expired or already been used.
            Request a fresh link and open the newest one.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <Label htmlFor="new-password">New password</Label>
              <PasswordInput
                id="new-password"
                aria-label="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="confirm-password">Confirm password</Label>
              <PasswordInput
                id="confirm-password"
                aria-label="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
            <FieldError>{error}</FieldError>
            <Button type="submit" size="lg" fullWidth loading={busy}>
              Update password
            </Button>
          </form>
        )}
        <Link href="/login" className="mt-5 block text-center text-sm font-bold text-primary">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
