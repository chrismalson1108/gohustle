"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_FILTERS,
  PAY_OPTIONS,
  PAY_TYPE_OPTIONS,
  SORT_OPTIONS,
  DAY_OPTIONS,
  countActiveFilters,
} from "@gohustlr/shared";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import { classNames } from "@/lib/format";

export interface Filters {
  payRange: string;
  days: string[];
  location: string;
  payType: string;
  urgentOnly: boolean;
  verifiedStudentsOnly: boolean;
  campusOnly: boolean;
  sortBy: string;
}

interface Props {
  open: boolean;
  filters: Filters;
  availableStates: string[];
  mySchool?: string | null;
  onApply: (f: Filters) => void;
  onClose: () => void;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        "rounded-full border px-3.5 py-2 text-[13px] font-bold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary",
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export default function FilterSheet({ open, filters, availableStates, mySchool, onApply, onClose }: Props) {
  const [local, setLocal] = useState<Filters>(filters);
  useEffect(() => {
    if (open) setLocal(filters);
  }, [open, filters]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setLocal((p) => ({ ...p, [k]: v }));
  const toggleDay = (d: string) =>
    set("days", local.days.includes(d) ? local.days.filter((x) => x !== d) : [...local.days, d]);

  const active = countActiveFilters(local);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Filter gigs"
      footer={
        <div className="flex gap-3">
          <Button variant="ghost" onClick={() => setLocal({ ...DEFAULT_FILTERS })}>
            Reset
          </Button>
          <Button fullWidth onClick={() => onApply(local)}>
            Show results{active > 0 ? ` · ${active} filter${active !== 1 ? "s" : ""}` : ""}
          </Button>
        </div>
      }
    >
      <Section title="Sort by">
        {SORT_OPTIONS.map((o) => (
          <Chip key={o.id} active={local.sortBy === o.id} onClick={() => set("sortBy", o.id)}>
            {o.label}
          </Chip>
        ))}
      </Section>

      <Section title="Pay range">
        {PAY_OPTIONS.map((o) => (
          <Chip key={o.id} active={local.payRange === o.id} onClick={() => set("payRange", o.id)}>
            {o.label}
          </Chip>
        ))}
      </Section>

      <Section title="Pay type">
        {PAY_TYPE_OPTIONS.map((o) => (
          <Chip key={o.id} active={local.payType === o.id} onClick={() => set("payType", o.id)}>
            {o.label}
          </Chip>
        ))}
      </Section>

      <div className="mb-5">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Available days</p>
        <div className="grid grid-cols-7 gap-1.5">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              className={classNames(
                "rounded-xl border py-2 text-xs font-extrabold transition",
                local.days.includes(d) ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <Section title="Location">
        <Chip active={local.location === "any"} onClick={() => set("location", "any")}>
          Any
        </Chip>
        <Chip active={local.location === "remote"} onClick={() => set("location", "remote")}>
          Remote only
        </Chip>
        {availableStates.map((st) => (
          <Chip key={st} active={local.location === st} onClick={() => set("location", st)}>
            {st}
          </Chip>
        ))}
      </Section>

      <Section title="Urgency">
        <Chip active={local.urgentOnly} onClick={() => set("urgentOnly", !local.urgentOnly)}>
          ⚡ Urgent gigs only
        </Chip>
      </Section>

      <Section title="Trust">
        <Chip active={local.verifiedStudentsOnly} onClick={() => set("verifiedStudentsOnly", !local.verifiedStudentsOnly)}>
          🎓 Verified students only
        </Chip>
        {mySchool && (
          <Chip active={local.campusOnly} onClick={() => set("campusOnly", !local.campusOnly)}>
            🏫 Only {mySchool}
          </Chip>
        )}
      </Section>
    </Modal>
  );
}
