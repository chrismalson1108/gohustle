"use client";

import { useCallback, useEffect, useState } from "react";
import { stripeEdge } from "@/lib/edge";
import { supabase } from "@/lib/supabaseClient";
import type { ConnectStatus } from "@/lib/connectStatus";
import PayoutStatusCard from "./PayoutStatusCard";

// Fetching half of the Stripe onboarding return screen. Asks the server what
// ACTUALLY happened rather than assuming the redirect means success — Stripe sends
// the user back here whether they completed verification or tapped "Skip for now",
// and the old page claimed "Payout setup complete" either way.
//
// NOTE: this route sits OUTSIDE the (app) route group, so JobsProvider/UserProvider
// are not mounted — call the edge helper directly rather than useJobs().
export default function ConnectReturnStatus() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [noWebSession, setNoWebSession] = useState(false);

  const load = useCallback(async () => {
    // Check for a web session FIRST. Mobile users arrive here in an in-app browser
    // that shares no session with the native app, so the status call would always
    // 401 and render the alarming "we couldn't confirm" state — then hand them a
    // button into a gated route that bounces to /login. Detect it up front and show
    // them the door back to the app instead of a failure they can't act on.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setNoWebSession(true);
      return;
    }
    try {
      setStatus(await stripeEdge.getPayoutStatus());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Send the user back into hosted onboarding to supply what's still outstanding.
  const onFinishSetup = async () => {
    setResuming(true);
    try {
      const res = await stripeEdge.getPayoutOnboardingUrl();
      if (res?.url) {
        window.location.href = res.url;
        return;
      }
      // No link issued — the server re-checks live and decided there's nothing left
      // to collect. Re-read status so the page stops offering a dead button.
      await load();
    } catch {
      setFailed(true);
    } finally {
      setResuming(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-6 py-12">
      <PayoutStatusCard
        status={status}
        failed={failed}
        resuming={resuming}
        noWebSession={noWebSession}
        onFinishSetup={onFinishSetup}
      />
    </main>
  );
}
