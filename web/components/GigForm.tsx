"use client";

import { useRef, useState } from "react";
import { X, ImagePlus, Lock, Zap } from "lucide-react";
import { CATEGORIES, findProhibited, MIN_JOB_PAY, validateJobPay } from "@gohustlr/shared";
import { moderateText, logModerationBlock } from "@/lib/moderation";
import { useAuth } from "@/lib/auth";
import { uploadImages } from "@/lib/uploadImage";
import Button from "@/components/ui/Button";
import { Input, Textarea, Label } from "@/components/ui/Field";
import LocationPicker, { type Coords } from "@/components/LocationPicker";
import SlotBuilder from "@/components/SlotBuilder";
import { classNames } from "@/lib/format";
import type { Slot } from "@/lib/types";

const CATS = CATEGORIES.filter((c) => c.id !== "all");
const RECURRENCE = [
  { id: "none", label: "One-time" },
  { id: "weekly", label: "Weekly" },
  { id: "biweekly", label: "Biweekly" },
  { id: "monthly", label: "Monthly" },
];

export interface GigFormData {
  title: string;
  category: string;
  pay: number;
  payType: "flat" | "hourly";
  location: string;
  description: string;
  urgent: boolean;
  tags: string[];
  hazards: string[];
  estimatedHours: number;
  requirements: string[];
  slots: Slot[];
  photos: string[];
  recurrence: string;
  instantBook: boolean;
  instantBookAudience: string;
  lat: number | null;
  lng: number | null;
}

export interface GigFormInitial {
  title?: string;
  category?: string;
  pay?: number | string;
  payType?: "flat" | "hourly";
  location?: string;
  lat?: number | null;
  lng?: number | null;
  description?: string;
  requirements?: string[];
  recurrence?: string;
  urgent?: boolean;
  tags?: string[];
  hazards?: string[];
  slots?: Slot[];
  estimatedHours?: number;
  instantBook?: boolean;
}

