"use client";

import { useEffect, useState } from "react";
import { Car, Receipt, Paperclip, X } from "lucide-react";
import { IRS_MILEAGE_RATE } from "@gohustlr/shared";
import { addExpense, uploadReceipt, EXPENSE_CATEGORIES } from "@/lib/expenses";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import { money, classNames } from "@/lib/format";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import type { Booking } from "@/lib/types";

const todayISO = () => new Date().toISOString().slice(0, 10);

// Lets an earner log mileage (there & back) and out-of-pocket expenses for a specific
// gig while or after they work it. Everything is tied to the booking and shows up in
// the Tax Center, grouped per job. Mileage uses the IRS standard rate.
export default function TrackExpensesModal({
  booking,
  onClose,
  onSaved,
}: {
  booking: Booking | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { user } = useAuth();
  const { showToast } = useUser();
  const [mode, setMode] = useState<"mileage" | "expense">("mileage");

  // Mileage
  const [miles, setMiles] = useState("");
  const [roundTrip, setRoundTrip] = useState(true);
  // Expense
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("supplies");
  const [desc, setDesc] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (booking) {
      setMode("mileage");
      setMiles("");
      setRoundTrip(true);
      setAmount("");
      setCategory("supplies");
      setDesc("");
      setReceiptFile(null);
    }
  }, [booking]);

  if (!booking) return null;
  const jobTitle = booking.job?.title || "this gig";

  const oneWay = parseFloat(miles);
  const totalMiles = Number.isFinite(oneWay) && oneWay > 0 ? (roundTrip ? oneWay * 2 : oneWay) : 0;
  const mileageAmount = Math.round(totalMiles * IRS_MILEAGE_RATE * 100) / 100;
  const expenseAmount = parseFloat(amount);

  const saveMileage = async () => {
    if (!user || totalMiles <= 0) return;
    setBusy(true);
    try {
      await addExpense(user.id, {
        amount: mileageAmount,
        category: "transport",
        description: `Drive — ${jobTitle}${roundTrip ? " (round trip)" : ""}`,
        date: todayISO(),
        bookingId: booking.id,
        miles: totalMiles,
      });
      showToast({ icon: "🚗", title: `Logged ${totalMiles.toFixed(1)} mi`, message: `${money(mileageAmount)} deduction saved to your Tax Center.` });
      onSaved?.();
      onClose();
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't save", message: (e as Error).message || "Please try again." });
    }
    setBusy(false);
  };

  const saveExpense = async () => {
    if (!user || !Number.isFinite(expenseAmount) || expenseAmount <= 0) return;
    setBusy(true);
    try {
      let receiptUrl: string | null = null;
      if (receiptFile) receiptUrl = await uploadReceipt(receiptFile, user.id);
      await addExpense(user.id, {
        amount: expenseAmount,
        category,
        description: desc.trim() || undefined,
        date: todayISO(),
        bookingId: booking.id,
        receiptUrl,
      });
      showToast({ icon: "🧾", title: "Expense logged", message: `${money(expenseAmount)} saved to your Tax Center.` });
      onSaved?.();
      onClose();
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't save", message: (e as Error).message || "Please try again." });
    }
    setBusy(false);
  };

  const Tab = ({ id, icon, label }: { id: "mileage" | "expense"; icon: React.ReactNode; label: string }) => (
    <button
      type="button"
      onClick={() => setMode(id)}
      className={classNames(
        "flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-bold transition",
        mode === id ? "bg-white text-primary shadow-sm" : "text-ink-soft",
      )}
    >
      {icon} {label}
    </button>
  );

  return (
    <Modal open={!!booking} onClose={onClose} title={`Track for “${jobTitle}”`}>
      <div className="mb-4 flex gap-1 rounded-2xl bg-line/60 p-1">
        <Tab id="mileage" icon={<Car className="size-4" />} label="Mileage" />
        <Tab id="expense" icon={<Receipt className="size-4" />} label="Expense" />
      </div>

      {mode === "mileage" ? (
        <div>
          <Field label="Distance (one way, miles)">
            <Input type="number" inputMode="decimal" min="0" step="0.1" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="e.g. 8.5" />
          </Field>
          <label className="mb-4 flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-ink-soft">
            <input type="checkbox" checked={roundTrip} onChange={(e) => setRoundTrip(e.target.checked)} className="size-4 accent-primary" />
            Round trip — count the drive there and back
          </label>
          {totalMiles > 0 && (
            <div className="mb-4 rounded-2xl bg-success/10 p-3.5 text-sm ring-1 ring-success/20">
              <span className="text-ink-soft">{totalMiles.toFixed(1)} mi × ${IRS_MILEAGE_RATE.toFixed(2)}/mi = </span>
              <b className="text-success">{money(mileageAmount)} deduction</b>
            </div>
          )}
          <Button fullWidth size="lg" loading={busy} disabled={totalMiles <= 0} onClick={saveMileage}>
            Log mileage
          </Button>
        </div>
      ) : (
        <div>
          <Field label="Amount ($)">
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)">
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. parking, supplies, gas" maxLength={120} />
          </Field>
          <Field label="Receipt photo (optional)">
            {receiptFile ? (
              <div className="flex items-center gap-2 rounded-2xl border border-line bg-white px-3 py-2.5 text-sm">
                <Paperclip className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-ink">{receiptFile.name}</span>
                <button type="button" onClick={() => setReceiptFile(null)} aria-label="Remove receipt" className="shrink-0 text-ink-muted hover:text-urgent">
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 rounded-2xl border border-dashed border-line bg-white px-3 py-2.5 text-sm font-semibold text-ink-soft transition hover:border-primary hover:text-primary">
                <Paperclip className="size-4 text-primary" /> Attach a photo of the receipt
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (f && f.size > 10 * 1024 * 1024) {
                      showToast({ icon: "⚠️", title: "Receipt too large", message: "Please use a photo under 10 MB." });
                      e.target.value = "";
                      return;
                    }
                    setReceiptFile(f);
                  }}
                />
              </label>
            )}
          </Field>
          <Button fullWidth size="lg" loading={busy} disabled={!(expenseAmount > 0)} onClick={saveExpense}>
            Log expense
          </Button>
        </div>
      )}

      <p className="mt-3 text-center text-xs text-ink-muted">Tied to this gig and tracked in your Tax Center. Not tax advice.</p>
    </Modal>
  );
}
