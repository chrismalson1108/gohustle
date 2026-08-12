"use client";

import { useRef, useState, useTransition } from "react";
import { openThreadWithUser, type ActionResult } from "./actions";

const CATEGORIES = [
  { key: "safety", label: "Safety" },
  { key: "payment", label: "Payment" },
  { key: "booking", label: "A gig" },
  { key: "account", label: "Account" },
  { key: "other", label: "Other" },
] as const;

/**
 * Start a conversation with a user.
 *
 * Deliberately a THREAD and not another one-way alert. The existing "Notify user"
 * pushes a warning the person cannot answer, which is the wrong shape for the case it
 * is mostly used for: we received a report, and the user is usually the one holding
 * the context that resolves it. Refusing to hear it is how a wrong ban happens.
 */
export default function OpenThreadForm({
  userId,
  bookingId,
  defaultCategory = "other",
  defaultSubject = "",
}: {
  userId: string;
  bookingId?: string;
  defaultCategory?: string;
  defaultSubject?: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [category, setCategory] = useState<string>(defaultCategory);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(fd) =>
        start(async () => {
          fd.set("userId", userId);
          fd.set("category", category);
          if (bookingId) fd.set("bookingId", bookingId);
          const r = await openThreadWithUser(fd);
          setResult(r);
          if (r.ok) formRef.current?.reset();
        })
      }
      className="space-y-2"
    >
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCategory(c.key)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              category === c.key
                ? "bg-[var(--brand)] text-white"
                : "border border-[var(--line)] hover:bg-[var(--surface)]"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <input
        name="subject"
        required
        defaultValue={defaultSubject}
        placeholder="What this is about (they see this)"
        className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />
      <textarea
        name="body"
        required
        rows={4}
        placeholder="Write to them… they can reply from the app."
        className="w-full resize-y rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
          Priority
          <select
            name="priority"
            defaultValue={category === "safety" ? "urgent" : "normal"}
            className="rounded border border-[var(--line)] px-2 py-1 text-xs"
          >
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Sending…" : "Start conversation"}
        </button>
      </div>

      <p className="text-xs text-[var(--muted)]">
        Appears in their app under Messages and is emailed. If they already have an open
        conversation on this topic, this is added to it rather than starting a second one.
      </p>

      {result && (
        <p className={`text-sm ${result.ok ? "text-emerald-700" : "text-[var(--danger)]"}`}>{result.message}</p>
      )}
    </form>
  );
}
