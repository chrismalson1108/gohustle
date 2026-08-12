"use client";

import { useTransition } from "react";
import { setFlag } from "./actions";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";

// Turning a flag OFF is the destructive direction — it takes a feature away from
// every user at once — so only that direction is confirmed. Turning it back ON is
// a restoration and shouldn't need a speed bump during an incident.
export default function FlagToggle({
  flagKey,
  enabled,
  isAdmin,
}: {
  flagKey: string;
  enabled: boolean;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  // Turning a flag off is a step-up action; without this the operator got a raw
  // "stale_mfa" and no way to satisfy it.
  const stepUp = useStepUp();
  const result = stepUp.result;

  if (!isAdmin) {
    return (
      <span className="text-xs text-[var(--muted)]">
        {enabled ? "on" : "off"} · admin only
      </span>
    );
  }

  function toggle() {
    const next = !enabled;
    if (!next && !confirm(`Turn OFF "${flagKey}" for every user right now?`)) return;
    const fd = new FormData();
    fd.set("key", flagKey);
    fd.set("enabled", String(next));
    start(async () => { await stepUp.run(() => setFlag(fd)); });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={toggle}
        disabled={pending}
        className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
          enabled
            ? "border border-[var(--line)] hover:bg-[var(--surface)]"
            : "bg-[var(--danger)] text-white"
        }`}
      >
        {pending ? "…" : enabled ? "Turn off" : "Turn back on"}
      </button>
      {stepUp.needed && (
        <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />
      )}
      {result && (
        <span className={`text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}
