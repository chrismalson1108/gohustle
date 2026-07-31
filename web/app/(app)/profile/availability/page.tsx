"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Clock, GraduationCap } from "lucide-react";
import { DAYS, fmtTime } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import { listClasses, addClass, deleteClass, type ClassRow } from "@/lib/schedule";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import WorkStatusBar from "@/components/WorkStatusBar";
import Button from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";

export default function AvailabilityPage() {
  const { user } = useAuth();
  const { availability, setAvailability, showToast } = useUser();

  // ── Availability windows ──
  const [day, setDay] = useState(1);
  const [start, setStart] = useState("15:00");
  const [end, setEnd] = useState("20:00");

  const addWindow = () => {
    if (start >= end) {
      showToast({ icon: "⚠️", title: "Check the times", message: "End must be after start." });
      return;
    }
    setAvailability([...availability, { day, start, end }]);
  };
  const removeWindow = (i: number) => setAvailability(availability.filter((_, idx) => idx !== i));

  // ── Class schedule ──
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [cTitle, setCTitle] = useState("");
  const [cDays, setCDays] = useState<number[]>([]);
  const [cStart, setCStart] = useState("10:00");
  const [cEnd, setCEnd] = useState("11:00");

  useEffect(() => {
    if (user) listClasses(user.id).then(setClasses).catch(() => {});
  }, [user?.id]);

  const toggleDay = (d: number) => setCDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));

  const saveClass = async () => {
    if (!cTitle.trim() || cDays.length === 0 || !user) return;
    if (cStart >= cEnd) {
      showToast({ icon: "⚠️", title: "Check the times", message: "End must be after start." });
      return;
    }
    try {
      await addClass(user.id, { title: cTitle.trim(), days: [...cDays].sort(), start_time: cStart, end_time: cEnd });
      setClasses(await listClasses(user.id));
      setCTitle("");
      setCDays([]);
      showToast({ icon: "📚", title: "Class added" });
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't add class", message: "Please try again." });
    }
  };

  const removeClass = async (id: string) => {
    try {
      await deleteClass(id);
      setClasses((cs) => cs.filter((c) => c.id !== id));
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't delete", message: "Please try again." });
    }
  };

  return (
    <div>
      <PageHeader
        title="Availability"
        subtitle="When you can work — Hustlr AI uses this to match gigs"
        width="form"
        back="/profile"
      />
      <PageContainer width="form" className="space-y-4 pb-8">
        <WorkStatusBar />

        {/* Availability windows */}
        <section className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
          <p className="mb-1 flex items-center gap-2 text-base font-bold tracking-[-0.2px] text-ink">
            <Clock className="size-4 shrink-0 text-ink-muted" /> Weekly availability
          </p>
          <p className="mb-3 text-[13px] leading-[18px] text-ink-muted">
            Add the times you&apos;re free to work each week.
          </p>

          {availability.length > 0 ? (
            <div className="mb-3 space-y-1.5">
              {availability.map((w, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-xl bg-canvas px-3 py-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-ink">
                    {DAYS[w.day]} · {fmtTime(w.start)}–{fmtTime(w.end)}
                  </span>
                  <button
                    onClick={() => removeWindow(i)}
                    aria-label="Remove"
                    // An explicit 44px box, not padding around a 16px glyph: padding
                    // alone got this to 36px. `-m-2` pulls the extra 8px back out of
                    // the layout so the row keeps its height and the icon stays put —
                    // the negative margin is for layout only, it does NOT enlarge a
                    // hit area, which is why the box is sized outright.
                    className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-urgent"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-sm text-ink-muted">No availability set yet.</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Select value={day} onChange={(e) => setDay(Number(e.target.value))} className="w-auto min-w-0">
              {DAYS.map((d, i) => (
                <option key={i} value={i}>{d}</option>
              ))}
            </Select>
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-auto min-w-0" />
            <span className="shrink-0 text-sm text-ink-muted">to</span>
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-auto min-w-0" />
            <Button size="sm" onClick={addWindow}>
              <Plus className="size-4 shrink-0" /> Add
            </Button>
          </div>
        </section>

        {/* Class schedule */}
        <section className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
          <p className="mb-1 flex items-center gap-2 text-base font-bold tracking-[-0.2px] text-ink">
            <GraduationCap className="size-4 shrink-0 text-ink-muted" /> Class schedule
          </p>
          <p className="mb-3 text-[13px] leading-[18px] text-ink-muted">
            Your classes block the times you can&apos;t work.
          </p>

          {classes.length > 0 ? (
            <div className="mb-3 space-y-1.5">
              {classes.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 rounded-xl bg-canvas px-3 py-2">
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-semibold text-ink">{c.title}</span>{" "}
                    <span className="text-ink-muted">
                      {(c.days || []).map((d) => DAYS[d]).join("/")} · {fmtTime(c.start_time)}–{fmtTime(c.end_time)}
                    </span>
                  </span>
                  <button
                    onClick={() => removeClass(c.id)}
                    aria-label="Remove"
                    // Same 44px box as the remove-window button above.
                    className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-urgent"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-sm text-ink-muted">No classes added yet.</p>
          )}

          <Input
            value={cTitle}
            onChange={(e) => setCTitle(e.target.value)}
            placeholder="Class name (e.g. CS 101)"
            className="mb-2 w-full"
          />
          {/* Wraps rather than sitting in seven fixed columns: `Wednesday` in a 1/7th
              column clips on a narrow phone, and each chip clears the 44px touch
              minimum in BOTH axes — `min-w-11` alone only floors the width, which
              left these ~36px tall. The height floor is `min-h-11` with the label
              centred, not more vertical padding. */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => (
              <button
                key={i}
                onClick={() => toggleDay(i)}
                aria-pressed={cDays.includes(i)}
                className={`flex min-h-11 min-w-11 grow basis-11 items-center justify-center rounded-full px-2.5 text-[11px] font-semibold transition ${
                  cDays.includes(i) ? "bg-primary text-white" : "bg-canvas text-ink-soft hover:text-ink"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="time" value={cStart} onChange={(e) => setCStart(e.target.value)} className="w-auto min-w-0" />
            <span className="shrink-0 text-sm text-ink-muted">to</span>
            <Input type="time" value={cEnd} onChange={(e) => setCEnd(e.target.value)} className="w-auto min-w-0" />
            <Button size="sm" onClick={saveClass} disabled={!cTitle.trim() || cDays.length === 0}>
              <Plus className="size-4 shrink-0" /> Add class
            </Button>
          </div>
        </section>
      </PageContainer>
    </div>
  );
}
