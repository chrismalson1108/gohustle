"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Transactions — every payment, both sides. The website's half of the statement.
//
// Mobile has had this since PaymentsScreen shipped; the web had nothing. Not a
// thinner version — NOTHING: no receipts, no refunds, no pinned fee rate, no CSV,
// no bank deposits. A poster who hired through gohustlr.com and settled a disputed
// gig at 50% had no page showing what was actually charged. And Hustlr AI, whose
// widget is mounted in this app's layout and whose prompt is the SAME one the phone
// gets, told them to open "Transactions" and "the Bank deposits list on that same
// screen" — a screen that did not exist on the client they were using, from a prompt
// whose own rule is never invent a screen.
//
// The arithmetic is NOT here. It is shared/ledger.js via web/lib/payments.ts, the
// same module the app uses, because the fee is pinned per booking and the refund
// share differs by side — two hand-written copies of that disagree within a release.
// This file is presentation only.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Landmark, Receipt, Search, Wallet } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  fetchLedger,
  fetchPayouts,
  byMonth,
  filterEntries,
  ledgerCsv,
  monthlyTotals,
  paymentState,
  receiptLines,
  stats,
  RANGES,
  STATUS_FILTERS,
  type Deposit,
  type LedgerEntry,
  type LedgerSide,
} from "@/lib/payments";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames } from "@/lib/format";

