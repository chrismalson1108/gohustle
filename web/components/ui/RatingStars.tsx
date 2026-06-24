"use client";

import { Star } from "lucide-react";
import { classNames } from "@/lib/format";

interface Props {
  value: number;
  size?: number;
  onChange?: (v: number) => void;
  className?: string;
}

// Read-only when no onChange; interactive star input otherwise.
export default function RatingStars({ value, size = 18, onChange, className = "" }: Props) {
  const interactive = !!onChange;
  return (
    <div className={classNames("inline-flex items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= Math.round(value);
        const star = (
          <Star
            className={classNames(filled ? "fill-gold text-gold" : "fill-transparent text-line")}
            style={{ width: size, height: size }}
          />
        );
        return interactive ? (
          <button
            key={n}
            type="button"
            onClick={() => onChange?.(n)}
            className="cursor-pointer transition active:scale-90"
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
