"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  Plus,
  Trash2,
  Receipt,
  Wallet,
  Camera,
  X,
  Box,
  Car,
  Wrench,
  CreditCard,
  Megaphone,
  Smartphone,
  Utensils,
  MoreHorizontal,
  Banknote,
  Gift,
  Loader2,
  Briefcase,
} from "lucide-react";
import {
  EXPENSE_CATEGORIES,
  categoryMeta,
  INCOME_SOURCES,
  sourceMeta,
  buildTaxSummaryCSV,
} from "@gohustlr/shared";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import { useJobs, computeEffectivePay } from "@/lib/jobs";
import { bookingNetDollars } from "@gohustlr/shared";
import {
  fetchExpenses,
  addExpense,
  deleteExpense,
  fetchIncome,
  addIncome,
  deleteIncome,
  uploadReceipt,
  getSignedUrl,
  yearSummary,
  expensesByJob,
  type Expense,
  type IncomeEntry,
} from "@/lib/expenses";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Input, Textarea, Label } from "@/components/ui/Field";
import { money, classNames } from "@/lib/format";

const todayISO = () => new Date().toISOString().slice(0, 10);

// Map shared category/source ids to lucide icons (web equivalent of the mobile
// Ionicons). Falls back to a generic icon.
const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  supplies: Box,
  transport: Car,
  equipment: Wrench,
  fees: CreditCard,
  marketing: Megaphone,
  phone: Smartphone,
  meals: Utensils,
  other: MoreHorizontal,
};
const SOURCE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  cash: Banknote,
  tip: Gift,
  other: MoreHorizontal,
};

type Tab = "expenses" | "income";

