import type { getLevelInfo } from "@gohustlr/shared";

type LevelInfo = ReturnType<typeof getLevelInfo>;

// XP progress toward the next level. `dark` for use on gradient headers.
export default function XPBar({ levelInfo, xp, dark = false }: { levelInfo: LevelInfo; xp: number; dark?: boolean }) {
  const { current, next, progress } = levelInfo;
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs font-bold">
        <span className={dark ? "text-white" : "text-ink"} style={{ color: dark ? undefined : current.color }}>
          Lv {current.level} · {current.label}
        </span>
        <span className={dark ? "text-white/70" : "text-ink-muted"}>
          {next ? `${xp} / ${next.minXP} XP` : `${xp} XP · MAX`}
        </span>
      </div>
      <div className={`h-2 w-full overflow-hidden rounded-full ${dark ? "bg-white/25" : "bg-line"}`}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: dark ? "#ffffff" : current.color }}
        />
      </div>
    </div>
  );
}
