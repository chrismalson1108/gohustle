"use client";

import { useState, useTransition } from "react";
import { setDisputeStatus, type ActionResult } from "./actions";

export default function DisputeControls({
  disputeId,
  status,
  isAdmin,
}: {
  disputeId: string;
  status: string;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [note, setNote] = useState("");

  if (!isAdmin) {
    return <span className="text-xs text-[var(--muted)]">{status} · admin only</span>;
  }

  const fire = (next: string) => {
    const fd = new FormData();
    fd.set("disputeId", disputeId);
    fd.set("status", next);
    fd.set("note", note);
    start(async () => {
      const r = await setDisputeStatus(fd);
      setResult(r);
      if (r.ok) setNote("");
    });
  };

  const closed = status === "resolved" || status === "rejected";
  const btn = "rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-40";

  return (
    <div className="flex flex-col items-end gap-2">
      {!closed && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="what you decided, and why"
          className="w-64 rounded-lg border border-[var(--line)] px-2 py-1 text-xs"
        />
      )}
      <div className="flex gap-2">
        {status !== "investigating" && !closed && (
          <button className={btn} disabled={pending} onClick={() => fire("investigating")}>
            Investigating
          </button>
        )}
        {!closed ? (
          <>
            <button
              className="rounded-lg bg-[var(--brand)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
              disabled={pending}
              onClick={() => fire("resolved")}
            >
              Resolve
            </button>
            <button className={btn} disabled={pending} onClick={() => fire("rejected")}>
              Reject
            </button>
          </>
        ) : (
          <button className={btn} disabled={pending} onClick={() => fire("open")}>
            Re-open
          </button>
        )}
      </div>
      {result && (
        <span className={`max-w-xs text-right text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}
