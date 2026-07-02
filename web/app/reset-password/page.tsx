"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import Logo from "@/components/Logo";
import Button from "@/components/ui/Button";
import { Label, FieldError } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";

// Reached via the password-reset email link. detectSessionInUrl establishes a
// temporary recovery session; we then let the user set a new password.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // null = still checking, true/false = whether a recovery session was established
  // from the link. detectSessionInUrl consumes the hash token on mount.
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    // Give detectSessionInUrl a beat to process the recovery hash, then check.
    const check = () => supabase.auth.getSession().then(({ data }) => {
      if (active) setHasSession(!!data.session);
    });
    const t = setTimeout(check, 600);
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (active && session) setHasSession(true);
    });
    return () => { active = false; clearTimeout(t); sub.subscription.unsubscribe(); };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      // Time the call out: supabase-js auth calls share a cross-tab navigator
      // lock and can hang forever if another open tab holds it — never leave the
      // button spinning indefinitely.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("updateUser timed out")), 12000),
      );
      const { error } = await Promise.race([
        supabase.auth.updateUser({ password }),
        timeout,
      ]);
      if (error) {
        setError(error.message);
        return;
      }
      setDone(true);
      setTimeout(() => router.replace("/browse"), 1500);
    } catch {
      setError(
        "That took too long to go through — your reset link may have expired. Close any other open GoHustlr tabs, then request a fresh reset link and try again.",
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
          <p className="mt-3 font-medium text-success">Password updated — taking you in…</p>
        ) : hasSession === false ? (
          <p className="mt-3 text-sm text-ink-soft">
            This reset link can&apos;t be verified in this browser — it may have expired, already been
            used, or been opened somewhere other than where you requested it. Request a fresh link and
            open it in the same browser.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <Label>New password</Label>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
            </div>
            <div>
              <Label>Confirm password</Label>
              <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
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
