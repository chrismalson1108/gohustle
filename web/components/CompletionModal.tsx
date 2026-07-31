"use client";

import { useEffect, useState } from "react";
import { Check, ShieldCheck, Square, SquareCheckBig } from "lucide-react";
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
        "max-w-full truncate rounded-full border px-3 py-2 text-[13px] font-semibold transition",
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
        {/* min-w-0 + truncate: both values are user-generated (profile name, job
            title), and a flex item defaults to min-width:auto, so one long
            unbroken token pushed this column past the sheet's content box and the
            shell's overflow-hidden clipped it instead of ellipsizing. */}
        <div className="min-w-0">
          <p className="truncate font-bold text-ink">{earnerName}</p>
          {booking.job && <p className="truncate text-xs text-ink-muted">{payLabel(booking.job)} · {jobTitle}</p>}
        </div>
      </div>

      {heldCents > 0 && (
        <div className="mb-5 rounded-2xl bg-success/10 p-3.5 ring-1 ring-success/25">
          <p className="flex items-center gap-1.5 text-sm font-bold text-success">
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

      <p className="mb-2 text-[13px] font-semibold text-ink-muted">Rate {earnerName}</p>
      <div className="mb-1 flex items-center gap-3">
        <RatingStars value={rating} size={32} onChange={setRating} />
        <span className="text-sm italic text-ink-muted">{RATING_TEXT[rating]}</span>
      </div>

      <p className="mb-2 mt-5 text-[13px] font-semibold text-ink-muted">Leave a review</p>
      <Textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)} placeholder={`How did ${earnerName} do?`} className="min-h-[80px]" />

      <p className="mb-2 mt-5 text-[13px] font-semibold text-ink-muted">Add a tip (optional)</p>
      <div className="flex flex-wrap gap-2">
        {TIPS.map((c) => (
          <Chip key={c} active={tipCents === c} onClick={() => setTipCents(c)}>
            {c === 0 ? "No tip" : `$${(c / 100).toFixed(0)}`}
          </Chip>
        ))}
      </div>
      {tipCents > 0 && <p className="mt-1.5 text-xs text-ink-muted">Charged to your saved card and sent to {earnerName}.</p>}

      {/* A real checkbox, not a <button> wearing one: the hand-rolled version had
          no native checkbox semantics and carried a 4px radius + 2px border that
          exist nowhere else in the system. The glyph swap mirrors mobile's
          square-outline → checkbox Ionicon. py-2 keeps a 44px touch target. */}
      <label className="mt-5 flex w-full cursor-pointer items-center gap-2 py-2 text-left text-sm font-medium text-ink-soft">
        <input
          type="checkbox"
          checked={disputed}
          onChange={(e) => setDisputed(e.target.checked)}
          className="peer sr-only"
        />
        <span
          className={classNames(
            "flex shrink-0 rounded-lg peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40",
            disputed ? "text-urgent" : "text-ink-muted",
          )}
        >
          {disputed ? <SquareCheckBig className="size-[18px]" /> : <Square className="size-[18px]" />}
        </span>
        There was a problem — pay a reduced amount
      </label>
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
