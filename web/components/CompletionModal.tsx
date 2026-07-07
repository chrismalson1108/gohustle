"use client";

import { useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import RatingStars from "./ui/RatingStars";
import SignedPhotoStrip from "./SignedPhotoStrip";
import Avatar from "./ui/Avatar";
import { Textarea } from "./ui/Field";
import { classNames, money, payLabel } from "@/lib/format";
import type { Booking } from "@/lib/types";

export interface VerifyArgs {
  rating: number;
  reviewText: string;
  paymentMethod: string;
  tipCents: number;
  pct: number;
  disputeReason: string | null;
}

const TIPS = [0, 300, 500, 1000];
// Reduced-payout tiers, floored at 50% — the server rejects/relevels anything lower,
// and reaching verify means the poster attested the work was done, so the worker
// earns at least half. A true no-show should be cancelled (full refund), not verified.
const PCTS = [0.9, 0.75, 0.5];
const RATING_TEXT: Record<number, string> = { 5: "Excellent", 4: "Great", 3: "Good", 2: "Fair", 1: "Poor" };

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        "rounded-full border px-3 py-2 text-[13px] font-bold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary",
      )}
    >
      {children}
    </button>
  );
}

export default function CompletionModal({
  open,
  booking,
  heldCents = 0,
  onClose,
  onConfirm,
}: {
  open: boolean;
  booking: Booking | null;
  heldCents?: number;
  onClose: () => void;
  onConfirm: (args: VerifyArgs) => Promise<void>;
}) {
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [tipCents, setTipCents] = useState(0);
  const [disputed, setDisputed] = useState(false);
  const [pct, setPct] = useState(0.75);
  const [disputeReason, setDisputeReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setRating(5);
      setReviewText("");
      setTipCents(0);
      setDisputed(false);
      setPct(0.75);
      setDisputeReason("");
    }
  }, [open]);

  // A reduced payout must state a reason (recorded as the dispute audit trail).
  const reasonMissing = disputed && !disputeReason.trim();

  if (!booking) return null;
  const earnerName = booking.earner?.name || "the earner";
  const jobTitle = booking.job?.title || "this job";

  const confirm = async () => {
    if (reasonMissing) return; // guarded by the disabled button, belt-and-suspenders
    setBusy(true);
    try {
      await onConfirm({
        rating,
        reviewText,
        paymentMethod: "card", // funds were authorized to the card at accept (escrow); no method to choose
        tipCents: tipCents || 0,
        pct: disputed ? pct : 1,
        disputeReason: disputed ? disputeReason || null : null,
      });
      onClose();           // only close on success
    } catch (e) {
      console.warn("Completion confirm failed:", (e as Error)?.message);
    } finally {
      setBusy(false);      // never strand the spinner
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Verify job completion"
      footer={
        <Button fullWidth size="lg" loading={busy} disabled={reasonMissing} onClick={confirm}>
          <Check className="size-5" /> Confirm job complete
        </Button>
      }
    >
      <p className="mb-4 text-sm text-ink-soft">
        Confirm that <span className="font-bold text-primary">{earnerName}</span> completed &ldquo;{jobTitle}&rdquo;.
      </p>

      <div className="mb-5 flex items-center gap-3 rounded-2xl bg-canvas p-3.5">
        <Avatar url={booking.earner?.avatarUrl} initial={booking.earner?.avatarInitial} name={earnerName} size={48} />
        <div>
          <p className="font-extrabold text-ink">{earnerName}</p>
          {booking.job && <p className="text-xs text-ink-muted">{payLabel(booking.job)} · {jobTitle}</p>}
        </div>
      </div>

      {heldCents > 0 && (
        <div className="mb-5 rounded-2xl bg-success/10 p-3.5 ring-1 ring-success/25">
          <p className="flex items-center gap-1.5 text-sm font-extrabold text-success">
            <ShieldCheck className="size-4" /> {money(heldCents, { cents: true })} held on your card
          </p>
          {!disputed && (
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              Confirming releases <b className="text-ink">{money(Math.round(heldCents * 0.9), { cents: true })}</b> to {earnerName} (we keep a 10% platform fee). No new charge — this is the amount you already authorized when you accepted.
            </p>
          )}
        </div>
      )}

      {booking.beforePhotos?.length > 0 && (
        <div className="mb-5">
          <SignedPhotoStrip label="Before" values={booking.beforePhotos} bucket="completion-photos" thumbClass="size-20" />
        </div>
      )}

      {booking.completionPhotos?.length > 0 && (
        <div className="mb-5">
          <SignedPhotoStrip label="After" values={booking.completionPhotos} bucket="completion-photos" thumbClass="size-20" />
        </div>
      )}

      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Rate {earnerName}</p>
      <div className="mb-1 flex items-center gap-3">
        <RatingStars value={rating} size={32} onChange={setRating} />
        <span className="text-sm italic text-ink-muted">{RATING_TEXT[rating]}</span>
      </div>

      <p className="mb-2 mt-5 text-xs font-bold uppercase tracking-wide text-ink-muted">Leave a review</p>
      <Textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)} placeholder={`How did ${earnerName} do?`} className="min-h-[80px]" />

      <p className="mb-2 mt-5 text-xs font-bold uppercase tracking-wide text-ink-muted">Add a tip (optional)</p>
      <div className="flex flex-wrap gap-2">
        {TIPS.map((c) => (
          <Chip key={c} active={tipCents === c} onClick={() => setTipCents(c)}>
            {c === 0 ? "No tip" : `$${(c / 100).toFixed(0)}`}
          </Chip>
        ))}
      </div>
      {tipCents > 0 && <p className="mt-1.5 text-xs text-ink-muted">Charged to your saved card and sent to {earnerName}.</p>}

      <button
        type="button"
        aria-pressed={disputed}
        onClick={() => setDisputed((d) => !d)}
        className="mt-5 flex w-full items-center gap-2 text-left text-sm font-semibold text-ink-soft"
      >
        <span className={classNames("flex size-5 items-center justify-center rounded border-2", disputed ? "border-urgent bg-urgent text-white" : "border-line")}>
          {disputed && <Check className="size-3.5" />}
        </span>
        There was a problem — pay a reduced amount
      </button>
      {disputed && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            {PCTS.map((p) => (
              <Chip key={p} active={pct === p} onClick={() => setPct(p)}>
                Pay {Math.round(p * 100)}%
              </Chip>
            ))}
          </div>
          <Textarea
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="What went wrong? (shared with support)"
            className="mt-3 min-h-[64px]"
          />
          <p className="mt-1.5 text-xs text-ink-muted">The rest of the hold is released back to you.</p>
        </div>
      )}
    </Modal>
  );
}
