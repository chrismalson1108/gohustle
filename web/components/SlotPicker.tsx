"use client";

import { classNames } from "@/lib/format";
import type { Slot } from "@/lib/types";

// Single-select chip row from a job's slots. Taken slots are disabled.
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
            className={classNames(
              "rounded-2xl border px-3.5 py-2.5 text-sm font-bold transition",
              s.taken
                ? "cursor-not-allowed border-line bg-line/40 text-ink-muted line-through"
                : active
                  ? "border-primary bg-primary text-white"
                  : "border-line bg-white text-ink-soft hover:border-primary",
            )}
          >
            {s.label}
            {s.taken && " · taken"}
          </button>
        );
      })}
    </div>
  );
}