// Bordered pill, active = INK fill — the same chip Browse uses for its category
// rack. Brand purple is reserved for links/CTAs and the active filter state; a
// selected category (or pay type, or recurrence) is a generic active chip and
// takes ink. `min-h-11` clears the 44px touch minimum and `max-w-full` + a
// truncating label keep a long custom category inside the card.
function Chip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={classNames(
        "inline-flex min-h-11 max-w-full shrink-0 items-center justify-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition",
        active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-soft hover:border-primary",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

// Remove-affordance on a tag/hazard/photo chip. The glyph stays small; the
// `after` box (invisible, no content) is what the finger actually hits — a real
// `min-h-11` box would force the whole pill to 44px tall.
// The math: a 14px glyph + `p-1` is a 22px button, so the inset has to be 12px a
// side to reach 46px. `-inset-2` only got it to 38px, under the 44px minimum.
const CHIP_REMOVE = "relative -m-1 shrink-0 rounded-full p-1 transition after:absolute after:-inset-3 hover:opacity-70";

// Shared gig editor used by Post (/hiring/new) and Edit (/hiring/[id]/edit).
// `lockedCore` disables core terms (used on Edit once a booking is active).
// `lockedPay` disables pay/payType specifically — it stays locked even when an
// amendment unlocks the rest, because the escrow hold can't be re-priced in place.
export default function GigForm({
  initial,
  existingPhotos = [],
  lockedCore = false,
  lockedPay,
  submitLabel,
  onSubmit,
  onError,
}: {
  initial?: GigFormInitial;
  existingPhotos?: string[];
  lockedCore?: boolean;
  lockedPay?: boolean;
  submitLabel: string;
  onSubmit: (data: GigFormData) => Promise<void>;
  onError?: (message: string) => void;
}) {
  // Pay locks at least as often as the rest of the core terms; if not given
  // explicitly, fall back to lockedCore.
  const payLocked = lockedPay ?? lockedCore;
  const { user } = useAuth();
  const knownCat = CATS.some((c) => c.id === initial?.category);

  const [title, setTitle] = useState(initial?.title || "");
  const [category, setCategory] = useState(initial?.category && knownCat ? initial.category : initial?.category ? "other" : "");
  const [customCategory, setCustomCategory] = useState(initial?.category && !knownCat ? initial.category : "");
  const [pay, setPay] = useState(initial?.pay != null ? String(initial.pay) : "");
  const [payType, setPayType] = useState<"flat" | "hourly">(initial?.payType || "flat");
  const [location, setLocation] = useState(initial?.location || "");
  const [coords, setCoords] = useState<Coords | null>(
    initial?.lat != null && initial?.lng != null ? { lat: initial.lat, lng: initial.lng } : null,
  );
  const [description, setDescription] = useState(initial?.description || "");
  const [requirements, setRequirements] = useState((initial?.requirements || []).join("\n"));
  const [slots, setSlots] = useState<Slot[]>(initial?.slots || []);
  const [estimatedHours, setEstimatedHours] = useState(String(initial?.estimatedHours || 2));
  const [recurrence, setRecurrence] = useState(initial?.recurrence || "none");
  const [urgent, setUrgent] = useState(!!initial?.urgent);
  // Preserve any previously-set instant_book value on edit, but the poster can no
  // longer toggle it (see the parked-feature note below) — so it's read-only here.
  const [instantBook] = useState(!!initial?.instantBook);
  const [keptPhotos, setKeptPhotos] = useState<string[]>(existingPhotos);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  // Re-entry guard: setBusy is async, so two rapid clicks can both pass the busy
  // check before a re-render. A ref flips synchronously and blocks the second call.
  const submitting = useRef(false);

  const [tags, setTags] = useState<string[]>(initial?.tags || []);
  const [tagDraft, setTagDraft] = useState("");
  const addTag = () => {
    const t = tagDraft.trim().toLowerCase().slice(0, 24);
    if (t && !tags.includes(t) && tags.length < 6) setTags([...tags, t]);
    setTagDraft("");
  };
  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const [hazards, setHazards] = useState<string[]>(initial?.hazards || []);
  const [hazardDraft, setHazardDraft] = useState("");
  const addHazard = () => {
    const h = hazardDraft.trim().toLowerCase().slice(0, 40);
    if (h && !hazards.includes(h) && hazards.length < 6) setHazards([...hazards, h]);
    setHazardDraft("");
  };
  const removeHazard = (h: string) => setHazards(hazards.filter((x) => x !== h));

  const effectiveCategory = category === "other" ? customCategory : category;
  // Shared with mobile so the two clients can never tell users different rules.
  // Also catches "." / "abc", which would serialize to null and fail the NOT NULL
  // insert (previously surfaced as a false "posted").
  const payError = validateJobPay(pay);
  const payValid = !payError;
  const valid = title && effectiveCategory && payValid && location && description;

  const submit = async () => {
    if (!user || submitting.current) return;
    if (!valid) {
      onError?.(payError && pay ? payError : "Please fill in all required fields.");
      return;
    }
    const kwTerm = findProhibited([title, description, ...tags, ...hazards].join(" "));
    if (kwTerm) {
      logModerationBlock(kwTerm, "gig", `${title} ${description}`);
      onError?.("Your gig contains content that isn't allowed. Please edit it.");
      return;
    }
    // Guard BEFORE the async moderation await so the button disables/spins and a
    // double-click can't post twice. finally resets on every path.
    submitting.current = true;
    setBusy(true);
    try {
      // Context-aware check (catches intent a keyword list misses).
      const mod = await moderateText([title, description].join("\n"), "gig");
      // A 429 here is self-inflicted (own quota), not an outage, so moderateText
      // fails CLOSED on it — otherwise burning the quota would disable this layer.
      if (mod.rateLimited) {
        onError?.("You've made a lot of checks in a row. Wait a minute and try again.");
        return;
      }
      if (!mod.allowed) {
        onError?.("Your gig contains content that isn't allowed. Please edit it.");
        return;
      }
      let newUrls: string[] = [];
      try {
        if (files.length) newUrls = await uploadImages(files, "job-photos", user.id);
      } catch (e) {
        onError?.((e as Error).message || "Photo upload failed.");
        return;
      }
      const finalSlots = slots.length
        ? slots
        : [{ id: "s1", label: "Flexible — Contact to Schedule", taken: false, startsAt: null }];
      await onSubmit({
        title,
        category: effectiveCategory,
        pay: parseFloat(pay),
        payType,
        location,
        description,
        urgent,
        estimatedHours: payType === "hourly" ? Math.max(1, parseFloat(estimatedHours) || 2) : 2,
        requirements: requirements ? requirements.split("\n").filter(Boolean) : [],
        slots: finalSlots,
        photos: [...keptPhotos, ...newUrls],
        recurrence,
        tags,
        hazards,
        instantBook,
        instantBookAudience: "all",
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const coreNote = lockedCore ? (
    <p className="flex items-start gap-1.5 rounded-xl bg-accent-light px-3 py-2.5 text-[13px] font-semibold text-accent-deep">
      <Lock className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">Core terms are locked while a booking is active. Ask the earner for an amendment to change them.</span>
    </p>
  ) : null;

  return (
    <div className="space-y-4">
      {coreNote}
      {/* Two columns once the form column clears 42rem. Only the SHORT controls
          pair up (pay + pay type, estimated hours; repeats + urgent) — anything the
          poster writes into (title, description, requirements) or that owns a wide
          control (category rack, location autocomplete, photos, slots) keeps the
          full measure via `@2xl:col-span-2`. A col-span-2 item can't fit beside a
          lone half cell, so it starts the next row on its own; no spacer needed.
          Container steps, not `md:` — `<main>` is the @container. At exactly a 768px
          window the desktop icon rail (76px) is already showing and the gutter takes
          another 48px, so `md:` split a ~644px box: wrong by one sidebar, which is
          the failure the container system exists to prevent. `@2xl` (672px) is the
          honest measure for this 760px-max form. */}
      <div className="grid grid-cols-1 gap-5 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] sm:p-5 @2xl:grid-cols-2 @2xl:gap-x-6">
        <div className="@2xl:col-span-2">
          <Label>Job title *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={lockedCore} placeholder="e.g. Lawn mowing, Math tutor…" />
        </div>

        <div className="@2xl:col-span-2">
          <Label>Category *</Label>
          <div className="flex flex-wrap gap-2">
            {CATS.map((c) => (
              <Chip key={c.id} active={category === c.id} disabled={lockedCore} onClick={() => setCategory(c.id)}>
                <span>{c.icon}</span>
                <span className="min-w-0 truncate">{c.label}</span>
              </Chip>
            ))}
            <Chip active={category === "other"} disabled={lockedCore} onClick={() => setCategory("other")}>
              <span>✏️</span>
              <span className="min-w-0 truncate">Other</span>
            </Chip>
          </div>
          {category === "other" && <Input className="mt-2.5" value={customCategory} disabled={lockedCore} onChange={(e) => setCustomCategory(e.target.value)} placeholder="Type your category…" />}
        </div>

        <div className="@2xl:col-span-2">
          <Label>
            Tags <span className="font-normal text-ink-muted">(optional — helps the right workers find your gig)</span>
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            {tags.map((t) => (
              <span key={t} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-primary-light px-3 py-1.5 text-[13px] font-semibold text-primary">
                <span className="min-w-0 truncate">{t}</span>
                <button type="button" onClick={() => removeTag(t)} aria-label={`Remove ${t}`} className={CHIP_REMOVE}>
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            {tags.length < 6 && (
              <Input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); } }}
                onBlur={addTag}
                placeholder={tags.length ? "Add another…" : "e.g. lawncare, assembly, heavy lifting"}
                className="min-w-0 grow basis-36"
              />
            )}
          </div>
        </div>

        <div className="@2xl:col-span-2">
          <Label>
            Safety notes / hazards <span className="font-normal text-ink-muted">(optional — warn applicants of any risks)</span>
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            {hazards.map((h) => (
              <span key={h} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-urgent-light px-3 py-1.5 text-[13px] font-semibold text-urgent">
                <span className="min-w-0 truncate">{h}</span>
                <button type="button" onClick={() => removeHazard(h)} aria-label={`Remove ${h}`} className={CHIP_REMOVE}>
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            {hazards.length < 6 && (
              <Input
                value={hazardDraft}
                onChange={(e) => setHazardDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addHazard(); } }}
                onBlur={addHazard}
                placeholder={hazards.length ? "Add another…" : "e.g. dog on site, uneven ground, fragile items"}
                className="min-w-0 grow basis-36"
              />
            )}
          </div>
        </div>

        <div>
          <Label>Pay *{payLocked && !lockedCore ? " (locked — backed by escrow)" : ""}</Label>
          {/* No items-center: the default stretch makes the Flat / /hr chips match
              the input's height exactly, and flex-wrap lets them drop below it
              rather than crushing the amount field on a narrow card. */}
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-0 grow basis-32">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-soft">$</span>
              <Input value={pay} disabled={payLocked} onChange={(e) => setPay(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={String(MIN_JOB_PAY)} inputMode="decimal" className="pl-7" />
            </div>
            {(["flat", "hourly"] as const).map((t) => (
              <Chip key={t} active={payType === t} disabled={payLocked} onClick={() => setPayType(t)}>
                {t === "flat" ? "Flat" : "/hr"}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            Minimum ${MIN_JOB_PAY}
            {payType === "hourly" ? " per hour" : ""}.
          </p>
        </div>

        {payType === "hourly" && (
          <div>
            <Label>Estimated hours{payLocked && !lockedCore ? " (locked — backed by escrow)" : ""}</Label>
            <Input
              value={estimatedHours}
              disabled={payLocked}
              onChange={(e) => setEstimatedHours(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="2"
            />
            <p className="mt-1.5 text-xs text-ink-muted">Used to estimate total pay and to filter by pay range.</p>
          </div>
        )}

        <div className="@2xl:col-span-2">
          <Label>Location *</Label>
          <LocationPicker
            value={location}
            disabled={lockedCore}
            onChange={(label, c) => { setLocation(label); setCoords(c); }}
            placeholder="e.g. Austin, TX or Remote"
          />
        </div>

        <div className="@2xl:col-span-2">
          <Label>Description *</Label>
          <Textarea value={description} disabled={lockedCore} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the job in detail…" />
        </div>

        <div className="@2xl:col-span-2">
          <Label>Photos (optional)</Label>
          <div className="flex flex-wrap gap-3">
            {keptPhotos.map((u, i) => (
              <div key={u} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="" className="size-20 rounded-xl bg-divider object-cover" />
                <button onClick={() => setKeptPhotos(keptPhotos.filter((_, idx) => idx !== i))} aria-label="Remove photo" className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-white bg-urgent text-white after:absolute after:-inset-2.5">
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {files.map((f, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={URL.createObjectURL(f)} alt="" className="size-20 rounded-xl bg-divider object-cover" />
                <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))} aria-label="Remove photo" className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-white bg-urgent text-white after:absolute after:-inset-2.5">
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {keptPhotos.length + files.length < 6 && (
              <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line bg-white text-ink-soft transition hover:border-primary hover:text-primary">
                <ImagePlus className="size-5" />
                <span className="text-[11px] font-semibold">Add</span>
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])].slice(0, 6))} />
              </label>
            )}
          </div>
        </div>

        <div className="@2xl:col-span-2">
          <Label>Requirements (one per line)</Label>
          <Textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} placeholder={"Must have a car\nExperience with power tools"} />
        </div>

        <div className="@2xl:col-span-2">
          <Label>Available times</Label>
          <SlotBuilder slots={slots} onChange={setSlots} />
        </div>

        <div>
          <Label>Repeats</Label>
          <div className="flex flex-wrap gap-2">
            {RECURRENCE.map((o) => (
              <Chip key={o.id} active={recurrence === o.id} onClick={() => setRecurrence(o.id)}>
                {o.label}
              </Chip>
            ))}
          </div>
        </div>

        {/* items-end keeps the toggle on the same baseline as the Repeats chips
            when the two share a row from `@2xl` up. */}
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => setUrgent(!urgent)}
            aria-pressed={urgent}
            className={classNames(
              "flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border py-3.5 text-center text-sm font-semibold transition",
              urgent ? "border-urgent bg-urgent-light text-urgent" : "border-line bg-white text-ink-soft hover:border-urgent/40",
            )}
          >
            <Zap className={classNames("size-4 shrink-0", urgent ? "text-urgent" : "text-urgent/70")} />
            <span className="min-w-0 truncate">{urgent ? "Marked as Urgent — Needed ASAP" : "Mark as Urgent (optional)"}</span>
          </button>
        </div>
      </div>

      {/* Instant Book is parked: auto-confirm was removed because it skipped the
          escrow hold (the earner could end up working unpaid). It needs escrow
          authorization at book-time before it can be re-enabled. */}

      {/* Sticky submit. This form is ~14 fields; on a laptop the button used to
          be a full screen below the fold, so the poster scrolled back down to
          find it. It parks above the mobile tab bar (fixed, 4.5rem tall) below
          `md`, and at the viewport edge from `md` up where the tab bar is gone.
          The negative margins cancel PageContainer's gutter so the rule spans
          the full content column. */}
      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 -mx-4 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0 lg:-mx-8 lg:px-8">
        {!valid && <p className="mb-2 text-center text-sm text-ink-muted">* Fill in all required fields</p>}
        <Button fullWidth size="lg" loading={busy} disabled={!valid} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
