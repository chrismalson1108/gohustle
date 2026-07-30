"use client";

import { useState } from "react";
import { Target, Pencil } from "lucide-react";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { classNames, money } from "@/lib/format";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

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
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
      <div className="flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-full bg-primary-light text-primary">
          <Target className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-black text-ink">Weekly goals</p>
          <p className="text-xs text-ink-muted">Your pace this week</p>
        </div>
        <button
          onClick={openEdit}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold text-ink-muted transition hover:bg-line/60 hover:text-primary"
        >
          <Pencil className="size-3.5" /> Edit
        </button>
      </div>

      <div className="mt-3 space-y-3.5">
        {[
          { label: "Earnings", value: money(earningsWeek), max: money(weeklyEarningGoal), pct: earningPct, barCls: "bg-accent" },
          { label: "Jobs done", value: String(weeklyJobsDone), max: `${weeklyJobsGoal} gigs`, pct: jobsPct, barCls: "bg-primary" },
        ].map((g) => (
          <div key={g.label}>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold text-ink-soft">{g.label}</span>
              <span className="text-sm font-black text-ink">
                {g.value} <span className="font-bold text-ink-muted">of {g.max}</span>
              </span>
            </div>
            <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-line">
              <div className={classNames("h-full rounded-full transition-all", g.barCls)} style={{ width: `${Math.round(g.pct * 100)}%` }} />
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
        <label className="text-sm font-bold text-ink-soft">Earnings goal ($)</label>
        <Input
          type="number"
          inputMode="numeric"
          value={earningDraft}
          onChange={(e) => setEarningDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveGoals()}
          autoFocus
          className="mt-1.5"
        />
        <label className="mt-4 block text-sm font-bold text-ink-soft">Jobs goal</label>
        <Input
          type="number"
          inputMode="numeric"
          value={jobsDraft}
          onChange={(e) => setJobsDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveGoals()}
          className="mt-1.5"
        />
      </Modal>
    </div>
  );
}
