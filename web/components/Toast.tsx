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
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
      <div
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-[var(--shadow-pop)] ring-1 ring-line"
        role="status"
        onClick={dismissToast}
      >
        {pendingToast.icon && <span className="text-2xl">{pendingToast.icon}</span>}
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-ink">{pendingToast.title}</p>
          {pendingToast.message && (
            <p className="truncate text-xs text-ink-soft">{pendingToast.message}</p>
          )}
        </div>
      </div>
    </div>
  );
}
