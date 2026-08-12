"use client";

import { useRef, useState, useTransition } from "react";
import { replyTicket, setTicketStatus, setTicketPriority, claimTicket, aiDraft, type ActionResult } from "../actions";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export default function Composer({
  ticketId,
  currentStatus,
  priority,
  assignedToMe,
  assigned,
  hasAppUser,
}: {
  ticketId: string;
  currentStatus: string;
  priority: string;
  assignedToMe: boolean;
  assigned: boolean;
  hasAppUser: boolean;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  function send() {
    const fd = new FormData();
    fd.set("ticketId", ticketId);
    fd.set("body", body);
    files.forEach((f) => fd.append("images", f));
    start(async () => {
      const r = await replyTicket(fd);
      setResult(r);
      if (r.ok) {
        setBody("");
        setFiles([]);
        if (fileRef.current) fileRef.current.value = "";
      }
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
    // WHAT CLOSING NOW MEANS. This dialog used to say the user could no longer reply
    // and that a new message would start a fresh ticket. That stopped being true when
    // a user reply started reopening the thread — and a confirm that misdescribes its
    // own consequence is worse than no confirm, because it is trusted.
    if (
      s === "closed" &&
      !confirm(
        "Mark this ticket resolved?\n\nIt leaves the open queue. The user keeps the thread and can still write in it — a reply reopens this same ticket with all its history, so nothing is lost if we called it early.",
      )
    )
      return;
    const fd = new FormData();
    fd.set("ticketId", ticketId);
    fd.set("status", s);
    start(async () => setResult(await setTicketStatus(fd)));
  }

  function claim(release: boolean) {
    const fd = new FormData();
    fd.set("ticketId", ticketId);
    if (release) fd.set("release", "1");
    start(async () => setResult(await claimTicket(fd)));
  }

  function prio(p: string) {
    const fd = new FormData();
    fd.set("ticketId", ticketId);
    fd.set("priority", p);
    start(async () => setResult(await setTicketPriority(fd)));
  }

  return (
    <div className="space-y-3">
      {/* ── Triage row ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-xs">
        <span className="text-[var(--muted)]">Priority:</span>
        {PRIORITIES.map((p) => (
          <button
            key={p}
            onClick={() => prio(p)}
            disabled={pending || priority === p}
            className={`rounded px-2 py-1 capitalize ${
              priority === p
                ? "bg-[var(--brand)] text-white"
                : "border border-[var(--line)] hover:bg-[var(--surface)]"
            }`}
          >
            {p}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {assignedToMe ? (
            <>
              <span className="text-[var(--muted)]">Assigned to you</span>
              <button
                onClick={() => claim(true)}
                disabled={pending}
                className="rounded border border-[var(--line)] px-2 py-1 hover:bg-[var(--surface)]"
              >
                Release
              </button>
            </>
          ) : (
            <button
              onClick={() => claim(false)}
              disabled={pending}
              className="rounded border border-[var(--line)] px-2 py-1 font-medium hover:bg-[var(--surface)]"
            >
              {assigned ? "Take over" : "Claim"}
            </button>
          )}
        </div>
      </div>

      {/* ── Reply ───────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--line)] bg-white p-4">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder={
            hasAppUser
              ? "Write a reply… (appears in their app and is emailed)"
              : "Write a reply… (emailed — this ticket has no app account)"
          }
          className="w-full resize-y rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
        />

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 6))}
            className="text-xs text-[var(--muted)] file:mr-2 file:rounded file:border file:border-[var(--line)] file:bg-[var(--surface)] file:px-2 file:py-1 file:text-xs"
          />
          {files.length ? (
            <span className="text-[var(--muted)]">
              {files.length} attachment{files.length === 1 ? "" : "s"} · sent in-app only
            </span>
          ) : null}
        </div>

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
                  className="ml-1 rounded border border-[var(--line)] px-2 py-1 font-medium text-[var(--danger)] hover:bg-[var(--surface)] disabled:opacity-50"
                >
                  Resolve…
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
