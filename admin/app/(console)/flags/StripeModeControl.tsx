"use client";

import { useState, useTransition } from "react";
import { setStripeMode } from "./actions";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";

// The one console control that writes app_flags.value. stripe_mode's `enabled` bit is
// read by nothing; `value->>'mode'` is what ctl_stripe_id_mode_mismatch reads, and until
// this existed there was no way to change it outside a migration — while 20260814080000,
// OPEN_WORK and the cutover runbook all said /flags would do it.
export default function StripeModeControl({
  mode,
  isAdmin,
}: {
  mode: string;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [next, setNext] = useState(mode === "live" ? "test" : "live");
  const [confirmText, setConfirmText] = useState("");
  const stepUp = useStepUp();
  const result = stepUp.result;

  if (!isAdmin) {
    return <span className="text-xs text-[var(--muted)]">mode: {mode} · admin only</span>;
  }

  const phrase = next === "live" ? "SWITCH TO LIVE" : "SWITCH TO TEST";

  function submit() {
    const fd = new FormData();
    fd.set("mode", next);
    fd.set("confirm", confirmText.trim());
    start(async () => { await stepUp.run(() => setStripeMode(fd)); });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <select
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="rounded-lg border border-[var(--line)] px-2 py-1.5 text-xs"
        >
          <option value="test">test</option>
          <option value="live">live</option>
        </select>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={phrase}
          aria-label={`Type ${phrase} to confirm`}
          className="w-40 rounded-lg border border-[var(--line)] px-2 py-1.5 font-mono text-xs"
        />
        <button
          onClick={submit}
          disabled={pending || next === mode}
          className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {pending ? "…" : "Set mode"}
        </button>
      </div>
      {next === mode && (
        <span className="text-xs text-[var(--muted)]">Already {mode}.</span>
      )}
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      {result && (
        <span className={`max-w-md text-right text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}
