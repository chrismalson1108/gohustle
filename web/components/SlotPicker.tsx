"use client";

import { Lock } from "lucide-react";
import { classNames } from "@/lib/format";
import type { Slot } from "@/lib/types";

// Single-select chip row from a job's slots. Taken slots are disabled.
// Ported from src/components/SlotPicker.js: true pills, 1px line border, primary
// fill when selected. The mobile version scrolls horizontally; on web the row
// WRAPS instead — a mouse cannot scroll an x-overflow row, so a hidden slot would
// be unreachable on desktop.
export default function SlotPicker({
  slots,
  selected,
  onSelect,
}: {
  slots: Slot[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  // Hide dated slots whose time has already passed (flexible/undated slots stay) —
  // mirrors mobile so an earner can't select and book a slot that's already elapsed.
  const now = new Date().getTime();
  const visible = slots.filter((s) => !s.startsAt || new Date(s.startsAt).getTime() > now);
  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((s) => {
        const active = selected === s.id;
        return (
          <button
            key={s.id}
            type="button"
            disabled={s.taken}
            onClick={() => onSelect(s.id)}
            // The lock glyph replaces the old " · taken" suffix + line-through;
            // aria-label keeps that information for assistive tech.
            aria-label={s.taken ? `${s.label} — already taken` : s.label}
            aria-pressed={active}
            className={classNames(
              "inline-flex min-h-11 max-w-full shrink-0 items-center gap-1.5 rounded-full border px-4 py-2.5 text-[13px] font-medium transition",
              s.taken
                ? // Disabled state reads through COLOR alone — stacking opacity on
                  // top of the fill faded the label into it and made taken slots
                  // unreadable (same fix as mobile).
                  "cursor-not-allowed border-divider bg-divider text-ink-soft"
                : active
                  ? "border-primary bg-primary font-semibold text-white"
                  : "border-line bg-white text-ink-soft hover:border-primary",
            )}
          >
            {s.taken && <Lock className="size-3.5 shrink-0" />}
            <span className="truncate">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
