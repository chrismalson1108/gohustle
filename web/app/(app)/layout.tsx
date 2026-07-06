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
// loading → spinner; no session → /login; not onboarded → /onboarding;
// stale legal acceptance → /consent.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, onboardingResolved, onboardingDone, needsTermsAcceptance } = useAuth();
  const router = useRouter();

  // With a session present, wait for onboarding/terms state to actually load before
  // making a routing decision — otherwise a not-onboarded / terms-owing user flashes
  // the app shell on the optimistic onboardingDone=true default before we bounce them.
  const gateResolving = loading || (!!session && !onboardingResolved);

  useEffect(() => {
    if (gateResolving) return;
    if (!session) router.replace("/login");
    else if (!onboardingDone) router.replace("/onboarding");
    else if (needsTermsAcceptance) router.replace("/consent");
  }, [gateResolving, session, onboardingDone, needsTermsAcceptance, router]);

  if (gateResolving || !session || !onboardingDone || needsTermsAcceptance) {
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
