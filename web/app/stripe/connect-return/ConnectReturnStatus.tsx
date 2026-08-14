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
// The app scheme is hardcoded HERE, never taken from the query string. The edge
// function only gets to say "this came from the app" (?native=1); if it could name the
// destination, this page would be an open redirect on our own domain.
const APP_RETURN = "gohustlr://stripe/connect-return";

export default function ConnectReturnStatus() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [noWebSession, setNoWebSession] = useState(false);

  // ── Hand the app back to itself ─────────────────────────────────────────────
  //
  // Stripe will not accept a custom scheme as return_url (`url_invalid`), so the app's
  // onboarding necessarily lands on this https page. It arrives with ?native=1, and
  // this is the redirect that lets WebBrowser.openAuthSessionAsync recognise the flow
  // as finished and close the in-app browser by itself. Without it the user has to
  // notice a Done button, and the app only refreshes once they tap it.
  //
  // Deliberately does NOT return early or block rendering: on a desktop browser (or
  // anywhere the scheme is not installed) the navigation silently does nothing, and
  // the real status page below must still be there. Runs once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isNative = new URLSearchParams(window.location.search).get("native") === "1";
    if (!isNative) return;
    window.location.replace(APP_RETURN);
  }, []);

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
