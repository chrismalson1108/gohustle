"use client";

import { Check, Trophy } from "lucide-react";
import { classNames } from "@/lib/format";
import type { Challenge } from "@/lib/user";

// Per-challenge progress card — web mirror of mobile src/components/ChallengeCard.js.
//
// One decorated element only: the Daily/Weekly/Done pill. The card used to carry
// FOUR (emoji, type pill, gold XP pill, coloured percentage) plus a fully tinted
// surface in the done state, inside ~110px of height. The XP reward is now plain
// text and the progress bar is the card's single accent.
export default function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const pct = Math.min(100, Math.round((challenge.progress / challenge.target) * 100));
  const done = pct >= 100;

  return (
    // White at every state — completion reads from the pill's check + the green
    // bar, not from repainting the whole surface. Shadow, no ring.
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-2xl leading-none">{challenge.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold tracking-[-0.2px] text-ink">{challenge.title}</p>
          <p className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-ink-soft">{challenge.description}</p>
        </div>
        <span
          className={classNames(
            "inline-flex shrink-0 items-center gap-1 self-start rounded-lg px-2 py-1 text-[11px] font-semibold",
            done ? "bg-success-light text-success" : "bg-canvas text-ink-muted",
          )}
        >
          {done && <Check className="size-3 shrink-0" />}
          {done ? "Done" : challenge.type === "daily" ? "Daily" : "Weekly"}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-divider">
          <div
            className={classNames("h-full rounded-full transition-all", done ? "bg-success" : "bg-primary")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span
          className={classNames(
            "w-9 shrink-0 text-right text-xs font-semibold",
            done ? "text-success" : "text-ink-soft",
          )}
        >
          {pct}%
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        {/* Plain text, not a gold pill — the bar above is the card's one accent. */}
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-ink-muted">
          <Trophy className="size-3 shrink-0" /> +{challenge.xpReward} XP
        </span>
        <span
          className={classNames(
            "min-w-0 truncate text-right text-xs font-semibold",
            done ? "text-success" : "text-ink-soft",
          )}
        >
          {done ? "Complete!" : `${challenge.progress} / ${challenge.target}`}
        </span>
      </div>
    </div>
  );
}
