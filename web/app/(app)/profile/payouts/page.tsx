"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Wallet, CreditCard, CheckCircle2 } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import { FullPageSpinner } from "@/components/ui/Spinner";

export default function PayoutsPage() {
  const router = useRouter();
  const { getPaymentReadiness, getPayoutOnboardingUrl, getPayoutLoginLink } = useJobs();
  const [ready, setReady] = useState<{ payoutReady: boolean; paymentMethodReady: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    getPaymentReadiness().then(setReady).catch(() => setReady({ payoutReady: false, paymentMethodReady: false }));
  }, [getPaymentReadiness]);

  const go = async (which: "onboard" | "manage") => {
    setBusy(which);
    try {
      const { url } = which === "onboard" ? await getPayoutOnboardingUrl() : await getPayoutLoginLink();
      if (url) window.location.href = url;
    } catch {
      setBusy(null);
    }
  };

  if (!ready) return <FullPageSpinner />;

  return (
    <div>
      <PageHeader title="Payouts & payments" subtitle="Get paid and manage your card" />
      <PageContainer className="max-w-xl">
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        {/* Earner payouts */}
        <div className="rounded-3xl bg-white p-5 shadow-[var(--shadow-card)] ring-1 ring-line/70">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-accent-light text-success">
              <Wallet className="size-6" />
            </div>
            <div>
              <p className="font-black text-ink">Get paid (earner)</p>
              <p className="text-sm text-ink-soft">Connect a bank to receive card earnings.</p>
            </div>
          </div>
          {ready.payoutReady ? (
            <div className="mt-4">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-success">
                <CheckCircle2 className="size-4" /> Payouts are active
              </p>
              <Button variant="outline" fullWidth loading={busy === "manage"} onClick={() => go("manage")}>
                Manage payout details
              </Button>
            </div>
          ) : (
            <Button fullWidth className="mt-4" loading={busy === "onboard"} onClick={() => go("onboard")}>
              Set up payouts
            </Button>
          )}
        </div>

        {/* Poster card */}
        <div className="mt-4 rounded-3xl bg-white p-5 shadow-[var(--shadow-card)] ring-1 ring-line/70">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary-light text-primary">
              <CreditCard className="size-6" />
            </div>
            <div>
              <p className="font-black text-ink">Pay for gigs (poster)</p>
              <p className="text-sm text-ink-soft">A card on file lets you book and pay securely.</p>
            </div>
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-sm font-bold" style={{ color: ready.paymentMethodReady ? "#059669" : "#9CA3AF" }}>
            {ready.paymentMethodReady ? (
              <>
                <CheckCircle2 className="size-4" /> Card on file
              </>
            ) : (
              "No card on file yet"
            )}
          </p>
          <p className="mt-2 text-xs text-ink-muted">
            Card entry on the web uses Stripe&apos;s secure form at checkout when you book a gig. You can also add or
            change a card in the mobile app.
          </p>
        </div>

        <p className="mt-5 text-center text-xs text-ink-muted">Payments are processed securely by Stripe. GoHustlr never stores your card details.</p>
      </PageContainer>
    </div>
  );
}
