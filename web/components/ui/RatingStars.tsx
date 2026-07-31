"use client";

import { Star } from "lucide-react";
import { classNames } from "@/lib/format";

interface Props {
  value: number;
  size?: number;
  onChange?: (v: number) => void;
  /** Dense read-only unit: one amber star + the ink numeral (mirror of the
   *  mobile RatingStars). Prefer this in list rows, where five glyphs cost far
   *  more width than they carry meaning. Ignored when `onChange` is set. */
  display?: boolean;
  className?: string;
}

// Read-only when no onChange; interactive star input otherwise.
export default function RatingStars({ value, size = 18, onChange, display = false, className = "" }: Props) {
  const interactive = !!onChange;

  // The amber glyph is the rating convention, but the ink number is what carries
  // the value — meaning never depends on counting low-contrast stars.
  if (display && !interactive) {
    return (
      <span
        className={classNames("inline-flex shrink-0 items-center gap-1 leading-none", className)}
        style={{ fontSize: size }}
      >
        <span className="text-gold">★</span>
        <span className="font-semibold text-ink">{value.toFixed(1)}</span>
      </span>
    );
  }

  return (
    <div className={classNames("inline-flex shrink-0 items-center", interactive ? "gap-0" : "gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= Math.round(value);
        const star = (
          <Star
            className={classNames("shrink-0", filled ? "fill-gold text-gold" : "fill-transparent text-line")}
            style={{ width: size, height: size }}
          />
        );
        return interactive ? (
          // Each star is a real touch target: the bare glyph is 18–34px, under
          // the 44px minimum, and this is the control that submits a review.
          <button
            key={n}
            type="button"
            onClick={() => onChange?.(n)}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center transition active:scale-90"
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            {star}
          </button>
        ) : (
          <span key={n}>{star}</span>
        );
      })}
    </div>
  );
}
