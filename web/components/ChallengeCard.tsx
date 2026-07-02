"use client";

import { Check, Trophy } from "lucide-react";
import { classNames } from "@/lib/format";
import type { Challenge } from "@/lib/user";

// Per-challenge progress card — web mirror of mobile src/components/ChallengeCard.js.
export default function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const pct = Math.min(100, Math.round((challenge.progress / challenge.target) * 100));
  const done = pct >= 100;

  return (
    <div
      className={classNames(
        "rounded-2xl p-4 shadow-[var(--shadow-card)] ring-1",
        done ? "bg-success-light ring-success/40" : "bg-white ring-line/70",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none">{challenge.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{challenge.title}</p>
          <p className="mt-0.5 text-xs text-ink-soft">{challenge.description}</p>
        </div>
        <span
          className={classNames(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold",
            done ? "bg-success/10 text-success" : "bg-primary-light text-primary",
          )}
        >
          {done && <Check className="size-3" />}
          {done ? "Done" : challenge.type === "daily" ? "Daily" : "Weekly"}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
          <div
            className={classNames("h-full rounded-full transition-all", done ? "bg-success" : "bg-primary")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={classNames("w-9 shrink-0 text-right text-xs font-bold", done ? "text-success" : "text-primary")}>
          {pct}%
        </span>
      </div>

      <div className="mt-2.5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 rounded-full bg-gold-light px-2.5 py-0.5 text-[11px] font-extrabold text-accent-deep">
          <Trophy className="size-3" /> +{challenge.xpReward} XP
        </span>
        <span className={classNames("text-xs", done ? "font-bold text-success" : "font-semibold text-ink-muted")}>
          {done ? "Complete!" : `${challenge.progress} / ${challenge.target}`}
        </span>
      </div>
    </div>
  );
}
