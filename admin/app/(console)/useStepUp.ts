"use client";

import { useState, useCallback } from "react";

// The step-up retry cycle, in one place.
//
// Server actions guarded by requireFreshAdmin return { ok: false, message: "stale_mfa" }
// when the session is valid and the role is right but the second factor was satisfied
// too long ago. That is RECOVERABLE — the operator enters a current code and the same
// action runs again — but only if the calling surface knows to offer the prompt.
//
// It mostly did not. requireFreshAdmin protected 16 actions across five surfaces, and
// only pricing and bookings caught the denial; flags, team and user actions dead-ended
// on a raw "stale_mfa" string with no way forward short of signing out. An operator who
// cannot complete a legitimate action is an operator who will eventually be asked to
// take the guard off, so a step-up with no recovery path is worse than no step-up.
//
// Wrapping it here rather than repeating the useState dance means the next surface gets
// it by construction.
//
// Usage:
//   const stepUp = useStepUp();
//   ...
//   await stepUp.run(() => someGuardedAction(fd));
//   ...
//   {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}

// message is REQUIRED, matching every server action's own ActionResult. TypeScript is
// structural, so the shapes interoperate across modules without a cast — and an
// optional message here would silently widen every consumer's type.
export type ActionResult = { ok: boolean; message: string };

export function useStepUp() {
  // The call to replay once a fresh code has been accepted.
  const [pendingCall, setPendingCall] = useState<(() => Promise<ActionResult>) | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const run = useCallback(async (call: () => Promise<ActionResult>) => {
    const r = await call();
    if (!r.ok && r.message === "stale_mfa") {
      // Stash the exact call, not just its arguments, so the retry re-runs the same
      // action against the same target. Wrapped in a thunk because React treats a
      // bare function passed to a setter as an updater.
      setPendingCall(() => call);
      setResult(null);
      return r;
    }
    setResult(r);
    return r;
  }, []);

  const retry = useCallback(async () => {
    if (!pendingCall) return;
    const call = pendingCall;
    setPendingCall(null);
    setResult(await call());
  }, [pendingCall]);

  const cancel = useCallback(() => {
    setPendingCall(null);
    // Say why nothing happened. Silently closing the prompt reads as "it worked".
    setResult({ ok: false, message: "Cancelled — the action was not performed." });
  }, []);

  return { run, retry, cancel, needed: pendingCall !== null, result, setResult };
}
