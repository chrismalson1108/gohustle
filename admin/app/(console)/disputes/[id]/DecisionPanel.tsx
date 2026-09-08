"use client";

import { useState, useTransition } from "react";
import { decideDispute, setDisputeStatus } from "../actions";
import ReauthPrompt from "../../ReauthPrompt";
import { useStepUp } from "../../useStepUp";
import { fmtCents } from "@/lib/format";

/**
 * The adjudication control.
 *
 * `canResolve` comes from the PAGE as roleSatisfies(ctx.role, "trust") — the same
 * predicate both actions enforce. This queue is trust's whole job; gating it on
 * role === "admin" is the mistake adminTierParity.test.js exists to catch.
 *
 * The percentage floor is the poster's own ask, and it is enforced on the SERVER; the
 * slider is bounded here as well so the operator is not offered a number that will be
 * refused. Both halves say why, because "invalid" on a money decision is useless.
 */
export default function DecisionPanel({
  disputeId,
  status,
  proposedPct,
  decidedPct,
  settledPct,
  holdCents,
  canResolve,
}: {
  disputeId: string;
  status: string;
  proposedPct: number;
  decidedPct: number | null;
  settledPct: number | null;
  holdCents: number | null;
  canResolve: boolean;
}) {
  const [pending, start] = useTransition();
  // requireAdmin itself throws stale_mfa at the 12h session cap, and decideDispute is
  // requireFreshAdmin — so both paths here can come back recoverable, and both need the
  // prompt or the operator dead-ends on a decision they are allowed to make.
  const stepUp = useStepUp();
  const result = stepUp.result;
  const [pct, setPct] = useState<number>(decidedPct ?? 100);
  const [note, setNote] = useState("");

  if (settledPct != null) {
    return (
      <p className="text-sm text-[var(--muted)]">
        Settled at {settledPct}% — the money has moved. A further adjustment is a refund, from the
        booking page.
      </p>
    );
  }
  if (!canResolve) {
    return <p className="text-sm text-[var(--muted)]">{status} · view only. Deciding this needs the trust tier.</p>;
  }

  const chips = [...new Set([proposedPct, Math.min(100, Math.round((proposedPct + 100) / 2)), 100])]
    .filter((p) => p >= proposedPct)
    .sort((a, b) => a - b);
  const preview = holdCents == null ? null : Math.round((holdCents * pct) / 100);
  const btn =
    "rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-40";

  const apply = () => {
    const fd = new FormData();
    fd.set("disputeId", disputeId);
    fd.set("pct", String(pct));
    fd.set("note", note);
    start(async () => {
      // Clear inside the thunk: useStepUp replays this same call after a fresh code.
      await stepUp.run(async () => {
        const r = await decideDispute(fd);
        if (r.ok) setNote("");
        return r;
      });
    });
  };

  const mark = (next: string) => {
    const fd = new FormData();
    fd.set("disputeId", disputeId);
    fd.set("status", next);
    fd.set("note", note);
    start(async () => {
      await stepUp.run(() => setDisputeStatus(fd));
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm text-[var(--muted)]">
          Pay the earner{" "}
          <strong className="text-[var(--fg)]">
            {proposedPct}–100%
          </strong>
          . You cannot go below what the poster asked for: a partial capture releases the rest to the
          poster and cannot be topped up, so that direction is the one decision nobody can undo.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setPct(c)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                pct === c ? "bg-[var(--brand)] text-white" : "border border-[var(--line)] hover:bg-[var(--surface)]"
              }`}
            >
              {c}%{c === proposedPct ? " (asked)" : c === 100 ? " (in full)" : ""}
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            or
            <input
              type="number"
              min={proposedPct}
              max={100}
              value={pct}
              onChange={(e) => setPct(Math.max(proposedPct, Math.min(100, Number(e.target.value) || 0)))}
              className="w-20 rounded-lg border border-[var(--line)] px-2 py-1 text-xs"
            />
            %
          </label>
          {preview != null && (
            <span className="text-xs text-[var(--muted)]">
              captures {fmtCents(preview)} of the {fmtCents(holdCents)} hold, less the platform fee pinned on
              this booking
            </span>
          )}
        </div>
      </div>

      {/* The note is granted to `authenticated` (20260909030000) and both dispute screens
          render it, so it is not an internal aside. Saying so at the point of writing is
          the only thing that stops one being typed. */}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="What you decided and why. BOTH PARTIES SEE THIS — write it to them, not about them."
        className="w-full resize-y rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={pending}
          className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : `Settle at ${pct}%`}
        </button>
        {status !== "investigating" && (
          <button type="button" className={btn} disabled={pending} onClick={() => mark("investigating")}>
            Mark investigating
          </button>
        )}
        <span className="text-xs text-[var(--muted)]">
          Recorded now; the hourly sweep captures it and notifies both parties.
        </span>
      </div>

      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      {result && (
        <p className={`text-sm ${result.ok ? "text-emerald-700" : "text-[var(--danger)]"}`}>{result.message}</p>
      )}
    </div>
  );
}
