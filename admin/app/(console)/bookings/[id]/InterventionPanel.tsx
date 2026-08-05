"use client";

import { useState, useTransition } from "react";
import {
  forceComplete, reopenBooking, clearStartedAt, forceCancel, releaseHold, refundPayment,
  recordReversal, type ActionResult,
} from "../actions";

type Action = (fd: FormData) => Promise<ActionResult>;

// Every action here writes to a live booking or moves real money, so all of them
// require a written reason — it is the only record of why an operator overrode the
// normal flow, and it is what an appeal or a chargeback dispute is judged against.
export default function InterventionPanel({
  bookingId,
  status,
  startedAt,
  paymentStatus,
  refundableCents,
  isAdmin,
}: {
  bookingId: string;
  status: string;
  startedAt: string | null;
  paymentStatus: string | null;
  refundableCents: number;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");

  if (!isAdmin) {
    return (
      <p className="text-sm text-[var(--muted)]">
        Intervening on a booking requires the admin role.
      </p>
    );
  }

  const fire = (action: Action, label: string, extra: Record<string, string> = {}) => {
    if (!reason.trim()) {
      setResult({ ok: false, message: "Write a reason first." });
      return;
    }
    if (!confirm(`${label}\n\nBooking ${bookingId.slice(0, 8)}…\nReason: ${reason}`)) return;
    const fd = new FormData();
    fd.set("bookingId", bookingId);
    fd.set("reason", reason);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    start(async () => {
      const r = await action(fd);
      setResult(r);
      if (r.ok) { setReason(""); setAmount(""); }
    });
  };

  const settled = status === "verified";
  const btn = "rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-40";
  const danger = "rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40";

  return (
    <div className="space-y-3">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required — recorded in the audit log)"
        className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />

      <div className="flex flex-wrap gap-2">
        <button
          className={btn}
          disabled={pending || settled || !["confirmed", "completed"].includes(status)}
          onClick={() => fire(forceComplete, "Mark BOTH sides done?")}
        >
          Force complete
        </button>
        <button
          className={btn}
          disabled={pending || settled || status === "cancelled"}
          onClick={() => fire(reopenBooking, "Re-open this booking as confirmed?")}
        >
          Re-open
        </button>
        <button
          className={btn}
          disabled={pending || !startedAt}
          onClick={() => fire(clearStartedAt, "Clear started_at so both parties can cancel again?")}
        >
          Clear &ldquo;started&rdquo;
        </button>
        <button
          className={danger}
          disabled={pending || settled || status === "cancelled"}
          onClick={() => fire(forceCancel, "Cancel this booking and release any escrow hold?")}
        >
          Force cancel
        </button>
      </div>

      <div className="border-t border-[var(--line)] pt-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Money</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={btn}
            disabled={pending || paymentStatus !== "authorized"}
            onClick={() => fire(releaseHold, "Void the escrow hold? The poster is never charged.")}
          >
            Release hold
          </button>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={refundableCents > 0 ? `${(refundableCents / 100).toFixed(2)} (full)` : "—"}
            disabled={refundableCents <= 0}
            className="w-28 rounded-lg border border-[var(--line)] px-2 py-1.5 text-xs disabled:opacity-40"
          />
          <button
            className={danger}
            disabled={pending || refundableCents <= 0}
            onClick={() =>
              fire(
                refundPayment,
                amount
                  ? `Refund $${amount} to the poster?`
                  : `Refund the full remaining $${(refundableCents / 100).toFixed(2)} to the poster?`,
                { amount },
              )
            }
          >
            Refund
          </button>
          <button
            className={btn}
            disabled={pending || refundableCents <= 0}
            onClick={() =>
              fire(
                recordReversal,
                "Record a LOST CHARGEBACK against this booking?\n\nLedger only — no Stripe call. Use this when the money is already gone and Stripe refuses a refund.",
              )
            }
          >
            Record chargeback
          </button>
          <span className="text-xs text-[var(--muted)]">
            {paymentStatus === "authorized"
              ? "Hold is open — release it rather than refunding."
              : refundableCents > 0
                ? `Up to $${(refundableCents / 100).toFixed(2)} refundable. Blank = full.`
                : "Nothing refundable on this booking."}
          </span>
        </div>
      </div>

      {result && (
        <p className={`text-sm ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}
