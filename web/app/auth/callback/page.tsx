"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { captureError } from "@/lib/analytics";
import { FullPageSpinner } from "@/components/ui/Spinner";

type OAuthError = { description: string; kind: "cancelled" | "identity" | "other" };

// GoTrue error_codes that mean "this email is already a different identity" — i.e.
// the user has an existing email/password account (or another linked provider).
const IDENTITY_CODES = [
  "identity_already_exists",
  "email_exists",
  "user_already_exists",
  "email_conflict_identity_not_deletable",
];

// OAuth return target. The Supabase client (detectSessionInUrl) exchanges the
// ?code in the URL for a session on mount; we wait for that to resolve, then
// route the user in. The (app) layout handles onboarding/consent gating, so a
// plain /browse push is enough — but routing here keeps the redirect snappy.
export default function AuthCallbackPage() {
  const router = useRouter();
  const { loading, session, onboardingDone } = useAuth();
  const [timedOut, setTimedOut] = useState(false);
  const [oauthError, setOauthError] = useState<OAuthError | null>(null);

  // If the provider sent us back with an error, classify it so we show the RIGHT
  // message (a real cancel vs. an existing-account collision vs. a genuine failure)
  // instead of always claiming "cancelled", and log the non-cancel ones so a
  // provider misconfiguration is observable rather than silently swallowed.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const errorCode = params.get("error_code");
    const description = (params.get("error_description") || "").replace(/\+/g, " ");
    if (!error && !errorCode && !description) return;
    let kind: OAuthError["kind"];
    if (error === "access_denied" || /denied|cancel/i.test(description)) kind = "cancelled";
    else if (IDENTITY_CODES.includes(errorCode || "")) kind = "identity";
    else kind = "other";
    setOauthError({ description, kind });
    if (kind !== "cancelled") {
      captureError(new Error("oauth_callback_error"), { error, errorCode, description });
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (session) {
      router.replace(onboardingDone ? "/browse" : "/onboarding");
    }
  }, [loading, session, onboardingDone, router]);

  // If the code exchange never produces a session (denied consent, expired code,
  // provider misconfigured), don't spin forever — surface a way back to login.
  // Give the exchange a generous window: on a weak connection the round-trip can
  // take many seconds, and showing an error that then flips to success is worse
  // than waiting a beat longer.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!session) setTimedOut(true);
    }, 20000);
    return () => clearTimeout(t);
  }, [session]);

  if ((oauthError || timedOut) && !session) {
    const message = !oauthError
      ? "We couldn't finish signing you in with Google — the request may have timed out. Please try again."
      : oauthError.kind === "cancelled"
        ? "Google sign-in wasn't completed — it looks like it was cancelled. No problem, nothing was changed."
        : oauthError.kind === "identity"
          ? "This email already has a GoHustlr account with a password. Sign in with your email and password instead."
          : "We couldn't complete Google sign-in. Please try again, or sign in with your email and password.";
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-5 text-center">
        <p className="max-w-sm text-ink-soft">{message}</p>
        <Link href="/login" className="font-bold text-primary">
          {oauthError?.kind === "identity" ? "Go to sign in" : "Back to sign in"}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <FullPageSpinner label="Signing you in…" />
    </div>
  );
}
