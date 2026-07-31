"use client";

import { useEffect } from "react";
import { useUser } from "@/lib/user";

// Achievement / event toast driven by UserContext.pendingToast (mirror of the
// mobile AchievementToast). Auto-dismisses after a few seconds.
export default function Toast() {
  const { pendingToast, dismissToast } = useUser();

  useEffect(() => {
    if (!pendingToast) return;
    const t = setTimeout(dismissToast, 3800);
    return () => clearTimeout(t);
  }, [pendingToast, dismissToast]);

  if (!pendingToast) return null;

  return (
    // The layout viewport extends under the iOS status bar (layout.tsx sets
    // viewportFit: "cover"), so a flat `top-4` put the toast partly behind the
    // notch in a standalone/PWA window. Every other fixed element in the shell
    // compensates for its inset; this was the only top-anchored one that didn't.
    // z-60 sits one step above the overlay layer (modals + assistant panel at
    // z-50) — a toast fired from inside a sheet has to be readable.
    <div className="pointer-events-none fixed inset-x-0 top-[calc(1rem+env(safe-area-inset-top))] z-[60] flex justify-center px-4">
      <div
        className="pointer-events-auto flex w-full max-w-md cursor-pointer items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-soft)]"
        role="status"
        onClick={dismissToast}
      >
        {pendingToast.icon && (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-canvas text-xl">
            {pendingToast.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold tracking-[-0.2px] text-ink">{pendingToast.title}</p>
          {pendingToast.message && (
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-[18px] text-ink-soft">{pendingToast.message}</p>
          )}
        </div>
      </div>
    </div>
  );
}
