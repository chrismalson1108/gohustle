"use client";

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { ShieldCheck, CreditCard } from "lucide-react";
import { getStripe } from "@/lib/stripe";
import { stripeEdge } from "@/lib/edge";
import { money } from "@/lib/format";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import type { Booking } from "@/lib/types";

type SavedCard = { id: string; brand: string | null; last4: string | null };

// Poster "Accept & pay": creates the manual-capture (escrow) PaymentIntent. If the
// poster has a card on file, offers a ONE-TAP "hold & accept" with that card; otherwise
// (or on "use a different card") it collects one via Stripe Elements. Places the hold,
// then calls onConfirmed() — which the caller uses to flip the booking to confirmed.
// Funds are captured later at verify.
export default function AcceptPaymentModal({
  booking,
  onClose,
  onConfirmed,
}: {
  booking: Booking | null;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState(0);
  const [savedCard, setSavedCard] = useState<SavedCard | null>(null);
  const [useNewCard, setUseNewCard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!booking) {
      setClientSecret(null);
      setError(null);
      setSavedCard(null);
      setUseNewCard(false);
      return;
    }
    setLoading(true);
    setError(null);
    setClientSecret(null);
    setSavedCard(null);
    setUseNewCard(false);
    stripeEdge
      .createPaymentIntent(booking.id)
      .then((res) => {
        setClientSecret(res.clientSecret);
        setAmountCents(res.amountCents ?? res.amount ?? 0);
        setSavedCard(res.savedCard ?? null);
      })
      .catch((e: Error & { code?: string }) => {
        setError(
          e.code === "EARNER_NO_PAYOUT"
            ? "This earner hasn't set up their payout account yet, so funds can't be held. Ask them to add a payout method, then accept."
            : e.message || "Couldn't start the payment. Please try again.",
        );
      })
      .finally(() => setLoading(false));
  }, [booking?.id]);

  const jobTitle = booking?.job?.title ?? "this gig";
  const showSaved = !!savedCard && !useNewCard;

  return (
    <Modal open={!!booking} onClose={onClose} title="Accept & hold payment">
      {error ? (
        <p className="text-sm font-medium text-urgent">{error}</p>
      ) : loading || !clientSecret ? (
        <p className="py-4 text-sm text-ink-muted">Setting up secure payment…</p>
      ) : showSaved ? (
        <SavedCardForm
          clientSecret={clientSecret}
          amountCents={amountCents}
          jobTitle={jobTitle}
          card={savedCard!}
          onConfirmed={onConfirmed}
          onUseNewCard={() => setUseNewCard(true)}
        />
      ) : (
        <Elements stripe={getStripe()} options={{ clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#3F25FE" } } }}>
          <PayForm amountCents={amountCents} jobTitle={jobTitle} onConfirmed={onConfirmed} />
        </Elements>
      )}
    </Modal>
  );
}

function EscrowNote({ amountCents, jobTitle }: { amountCents: number; jobTitle: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-primary-light/50 p-3 text-sm text-ink-soft">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
      <span>
        <b className="text-ink">{money(amountCents / 100)}</b> is held securely for “{jobTitle}” and only released to the
        earner when you verify the finished work. Cancel before then and it&apos;s refunded.
      </span>
    </div>
  );
}

// One-tap accept using the poster's card on file (no re-entry).
function SavedCardForm({
  clientSecret,
  amountCents,
  jobTitle,
  card,
  onConfirmed,
  onUseNewCard,
}: {
  clientSecret: string;
  amountCents: number;
  jobTitle: string;
  card: SavedCard;
  onConfirmed: () => void;
  onUseNewCard: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setErr(null);
    const stripe = await getStripe();
    if (!stripe) {
      setErr("Payment is unavailable right now. Please try again.");
      setBusy(false);
      return;
    }
    // Confirm the manual-capture PI with the saved card → authorizes to requires_capture
    // (held, not yet charged). Handles 3-D Secure interactively if the card requires it.
    const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: card.id,
    });
    if (error) {
      setErr(error.message || "Payment couldn't be authorized.");
      setBusy(false);
      return;
    }
    if (paymentIntent && (paymentIntent.status === "requires_capture" || paymentIntent.status === "succeeded")) {
      onConfirmed();
    } else {
      setErr("The payment didn't go through. Please try again.");
      setBusy(false);
    }
  };

  const brand = card.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : "Card";

  return (
    <div className="space-y-3">
      <EscrowNote amountCents={amountCents} jobTitle={jobTitle} />
      <div className="flex items-center gap-2.5 rounded-xl bg-canvas px-3.5 py-3 ring-1 ring-line/70">
        <CreditCard className="size-5 shrink-0 text-primary" />
        <span className="text-sm font-bold text-ink">
          {brand} •••• {card.last4 ?? "----"}
        </span>
        <span className="ml-auto text-xs font-semibold text-ink-muted">Card on file</span>
      </div>
      {err && <p className="text-sm font-semibold text-urgent">{err}</p>}
      <Button fullWidth size="lg" loading={busy} onClick={pay}>
        Hold {money(amountCents / 100)} &amp; accept
      </Button>
      <button type="button" onClick={onUseNewCard} disabled={busy} className="w-full text-center text-sm font-semibold text-primary disabled:opacity-50">
        Use a different card
      </button>
    </div>
  );
}

// Card-entry fallback (no card on file, or "use a different card").
function PayForm({
  amountCents,
  jobTitle,
  onConfirmed,
}: {
  amountCents: number;
  jobTitle: string;
  onConfirmed: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pay = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setErr(null);
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (error) {
      setErr(error.message || "Payment couldn't be authorized.");
      setBusy(false);
      return;
    }
    // Manual-capture PI authorizes to "requires_capture" (held, not yet charged).
    if (paymentIntent && (paymentIntent.status === "requires_capture" || paymentIntent.status === "succeeded")) {
      onConfirmed();
    } else {
      setErr("The payment didn't go through. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <EscrowNote amountCents={amountCents} jobTitle={jobTitle} />
      <PaymentElement />
      {err && <p className="text-sm font-semibold text-urgent">{err}</p>}
      <Button fullWidth size="lg" loading={busy} onClick={pay} disabled={!stripe}>
        Hold {money(amountCents / 100)} &amp; accept
      </Button>
    </div>
  );
}
