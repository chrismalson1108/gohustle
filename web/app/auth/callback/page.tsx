"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { FullPageSpinner } from "@/components/ui/Spinner";

// OAuth return target. The Supabase client (detectSessionInUrl) exchanges the
// ?code in the URL for a session on mount; we wait for that to resolve, then
// route the user in. The (app) layout handles onboarding/consent gating, so a
// plain /browse push is enough — but routing here keeps the redirect snappy.
export default function AuthCallbackPage() {
  const router = useRouter();
  const { loading, session, onboardingDone } = useAuth();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (session) {
      router.replace(onboardingDone ? "/browse" : "/onboarding");
    }
  }, [loading, session, onboardingDone, router]);

  // If the code exchange never produces a session (denied consent, expired code,
  // provider misconfigured), don't spin forever — surface a way back to login.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!session) setTimedOut(true);
    }, 10000);
    return () => clearTimeout(t);
  }, [session]);

  if (timedOut && !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-5 text-center">
        <p className="max-w-sm text-ink-soft">
          We couldn&apos;t finish signing you in with Google. The link may have expired
          or the request was cancelled.
        </p>
        <Link href="/login" className="font-bold text-primary">
          Back to sign in
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
