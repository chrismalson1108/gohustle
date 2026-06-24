"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Receipt, FileSpreadsheet, Wallet } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";

// The full Tax Center (expense logging, cash-income log, Schedule-C CSV export) is
// live in the mobile app. The web version surfaces the overview + guidance; the
// full logger is a fast follow.
export default function TaxesPage() {
  const router = useRouter();
  return (
    <div>
      <PageHeader title="Tax Center" subtitle="Track income & deductible expenses" variant="earn" />
      <PageContainer className="max-w-xl">
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        <div className="rounded-3xl bg-white p-6 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-accent-light text-success">
            <Receipt className="size-7" />
          </div>
          <h2 className="mt-4 text-lg font-black text-ink">Your 1099 toolkit</h2>
          <p className="mt-2 text-sm text-ink-soft">
            As an independent contractor you own your taxes. The Tax Center logs deductible expenses and cash income,
            then exports a Schedule-C-style summary.
          </p>
          <div className="mt-5 grid gap-3 text-left sm:grid-cols-2">
            <Feature icon={<Wallet className="size-5" />} title="Income log" body="Card earnings (via Stripe) + your logged cash income." />
            <Feature icon={<FileSpreadsheet className="size-5" />} title="CSV export" body="Expenses + net-profit summary for tax time." />
          </div>
          <p className="mt-5 rounded-2xl bg-canvas px-4 py-3 text-xs text-ink-muted">
            Full expense logging is available in the GoHustlr mobile app today — the web logger is coming next.
          </p>
        </div>
      </PageContainer>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="flex size-9 items-center justify-center rounded-xl bg-primary-light text-primary">{icon}</div>
      <p className="mt-2 font-bold text-ink">{title}</p>
      <p className="text-xs text-ink-soft">{body}</p>
    </div>
  );
}
