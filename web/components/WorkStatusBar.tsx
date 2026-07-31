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
    // One elevation mechanism: shadow, no ring. (Stacking both was the tell.)
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="mb-2 text-[13px] font-semibold text-ink-muted">Your work status</p>
      {/* A grid, not four flex-1 buttons: at 320-360px each button was ~70px, so
          "Ready to work" wrapped to three lines while "Busy" stayed on one and the
          row went ragged. Two-up on phones gives every label real width, and the
          grid keeps all four cells the same height at any width.
          The four-up step is a CONTAINER query (`<main>` is the @container), not
          `sm:` — this card is reused, and a viewport query would go four-up off the
          window size even when the card sits in a narrow column, which is the exact
          ragged wrap described above. `@2xl` (672px) is where `sm:` used to fire on
          a sidebar-less window, and matches the four-cell grid on the profile page. */}
      <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
        {WORK_STATUSES.map((s: { id: string; label: string; emoji: string }) => {
          const active = s.id === workStatus;
          return (
            <button
              key={s.id}
              onClick={() => pick(s.id, s.label)}
              className={classNames(
                "flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-[11px] font-semibold leading-[14px] transition",
                // The fill alone carries the active state — a filled pill needs no
                // elevation, and the old shadow here was the purple-glow token.
                active
                  ? "border-primary bg-primary text-white"
                  : "border-line bg-white text-ink-soft hover:border-primary hover:text-primary",
              )}
            >
              <span className="text-base leading-none">{s.emoji}</span>
              <span className="line-clamp-2 w-full text-center">{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
