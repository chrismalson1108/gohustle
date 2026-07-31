"use client";

import { useEffect, useState } from "react";
import { Building2, GraduationCap, Zap } from "lucide-react";
import {
  DEFAULT_FILTERS,
  PAY_OPTIONS,
  PAY_TYPE_OPTIONS,
  SORT_OPTIONS,
  DAY_OPTIONS,
  RADIUS_OPTIONS,
  countActiveFilters,
} from "@gohustlr/shared";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import LocationPicker from "./LocationPicker";
import { classNames } from "@/lib/format";

export interface Filters {
  payRange: string;
  days: string[];
  location: string;
  payType: string;
  urgentOnly: boolean;
  verifiedStudentsOnly: boolean;
  campusOnly: boolean;
  radius: string | number;
  near: { label: string; lat: number | null; lng: number | null } | null;
  sortBy: string;
}

interface Props {
  open: boolean;
  filters: Filters;
  availableStates: string[];
  mySchool?: string | null;
  defaultCenterLabel?: string | null;
  onApply: (f: Filters) => void;
  onClose: () => void;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        "max-w-full truncate rounded-full border px-3.5 py-2 text-[13px] font-semibold transition",
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
      <p className="mb-2 text-[13px] font-semibold text-ink-muted">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

// A real <input type="checkbox"> behind an sr-only mask, so the control keeps
// native checkbox semantics and keyboard behaviour; the track/thumb are styled
// siblings driven by `peer-checked:`. Mirrors mobile's <Switch>.
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    // -my-2/py-2 grows the hit area to 44px without changing the row's layout.
    <label className="relative -my-2 inline-flex shrink-0 cursor-pointer items-center py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        className="peer sr-only"
      />
      <span className="h-7 w-12 rounded-full bg-line transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40" />
      <span className="pointer-events-none absolute left-0.5 top-1/2 size-6 -translate-y-1/2 rounded-full bg-white shadow-[var(--shadow-sm)] transition peer-checked:translate-x-5" />
    </label>
  );
}

// The mobile `toggleRow`: icon + 14/600 label + a muted sub-line explaining what
// the filter actually does, with the switch on the right. Replaces the old
// emoji-prefixed chips ("⚡ Urgent gigs only"), which said less in more space.
function ToggleRow({
  icon,
  label,
  sub,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-2xl bg-canvas p-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {icon}
          <span className="truncate">{label}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-[17px] text-ink-muted">{sub}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export default function FilterSheet({ open, filters, availableStates, mySchool, defaultCenterLabel, onApply, onClose }: Props) {
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
      // Dense sheet: give the chip rows room to breathe on desktop instead of
      // wrapping every option list onto four lines inside a 512px column.
      size="lg"
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
        <p className="mb-2 text-[13px] font-semibold text-ink-muted">Available days</p>
        {/* Wraps instead of forcing 7 equal columns — the same rule mobile's
            dayRow documents: at ~360px each of seven columns leaves too little
            room for the label and clips it. Each button keeps a 44px minimum
            touch target in BOTH axes and grows to share whatever width is left
            over — `min-w-11` alone only floors the width, which left these 38px
            tall. The height floor is `min-h-11` with the label centred, not more
            vertical padding. */}
        <div className="flex flex-wrap gap-1.5">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={local.days.includes(d)}
              onClick={() => toggleDay(d)}
              className={classNames(
                "flex min-h-11 min-w-11 grow basis-11 items-center justify-center rounded-xl border px-2 text-xs font-semibold transition",
                local.days.includes(d) ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <Section title="Distance">
        {RADIUS_OPTIONS.map((o) => (
          <Chip key={String(o.id)} active={local.radius === o.id} onClick={() => set("radius", o.id)}>
            {o.label}
          </Chip>
        ))}
      </Section>

      {local.radius !== "any" && (
        <div className="mb-5">
          <p className="mb-2 text-[13px] font-semibold text-ink-muted">Center of search</p>
          <LocationPicker
            value={local.near?.label ?? defaultCenterLabel ?? ""}
            onChange={(label, coords) =>
              set("near", label ? { label, lat: coords?.lat ?? null, lng: coords?.lng ?? null } : null)
            }
            placeholder="Your location"
          />
          <p className="mt-1.5 text-xs text-ink-muted">
            Showing gigs within {local.radius} mi of this location. Remote gigs always show.
          </p>
        </div>
      )}

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
        <ToggleRow
          icon={<Zap className="size-3.5 shrink-0 text-ink-soft" />}
          label="Urgent gigs only"
          sub="Needed ASAP — higher chance of quick earnings"
          checked={local.urgentOnly}
          onChange={(v) => set("urgentOnly", v)}
        />
      </Section>

      <Section title="Trust">
        <ToggleRow
          icon={<GraduationCap className="size-3.5 shrink-0 text-ink-soft" />}
          label="Verified students only"
          sub="Only show gigs from posters with a Verified Student badge"
          checked={local.verifiedStudentsOnly}
          onChange={(v) => set("verifiedStudentsOnly", v)}
        />
        {mySchool && (
          <ToggleRow
            icon={<Building2 className="size-3.5 shrink-0 text-ink-soft" />}
            label="My campus only"
            sub={`Only gigs from posters at ${mySchool}`}
            checked={local.campusOnly}
            onChange={(v) => set("campusOnly", v)}
          />
        )}
      </Section>
    </Modal>
  );
}
