"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import Logo from "@/components/Logo";
import Button from "@/components/ui/Button";
import { Input, Label, FieldError } from "@/components/ui/Field";

type Mode = "signin" | "signup" | "forgot";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const {
    session,
    signIn,
    signUp,
    resetPassword,
    resendConfirmation,
    authError,
    clearError,
    pendingEmail,
    clearPending,
  } = useAuth();

  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [referral, setReferral] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
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
      if (password.length < 6) return setLocalErr("Password must be at least 6 characters.");
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

  const err = localErr || authError;

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
          <button onClick={() => switchMode("signin")} className="mt-4 text-sm font-bold text-primary">
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

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {mode === "signup" && (
          <div>
            <Label>Full name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" autoComplete="name" />
          </div>
        )}
        <div>
          <Label>Email</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@school.edu"
            autoComplete="email"
          />
        </div>
        {mode !== "forgot" && (
          <div>
            <Label>Password</Label>
            <Input
              type="password"
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
              <Label>Confirm password</Label>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
            </div>
            <div>
              <Label>Referral code (optional)</Label>
              <Input value={referral} onChange={(e) => setReferral(e.target.value)} placeholder="Got a code?" />
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
      </form>

      <div className="mt-6 space-y-2 text-center text-sm">
        {mode === "signin" && (
          <>
            <button onClick={() => switchMode("forgot")} className="block w-full font-medium text-ink-soft hover:text-primary">
              Forgot your password?
            </button>
            <p className="text-ink-soft">
              New here?{" "}
              <button onClick={() => switchMode("signup")} className="font-bold text-primary">
                Create an account
              </button>
            </p>
          </>
        )}
        {mode === "signup" && (
          <p className="text-ink-soft">
            Already have an account?{" "}
            <button onClick={() => switchMode("signin")} className="font-bold text-primary">
              Sign in
            </button>
          </p>
        )}
        {mode === "forgot" && (
          <button onClick={() => switchMode("signin")} className="font-bold text-primary">
            Back to sign in
          </button>
        )}
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-5 py-10">
      <Link href="/" className="mb-6">
        <Logo />
      </Link>
      <div className="w-full max-w-md rounded-3xl bg-white p-7 shadow-[var(--shadow-soft)] ring-1 ring-line">{children}</div>
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