const fmt = (c: number) =>
  `$${(Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const longDate = (v?: string | null) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

// Same four tones the app uses, so a status reads identically on both clients.
const TONE: Record<string, string> = {
  good: "bg-success-light text-success",
  hold: "bg-warning-light text-warning-deep",
  bad: "bg-urgent-light text-urgent",
  muted: "bg-line text-ink-muted",
};

export default function TransactionsPage() {
  const { user } = useAuth();

  const [side, setSide] = useState<LedgerSide>("earner");
  // Landing a pure poster on an empty "Earnings" tab reads as "we lost your money".
  // Pick the side they actually have history on, ONCE, and only before they touch
  // the control — after that the choice is theirs.
  const chosen = useRef(false);

  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [range, setRange] = useState("ytd");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [receipt, setReceipt] = useState<LedgerEntry | null>(null);
  const [showDeposits, setShowDeposits] = useState(false);

  // Hoisted out of the callback so the compiler's inferred dependency matches the
  // declared one — `user?.id` inside the body infers the whole `user` object and
  // React Compiler then skips optimizing the component.
  const userId = user?.id;

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      const rows = await fetchLedger(userId);
      setEntries(rows);
      if (!chosen.current) {
        const mine = rows.some((e) => e.side === "earner");
        if (!mine && rows.some((e) => e.side === "poster")) setSide("poster");
      }
      // Deposits are the earner's last leg and must never take the statement down
      // with them — a failure here leaves the list intact and the sheet empty.
      fetchPayouts(userId).then(setDeposits).catch(() => setDeposits([]));
    } catch (e) {
      // NOT an empty state. "You have no transactions" is a lie a failed read must
      // never tell on the page people open to find their money.
      setError((e as Error).message || "Couldn't load your transactions.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () => filterEntries(entries, { side, range, status, query }),
    [entries, side, range, status, query],
  );
  const sum = useMemo(() => stats(filtered), [filtered]);
  const months = useMemo(() => byMonth(filtered), [filtered]);
  const trend = useMemo(() => monthlyTotals(filtered), [filtered]);
  const trendMax = useMemo(() => Math.max(1, ...trend.map((m) => m.cents)), [trend]);

  const isEarner = side === "earner";

  const download = () => {
    const csv = ledgerCsv(filtered, side);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gohustlr-${side === "earner" ? "earnings" : "spending"}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <FullPageSpinner />;

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle="Receipts, fees, refunds & escrow"
        width="content"
        back="/profile"
        right={
          filtered.length > 0 ? (
            <Button variant="outline" onClick={download}>
              <Download className="size-4" /> Export CSV
            </Button>
          ) : undefined
        }
      />

      <PageContainer width="content" className="space-y-4 pb-10">
        {/* Which side of the money you are looking at. The same row means opposite
            things to the two parties, so the control is not cosmetic. */}
        <div className="flex rounded-xl bg-white p-1 shadow-[var(--shadow-card)]">
          {(["earner", "poster"] as LedgerSide[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                chosen.current = true;
                setSide(s);
              }}
              className={classNames(
                "flex-1 rounded-lg px-3 py-2 text-sm font-bold transition",
                side === s ? "bg-primary text-white" : "text-ink-soft hover:bg-canvas",
              )}
            >
              {s === "earner" ? "Earnings" : "Spending"}
            </button>
          ))}
        </div>

        {error ? (
          <div className="rounded-2xl bg-urgent-light p-4">
            <p className="text-sm font-bold text-urgent">Couldn&apos;t load your transactions</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">{error}</p>
            <Button variant="outline" className="mt-3" onClick={() => { setLoading(true); load(); }}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {/* Summary. Gross AND net AND what came out in between, because "why is
                this $54 when the gig was $60" is the ticket this page should answer
                without anyone writing a reply. */}
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {isEarner ? "Net to you" : "Total charged"}
              </p>
              <p className="mt-1 text-3xl font-bold tracking-[-0.5px] text-ink">{fmt(sum.netCents)}</p>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-ink-muted">Transactions</dt>
                  <dd className="font-semibold text-ink">{sum.settledCount}</dd>
                </div>
                {sum.heldCents > 0 && (
                  <div>
                    <dt className="text-ink-muted">In escrow</dt>
                    <dd className="font-semibold text-ink">{fmt(sum.heldCents)}</dd>
                  </div>
                )}
                {isEarner && sum.feesCents > 0 && (
                  <div>
                    <dt className="text-ink-muted">Platform fees</dt>
                    <dd className="font-semibold text-ink">−{fmt(sum.feesCents)}</dd>
                  </div>
                )}
                {sum.tipsCents > 0 && (
                  <div>
                    <dt className="text-ink-muted">Tips</dt>
                    <dd className="font-semibold text-ink">{fmt(sum.tipsCents)}</dd>
                  </div>
                )}
                {sum.refundedCents > 0 && (
                  <div>
                    <dt className="text-ink-muted">Refunded</dt>
                    <dd className="font-semibold text-ink">−{fmt(sum.refundedCents)}</dd>
                  </div>
                )}
              </dl>

              {/* Six months. Empty months are KEPT — a gap is data. */}
              {sum.settledCount > 0 && (
                <div className="mt-5 flex items-end gap-2">
                  {trend.map((m) => (
                    <div key={m.key} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="w-full rounded-t bg-primary-light"
                        style={{ height: `${Math.max(2, Math.round((m.cents / trendMax) * 56))}px` }}
                        title={`${m.label}: ${fmt(m.cents)}`}
                      />
                      <span className="text-[10px] text-ink-muted">{m.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {isEarner && (
                <button
                  type="button"
                  onClick={() => setShowDeposits(true)}
                  className="mt-4 flex w-full items-center gap-2 rounded-xl bg-canvas px-3 py-2.5 text-left text-sm font-semibold text-ink hover:bg-line"
                >
                  <Landmark className="size-4 shrink-0 text-primary" />
                  Bank deposits
                  <span className="ml-auto text-xs font-normal text-ink-muted">
                    {deposits.length ? `${deposits.length} recorded` : "none yet"}
                  </span>
                </button>
              )}
            </div>

            {/* Filters. A statement you cannot slice is a list, not a statement. */}
            <div className="space-y-2 rounded-2xl bg-white p-3 shadow-[var(--shadow-card)]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by gig"
                  className="w-full rounded-xl bg-canvas py-2.5 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-ink-muted"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {RANGES.map((r) => (
                  <Chip key={r.key} on={range === r.key} onClick={() => setRange(r.key)}>
                    {r.label}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_FILTERS.map((s) => (
                  <Chip key={s.key} on={status === s.key} onClick={() => setStatus(s.key)}>
                    {s.label}
                  </Chip>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <EmptyState
                icon={<Receipt className="size-8" />}
                title={isEarner ? "No earnings here yet" : "No payments here yet"}
                body={
                  entries.length
                    ? "Nothing matches these filters. Try a wider date range."
                    : isEarner
                      ? "Money you're paid for a gig shows up here, with the fee and what reached your bank."
                      : "Every gig you pay for shows up here, with a receipt you can check against your card."
                }
              />
            ) : (
              months.map((m) => (
                <section key={m.key} className="space-y-2">
                  <h2 className="px-1 text-xs font-bold uppercase tracking-wide text-ink-muted">{m.label}</h2>
                  <ul className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
                    {m.data.map((e) => {
                      const st = paymentState(e.status, e.side);
                      return (
                        <li key={e.id} className="border-b border-line last:border-0">
                          <button
                            type="button"
                            onClick={() => setReceipt(e)}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-bold text-ink">{e.title}</p>
                              <p className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                                <span>{shortDate(e.at)}</span>
                                <span
                                  className={classNames(
                                    "rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                                    TONE[st.tone] ?? TONE.muted,
                                  )}
                                >
                                  {st.label}
                                </span>
                              </p>
                            </div>
                            <p
                              className={classNames(
                                "shrink-0 text-sm font-bold",
                                e.pending ? "text-ink-muted" : "text-ink",
                              )}
                            >
                              {isEarner ? "+" : "−"}
                              {fmt(e.netCents)}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </>
        )}
      </PageContainer>

      {/* Receipt. The line items SUM to the total by construction (receiptLines),
          and the fee rate is THAT booking's pin — never today's rate card. */}
      <Modal open={Boolean(receipt)} onClose={() => setReceipt(null)} title={receipt?.title ?? "Receipt"} size="sm">
        {receipt && <ReceiptBody entry={receipt} />}
      </Modal>

      <Modal open={showDeposits} onClose={() => setShowDeposits(false)} title="Bank deposits" size="sm">
        <p className="mb-3 text-xs leading-relaxed text-ink-soft">
          Money reaches your Stripe payout account as soon as a gig is released, and Stripe deposits it to your bank
          on its own schedule. Stripe batches gigs into one deposit, so a deposit does not map to a single gig.
        </p>
        {deposits.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">No deposits recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {deposits.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-3">
                <Wallet className="size-4 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-ink">{fmt(d.amountCents)}</p>
                  <p className="text-xs text-ink-muted">
                    {d.verb} {shortDate(d.arrivalAt)}
                    {d.failureMessage ? ` · ${d.failureMessage}` : ""}
                  </p>
                </div>
                <span
                  className={classNames(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    TONE[d.tone] ?? TONE.muted,
                  )}
                >
                  {d.label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        "rounded-full px-3 py-1.5 text-xs font-semibold transition",
        on ? "bg-primary text-white" : "bg-canvas text-ink-soft hover:bg-line",
      )}
    >
      {children}
    </button>
  );
}

function ReceiptBody({ entry }: { entry: LedgerEntry }) {
  const { lines, totalCents, totalLabel } = receiptLines(entry);
  const st = paymentState(entry.status, entry.side);
  return (
    <div className="space-y-3">
      <div>
        <span
          className={classNames("rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE[st.tone] ?? TONE.muted)}
        >
          {st.label}
        </span>
        {st.note && <p className="mt-2 text-xs leading-relaxed text-ink-soft">{st.note}</p>}
      </div>

      <dl className="space-y-1.5 rounded-xl bg-canvas p-3 text-sm">
        {lines.map((l) => (
          <div key={l.key} className="flex items-center justify-between gap-4">
            <dt className={classNames(l.dim ? "text-ink-muted" : "text-ink-soft")}>{l.label}</dt>
            <dd className={classNames("font-semibold tabular-nums", l.good ? "text-success" : "text-ink")}>
              {l.cents < 0 ? "−" : ""}
              {fmt(l.cents)}
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 border-t border-line pt-2">
          <dt className="font-bold text-ink">{totalLabel}</dt>
          <dd className="text-base font-bold tabular-nums text-ink">{fmt(totalCents)}</dd>
        </div>
      </dl>

      <dl className="space-y-1 text-xs text-ink-muted">
        <div className="flex justify-between gap-4">
          <dt>Authorized</dt>
          <dd>{longDate(entry.authorizedAt)}</dd>
        </div>
        {entry.capturedAt && (
          <div className="flex justify-between gap-4">
            <dt>Released</dt>
            <dd>{longDate(entry.capturedAt)}</dd>
          </div>
        )}
        {entry.refundedAt && (
          <div className="flex justify-between gap-4">
            <dt>Refunded</dt>
            <dd>
              {longDate(entry.refundedAt)}
              {entry.refundReason ? ` · ${entry.refundReason}` : ""}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
