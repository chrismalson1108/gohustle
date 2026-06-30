"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Wallet, CreditCard, CheckCircle2, Trash2 } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import AddCardModal from "@/components/AddCardModal";
import { FullPageSpinner } from "@/components/ui/Spinner";

type Readiness = {
  payoutReady: boolean;
  paymentMethodReady: boolean;
  cardBrand?: string | null;
  cardLast4?: string | null;
};

export default function PayoutsPage() {
  const router = useRouter();
  const { getPaymentReadiness, getPayoutOnboardingUrl, getPayoutLoginLink, detachPaymentMethod } = useJobs();
  const { showToast } = useUser();
  const [ready, setReady] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAddCard, setShowAddCard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refreshReadiness = useCallback(async () => {
    const r = await getPaymentReadiness();
    setReady(r);
    return r;
  }, [getPaymentReadiness]);

  useEffect(() => {
    refreshReadiness().catch(() => setReady({ payoutReady: false, paymentMethodReady: false }));
  }, [refreshReadiness]);

  const onCardSaved = async () => {
    setShowAddCard(false);
    try {
      await refreshReadiness();
    } catch {
      /* status will refresh on next load */
    }
    showToast({ icon: "✅", title: "Card saved", message: "Your card is on file and ready for booking gigs." });
  };

  const removeCard = async () => {
    setBusy("removeCard");
    try {
      await detachPaymentMethod();
      await refreshReadiness();
      setConfirmRemove(false);
      showToast({ icon: "🗑️", title: "Card removed", message: "Your saved card was removed." });
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't remove card", message: (e as Error).message || "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const cardLabel =
    ready?.cardLast4
      ? `•••• ${ready.cardLast4}${ready.cardBrand ? ` (${ready.cardBrand[0].toUpperCase()}${ready.cardBrand.slice(1)})` : ""}`
      : "Card on file";

  const go = async (which: "onboard" | "manage") => {
    setBusy(which);
    try {
      const res = (which === "onboard" ? await getPayoutOnboardingUrl() : await getPayoutLoginLink()) as {
        url?: string;
        alreadyOnboarded?: boolean;
      };
      if (res?.url) {
        window.location.href = res.url;
        return;
      }
      if (res?.alreadyOnboarded) {
        const r = await getPaymentReadiness();
        setReady(r);
        showToast({ icon: "✅", title: "Payouts already active", message: "Your payout account is set up." });
      } else {
        showToast({ icon: "⚠️", title: "Couldn't open payout setup", message: "No setup link was returned — please try again." });
      }
      setBusy(null);
    } catch (e) {
      // Surface the real reason (e.g. Stripe Connect not enabled) instead of a silent no-op.
      setBusy(null);
      showToast({ icon: "⚠️", title: "Payout setup unavailable", message: (e as Error).message || "Please try again in a moment." });
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
            <div className="flex size-11 items-center justify-center rounded-2xl bg-accent-light text-accent-deep">
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
          <p className="mt-4 flex items-center gap-1.5 text-sm font-bold" style={{ color: ready.paymentMethodReady ? "#15803D" : "#9A93AD" }}>
            {ready.paymentMethodReady ? (
              <>
                <CheckCircle2 className="size-4" /> {cardLabel}
              </>
            ) : (
              "No card on file yet"
            )}
          </p>

          {ready.paymentMethodReady ? (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" fullWidth onClick={() => setShowAddCard(true)}>
                Replace card
              </Button>
              <Button
                variant="danger"
                fullWidth
                loading={busy === "removeCard"}
                onClick={() => setConfirmRemove(true)}
              >
                Remove card
              </Button>
            </div>
          ) : (
            <Button fullWidth className="mt-4" onClick={() => setShowAddCard(true)}>
              Add a card
            </Button>
          )}

          <p className="mt-3 text-xs text-ink-muted">
            Your card is saved securely with Stripe and only charged when you accept a booking — held in escrow until
            you verify the work.
          </p>
        </div>

        <p className="mt-5 text-center text-xs text-ink-muted">Payments are processed securely by Stripe. GoHustlr never stores your card details.</p>
      </PageContainer>

      <AddCardModal
        open={showAddCard}
        replacing={ready.paymentMethodReady}
        onClose={() => setShowAddCard(false)}
        onSaved={onCardSaved}
      />

      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title="Remove card?" size="sm">
        <p className="text-sm text-ink-soft">
          We&apos;ll remove your saved card. You&apos;ll need to add one again before you can accept and pay for a
          booking.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" fullWidth onClick={() => setConfirmRemove(false)} disabled={busy === "removeCard"}>
            Keep card
          </Button>
          <Button variant="danger" fullWidth loading={busy === "removeCard"} onClick={removeCard}>
            <Trash2 className="size-4" /> Remove card
          </Button>
        </div>
      </Modal>
    </div>
  );
}
