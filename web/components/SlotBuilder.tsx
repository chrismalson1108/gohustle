"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { Slot } from "@/lib/types";

// Builds concrete time slots from a datetime-local input. Produces a label like
// "Mon Dec 16, 2:00 PM" (so the shared day-filter can parse the weekday) plus an
// ISO `startsAt`. Past datetimes are rejected.
function labelFor(d: Date): string {
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

export default function SlotBuilder({
  slots,
  onChange,
}: {
  slots: Slot[];
  onChange: (slots: Slot[]) => void;
}) {
  const [value, setValue] = useState("");

  const add = () => {
    if (!value) return;
    const d = new Date(value);
    if (isNaN(d.getTime()) || d.getTime() < Date.now()) return;
    const slot: Slot = {
      id: `new-${Date.now()}-${slots.length}`,
      label: labelFor(d),
      taken: false,
      startsAt: d.toISOString(),
    };
    onChange([...slots, slot]);
    setValue("");
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-2xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={add}
          disabled={!value}
          className="flex items-center gap-1 rounded-2xl bg-primary px-4 text-sm font-bold text-white disabled:opacity-50"
        >
          <Plus className="size-4" /> Add
        </button>
      </div>
      {slots.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {slots.map((s) => (
            <span key={s.id} className="flex items-center gap-1.5 rounded-full bg-primary-light px-3 py-1.5 text-sm font-bold text-primary">
              {s.label}
              <button type="button" onClick={() => onChange(slots.filter((x) => x.id !== s.id))} aria-label="Remove">
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">No times added — posters can also leave this empty for &ldquo;flexible / contact to schedule.&rdquo;</p>
      )}
    </div>
  );
}
