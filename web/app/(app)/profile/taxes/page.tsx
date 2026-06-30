"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
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
import { useJobs } from "@/lib/jobs";
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
import PageHeader, { PageContainer } from "@/components/PageHeader";
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
  const router = useRouter();
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
  const summary = useMemo(
    () => yearSummary({ year, stripeIncome: earningsTotal, expenses, income }),
    [year, earningsTotal, expenses, income],
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

  const handleDeleteExpense = async (exp: Expense) => {
    if (!window.confirm(`Delete this expense?\n${categoryMeta(exp.category).label} · ${money(exp.amount)}`)) return;
    setExpenses((p) => p.filter((e) => e.id !== exp.id));
    try {
      await deleteExpense(exp.id);
    } catch {
      load();
    }
  };

  const handleDeleteIncome = async (inc: IncomeEntry) => {
    if (!window.confirm(`Delete this income entry?\n${sourceMeta(inc.source).label} · ${money(inc.amount)}`)) return;
    setIncome((p) => p.filter((e) => e.id !== inc.id));
    try {
      await deleteIncome(inc.id);
    } catch {
      load();
    }
  };

  const handleExport = () => {
    const { yearExpenses, yearIncome } = summary;
    if (!yearExpenses.length && !yearIncome.length && !earningsTotal) {
      showToast({ icon: "📄", title: "Nothing to export", message: `No income or expenses recorded for ${year} yet.` });
      return;
    }
    const csv = buildTaxSummaryCSV({
      year,
      stripeIncome: earningsTotal,
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
      <PageHeader title="Tax Center" subtitle="Track income & deductible expenses" variant="earn">
        <div className="mt-5 rounded-2xl bg-white/15 p-5">
          <p className="text-xs font-bold text-white/75">{year} net profit</p>
          <p className="text-3xl font-black text-white">{money(summary.net)}</p>
          <div className="mt-4 flex items-stretch gap-3 text-white">
            <SummaryStat label="Income" value={money(summary.grossIncome)} />
            <div className="w-px bg-white/25" />
            <SummaryStat label="Expenses" value={money(summary.expTotal)} />
            <div className="w-px bg-white/25" />
            <SummaryStat label="Set aside ~27%" value={money(summary.setAside)} />
          </div>
        </div>
      </PageHeader>

      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        {/* Segmented control */}
        <div className="flex rounded-2xl border border-line bg-white p-1">
          <SegmentBtn label="Expenses" active={tab === "expenses"} onClick={() => setTab("expenses")} />
          <SegmentBtn label="Income" active={tab === "income"} onClick={() => setTab("income")} />
        </div>

        {/* Actions */}
        <div className="mt-4 flex gap-3">
          <Button onClick={openAdd} fullWidth>
            <Plus className="size-4" /> {tab === "expenses" ? "Add Expense" : "Add Income"}
          </Button>
          <Button variant="outline" onClick={handleExport}>
            <Download className="size-4" /> Export
          </Button>
        </div>

        <p className="mt-3 text-xs leading-5 text-ink-muted">
          {tab === "income"
            ? "Card payments are already counted from your platform earnings. Log cash and tips here so your income is complete."
            : "Log work-related purchases to deduct them. Export the year-end summary for your accountant or tax software. (Not tax advice.)"}
        </p>

        {/* By-job expense breakdown */}
        {tab === "expenses" && jobGroups.length > 0 && (
          <div className="mt-4 rounded-2xl border border-line bg-white p-4 shadow-[var(--shadow-card)]">
            <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-muted">By job · {year}</p>
            <ul className="space-y-1.5">
              {jobGroups.map((g) => (
                <li key={g.bookingId} className="flex items-center gap-2">
                  <Briefcase className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{g.title}</span>
                  <span className="font-black text-ink">{money(g.total)}</span>
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
              icon={<Receipt className="size-12" />}
              title="No expenses yet"
              body='Tap "Add Expense" to start tracking write-offs.'
            />
          ) : (
            <ul className="mt-5 space-y-2">
              {expenses.map((exp) => {
                const meta = categoryMeta(exp.category);
                const Icon = CATEGORY_ICONS[exp.category] || MoreHorizontal;
                const thumb =
                  receiptUrls[exp.id] || (exp.receipt_url?.startsWith("http") ? exp.receipt_url : null);
                return (
                  <li
                    key={exp.id}
                    className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3 shadow-[var(--shadow-card)]"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-ink">{meta.label}</p>
                      {exp.description && <p className="truncate text-xs text-ink-soft">{exp.description}</p>}
                      <div className="flex items-center gap-2">
                        <p className="text-[11px] text-ink-muted">{exp.date}</p>
                        {exp.booking_id && (
                          <span className="inline-flex max-w-[160px] items-center gap-1 truncate rounded-md bg-primary-light px-1.5 py-0.5 text-[10px] font-bold text-primary">
                            <Briefcase className="size-2.5 shrink-0" />
                            <span className="truncate">{jobTitleFor[exp.booking_id] || "Gig"}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    {thumb && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="receipt" className="size-9 rounded-lg object-cover" />
                    )}
                    <p className="font-black text-ink">{money(exp.amount)}</p>
                    <button
                      onClick={() => handleDeleteExpense(exp)}
                      className="rounded-lg p-1.5 text-urgent hover:bg-urgent/10"
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
            icon={<Wallet className="size-12" />}
            title="No cash income logged"
            body='Tap "Add Income" to log cash payments and tips.'
          />
        ) : (
          <ul className="mt-5 space-y-2">
            {income.map((inc) => {
              const meta = sourceMeta(inc.source);
              const Icon = SOURCE_ICONS[inc.source] || MoreHorizontal;
              return (
                <li
                  key={inc.id}
                  className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3 shadow-[var(--shadow-card)]"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-light text-accent-deep">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-ink">{meta.label}</p>
                    {inc.description && <p className="truncate text-xs text-ink-soft">{inc.description}</p>}
                    <p className="text-[11px] text-ink-muted">{inc.date}</p>
                  </div>
                  <p className="font-black text-accent-deep">{money(inc.amount)}</p>
                  <button
                    onClick={() => handleDeleteIncome(inc)}
                    className="rounded-lg p-1.5 text-urgent hover:bg-urgent/10"
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
            <div className="flex items-center gap-2 rounded-2xl border border-line bg-white px-4 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
              <span className="text-xl font-black text-primary">$</span>
              <input
                className="w-full bg-transparent py-3 text-xl font-bold text-ink outline-none placeholder:text-ink-muted"
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
                  <img src={receiptPreview} alt="receipt preview" className="size-24 rounded-xl object-cover" />
                  <button
                    onClick={clearReceipt}
                    className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-urgent text-white ring-2 ring-white"
                    aria-label="Remove receipt"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-primary bg-primary-light py-3.5 text-sm font-bold text-primary">
                  <Camera className="size-5" /> Attach receipt
                  <input type="file" accept="image/*" className="hidden" onChange={onPickReceipt} />
                </label>
              )}
            </div>
          )}

          {formError && <p className="text-sm font-medium text-urgent">{formError}</p>}
        </div>
      </Modal>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1">
      <p className="text-[10px] font-semibold text-white/70">{label}</p>
      <p className="mt-0.5 text-sm font-black text-white">{value}</p>
    </div>
  );
}

function SegmentBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={classNames(
        "flex-1 rounded-xl py-2 text-sm font-bold transition",
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
      className={classNames(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary/50",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <div className="text-ink-muted">{icon}</div>
      <p className="font-bold text-ink">{title}</p>
      <p className="max-w-xs text-sm text-ink-soft">{body}</p>
    </div>
  );
}
