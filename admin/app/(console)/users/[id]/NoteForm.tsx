"use client";

import { useRef, useState, useTransition } from "react";
import { addNote, type ActionResult } from "./actions";

export default function NoteForm({ userId }: { userId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(fd) =>
        startTransition(async () => {
          fd.set("userId", userId);
          const r = await addNote(fd);
          setResult(r);
          if (r.ok) formRef.current?.reset();
        })
      }
      className="mt-3 flex gap-2"
    >
      <input
        name="note"
        required
        placeholder="Add an internal note…"
        className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        Add note
      </button>
      {result && !result.ok && <span className="self-center text-sm text-[var(--danger)]">{result.message}</span>}
    </form>
  );
}
