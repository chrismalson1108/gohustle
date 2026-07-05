"use client";

import { useRef, useState, useTransition } from "react";
import { notifyUser, type ActionResult } from "./actions";

export default function NotifyForm({ userId }: { userId: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(fd) =>
        start(async () => {
          fd.set("userId", userId);
          const r = await notifyUser(fd);
          setResult(r);
          if (r.ok) formRef.current?.reset();
        })
      }
      className="space-y-2"
    >
      <input
        name="title"
        required
        placeholder="Notification title"
        className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />
      <textarea
        name="body"
        required
        rows={3}
        placeholder="Message to the user…"
        className="w-full resize-y rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input type="checkbox" name="alsoEmail" /> also email them
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send notification"}
        </button>
      </div>
      {result && (
        <p className={`text-sm ${result.ok ? "text-emerald-700" : "text-[var(--danger)]"}`}>{result.message}</p>
      )}
    </form>
  );
}
