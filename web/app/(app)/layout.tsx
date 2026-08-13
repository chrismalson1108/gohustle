"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { UserProvider } from "@/lib/user";
import { JobsProvider } from "@/lib/jobs";
import AppShell from "@/components/AppShell";
import Toast from "@/components/Toast";
import AssistantWidget from "@/components/AssistantWidget";
import { FullPageSpinner } from "@/components/ui/Spinner";

// Auth gate for the whole authenticated app. Mirrors RootNavigator in App.js:
// loading → spinner; no session → /login; UNSATISFIED 2FA → /mfa; not onboarded →
// /onboarding; stale legal acceptance → /consent.
//
// ⚠️ THE 2FA CHECK MUST COME FIRST, and this file previously had no 2FA check at all.
// A password sign-in on an account with a verified TOTP factor returns a REAL session
// at aal1 — every other gate here happily lets it through. So enrolling on the phone
// protected the phone, and gohustlr.com handed out full account access for the password
// alone. Holding here is what makes the second factor a factor, on both clients.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const {
    session, loading, onboardingResolved, onboardingDone, needsTermsAcceptance,
    needsMfaChallenge, mfaResolved,
  } = useAuth();
  const router = useRouter();

  // With a session present, wait for onboarding/terms AND the assurance-level check to
  // actually load before making a routing decision — otherwise a not-onboarded /
  // terms-owing / code-owing user flashes the app shell on the optimistic defaults
  // before we bounce them.
  const gateResolving = loading || (!!session && (!onboardingResolved || !mfaResolved));

  useEffect(() => {
    if (gateResolving) return;
    if (!session) router.replace("/login");
    else if (needsMfaChallenge) router.replace("/mfa");
    else if (!onboardingDone) router.replace("/onboarding");
    else if (needsTermsAcceptance) router.replace("/consent");
  }, [gateResolving, session, needsMfaChallenge, onboardingDone, needsTermsAcceptance, router]);

  if (gateResolving || !session || needsMfaChallenge || !onboardingDone || needsTermsAcceptance) {
    return <FullPageSpinner label={gateResolving ? "Loading…" : "Redirecting…"} />;
  }

  return (
    <UserProvider>
      <JobsProvider>
        <AppShell>{children}</AppShell>
        <AssistantWidget />
        <Toast />
      </JobsProvider>
    </UserProvider>
  );
}
