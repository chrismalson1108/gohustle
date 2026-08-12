"use client";

import { useState, useTransition } from "react";
import { replyTicket, setTicketStatus, aiDraft, type ActionResult } from "../actions";

export default function Composer({ ticketId, currentStatus }: { ticketId: string; currentStatus: string }) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  function send() {
    const fd = new FormData();
    fd.set("ticketId", ticketId);
    fd.set("body", body);
    start(async () => {
      const r = await replyTicket(fd);
      setResult(r);
      if (r.ok) setBody("");
    });
  }

  function draft() {
    startDraft(async () => {
      const r = await aiDraft(ticketId);
      if (r.ok && r.draft) setBody((b) => (b ? b + "\n\n" + r.draft : r.draft!));
      else setResult({ ok: false, message: r.message ?? "AI draft failed." });
    });
  }

  function status(s: "open" | "pending" | "closed") {
    // Closing is the only one that ends the conversation for the user: the RLS insert
    // policy refuses a reply on a closed ticket, so from their side the thread stops
    // accepting messages. That deserves a confirm; open/pending are freely reversible
    // and do not.
    if (s === "closed" && !confirm(
      "Close this ticket?\n\nThe user can no longer reply on this thread — a new message from them starts a fresh ticket. You can reopen this one at any time.",
    )) return;
    const fd = new FormData();
    fd.set("ticketId", ticketId);
    fd.set("status", s);
    start(async () => setResult(await setTicketStatus(fd)));
  }

  return (
    <div className="rounded-xl border border-[var(--line)] bg-white p-4">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Write a reply… (sent as an email to the user)"
        className="w-full resize-y rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
      />
      {result && (
        <p className={`mt-2 text-sm ${result.ok ? "text-emerald-700" : "text-[var(--danger)]"}`}>{result.message}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={send}
          disabled={pending || !body.trim()}
          className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send reply"}
        </button>
        <button
          onClick={draft}
          disabled={drafting}
          className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-medium hover:bg-[var(--surface)] disabled:opacity-50"
        >
          {drafting ? "Drafting…" : "✨ Draft with AI"}
        </button>
        <div className="ml-auto flex items-center gap-1 text-xs">
          {currentStatus === "closed" ? (
            // A closed ticket is never a dead end. Reopening is one obvious click, and
            // it is the primary action here because the reason you are looking at a
            // closed ticket is usually that it should not have been closed.
            <button
              onClick={() => status("open")}
              disabled={pending}
              className="rounded-lg bg-[var(--brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Reopen ticket
            </button>
          ) : (
            <>
              <span className="text-[var(--muted)]">Mark:</span>
              {(["open", "pending"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => status(s)}
                  disabled={pending || currentStatus === s}
                  className={`rounded px-2 py-1 capitalize ${currentStatus === s ? "bg-[var(--surface)] text-[var(--muted)]" : "border border-[var(--line)] hover:bg-[var(--surface)]"}`}
                >
                  {s}
                </button>
              ))}
              <button
                onClick={() => status("closed")}
                disabled={pending}
                className="ml-1 rounded px-2 py-1 font-medium text-[var(--danger)] border border-[var(--line)] hover:bg-[var(--surface)] disabled:opacity-50"
              >
                Close…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
