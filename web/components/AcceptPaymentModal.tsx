"use client";

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { ShieldCheck } from "lucide-react";
import { getStripe } from "@/lib/stripe";
import { stripeEdge } from "@/lib/edge";
import { money } from "@/lib/format";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import type { Booking } from "@/lib/types";

// Poster "Accept & pay": creates the manual-capture (escrow) PaymentIntent, collects
// the card via Stripe Elements, places the hold, then calls onConfirmed() — which the
// caller uses to flip the booking to confirmed. Funds are captured later at verify.
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!booking) {
      setClientSecret(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setClientSecret(null);
    stripeEdge
      .createPaymentIntent(booking.id)
      .then((res) => {
        const r = res as { clientSecret: string; amountCents?: number; amount?: number };
        setClientSecret(r.clientSecret);
        setAmountCents(r.amountCents ?? r.amount ?? 0);
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

  return (
    <Modal open={!!booking} onClose={onClose} title="Accept & hold payment">
      {error ? (
        <p className="text-sm font-medium text-urgent">{error}</p>
      ) : loading || !clientSecret ? (
        <p className="py-4 text-sm text-ink-muted">Setting up secure payment…</p>
      ) : (
        <Elements stripe={getStripe()} options={{ clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#6D28D9" } } }}>
          <PayForm amountCents={amountCents} jobTitle={booking?.job?.title ?? "this gig"} onConfirmed={onConfirmed} />
        </Elements>
      )}
    </Modal>
  );
}

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
      <div className="flex items-start gap-2 rounded-xl bg-primary-light/50 p-3 text-sm text-ink-soft">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          <b className="text-ink">{money(amountCents / 100)}</b> is held securely for “{jobTitle}” and only released to the
          earner when you verify the finished work. Cancel before then and it&apos;s refunded.
        </span>
      </div>
      <PaymentElement />
      {err && <p className="text-sm font-semibold text-urgent">{err}</p>}
      <Button fullWidth size="lg" loading={busy} onClick={pay} disabled={!stripe}>
        Hold {money(amountCents / 100)} &amp; accept
      </Button>
    </div>
  );
}
