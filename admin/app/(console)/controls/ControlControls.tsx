"use client";

import { useState, useTransition } from "react";
import { resolveFinding, setControlEnabled, runSweepNow, type ActionResult } from "./actions";

// Server actions bound straight to <form action> must return void, and these return an
// ActionResult so the operator sees what happened. Same shape as DisputeControls: a
// small client component that fires the action in a transition and renders the result.

export function RunSweepButton() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await runSweepNow()))}
        className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:border-[var(--brand)] disabled:opacity-40"
      >
        {pending ? "Running…" : "Run sweep now"}
      </button>
      {result && (
        <span className={`text-xs ${result.ok ? "text-green-700" : "text-red-600"}`}>{result.message}</span>
      )}
    </div>
  );
}

export function CloseFinding({ findingId }: { findingId: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
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
              setResult(await resolveFinding(fd));
            })
          }
          className="rounded bg-[var(--surface)] px-2 py-1 text-xs font-medium disabled:opacity-40"
        >
          Close
        </button>
      </div>
      {result && !result.ok && <span className="text-xs text-red-600">{result.message}</span>}
    </div>
  );
}

export function ToggleControl({ controlKey, enabled }: { controlKey: string; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [on, setOn] = useState(enabled);
  const [result, setResult] = useState<ActionResult | null>(null);

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
            const r = await setControlEnabled(fd);
            setResult(r);
            if (r.ok) setOn(!on);
          })
        }
        className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-40 ${
          on ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"
        }`}
      >
        {on ? "on" : "off"}
      </button>
      {result && !result.ok && <span className="text-xs text-red-600">{result.message}</span>}
    </div>
  );
}
