"use client";

import { useRef, useTransition } from "react";
import { addNote } from "./actions";
import ReauthPrompt from "../../ReauthPrompt";
import { useStepUp } from "../../useStepUp";

export default function NoteForm({ userId }: { userId: string }) {
  const [pending, startTransition] = useTransition();
  const stepUp = useStepUp();
  const result = stepUp.result;
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(fd) =>
        startTransition(async () => {
          fd.set("userId", userId);
          // The FormData is captured, so a replay after a fresh code posts the same note
          // even though the form has been reset by then.
          await stepUp.run(async () => {
            const r = await addNote(fd);
            if (r.ok) formRef.current?.reset();
            return r;
          });
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
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      {result && !result.ok && <span className="self-center text-sm text-[var(--danger)]">{result.message}</span>}
    </form>
  );
}
