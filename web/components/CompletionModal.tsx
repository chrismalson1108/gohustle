"use client";

import { useEffect, useMemo, useState } from "react";
import { Camera, Check, ShieldCheck, Square, SquareCheckBig, X } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import RatingStars from "./ui/RatingStars";
import SignedPhotoStrip from "./SignedPhotoStrip";
import Avatar from "./ui/Avatar";
import { Textarea } from "./ui/Field";
import { classNames, money, payLabel } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { uploadPrivateImages } from "@/lib/uploadImage";
import type { Booking } from "@/lib/types";
import { earnerNetAfterCreditCents, effectiveFeeLabel, posterChargeCents } from "@gohustlr/shared";

export interface VerifyArgs {
  rating: number;
  reviewText: string;
  paymentMethod: string;
  tipCents: number;
  pct: number;
  disputeReason: string | null;
  /** Storage paths in the private completion-photos bucket, under the poster's own uid. */
  disputePhotos?: string[];
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
  quotedCents = 0,
  onClose,
  onConfirm,
}: {
  open: boolean;
  booking: Booking | null;
  // The GROSS pinned deal value (bookings.amount_cents_quoted), not the hold. Two
  // different numbers come off it and this sheet states both; see below.
  quotedCents?: number;
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
  const [error, setError] = useState<string | null>(null);
  // Evidence for the reduction. The web half of mobile's picker — without it the poster
  // on a phone browser could only make an unillustrated accusation, and the earner's new
  // right of reply would be answering a claim with no photo in it.
  const { user } = useAuth();
  const [photos, setPhotos] = useState<File[]>([]);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  useEffect(() => {
    if (open) {
      setRating(5);
      setReviewText("");
      setTipCents(0);
      setDisputed(false);
      setPct(0.75);
      setDisputeReason("");
      setPhotos([]);
      setError(null);
    }
  }, [open]);

  // A reduced payout must state a reason (recorded as the dispute audit trail).
  const reasonMissing = disputed && !disputeReason.trim();

  if (!booking) return null;
  const earnerName = booking.earner?.name || "the earner";
  const jobTitle = booking.job?.title || "this job";

  // TWO numbers come off the pinned amount, and this sheet asserts both to the payer:
  //
  //   held on the card   = quoted - poster_discount_cents   (Stripe's authorizedCents)
  //   released to earner = quoted - fee AFTER fee_credit_cents (the fee is the earner's side)
  //
  // Both benefits are pinned on the booking at INSERT and both were ignored here, so
  // on any booking carrying a referral fee credit or a poster-discount grant this sheet
  // overstated the hold and understated the payout — under the sentence "this is the
  // amount you already authorized". The helpers mirror platform_fee_after_credit and
  // stripe-create-payment-intent's authorizedCents; __tests__/benefitDisplay.test.js
  // parses the migration so they cannot drift.
  const discountCents = Math.max(0, booking.posterDiscountCents ?? 0);
  const creditCents = Math.max(0, booking.feeCreditCents ?? 0);
  const heldCents = quotedCents > 0 ? posterChargeCents(quotedCents, discountCents) : 0;
  const releasedCents = earnerNetAfterCreditCents(quotedCents, booking.feeBpsQuoted, creditCents);
  // A percentage is honest only when nothing else moved the fee. A credit means we keep
  // less than the rate and a discount less again, so the parenthetical is dropped the
  // same way effectiveFeeLabel already drops it when the processing floor binds.
  const feeText = discountCents || creditCents ? null : effectiveFeeLabel(heldCents, booking.feeBpsQuoted);

  const confirm = async () => {
    if (reasonMissing) return; // guarded by the disabled button, belt-and-suspenders
    setBusy(true);
    setError(null);
    try {
      // Uploaded at confirm rather than at pick time, exactly as mobile does it: a
      // poster who changes their mind and unticks "there was a problem" leaves nothing
      // behind in storage.
      let photoPaths: string[] = [];
      if (disputed && photos.length && user?.id) {
        photoPaths = await uploadPrivateImages(photos, "completion-photos", user.id);
      }
      await onConfirm({
        rating,
        reviewText,
        paymentMethod: "card", // funds were authorized to the card at accept (escrow); no method to choose
        tipCents: tipCents || 0,
        pct: disputed ? pct : 1,
        disputeReason: disputed ? disputeReason || null : null,
        disputePhotos: disputed ? photoPaths : undefined,
      });
      onClose();           // only close on success
    } catch (e) {
      // Say so. A swallowed console.warn left the sheet open with no explanation —
      // and the most likely throw here is image moderation refusing a photo, which the
      // poster can act on the moment they are told.
      setError((e as Error)?.message || "That didn't go through. Please try again.");
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
              Confirming releases <b className="text-ink">{money(releasedCents, { cents: true })}</b> to {earnerName} {feeText ? `(we keep a ${feeText} platform fee)` : "(minus the platform fee shown when you accepted)"}. No new charge — this is the amount you already authorized when you accepted.
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
          <div className="mt-3 flex flex-wrap gap-2">
            {previews.map((u, i) => (
              <div key={u} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="" className="size-16 rounded-lg border border-line object-cover" />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => setPhotos((p) => p.filter((_, idx) => idx !== i))}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-white"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {photos.length < 6 && (
              <label className="flex size-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-ink-muted hover:border-primary hover:text-primary">
                <Camera className="size-5" />
                <span className="text-[10px] font-semibold">Photo</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    setPhotos((p) => [...p, ...picked].slice(0, 6));
                    e.target.value = ""; // so re-picking the same file fires onChange
                  }}
                />
              </label>
            )}
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            The rest of the hold stays on your card until this is settled. Your reason and any photos
            are shown to {earnerName}, who has 48 hours to reply, and are what support reviews.
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-sm font-medium text-urgent">{error}</p>}
    </Modal>
  );
}
