"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Target, Pencil, TrendingUp, Check } from "lucide-react";
import { computeGoalPlan, rankGigsForGoal } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs, computeEffectivePay } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { money, classNames } from "@/lib/format";
import { bookingNetDollars } from "@gohustlr/shared";
import Button from "@/components/ui/Button";
import type { Booking } from "@/lib/types";
import { Input } from "@/components/ui/Field";

// Pace reads as plain coloured text, not a fourth filled pill — mirrors mobile's
// MoneyGoalCard fg colours. The progress bar is this card's one accent.
const PACE = {
  reached: { label: "Goal reached 🎉", cls: "text-success" },
  ahead: { label: "Ahead of pace", cls: "text-success" },
  onTrack: { label: "On track", cls: "text-ink-soft" },
  behind: { label: "Behind pace", cls: "text-urgent" },
  unset: { label: "Set a goal", cls: "text-ink-muted" },
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
    // Net of the platform fee — this card tracks progress toward what the earner
    // actually RECEIVES, and the gross list price overstates that by the fee. Mobile
    // has done this since the fee-net goal fix; web was left on gross, so the same
    // account read $45 here and $41 in the app at the same moment.
    //
    // Gross comes from amount_cents_quoted, the amount PINNED to the booking at insert
    // (20260806000000) and the figure the charge itself derives from, so the goal card
    // and the payout cannot disagree.
    //
    // This previously used the raw list pay, which for an hourly gig is the RATE — a
    // 4-hour $50/hr job counted as $50. The mobile card had the identical bug and was
    // fixed first; this is the same fix, kept in step deliberately, because the whole
    // point of the card is that both platforms show one number.
    const grossDollars = (b: Booking) =>
      b.amountCentsQuoted != null ? b.amountCentsQuoted / 100 : computeEffectivePay(b);
    const vals = paid
      .map((b) => bookingNetDollars(grossDollars(b), b.feeBpsQuoted))
      .filter((v) => v > 0);
    const earnedThisMonth = vals.reduce((s, v) => s + v, 0);

    // Average gig value: this month, else any verified booking, else $40.
    let avg = vals.length ? earnedThisMonth / vals.length : 0;
    if (!avg) {
      const anyPaid = bookings
        .filter((b) => b.status === "verified" || b.status === "completed")
        .map((b) => bookingNetDollars(grossDollars(b), b.feeBpsQuoted))
        .filter((v) => v > 0);
      avg = anyPaid.length ? anyPaid.reduce((s, v) => s + v, 0) / anyPaid.length : 40;
    }

    const p = computeGoalPlan({
      monthlyGoal: monthlyEarningGoal,
      earnedThisMonth,
      avgGigValue: avg,
      gigsThisMonth: vals.length,
    });

    const open = jobs.filter((j) => j.posterId !== user?.id);
    const ranked = rankGigsForGoal(open, {
      skills,
      remaining: p.remaining,
      myBookings: bookings,
    }).slice(0, 3);
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
    // Shadow, no ring — one elevation mechanism per surface.
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5">
        {/* Plain muted glyph, not a tinted puck. */}
        <Target className="size-5 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold tracking-[-0.2px] text-ink">Money goal</p>
          <p className="truncate text-xs text-ink-muted">
            {plan.daysLeft} {plan.daysLeft === 1 ? "day" : "days"} left this month
          </p>
        </div>
        <span className={classNames("shrink-0 text-[11px] font-semibold", pace.cls)}>{pace.label}</span>
      </div>

      {/* Goal + progress */}
      <div className="mt-4">
        {editing ? (
          // flex-wrap + a flexible input: the label, a fixed w-28 field and the
          // save button together outran the card interior at 320px, and would do
          // so again the moment this card sits in a narrower column.
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-[13px] font-medium text-ink-soft">Monthly goal $</span>
            <Input
              type="number"
              inputMode="numeric"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveGoal()}
              autoFocus
              className="w-24 min-w-0 flex-1 px-3 py-2 font-semibold sm:w-28 sm:flex-none"
            />
            {/* size-11, not size-9 — 36px is under the 44px touch minimum. */}
            <Button size="sm" onClick={saveGoal} aria-label="Save goal" className="size-11 shrink-0 px-0">
              <Check className="size-4" />
            </Button>
          </div>
        ) : (
          <button
            onClick={() => { setDraft(String(monthlyEarningGoal || 1000)); setEditing(true); }}
            className="flex max-w-full flex-wrap items-baseline gap-x-2 text-left"
          >
            <span className="min-w-0 truncate text-[26px] font-bold leading-tight tracking-[-0.4px] text-ink">
              {money(plan.earned)}
            </span>
            <span className="min-w-0 truncate text-[13px] font-medium text-ink-muted">of {money(plan.goal)}</span>
            <Pencil className="size-3.5 shrink-0 text-ink-muted" />
          </button>
        )}
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-divider">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>

      {/* Plan stats — three across at every width, as on mobile. The value drops
          to 15px and truncates so a "$1,250" money string can't burst a ~93px
          tile on a 360px phone. */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {[
          { label: "Left to go", value: money(plan.remaining) },
          { label: "Gigs to go", value: plan.gigsNeeded == null ? "—" : String(plan.gigsNeeded) },
          { label: "Per week", value: money(plan.perWeekNeeded) },
        ].map((s) => (
          <div key={s.label} className="min-w-0 rounded-xl bg-canvas px-2 py-3 text-center">
            <p className="truncate text-[15px] font-bold text-ink">{s.value}</p>
            <p className="mt-1 truncate text-[11px] text-ink-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Goal-matched gigs */}
      {picks.length > 0 && plan.status !== "reached" && (
        <div className="mt-4 border-t border-divider pt-4">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-muted">
            <TrendingUp className="size-3.5 shrink-0" /> Best gigs to hit your goal
          </p>
          <div className="space-y-2">
            {picks.map((j) => (
              <Link
                key={j.id}
                href={`/jobs/${j.id}`}
                className="flex items-center justify-between gap-2 rounded-xl bg-canvas px-3 py-3 transition hover:bg-divider"
              >
                <span className="min-w-0 truncate text-sm font-medium text-ink">{j.title}</span>
                <span className="shrink-0 text-sm font-bold text-ink">{money(j.pay)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
