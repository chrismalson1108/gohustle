"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, ImagePlus, ArrowLeft } from "lucide-react";
import { CATEGORIES, findProhibited } from "@gohustlr/shared";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import { uploadImages } from "@/lib/uploadImage";
import PageHeader, { PageContainer } from "@/components/PageHeader";
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

export default function PostGigPage() {
  const router = useRouter();
  const { addJob } = useJobs();
  const { showToast } = useUser();
  const { user } = useAuth();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [pay, setPay] = useState("");
  const [payType, setPayType] = useState<"flat" | "hourly">("flat");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [requirements, setRequirements] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [recurrence, setRecurrence] = useState("none");
  const [urgent, setUrgent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [posting, setPosting] = useState(false);

  const effectiveCategory = category === "other" ? customCategory : category;
  const valid = title && effectiveCategory && pay && location && description;

  const post = async () => {
    if (!valid || !user) return;
    if (findProhibited(`${title} ${description}`)) {
      showToast({ icon: "⚠️", title: "Check your wording", message: "Your gig contains content that isn't allowed. Please edit it." });
      return;
    }
    setPosting(true);
    let photoUrls: string[] = [];
    try {
      if (files.length) photoUrls = await uploadImages(files, "job-photos", user.id);
    } catch (e) {
      setPosting(false);
      showToast({ icon: "⚠️", title: "Photo upload failed", message: (e as Error).message || "Please try again." });
      return;
    }
    const finalSlots = slots.length
      ? slots
      : [{ id: "s1", label: "Flexible — Contact to Schedule", taken: false, startsAt: null }];
    await addJob({
      title,
      category: effectiveCategory,
      pay: parseFloat(pay),
      payType,
      location,
      description,
      urgent,
      estimatedHours: 2,
      requirements: requirements ? requirements.split("\n").filter(Boolean) : [],
      slots: finalSlots,
      photos: photoUrls,
      recurrence,
      lat: null,
      lng: null,
    });
    setPosting(false);
    showToast({ icon: "🚀", title: "Gig Posted!", message: "Your gig is live — students can now apply!" });
    router.push("/hiring");
  };

  return (
    <div>
      <PageHeader title="Post a Gig" subtitle="Hire a motivated college student" />
      <PageContainer>
        <button onClick={() => router.back()} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        <div className="space-y-5">
          <div>
            <Label>Job title *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Lawn mowing, Math tutor…" />
          </div>

          <div>
            <Label>Category *</Label>
            <div className="flex flex-wrap gap-2">
              {CATS.map((c) => (
                <Chip key={c.id} active={category === c.id} onClick={() => { setCategory(c.id); }}>
                  {c.icon} {c.label}
                </Chip>
              ))}
              <Chip active={category === "other"} onClick={() => setCategory("other")}>
                ✏️ Other
              </Chip>
            </div>
            {category === "other" && (
              <Input className="mt-2.5" value={customCategory} onChange={(e) => setCustomCategory(e.target.value)} placeholder="Type your category…" />
            )}
          </div>

          <div>
            <Label>Pay *</Label>
            <div className="flex gap-2">
              <div className="flex flex-1 items-center gap-1.5 rounded-2xl border border-line bg-white px-4">
                <span className="text-ink-soft">$</span>
                <input value={pay} onChange={(e) => setPay(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" inputMode="decimal" className="w-full bg-transparent py-3 text-[15px] outline-none" />
              </div>
              {(["flat", "hourly"] as const).map((t) => (
                <Chip key={t} active={payType === t} onClick={() => setPayType(t)}>
                  {t === "flat" ? "Flat" : "/hr"}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <Label>Location *</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Austin, TX or Remote" />
          </div>

          <div>
            <Label>Description *</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the job in detail…" />
          </div>

          <div>
            <Label>Photos (optional)</Label>
            <div className="flex flex-wrap gap-3">
              {files.map((f, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(f)} alt="" className="size-20 rounded-xl object-cover" />
                  <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))} className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border-2 border-white bg-urgent text-white">
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {files.length < 6 && (
                <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary bg-white text-primary">
                  <ImagePlus className="size-5" />
                  <span className="text-[11px] font-bold">Add</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])].slice(0, 6))}
                  />
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
            className={classNames(
              "w-full rounded-2xl border-2 py-3.5 text-center text-sm font-bold transition",
              urgent ? "border-urgent bg-urgent-light text-urgent" : "border-[#FCA5A5] bg-white text-urgent",
            )}
          >
            {urgent ? "⚡ Marked as Urgent — Needed ASAP" : "Mark as Urgent (optional)"}
          </button>

          {!valid && <p className="text-center text-sm text-ink-muted">* Fill in all required fields to post</p>}

          <Button fullWidth size="lg" loading={posting} disabled={!valid} onClick={post}>
            Post Gig
          </Button>
        </div>
      </PageContainer>
    </div>
  );
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
