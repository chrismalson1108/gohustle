"use client";

import { useState } from "react";
import { Target, Pencil } from "lucide-react";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { money } from "@/lib/format";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

// Weekly goals — earnings + jobs-done progress bars with an edit modal.
//
// Lifted out of the My Jobs page so the profile hub's Progress pane can mount it:
// mobile moved goals & challenges off the earner hub and into the You tab, and web
// follows. Everything is derived from context, so both mount points stay in sync.
export default function WeeklyGoalsCard() {
  const { earningsWeek, weeklyEarningGoal, weeklyJobsGoal, setGoals, showToast } = useUser();
  const { bookings } = useJobs();

  const [editing, setEditing] = useState(false);
  const [earningDraft, setEarningDraft] = useState(String(weeklyEarningGoal));
  const [jobsDraft, setJobsDraft] = useState(String(weeklyJobsGoal));

  // Jobs done counts work that actually FINISHED this week (mutual completion or
  // verified), derived from bookings — not the old apply-time counter, which
  // advanced the moment a gig was booked. Week starts Monday (mirror of mobile).
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const weeklyJobsDone = bookings.filter(
    (b) =>
      (b.status === "completed" || b.status === "verified") &&
      b.completedAt &&
      new Date(b.completedAt).getTime() >= weekStart.getTime(),
  ).length;

  const earningPct = weeklyEarningGoal > 0 ? Math.min(1, earningsWeek / weeklyEarningGoal) : 0;
  const jobsPct = weeklyJobsGoal > 0 ? Math.min(1, weeklyJobsDone / weeklyJobsGoal) : 0;

  const openEdit = () => {
    setEarningDraft(String(weeklyEarningGoal));
    setJobsDraft(String(weeklyJobsGoal));
    setEditing(true);
  };

  const saveGoals = () => {
    // Invalid input falls back to the current goal rather than zeroing it.
    const eg = Math.round(Number(earningDraft)) > 0 ? Math.round(Number(earningDraft)) : weeklyEarningGoal;
    const jg = Math.round(Number(jobsDraft)) > 0 ? Math.round(Number(jobsDraft)) : weeklyJobsGoal;
    setGoals(eg, jg);
    setEditing(false);
    showToast({ icon: "🎯", title: "Goals updated", message: `Aiming for ${money(eg)} and ${jg} gigs this week.` });
  };

  return (
    // Shadow, no ring — one elevation mechanism per surface.
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5">
        {/* Plain muted glyph, not a tinted puck: the progress bars are this
            card's only accent. */}
        <Target className="size-5 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold tracking-[-0.2px] text-ink">Weekly goals</p>
          <p className="truncate text-xs text-ink-muted">Your pace this week</p>
        </div>
        <button
          onClick={openEdit}
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-2 text-xs font-semibold text-ink-muted transition hover:text-primary"
        >
          <Pencil className="size-3.5 shrink-0" /> Edit
        </button>
      </div>

      <div className="mt-4 space-y-4">
        {/* Both bars are bg-primary. Two brand colours in one card (gold Earnings
            vs purple Jobs done) broke the one-accent-per-card rule; the metrics
            are told apart by their labels, not by hue. */}
        {[
          { label: "Earnings", value: money(earningsWeek), max: money(weeklyEarningGoal), pct: earningPct },
          { label: "Jobs done", value: String(weeklyJobsDone), max: `${weeklyJobsGoal} gigs`, pct: jobsPct },
        ].map((g) => (
          <div key={g.label}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{g.label}</span>
              <span className="shrink-0 text-[13px] font-bold text-ink">
                {g.value} <span className="font-medium text-ink-muted">of {g.max}</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-divider">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.round(g.pct * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit weekly goals"
        size="sm"
        footer={
          <Button fullWidth size="lg" onClick={saveGoals}>
            Save goals
          </Button>
        }
      >
        <Label htmlFor="weekly-earning-goal">Earnings goal ($)</Label>
        <Input
          id="weekly-earning-goal"
          type="number"
          inputMode="numeric"
          value={earningDraft}
          onChange={(e) => setEarningDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveGoals()}
          autoFocus
        />
        <Label htmlFor="weekly-jobs-goal" className="mt-4">
          Jobs goal
        </Label>
        <Input
          id="weekly-jobs-goal"
          type="number"
          inputMode="numeric"
          value={jobsDraft}
          onChange={(e) => setJobsDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveGoals()}
        />
      </Modal>
    </div>
  );
}
