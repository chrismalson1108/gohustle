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
          <span className="text-[var(--muted)]">Mark:</span>
          {(["open", "pending", "closed"] as const).map((s) => (
            <button
              key={s}
              onClick={() => status(s)}
              disabled={pending || currentStatus === s}
              className={`rounded px-2 py-1 capitalize ${currentStatus === s ? "bg-[var(--surface)] text-[var(--muted)]" : "border border-[var(--line)] hover:bg-[var(--surface)]"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
