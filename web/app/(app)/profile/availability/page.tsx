"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2, Clock, GraduationCap } from "lucide-react";
import { DAYS, fmtTime } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import { listClasses, addClass, deleteClass, type ClassRow } from "@/lib/schedule";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import WorkStatusBar from "@/components/WorkStatusBar";
import Button from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";

export default function AvailabilityPage() {
  const router = useRouter();
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
      <PageHeader variant="earn" title="Availability" subtitle="When you can work — Hustlr AI uses this to match gigs" />
      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        <div className="space-y-4">
          <WorkStatusBar />

          {/* Availability windows */}
          <section className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
            <p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
              <Clock className="size-4 text-primary" /> Weekly availability
            </p>
            <p className="mb-3 text-xs text-ink-muted">Add the times you&apos;re free to work each week.</p>

            {availability.length > 0 ? (
              <div className="mb-3 space-y-1.5">
                {availability.map((w, i) => (
                  <div key={i} className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2 text-sm">
                    <span className="font-semibold text-ink">
                      {DAYS[w.day]} · {fmtTime(w.start)}–{fmtTime(w.end)}
                    </span>
                    <button onClick={() => removeWindow(i)} aria-label="Remove" className="text-ink-muted hover:text-urgent">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mb-3 text-sm text-ink-muted">No availability set yet.</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Select value={day} onChange={(e) => setDay(Number(e.target.value))} className="w-auto">
                {DAYS.map((d, i) => (
                  <option key={i} value={i}>{d}</option>
                ))}
              </Select>
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-auto" />
              <span className="text-ink-muted">to</span>
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-auto" />
              <Button size="sm" onClick={addWindow}>
                <Plus className="size-4" /> Add
              </Button>
            </div>
          </section>

          {/* Class schedule */}
          <section className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
            <p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
              <GraduationCap className="size-4 text-primary" /> Class schedule
            </p>
            <p className="mb-3 text-xs text-ink-muted">Your classes block the times you can&apos;t work.</p>

            {classes.length > 0 ? (
              <div className="mb-3 space-y-1.5">
                {classes.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-semibold text-ink">{c.title}</span>{" "}
                      <span className="text-ink-muted">
                        {(c.days || []).map((d) => DAYS[d]).join("/")} · {fmtTime(c.start_time)}–{fmtTime(c.end_time)}
                      </span>
                    </span>
                    <button onClick={() => removeClass(c.id)} aria-label="Remove" className="shrink-0 text-ink-muted hover:text-urgent">
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
            <div className="mb-2 flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <button
                  key={i}
                  onClick={() => toggleDay(i)}
                  className={`rounded-full px-2.5 py-1 text-xs font-bold transition ${
                    cDays.includes(i) ? "bg-primary text-white" : "bg-canvas text-ink-soft hover:bg-primary-light/50"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="time" value={cStart} onChange={(e) => setCStart(e.target.value)} className="w-auto" />
              <span className="text-ink-muted">to</span>
              <Input type="time" value={cEnd} onChange={(e) => setCEnd(e.target.value)} className="w-auto" />
              <Button size="sm" onClick={saveClass} disabled={!cTitle.trim() || cDays.length === 0}>
                <Plus className="size-4" /> Add class
              </Button>
            </div>
          </section>
        </div>
      </PageContainer>
    </div>
  );
}
