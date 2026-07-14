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
      <div className="flex gap-2">
        <Input
          type="datetime-local"
          value={value}
          min={minLocal}
          onChange={(e) => { setValue(e.target.value); if (error) setError(""); }}
          className="flex-1"
        />
        <Button type="button" onClick={add} disabled={!value}>
          <Plus className="size-4" /> Add
        </Button>
      </div>
      {error && <p className="mt-1.5 text-sm font-medium text-urgent">{error}</p>}
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
