import type { getLevelInfo } from "@gohustlr/shared";

type LevelInfo = ReturnType<typeof getLevelInfo>;

// XP progress toward the next level — web mirror of src/components/XPBar.js.
//
// The five per-level hues that used to tint the label and the fill (LEVELS in
// shared/constants.js: #94A3B8 / #4F46E5 / #6D28D9 / #F59E0B / #EF4444) are gone.
// None of them exists in the brand palette and #6D28D9 is the PRE-rebrand purple,
// so the bar was quietly reintroducing the old identity. A level is communicated
// by its name ("Lv 5 · Hustle Legend"), never by a hue.
export default function XPBar({
  levelInfo,
  xp,
}: {
  levelInfo: LevelInfo;
  xp: number;
  /** Retired: headers are flat now, so there is no dark surface to sit on.
   *  Accepted-and-ignored so existing call sites don't need to change. */
  dark?: boolean;
}) {
  const { current, next, progress } = levelInfo;
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div>
      {/* flex-wrap + min-w-0/truncate: at 320px "Lv 5 · Hustle Legend" and
          "1450 / 2000 XP" used to collide and push out of the card. */}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
          Lv {current.level} · {current.label}
        </span>
        <span className="shrink-0 text-xs font-medium text-ink-muted">
          {next ? `${xp} / ${next.minXP} XP` : `${xp} XP · MAX`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-divider">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
