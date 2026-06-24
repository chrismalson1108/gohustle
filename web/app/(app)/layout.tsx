"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { UserProvider } from "@/lib/user";
import { JobsProvider } from "@/lib/jobs";
import AppShell from "@/components/AppShell";
import Toast from "@/components/Toast";
import { FullPageSpinner } from "@/components/ui/Spinner";

// Auth gate for the whole authenticated app. Mirrors RootNavigator in App.js:
// loading → spinner; no session → /login; not onboarded → /onboarding;
// stale legal acceptance → /consent.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, onboardingDone, needsTermsAcceptance } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace("/login");
    else if (!onboardingDone) router.replace("/onboarding");
    else if (needsTermsAcceptance) router.replace("/consent");
  }, [loading, session, onboardingDone, needsTermsAcceptance, router]);

  if (loading || !session || !onboardingDone || needsTermsAcceptance) {
    return <FullPageSpinner label={loading ? "Loading…" : "Redirecting…"} />;
  }

  return (
    <UserProvider>
      <JobsProvider>
        <AppShell>{children}</AppShell>
        <Toast />
      </JobsProvider>
    </UserProvider>
  );
}
