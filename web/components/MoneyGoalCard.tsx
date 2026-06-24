"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Target, Pencil, TrendingUp, Check } from "lucide-react";
import { computeGoalPlan, rankGigsForGoal } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { money, classNames } from "@/lib/format";

const PACE = {
  reached: { label: "Goal reached 🎉", cls: "bg-success/15 text-success" },
  ahead: { label: "Ahead of pace", cls: "bg-success/15 text-success" },
  onTrack: { label: "On track", cls: "bg-primary-light text-primary" },
  behind: { label: "Behind pace", cls: "bg-urgent/10 text-urgent" },
  unset: { label: "Set a goal", cls: "bg-line text-ink-muted" },
} as const;

function isThisMonth(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export default function MoneyGoalCard() {
  const { user } = useAuth();
  const { monthlyEarningGoal, skills, setMonthlyGoal, showToast } = useUser();
  const { bookings, jobs } = useJobs();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(monthlyEarningGoal || 1000));

  const { plan, picks } = useMemo(() => {
    const paid = bookings.filter(
      (b) => (b.status === "verified" || b.status === "completed") && isThisMonth(b.completedAt),
    );
    const vals = paid.map((b) => b.counterOffer ?? b.job?.pay ?? 0).filter((v) => v > 0);
    const earnedThisMonth = vals.reduce((s, v) => s + v, 0);

    // Average gig value: this month, else any verified booking, else $40.
    let avg = vals.length ? earnedThisMonth / vals.length : 0;
    if (!avg) {
      const anyPaid = bookings
        .filter((b) => b.status === "verified" || b.status === "completed")
        .map((b) => b.counterOffer ?? b.job?.pay ?? 0)
        .filter((v) => v > 0);
      avg = anyPaid.length ? anyPaid.reduce((s, v) => s + v, 0) / anyPaid.length : 40;
    }

    const p = computeGoalPlan({
      monthlyGoal: monthlyEarningGoal,
      earnedThisMonth,
      avgGigValue: avg,
      gigsThisMonth: vals.length,
    });

    const open = jobs.filter((j) => j.status === "open" && j.posterId !== user?.id);
    const ranked = rankGigsForGoal(open, { skills, remaining: p.remaining }).slice(0, 3);
    return { plan: p, picks: ranked };
  }, [bookings, jobs, monthlyEarningGoal, skills, user?.id]);

  const pace = PACE[plan.status as keyof typeof PACE] ?? PACE.unset;
  const pct = Math.round(plan.pctComplete * 100);

  const saveGoal = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0));
    if (n > 0) {
      setMonthlyGoal(n);
      showToast({ icon: "🎯", title: "Goal updated", message: `Aiming for ${money(n)} this month.` });
    }
    setEditing(false);
  };

  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
      <div className="flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-full bg-primary-light text-primary">
          <Target className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-black text-ink">Money goal</p>
          <p className="text-xs text-ink-muted">{plan.daysLeft} days left this month</p>
        </div>
        <span className={classNames("rounded-full px-2.5 py-1 text-[11px] font-bold", pace.cls)}>{pace.label}</span>
      </div>

      {/* Goal + progress */}
      <div className="mt-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-ink-soft">Monthly goal $</span>
            <input
              type="number"
              inputMode="numeric"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveGoal()}
              autoFocus
              className="w-28 rounded-xl border border-line bg-canvas px-3 py-1.5 text-sm font-bold text-ink outline-none focus:border-primary"
            />
            <button onClick={saveGoal} className="flex size-8 items-center justify-center rounded-full bg-primary text-white">
              <Check className="size-4" />
            </button>
          </div>
        ) : (
          <button onClick={() => { setDraft(String(monthlyEarningGoal || 1000)); setEditing(true); }} className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-ink">{money(plan.earned)}</span>
            <span className="text-sm font-bold text-ink-muted">of {money(plan.goal)}</span>
            <Pencil className="size-3.5 text-ink-muted" />
          </button>
        )}
        <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>

      {/* Plan stats */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: "Left to go", value: money(plan.remaining) },
          { label: "Gigs to go", value: plan.gigsNeeded == null ? "—" : String(plan.gigsNeeded) },
          { label: "Per week", value: money(plan.perWeekNeeded) },
        ].map((s) => (
          <div key={s.label} className="rounded-xl bg-canvas px-2 py-2 text-center">
            <p className="text-base font-black text-ink">{s.value}</p>
            <p className="text-[11px] text-ink-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Goal-matched gigs */}
      {picks.length > 0 && plan.status !== "reached" && (
        <div className="mt-3 border-t border-divider pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink-soft">
            <TrendingUp className="size-3.5 text-primary" /> Best gigs to hit your goal
          </p>
          <div className="space-y-1.5">
            {picks.map((j) => (
              <Link
                key={j.id}
                href={`/jobs/${j.id}`}
                className="flex items-center justify-between gap-2 rounded-xl bg-canvas px-3 py-2 transition hover:bg-primary-light/40"
              >
                <span className="min-w-0 truncate text-sm font-semibold text-ink">{j.title}</span>
                <span className="shrink-0 text-sm font-black text-primary">{money(j.pay)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
