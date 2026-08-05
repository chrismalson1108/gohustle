"use client";

import { useState, useTransition } from "react";
import { promoteCategory, renameCategory, mergeCategory, type ActionResult } from "./actions";

export interface GroupOption {
  key: string;
  label: string;
}

// Curation is only offered on user-created rows. Everything else is either seeded (its
// label lives in shared/categories.js, which the apps prefer over the DB) or already
// merged/reserved, so an edit here would look applied and change nothing.
export default function CurationControls({
  slug,
  label,
  groupKey,
  status,
  groups,
  isAdmin,
}: {
  slug: string;
  label: string;
  groupKey: string;
  status: string;
  groups: GroupOption[];
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [nextLabel, setNextLabel] = useState(label);
  const [nextGroup, setNextGroup] = useState(groupKey);
  const [target, setTarget] = useState("");

  if (status !== "community") {
    return <span className="text-xs text-[var(--muted)]">curated in shared/categories.js</span>;
  }
  if (!isAdmin) {
    return <span className="text-xs text-[var(--muted)]">curation requires the admin role</span>;
  }

  function fire(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string>) {
    const fd = new FormData();
    fd.set("slug", slug);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    start(async () => setResult(await action(fd)));
  }

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)]"
        >
          Curate
        </button>
        {result && (
          <span className={`max-w-xs text-right text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
            {result.message}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-md rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Curate</span>
        <button onClick={() => setOpen(false)} className="text-xs text-[var(--muted)] underline">
          Close
        </button>
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <label className="text-xs text-[var(--muted)]">Promote to canonical</label>
          <div className="mt-1 flex gap-2">
            <select
              value={nextGroup}
              onChange={(e) => setNextGroup(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-2 py-1.5 text-xs"
            >
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => fire(promoteCategory, { groupKey: nextGroup })}
              disabled={pending}
              className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Promote
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs text-[var(--muted)]">Rename</label>
          <div className="mt-1 flex gap-2">
            <input
              value={nextLabel}
              onChange={(e) => setNextLabel(e.target.value)}
              maxLength={32}
              className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-2 py-1.5 text-xs"
            />
            <button
              onClick={() => fire(renameCategory, { label: nextLabel })}
              disabled={pending || !nextLabel.trim() || nextLabel.trim() === label}
              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Rename
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs text-[var(--muted)]">Merge into</label>
          <div className="mt-1 flex gap-2">
            <input
              value={target}
              // The datalist is rendered once by the page, not per row — 200 categories
              // times every row would be tens of thousands of DOM nodes.
              list="category-merge-targets"
              onChange={(e) => setTarget(e.target.value)}
              placeholder="category name or slug"
              className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-2 py-1.5 text-xs"
            />
            <button
              onClick={() => {
                if (!confirm(`Fold "${label}" into "${target.trim()}"? Existing gigs move with it.`)) return;
                fire(mergeCategory, { target: target.trim() });
              }}
              disabled={pending || !target.trim()}
              className="rounded-lg border border-[var(--danger)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--danger)] disabled:opacity-50"
            >
              Merge
            </button>
          </div>
        </div>
      </div>

      {result && (
        <p className={`mt-3 text-xs ${result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>{result.message}</p>
      )}
    </div>
  );
}