export default function TaxesPage() {
  const { user } = useAuth();
  const { earningsTotal, showToast } = useUser();
  const { bookings, posterBookings } = useJobs();

  // The user's gigs available to tie an expense to: booked work + posted gigs,
  // de-duped by booking id.
  const jobOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; title: string }[] = [];
    [...(bookings || []), ...(posterBookings || [])].forEach((b) => {
      if (b?.id && !seen.has(b.id)) {
        seen.add(b.id);
        out.push({ id: b.id, title: b.job?.title || "Gig" });
      }
    });
    return out;
  }, [bookings, posterBookings]);
  const jobTitleFor = useMemo(() => {
    const m: Record<string, string> = {};
    jobOptions.forEach((o) => { m[o.id] = o.title; });
    return m;
  }, [jobOptions]);

  const [tab, setTab] = useState<Tab>("expenses");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [income, setIncome] = useState<IncomeEntry[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({}); // expenseId -> signed URL
  const [loading, setLoading] = useState(true);

  // Add-entry modal state
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("supplies");
  const [source, setSource] = useState("cash");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayISO());
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Pending destructive action — drives the confirm Modal below.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "expense"; row: Expense } | { kind: "income"; row: IncomeEntry } | null
  >(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [ex, inc] = await Promise.all([fetchExpenses(user.id), fetchIncome(user.id)]);
      setExpenses(ex);
      setIncome(inc);
      // Sign private receipt paths for display.
      const map: Record<string, string> = {};
      await Promise.all(
        ex
          .filter((e) => e.receipt_url && !e.receipt_url.startsWith("http"))
          .map(async (e) => {
            const u = await getSignedUrl("receipts", e.receipt_url as string);
            if (u) map[e.id] = u;
          }),
      );
      setReceiptUrls(map);
    } catch {
      // swallow — empty state will show
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async data load; setState runs after awaits, mirrors sibling pages
    load();
  }, [load]);

  const year = new Date().getFullYear();

  // Year-scoped, fee-net platform income — NOT profiles.earnings_total, which is a
  // LIFETIME figure and was being labelled as this year's income (and driving the
  // "set aside ~27%" prompt off it). Mobile's Tax Center was fixed for exactly this
  // and web was left behind; its comment names the bug: "a year-scoped estimate is
  // strictly better than a lifetime total presented as a single year's income."
  //
  // Approximate by nature — the authoritative per-booking net is
  // payments.earner_amount_cents, which this screen does not load. Hourly gigs are
  // valued at one hour because the booking embed carries no estimatedHours, so this
  // under- rather than over-states income, the safer direction for a tax set-aside.
  const platformIncome = useMemo(
    () =>
      (bookings || [])
        .filter((b) => b?.status === "verified" && String(b?.completedAt || "").startsWith(String(year)))
        .reduce((sum, b) => sum + bookingNetDollars(computeEffectivePay(b), b.feeBpsQuoted), 0),
    [bookings, year],
  );

  const summary = useMemo(
    () => yearSummary({ year, stripeIncome: platformIncome, expenses, income }),
    [year, platformIncome, expenses, income],
  );

  // Per-job expense breakdown for the current year.
  const jobGroups = useMemo(
    () => expensesByJob(summary.yearExpenses, [...(bookings || []), ...(posterBookings || [])]),
    [summary.yearExpenses, bookings, posterBookings],
  );

  const resetForm = () => {
    setAmount("");
    setCategory("supplies");
    setSource("cash");
    setDescription("");
    setDate(todayISO());
    setBookingId(null);
    setReceiptFile(null);
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptPreview(null);
    setFormError(null);
  };

  const openAdd = () => {
    resetForm();
    setAdding(true);
  };

  const closeAdd = () => {
    if (saving) return;
    setAdding(false);
    resetForm();
  };

  const onPickReceipt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptFile(file);
    setReceiptPreview(URL.createObjectURL(file));
  };

  const clearReceipt = () => {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptFile(null);
    setReceiptPreview(null);
  };

  const handleSave = async () => {
    if (!user) return;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      setFormError("Enter an amount greater than zero.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFormError("Use the date format YYYY-MM-DD.");
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      if (tab === "expenses") {
        let receiptPath: string | null = null;
        if (receiptFile) receiptPath = await uploadReceipt(receiptFile, user.id);
        const row = await addExpense(user.id, {
          amount: amt,
          category,
          description,
          date,
          receiptUrl: receiptPath,
          bookingId,
        });
        setExpenses((prev) => [row, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)));
        if (receiptPath) {
          const u = await getSignedUrl("receipts", receiptPath);
          if (u) setReceiptUrls((prev) => ({ ...prev, [row.id]: u }));
        }
      } else {
        const row = await addIncome(user.id, { amount: amt, source, description, date });
        setIncome((prev) => [row, ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)));
      }
      showToast({ icon: "✅", title: "Saved", message: tab === "expenses" ? "Expense logged." : "Income logged." });
      setAdding(false);
      resetForm();
    } catch (e) {
      setFormError((e as Error).message || "Could not save. Please try again.");
    }
    setSaving(false);
  };

  // Deletes confirm through the shared Modal, like every other destructive action
  // in the app (settings delete-account, hiring delete-gig). `window.confirm` was
  // an unstyled, render-blocking OS dialog prefixed with the site's hostname on
  // mobile Safari. The optimistic remove + reload-on-failure behaviour is unchanged.
  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    if (target.kind === "expense") {
      setExpenses((p) => p.filter((e) => e.id !== target.row.id));
      try {
        await deleteExpense(target.row.id);
      } catch {
        load();
      }
    } else {
      setIncome((p) => p.filter((e) => e.id !== target.row.id));
      try {
        await deleteIncome(target.row.id);
      } catch {
        load();
      }
    }
  };

  const handleExport = () => {
    const { yearExpenses, yearIncome } = summary;
    if (!yearExpenses.length && !yearIncome.length && !platformIncome) {
      showToast({ icon: "📄", title: "Nothing to export", message: `No income or expenses recorded for ${year} yet.` });
      return;
    }
    const csv = buildTaxSummaryCSV({
      year,
      // Same year-scoped figure the screen shows. This one ends up in front of an
      // accountant, so a lifetime total under a "2026" heading is the worst place
      // for it.
      stripeIncome: platformIncome,
      income: yearIncome as unknown as Array<Record<string, unknown>>,
      expenses: yearExpenses as unknown as Array<Record<string, unknown>>,
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gohustlr-tax-summary-${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader title="Tax Center" subtitle="Track income & deductible expenses" width="form" back="/profile" />

      <PageContainer width="form" className="space-y-4 pb-8">
        {/* Year summary — flat white cards on the page canvas, mirroring mobile's
            ExpensesScreen summary card. It used to be a translucent glass panel
            floating on the gradient hero, split by two hairline rules into a 3-up
            row that left each stat ~82px at 375px ("Set aside ~27%" barely fit).
            Same numbers, same order, no gradient and no dividers. */}
        <section>
          <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
            <p className="text-xs font-medium text-ink-muted">{year} net profit</p>
            <p className="mt-1 truncate text-[32px] font-bold leading-10 tracking-[-0.6px] text-ink">
              {money(summary.net)}
            </p>
          </div>
          {/* Container query, not a viewport one: this column is capped at the form
              measure, so it stacks on a phone and goes 3-up as soon as the content
              box — not the window — has room for it. */}
          <div className="mt-3 grid grid-cols-1 gap-3 @lg:grid-cols-3">
            <SummaryStat label="Income" value={money(summary.grossIncome)} />
            <SummaryStat label="Expenses" value={money(summary.expTotal)} />
            <SummaryStat label="Set aside ~27%" value={money(summary.setAside)} />
          </div>
        </section>

        {/* Segmented control — pill track, no shadow on the active segment, and the
            weight stays at 600 in both states so switching tabs can't re-measure. */}
        <div className="flex w-full rounded-full border border-line bg-white p-1">
          <SegmentBtn label="Expenses" active={tab === "expenses"} onClick={() => setTab("expenses")} />
          <SegmentBtn label="Income" active={tab === "income"} onClick={() => setTab("income")} />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button onClick={openAdd} fullWidth className="min-w-0">
            <Plus className="size-4 shrink-0" />
            <span className="truncate">{tab === "expenses" ? "Add Expense" : "Add Income"}</span>
          </Button>
          <Button variant="outline" className="shrink-0" onClick={handleExport}>
            <Download className="size-4 shrink-0" /> Export
          </Button>
        </div>

        <p className="text-xs leading-5 text-ink-muted">
          {tab === "income"
            ? "Card payments are already counted from your platform earnings. Log cash and tips here so your income is complete."
            : "Log work-related purchases to deduct them. Export the year-end summary for your accountant or tax software. (Not tax advice.)"}
        </p>

        {/* By-job expense breakdown */}
        {tab === "expenses" && jobGroups.length > 0 && (
          <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
            <p className="mb-2 text-[13px] font-semibold text-ink-muted">By job · {year}</p>
            <ul>
              {jobGroups.map((g) => (
                <li key={g.bookingId} className="flex items-center gap-2 py-1.5">
                  <Briefcase className="size-3.5 shrink-0 text-ink-muted" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{g.title}</span>
                  <span className="shrink-0 text-[13px] font-semibold text-ink">{money(g.total)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-16 text-ink-muted">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : tab === "expenses" ? (
          expenses.length === 0 ? (
            <EmptyState
              icon={<Receipt className="size-10" />}
              title="No expenses yet"
              body='Tap "Add Expense" to start tracking write-offs.'
            />
          ) : (
            <ul className="space-y-2">
              {expenses.map((exp) => {
                const meta = categoryMeta(exp.category);
                const Icon = CATEGORY_ICONS[exp.category] || MoreHorizontal;
                const thumb =
                  receiptUrls[exp.id] || (exp.receipt_url?.startsWith("http") ? exp.receipt_url : null);
                return (
                  <li
                    key={exp.id}
                    className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-soft">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{meta.label}</p>
                      {exp.description && (
                        <p className="mt-0.5 truncate text-xs leading-4 text-ink-soft">{exp.description}</p>
                      )}
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                        <p className="shrink-0 text-xs text-ink-muted">{exp.date}</p>
                        {exp.booking_id && (
                          // Neutral tag: the row's one piece of emphasis is the amount.
                          <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-lg bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
                            <Briefcase className="size-2.5 shrink-0" />
                            <span className="truncate">{jobTitleFor[exp.booking_id] || "Gig"}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    {thumb && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="receipt" className="size-9 shrink-0 rounded-lg bg-divider object-cover" />
                    )}
                    <div className="shrink-0 text-right">
                      <p className="text-[15px] font-bold text-ink">{money(exp.amount)}</p>
                      {exp.miles != null && (
                        <p className="text-[11px] font-medium text-ink-muted">{exp.miles.toFixed(1)} mi</p>
                      )}
                    </div>
                    <button
                      onClick={() => setPendingDelete({ kind: "expense", row: exp })}
                      // An explicit 44px box. Padding around the glyph only reached
                      // 36px (preflight sets `svg { display: block }`, so there is no
                      // line-box strut to help), and `-m-1` pulls the LAYOUT in — it
                      // does not enlarge a hit area.
                      className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-urgent transition hover:bg-urgent/10"
                      aria-label="Delete expense"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : income.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-10" />}
            title="No cash income logged"
            body='Tap "Add Income" to log cash payments and tips.'
          />
        ) : (
          <ul className="space-y-2">
            {income.map((inc) => {
              const meta = sourceMeta(inc.source);
              const Icon = SOURCE_ICONS[inc.source] || MoreHorizontal;
              return (
                <li
                  key={inc.id}
                  className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]"
                >
                  {/* Money that has actually landed — success green, same as mobile. */}
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-light text-success">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{meta.label}</p>
                    {inc.description && (
                      <p className="mt-0.5 truncate text-xs leading-4 text-ink-soft">{inc.description}</p>
                    )}
                    <p className="mt-1 truncate text-xs text-ink-muted">{inc.date}</p>
                  </div>
                  <p className="shrink-0 text-[15px] font-bold text-success">{money(inc.amount)}</p>
                  <button
                    onClick={() => setPendingDelete({ kind: "income", row: inc })}
                    // Same explicit 44px box as the expense delete above.
                    className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-urgent transition hover:bg-urgent/10"
                    aria-label="Delete income"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PageContainer>

      {/* Add modal */}
      <Modal
        open={adding}
        onClose={closeAdd}
        title={tab === "expenses" ? "Add Expense" : "Add Income"}
        footer={
          <div className="flex gap-3">
            <Button variant="ghost" onClick={closeAdd} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} fullWidth>
              {tab === "expenses" ? "Save Expense" : "Save Income"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>Amount</Label>
            <div className="flex min-h-14 items-center gap-1.5 rounded-xl border border-line bg-white px-4 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
              <span className="shrink-0 text-lg font-semibold text-ink-muted">$</span>
              <input
                className="w-full min-w-0 bg-transparent py-3 text-xl font-semibold text-ink outline-none placeholder:text-ink-muted"
                placeholder="0.00"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          {tab === "expenses" ? (
            <div>
              <Label>Category</Label>
              <div className="flex flex-wrap gap-2">
                {EXPENSE_CATEGORIES.map((c) => {
                  const Icon = CATEGORY_ICONS[c.id] || MoreHorizontal;
                  const active = category === c.id;
                  return (
                    <Chip key={c.id} active={active} onClick={() => setCategory(c.id)}>
                      <Icon className="size-3.5" /> {c.label}
                    </Chip>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <Label>Source</Label>
              <div className="flex flex-wrap gap-2">
                {INCOME_SOURCES.map((s) => {
                  const Icon = SOURCE_ICONS[s.id] || MoreHorizontal;
                  const active = source === s.id;
                  return (
                    <Chip key={s.id} active={active} onClick={() => setSource(s.id)}>
                      <Icon className="size-3.5" /> {s.label}
                    </Chip>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <Label>Note (optional)</Label>
            <Textarea
              className="min-h-[60px]"
              placeholder={tab === "expenses" ? "e.g. Gas for delivery run" : "e.g. Cash tip from client"}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {tab === "expenses" && jobOptions.length > 0 && (
            <div>
              <Label>Tie to a job (optional)</Label>
              <div className="flex flex-wrap gap-2">
                <Chip active={!bookingId} onClick={() => setBookingId(null)}>
                  — None —
                </Chip>
                {jobOptions.map((o) => (
                  <Chip key={o.id} active={bookingId === o.id} onClick={() => setBookingId(o.id)}>
                    <Briefcase className="size-3.5" /> <span className="max-w-[140px] truncate">{o.title}</span>
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {tab === "expenses" && (
            <div>
              <Label>Receipt (optional)</Label>
              {receiptPreview ? (
                <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={receiptPreview} alt="receipt preview" className="size-24 rounded-xl bg-divider object-cover" />
                  <button
                    onClick={clearReceipt}
                    className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-urgent text-white ring-1 ring-white"
                    aria-label="Remove receipt"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-canvas py-3.5 text-sm font-semibold text-ink-soft transition hover:border-primary hover:text-primary">
                  <Camera className="size-5 shrink-0" /> Attach receipt
                  <input type="file" accept="image/*" className="hidden" onChange={onPickReceipt} />
                </label>
              )}
            </div>
          )}

          {formError && <p className="text-sm font-medium text-urgent">{formError}</p>}
        </div>
      </Modal>

      {/* Delete confirm — replaces two `window.confirm()` calls. */}
      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={pendingDelete?.kind === "income" ? "Delete this income entry?" : "Delete this expense?"}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setPendingDelete(null)}>
              Keep it
            </Button>
            <Button variant="danger" fullWidth onClick={confirmDelete}>
              <Trash2 className="size-4 shrink-0" /> Delete
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          {pendingDelete && (
            <span className="font-semibold text-ink">
              {pendingDelete.kind === "expense"
                ? categoryMeta(pendingDelete.row.category).label
                : sourceMeta(pendingDelete.row.source).label}{" "}
              · {money(pendingDelete.row.amount)}
            </span>
          )}
          <br />
          This can&apos;t be undone, and it will drop out of your {year} tax summary.
        </p>
      </Modal>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      {/* min-h-8 reserves two lines so "Set aside ~27%" wraps instead of
          truncating and all three values still share a baseline. */}
      <p className="min-h-8 text-xs font-medium leading-4 text-ink-muted">{label}</p>
      <p className="mt-0.5 truncate text-[15px] font-semibold text-ink">{value}</p>
    </div>
  );
}

function SegmentBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={classNames(
        "flex-1 truncate rounded-full px-2 py-2.5 text-[13px] font-semibold transition",
        active ? "bg-primary text-white" : "text-ink-soft hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={classNames(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary/50",
      )}
    >
      {children}
    </button>
  );
}

