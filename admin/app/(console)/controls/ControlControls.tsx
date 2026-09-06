"use client";

import { useState, useTransition } from "react";
import { resolveFinding, setControlEnabled, runSweepNow } from "./actions";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";

// Server actions bound straight to <form action> must return void, and these return an
// ActionResult so the operator sees what happened. Same shape as DisputeControls: a
// small client component that fires the action in a transition and renders the result.
//
// All three go through useStepUp. These actions carry no step-up of their own, but the
// 12h session cap is inside requireAdmin, so any of them can come back stale_mfa — and
// this file used to return `e.reason` straight through, which printed the word
// "stale_mfa" at an operator with nothing to do about it.

export function RunSweepButton() {
  const [pending, start] = useTransition();
  const stepUp = useStepUp();
  const result = stepUp.result;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => { await stepUp.run(() => runSweepNow()); })}
        className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:border-[var(--brand)] disabled:opacity-40"
      >
        {pending ? "Running…" : "Run sweep now"}
      </button>
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      {result && (
        <span className={`text-xs ${result.ok ? "text-green-700" : "text-red-600"}`}>{result.message}</span>
      )}
    </div>
  );
}

export function CloseFinding({ findingId }: { findingId: number }) {
  const [pending, start] = useTransition();
  const stepUp = useStepUp();
  const result = stepUp.result;
  const [note, setNote] = useState("");

  if (result?.ok) return <span className="text-xs text-green-700">closed</span>;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="why?"
          className="w-32 rounded border border-[var(--line)] px-2 py-1 text-xs"
        />
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const fd = new FormData();
              fd.set("findingId", String(findingId));
              fd.set("note", note);
              await stepUp.run(() => resolveFinding(fd));
            })
          }
          className="rounded bg-[var(--surface)] px-2 py-1 text-xs font-medium disabled:opacity-40"
        >
          Close
        </button>
      </div>
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      {result && !result.ok && <span className="text-xs text-red-600">{result.message}</span>}
    </div>
  );
}

export function ToggleControl({ controlKey, enabled }: { controlKey: string; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [on, setOn] = useState(enabled);
  const stepUp = useStepUp();
  const result = stepUp.result;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set("key", controlKey);
            fd.set("enabled", on ? "0" : "1");
            // The flip is applied inside the thunk so a replay after a fresh code moves
            // the switch too, and so a denied attempt never moves it.
            await stepUp.run(async () => {
              const r = await setControlEnabled(fd);
              if (r.ok) setOn(!on);
              return r;
            });
          })
        }
        className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-40 ${
          on ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"
        }`}
      >
        {on ? "on" : "off"}
      </button>
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      {result && !result.ok && <span className="text-xs text-red-600">{result.message}</span>}
    </div>
  );
}
