"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import Logo from "@/components/Logo";
import Button from "@/components/ui/Button";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { Input, Label, FieldError } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";

type Mode = "signin" | "signup" | "forgot";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const {
    session,
    loading,
    signIn,
    signInWithGoogle,
    signUp,
    resetPassword,
    resendConfirmation,
    authError,
    clearError,
    pendingEmail,
    clearPending,
  } = useAuth();

  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const justReset = params.get("reset") === "1";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [referral, setReferral] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [resent, setResent] = useState(false);

  // Already authenticated → into the app (the app gate handles onboarding/consent).
  useEffect(() => {
    if (session) router.replace("/browse");
  }, [session, router]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setLocalErr(null);
    setResetSent(false);
    setResent(false); // don't carry a stale "Email re-sent ✓" into a new panel
    setAgreed(false);
    clearError();
    clearPending();
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalErr(null);
    clearError();

    if (mode === "forgot") {
      if (!email) return setLocalErr("Enter your email.");
      setBusy(true);
      const ok = await resetPassword(email);
      setBusy(false);
      if (ok) setResetSent(true);
      return;
    }

    if (mode === "signup") {
      if (!name.trim()) return setLocalErr("Enter your name.");
      if (password.length < 8) return setLocalErr("Password must be at least 8 characters.");
      if (password !== confirm) return setLocalErr("Passwords don't match.");
      if (!agreed) return setLocalErr("Please confirm you're 18 or older and accept the Terms, Privacy Policy, and Contractor Agreement.");
      setBusy(true);
      await signUp(email, password, name.trim(), referral.trim() || undefined);
      setBusy(false);
      return; // pendingEmail UI takes over
    }

    // signin
    if (!email || !password) return setLocalErr("Enter your email and password.");
    setBusy(true);
    const ok = await signIn(email, password);
    setBusy(false);
    if (ok) router.replace("/browse");
  };

  const onGoogle = async () => {
    setLocalErr(null);
    clearError();
    setGoogleBusy(true);
    const ok = await signInWithGoogle();
    // On success the browser navigates to Google; only reset if it failed to start.
    if (!ok) setGoogleBusy(false);
  };

  const err = localErr || authError;

  // Don't flash the sign-in form at someone who's already authenticated (or whose
  // session is still resolving) — show a spinner while the redirect above fires.
  if (loading || session) {
    return (
      <Card>
        <FullPageSpinner label="Taking you in…" />
      </Card>
    );
  }

  // Email-confirmation pending state (after sign-up).
  if (pendingEmail && mode === "signup") {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary-light text-primary">
            <Mail className="size-7" />
          </div>
          <h1 className="mt-5 text-2xl font-black text-ink">Check your email</h1>
          <p className="mt-2 text-ink-soft">
            We sent a confirmation link to <span className="font-bold text-ink">{pendingEmail}</span>.
            Click it, then come back to sign in.
          </p>
          <FieldError>{authError}</FieldError>
          <Button
            variant="outline"
            fullWidth
            className="mt-6"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await resendConfirmation();
              setBusy(false);
              setResent(ok);
            }}
          >
            {resent ? "Email re-sent ✓" : "Resend confirmation email"}
          </Button>
          <button onClick={() => switchMode("signin")} className="mt-4 cursor-pointer text-sm font-bold text-primary">
            Back to sign in
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-2xl font-black text-ink">
        {mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your account" : "Reset your password"}
      </h1>
      <p className="mt-1 text-ink-soft">
        {mode === "signin"
          ? "Sign in to find gigs and get paid."
          : mode === "signup"
            ? "Join GoHustlr — it's free."
            : "We'll email you a reset link."}
      </p>

      {justReset && mode === "signin" && (
        <p role="status" className="mt-4 rounded-2xl bg-success/10 px-4 py-3 text-sm font-semibold text-success">
          Password updated — sign in with your new password.
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {mode === "signup" && (
          <div>
            <Label htmlFor="name">Full name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" autoComplete="name" />
          </div>
        )}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@school.edu"
            autoComplete="email"
          />
        </div>
        {mode !== "forgot" && (
          <div>
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </div>
        )}
        {mode === "signup" && (
          <>
            <div>
              <Label htmlFor="confirm">Confirm password</Label>
              <PasswordInput
                id="confirm"
                aria-label="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="referral">Referral code (optional)</Label>
              <Input id="referral" value={referral} onChange={(e) => setReferral(e.target.value)} placeholder="Got a code?" />
            </div>
          </>
        )}

        {mode === "signup" && (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>
              I confirm I&apos;m 18 or older and agree to the{" "}
              <Link href="/legal/terms" target="_blank" className="font-semibold text-primary hover:underline">Terms</Link>,{" "}
              <Link href="/legal/privacy" target="_blank" className="font-semibold text-primary hover:underline">Privacy Policy</Link>, and{" "}
              <Link href="/legal/contractor" target="_blank" className="font-semibold text-primary hover:underline">Independent Contractor Agreement</Link>.
            </span>
          </label>
        )}

        <FieldError>{err}</FieldError>
        {resetSent && <p className="text-sm font-medium text-success">Check your inbox for the reset link.</p>}

        <Button type="submit" fullWidth size="lg" loading={busy} disabled={mode === "signup" && !agreed}>
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
          <ArrowRight className="size-5" />
        </Button>

        {mode !== "forgot" && (
          <>
            <div className="flex items-center gap-3 pt-1">
              <span className="h-px flex-1 bg-line" />
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">or</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <Button type="button" variant="outline" fullWidth size="lg" loading={googleBusy} onClick={onGoogle}>
              {!googleBusy && <GoogleG className="size-5" />}
              Continue with Google
            </Button>
          </>
        )}
      </form>

      <div className="mt-6 space-y-2 text-center text-sm">
        {mode === "signin" && (
          <>
            <button onClick={() => switchMode("forgot")} className="block w-full cursor-pointer font-medium text-ink-soft hover:text-primary">
              Forgot your password?
            </button>
            <p className="text-ink-soft">
              New here?{" "}
              <button onClick={() => switchMode("signup")} className="cursor-pointer font-bold text-primary">
                Create an account
              </button>
            </p>
          </>
        )}
        {mode === "signup" && (
          <p className="text-ink-soft">
            Already have an account?{" "}
            <button onClick={() => switchMode("signin")} className="cursor-pointer font-bold text-primary">
              Sign in
            </button>
          </p>
        )}
        {mode === "forgot" && (
          <button onClick={() => switchMode("signin")} className="cursor-pointer font-bold text-primary">
            Back to sign in
          </button>
        )}
      </div>
    </Card>
  );
}

// Official Google "G" mark (multi-color) for the sign-in button.
function GoogleG({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-5 py-10">
      <Link href="/" className="mb-6">
        <Logo />
      </Link>
      <div className="w-full max-w-md rounded-3xl bg-white p-7 shadow-[var(--shadow-soft)] ring-1 ring-line/70">{children}</div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
