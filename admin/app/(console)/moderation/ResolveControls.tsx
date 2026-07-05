"use client";

import { useState, useTransition } from "react";
import { resolveReport, reopenReport, type ActionResult } from "./actions";

export default function ResolveControls({
  reportId,
  resolved,
  isAdmin,
}: {
  reportId: string;
  resolved: boolean;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [note, setNote] = useState("");

  if (!isAdmin) return null;

  function fire(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set("reportId", reportId);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    start(async () => setResult(await action(fd)));
  }

  if (resolved) {
    return (
      <button
        onClick={() => fire(reopenReport)}
        disabled={pending}
        className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-50"
      >
        Reopen
      </button>
    );
  }

  return (
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
  );
}
