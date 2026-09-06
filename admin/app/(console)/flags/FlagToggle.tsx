"use client";

import { useTransition } from "react";
import { setFlag } from "./actions";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";
import { guideFor } from "./guide";

// The confirmation says what the flip ACTUALLY does, from guide.ts. It used to read
// `Turn OFF "<key>" for every user right now?` for every row — which on safety_alert
// named the wrong audience entirely: muting the pager changes nothing for any user, it
// stops a human being told when a safety report lands.
//
// The dangerous direction is per-key too. Taking a feature away is normally the
// destructive act and restoring it should not need a speed bump during an incident —
// but bonus_cash_payout_enabled is seeded OFF on purpose and turning it ON is the flip
// that opens real transfers off the platform balance.
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
  const guide = guideFor(flagKey);

  if (!isAdmin) {
    return (
      <span className="text-xs text-[var(--muted)]">
        {enabled ? "on" : "off"} · admin only
      </span>
    );
  }

  function toggle() {
    const next = !enabled;
    const dangerous = (guide.confirmDirection ?? "off") === (next ? "on" : "off");
    const effect = next ? guide.onMeans ?? "Normal behaviour restored." : guide.offMeans;

    if (dangerous && !confirm(`Turn ${next ? "ON" : "OFF"} "${flagKey}"?\n\n${effect}`)) return;

    // A mute with no reason is how a dark pager survives a shift change. The server
    // refuses it too — this only saves the round trip.
    let note = "";
    if (guide.kind === "alert_channel" && !next) {
      note = (window.prompt(`Why are you muting ${flagKey}? (recorded on the row)`) ?? "").trim();
      if (!note) return;
    }

    const fd = new FormData();
    fd.set("key", flagKey);
    fd.set("enabled", String(next));
    if (note) fd.set("note", note);
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
        {pending
          ? "…"
          : enabled
            ? guide.kind === "alert_channel"
              ? "Mute paging"
              : "Turn off"
            : "Turn back on"}
      </button>
      {stepUp.needed && (
        <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />
      )}
      {result && (
        <span className={`max-w-xs text-right text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}
