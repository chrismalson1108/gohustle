"use client";

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { ShieldCheck } from "lucide-react";
import { getStripe } from "@/lib/stripe";
import { useJobs } from "@/lib/jobs";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";

// Poster "Add / replace card on file": creates a SetupIntent (no charge), collects the
// card via Stripe Elements, then confirms it with stripe.confirmSetup so the card is saved
// off-session for future escrow holds. Mirrors the checkout flow in AcceptPaymentModal,
// but uses confirmSetup (SetupIntent) instead of confirmPayment (PaymentIntent).
export default function AddCardModal({
  open,
  replacing,
  onClose,
  onSaved,
}: {
  open: boolean;
  replacing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { createSetupIntent } = useJobs();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setClientSecret(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setClientSecret(null);
    createSetupIntent()
      .then((res) => {
        // Edge fn returns the secret as `setupIntentClientSecret` (see mobile contract).
        if (!res?.setupIntentClientSecret) throw new Error("Couldn't start card setup.");
        setClientSecret(res.setupIntentClientSecret);
      })
      .catch(() => setError("Card setup is temporarily unavailable — please try again later."))
      .finally(() => setLoading(false));
  }, [open, createSetupIntent]);

  return (
    <Modal open={open} onClose={onClose} title={replacing ? "Replace card on file" : "Add a card"}>
      {error ? (
        <p className="text-sm font-medium text-urgent">{error}</p>
      ) : loading || !clientSecret ? (
        <p className="py-4 text-sm text-ink-muted">Setting up secure card entry…</p>
      ) : (
        <Elements
          stripe={getStripe()}
          options={{ clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#3F25FE" } } }}
        >
          <SaveCardForm replacing={replacing} onSaved={onSaved} />
        </Elements>
      )}
    </Modal>
  );
}

function SaveCardForm({ replacing, onSaved }: { replacing: boolean; onSaved: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const { detachPaymentMethod } = useJobs();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setErr(null);
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (error) {
      setErr(error.message || "We couldn't save that card. Please try again.");
      setBusy(false);
      return;
    }
    if (setupIntent && setupIntent.status === "succeeded") {
      // On "Replace", the SetupIntent attached the NEW card — detach the previous
      // card(s) so they don't linger on file. Keep the one we just added. Best-effort.
      if (replacing && typeof setupIntent.payment_method === "string") {
        try { await detachPaymentMethod(setupIntent.payment_method); } catch { /* non-fatal */ }
      }
      onSaved();
    } else {
      setErr("The card couldn't be saved. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl bg-primary-light/50 p-3 text-sm text-ink-soft">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          Your card is saved securely with Stripe so you can book and pay for gigs in one tap. It&apos;s only charged
          when you accept a booking, and held in escrow until you verify the work.
        </span>
      </div>
      <PaymentElement />
      {err && <p className="text-sm font-semibold text-urgent">{err}</p>}
      <Button fullWidth size="lg" loading={busy} onClick={save} disabled={!stripe}>
        {replacing ? "Save new card" : "Save card"}
      </Button>
    </div>
  );
}
