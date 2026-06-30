"use client";

import { WORK_STATUSES } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { classNames } from "@/lib/format";

// Compact "ready to work / busy / away / offline" toggle. Posters see this signal
// on the user's profile and gig rows.
export default function WorkStatusBar() {
  const { workStatus, setWorkStatus, showToast } = useUser();

  const pick = (id: string, label: string) => {
    if (id === workStatus) return;
    setWorkStatus(id as ReturnType<typeof useUser>["workStatus"]);
    showToast({ icon: "📣", title: "Status updated", message: `You're now "${label}".` });
  };

  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Your work status</p>
      <div className="flex gap-1">
        {WORK_STATUSES.map((s: { id: string; label: string; emoji: string }) => {
          const active = s.id === workStatus;
          return (
            <button
              key={s.id}
              onClick={() => pick(s.id, s.label)}
              className={classNames(
                "flex flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-2 text-[11px] font-bold transition",
                active
                  ? "bg-primary text-white shadow-[var(--shadow-soft)]"
                  : "bg-canvas text-ink-soft hover:bg-primary-light/40",
              )}
            >
              <span className="text-base leading-none">{s.emoji}</span>
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
