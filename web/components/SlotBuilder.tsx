"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
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
  const [error, setError] = useState("");

  // Earliest selectable value for the datetime-local picker: now, in the user's
  // local time (YYYY-MM-DDTHH:mm). Blocks picking past times in the UI.
  const minLocal = (() => {
    const d = new Date();
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  })();

  const add = () => {
    if (!value) return;
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      setError("Enter a valid date and time.");
      return;
    }
    if (d.getTime() < Date.now()) {
      setError("Pick a time in the future.");
      return;
    }
    setError("");
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
      {/* A native datetime-local control has a large intrinsic width and a flex
          item's default min-width:auto refuses to shrink below it, so `flex-1`
          alone overflowed the row on a phone. `min-w-0` lets it compress and
          `flex-wrap` + a growable button drops "Add" to its own line when the
          picker still needs more room than the card has. */}
      <div className="flex flex-wrap gap-2">
        <Input
          type="datetime-local"
          value={value}
          min={minLocal}
          onChange={(e) => { setValue(e.target.value); if (error) setError(""); }}
          className="min-w-0 grow basis-56"
        />
        <Button type="button" onClick={add} disabled={!value} className="shrink-0 grow basis-24 sm:grow-0">
          <Plus className="size-4" /> Add
        </Button>
      </div>
      {error && <p className="mt-1.5 text-sm font-medium text-urgent">{error}</p>}
      {slots.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {slots.map((s) => (
            <span key={s.id} className="flex max-w-full items-center gap-1.5 rounded-full bg-primary-light px-3 py-1.5 text-[13px] font-semibold text-primary">
              <span className="min-w-0 truncate">{s.label}</span>
              {/* -m-1 p-1 keeps the glyph the same size while the hit area grows.
                  A 14px glyph + p-1 is a 22px button, so the invisible `after` box
                  needs a 12px inset to reach 46px — `-inset-2` was only 38px, under
                  the 44px touch minimum. (Same recipe as GigForm's CHIP_REMOVE; a
                  real min-h-11 box would force the whole pill to 44px tall.) */}
              <button
                type="button"
                onClick={() => onChange(slots.filter((x) => x.id !== s.id))}
                aria-label={`Remove ${s.label}`}
                className="relative -m-1 shrink-0 rounded-full p-1 after:absolute after:-inset-3"
              >
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
