"use client";

import { useState, useTransition } from "react";
import { resolveReport, reopenReport, type ActionResult } from "./actions";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";

// `canResolve` is computed by the PAGE from roleSatisfies(ctx.role, "trust") — the
// same predicate resolveReport/reopenReport enforce — and not from role === "admin",
// which is what this took before. guard.ts is server-only, so the boolean has to
// arrive as a prop; the name says which authority it stands for so the next reader
// cannot mistake it for "is an admin".
export default function ResolveControls({
  reportId,
  resolved,
  canResolve,
}: {
  reportId: string;
  resolved: boolean;
  canResolve: boolean;
}) {
  const [pending, start] = useTransition();
  // The 12h session cap lives in requireAdmin, so resolving a report can come back
  // stale_mfa without this action having any step-up of its own. That is recoverable —
  // but only if the surface offers the prompt, which this one did not.
  const stepUp = useStepUp();
  const result = stepUp.result;
  const [note, setNote] = useState("");

  if (!canResolve) return null;

  function fire(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set("reportId", reportId);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    start(async () => { await stepUp.run(() => action(fd)); });
  }

  if (resolved) {
    return (
      <span className="flex flex-col items-end gap-1">
        <button
          onClick={() => fire(reopenReport)}
          disabled={pending}
          className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-50"
        >
          Reopen
        </button>
        {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
        {result && !result.ok && <span className="text-xs text-[var(--danger)]">{result.message}</span>}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="resolution note"
          className="w-40 rounded-lg border border-[var(--line)] px-2 py-1 text-xs"
        />
        <button
          onClick={() => fire(resolveReport, { resolution: note })}
          disabled={pending}
          className="rounded-lg bg-[var(--brand)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Resolve
        </button>
        {result && !result.ok && <span className="text-xs text-[var(--danger)]">{result.message}</span>}
      </div>
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
    </div>
  );
}
