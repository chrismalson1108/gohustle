"use client";

import { useState, useTransition } from "react";
import { setJobStatus, type ActionResult } from "../actions";

export default function TakedownControls({
  jobId,
  cancelled,
  isAdmin,
}: {
  jobId: string;
  cancelled: boolean;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reason, setReason] = useState("");

  if (!isAdmin) return <p className="text-sm text-[var(--muted)]">Read-only — take-down requires the admin role.</p>;

  function fire(status: "cancelled" | "open", confirmText: string) {
    if (!window.confirm(confirmText)) return;
    const fd = new FormData();
    fd.set("jobId", jobId);
    fd.set("status", status);
    fd.set("reason", reason);
    start(async () => setResult(await setJobStatus(fd)));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {result && (
        <span className={`text-sm ${result.ok ? "text-emerald-700" : "text-[var(--danger)]"}`}>{result.message}</span>
      )}
      {cancelled ? (
        <button
          onClick={() => fire("open", "Restore this listing to open?")}
          disabled={pending}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface)] disabled:opacity-50"
        >
          Restore listing
        </button>
      ) : (
        <>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Take-down reason (internal)"
            className="w-56 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => fire("cancelled", "Take this gig down (sets it to cancelled)?")}
            disabled={pending}
            className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-[var(--danger)] hover:bg-red-50 disabled:opacity-50"
          >
            Take down listing
          </button>
        </>
      )}
    </div>
  );
}
