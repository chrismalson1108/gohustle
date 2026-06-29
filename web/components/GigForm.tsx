"use client";

import { useState } from "react";
import { X, ImagePlus, Lock } from "lucide-react";
import { CATEGORIES, findProhibited } from "@gohustlr/shared";
import { useAuth } from "@/lib/auth";
import { uploadImages } from "@/lib/uploadImage";
import Button from "@/components/ui/Button";
import { Input, Textarea, Label } from "@/components/ui/Field";
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
  description?: string;
  requirements?: string[];
  recurrence?: string;
  urgent?: boolean;
  slots?: Slot[];
  estimatedHours?: number;
  instantBook?: boolean;
}

function Chip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={classNames(
        "rounded-full border px-3.5 py-2 text-[13px] font-bold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

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

  const effectiveCategory = category === "other" ? customCategory : category;
  const valid = title && effectiveCategory && pay && location && description;

  const submit = async () => {
    if (!valid || !user) return;
    if (findProhibited(`${title} ${description}`)) {
      onError?.("Your gig contains content that isn't allowed. Please edit it.");
      return;
    }
    setBusy(true);
    let newUrls: string[] = [];
    try {
      if (files.length) newUrls = await uploadImages(files, "job-photos", user.id);
    } catch (e) {
      setBusy(false);
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
      instantBook,
      instantBookAudience: "all",
      lat: null,
      lng: null,
    });
    setBusy(false);
  };

  const coreNote = lockedCore ? (
    <p className="mb-3 flex items-center gap-1.5 rounded-xl bg-gold-light px-3 py-2 text-xs font-semibold text-accent-deep">
      <Lock className="size-3.5" /> Core terms are locked while a booking is active. Ask the earner for an amendment to change them.
    </p>
  ) : null;

  return (
    <div className="space-y-5">
      {coreNote}
      <div>
        <Label>Job title *</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={lockedCore} placeholder="e.g. Lawn mowing, Math tutor…" />
      </div>

      <div>
        <Label>Category *</Label>
        <div className="flex flex-wrap gap-2">
          {CATS.map((c) => (
            <Chip key={c.id} active={category === c.id} disabled={lockedCore} onClick={() => setCategory(c.id)}>
              {c.icon} {c.label}
            </Chip>
          ))}
          <Chip active={category === "other"} disabled={lockedCore} onClick={() => setCategory("other")}>
            ✏️ Other
          </Chip>
        </div>
        {category === "other" && <Input className="mt-2.5" value={customCategory} disabled={lockedCore} onChange={(e) => setCustomCategory(e.target.value)} placeholder="Type your category…" />}
      </div>

      <div>
        <Label>Pay *{payLocked && !lockedCore ? " (locked — backed by escrow)" : ""}</Label>
        <div className="flex gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-2xl border border-line bg-white px-4">
            <span className="text-ink-soft">$</span>
            <input value={pay} disabled={payLocked} onChange={(e) => setPay(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" inputMode="decimal" className="w-full bg-transparent py-3 text-[15px] outline-none disabled:opacity-60" />
          </div>
          {(["flat", "hourly"] as const).map((t) => (
            <Chip key={t} active={payType === t} disabled={payLocked} onClick={() => setPayType(t)}>
              {t === "flat" ? "Flat" : "/hr"}
            </Chip>
          ))}
        </div>
      </div>

      {payType === "hourly" && (
        <div>
          <Label>Estimated hours</Label>
          <Input
            value={estimatedHours}
            onChange={(e) => setEstimatedHours(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="2"
          />
          <p className="mt-1 text-xs text-ink-muted">Used to estimate total pay and to filter by pay range.</p>
        </div>
      )}

      <div>
        <Label>Location *</Label>
        <Input value={location} disabled={lockedCore} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Austin, TX or Remote" />
      </div>

      <div>
        <Label>Description *</Label>
        <Textarea value={description} disabled={lockedCore} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the job in detail…" />
      </div>

      <div>
        <Label>Photos (optional)</Label>
        <div className="flex flex-wrap gap-3">
          {keptPhotos.map((u, i) => (
            <div key={u} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="size-20 rounded-xl object-cover" />
              <button onClick={() => setKeptPhotos(keptPhotos.filter((_, idx) => idx !== i))} className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border-2 border-white bg-urgent text-white">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {files.map((f, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={URL.createObjectURL(f)} alt="" className="size-20 rounded-xl object-cover" />
              <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))} className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border-2 border-white bg-urgent text-white">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {keptPhotos.length + files.length < 6 && (
            <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary bg-white text-primary">
              <ImagePlus className="size-5" />
              <span className="text-[11px] font-bold">Add</span>
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])].slice(0, 6))} />
            </label>
          )}
        </div>
      </div>

      <div>
        <Label>Requirements (one per line)</Label>
        <Textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} placeholder={"Must have a car\nExperience with power tools"} />
      </div>

      <div>
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

      <button
        onClick={() => setUrgent(!urgent)}
        className={classNames("w-full rounded-2xl border-2 py-3.5 text-center text-sm font-bold transition", urgent ? "border-urgent bg-urgent-light text-urgent" : "border-urgent/40 bg-white text-urgent")}
      >
        {urgent ? "⚡ Marked as Urgent — Needed ASAP" : "Mark as Urgent (optional)"}
      </button>

      {/* Instant Book is parked: auto-confirm was removed because it skipped the
          escrow hold (the earner could end up working unpaid). It needs escrow
          authorization at book-time before it can be re-enabled. */}

      {!valid && <p className="text-center text-sm text-ink-muted">* Fill in all required fields</p>}

      <Button fullWidth size="lg" loading={busy} disabled={!valid} onClick={submit}>
        {submitLabel}
      </Button>
    </div>
  );
}
