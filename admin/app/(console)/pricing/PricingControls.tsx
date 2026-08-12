"use client";

import { useState, useTransition } from "react";
import { setPlatformRate, setTier, grantToUsers, saveTier, deleteTier, type ActionResult } from "./actions";

function Result({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return <span className={`text-xs ${r.ok ? "text-green-700" : "text-red-600"}`}>{r.message}</span>;
}

export function SetRate({ current }: { current: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const input = "rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-sm";
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      action={(fd) => start(async () => setResult(await setPlatformRate(fd)))}
    >
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        New rate %
        <input name="fee_pct" type="number" step="0.5" min="5" max="30" defaultValue={current / 100} className={`${input} w-24`} required />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        Effective from
        <input name="effective_from" type="datetime-local" className={input} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        Why
        <input name="note" placeholder="e.g. margin review Q3" className={`${input} w-56`} required />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        Type CHANGE RATE
        <input name="confirm" placeholder="CHANGE RATE" className={`${input} w-36`} required />
      </label>
      <button type="submit" disabled={pending} className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
        {pending ? "Setting…" : "Set rate"}
      </button>
      <Result r={result} />
    </form>
  );
}

export function TierToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [on, setOn] = useState(enabled);
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set("id", id);
            fd.set("enabled", on ? "0" : "1");
            const r = await setTier(fd);
            setResult(r);
            if (r.ok) setOn(!on);
          })
        }
        className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-40 ${on ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}`}
      >
        {on ? "live" : "off"}
      </button>
      <Result r={result} />
    </div>
  );
}

export function GrantDirect({ promos }: { promos: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  if (!promos.length) {
    return <p className="mt-2 text-xs text-[var(--muted)]">Create a promotion first.</p>;
  }
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      action={(fd) => start(async () => setResult(await grantToUsers(fd)))}
    >
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        Promotion
        <select name="promotionId" className="rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-sm">
          {promos.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--muted)]">
        Emails or usernames
        <textarea name="emails" rows={2} placeholder="one@school.edu, two@school.edu" className="min-w-[18rem] rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-sm" />
      </label>
      <button type="submit" disabled={pending} className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
        {pending ? "Granting…" : "Grant"}
      </button>
      <Result r={result} />
    </form>
  );
}

// Inline tier editor. Every field is editable — name, threshold, rate, note — because
// a ladder you can only switch on and off is a ladder you cannot tune, and tuning is
// the entire point of a retention mechanic.
export function TierEditor({
  tier,
}: {
  tier?: { id: string; name: string; min_completed: number; fee_bps: number; note: string | null };
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [open, setOpen] = useState(!tier);
  const input = "rounded-lg border border-[var(--line)] px-2 py-1 text-xs";

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-[var(--brand)] underline">
        edit
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-1.5"
      action={(fd) => start(async () => { const r = await saveTier(fd); setResult(r); if (r.ok && !tier) setOpen(false); })}
    >
      {tier && <input type="hidden" name="id" value={tier.id} />}
      <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
        Name
        <input name="name" defaultValue={tier?.name ?? ""} className={`${input} w-28`} required />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
        After N gigs
        <input name="min_completed" type="number" min="0" max="10000" defaultValue={tier?.min_completed ?? 10} className={`${input} w-20`} required />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
        Fee %
        <input name="fee_pct" type="number" step="0.5" min="0" max="30" defaultValue={(tier?.fee_bps ?? 900) / 100} className={`${input} w-16`} required />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
        Note
        <input name="note" defaultValue={tier?.note ?? ""} className={`${input} w-44`} />
      </label>
      <button type="submit" disabled={pending} className="rounded bg-[var(--brand)] px-2 py-1 text-xs font-medium text-white disabled:opacity-40">
        {pending ? "Saving…" : tier ? "Save" : "Add tier"}
      </button>
      {tier && <DeleteTier id={tier.id} />}
      {tier && (
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-[var(--muted)] underline">
          cancel
        </button>
      )}
      <Result r={result} />
    </form>
  );
}

function DeleteTier({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          const fd = new FormData();
          fd.set("id", id);
          setResult(await deleteTier(fd));
        })}
        className="rounded border border-[var(--line)] px-2 py-1 text-xs text-red-700 disabled:opacity-40"
      >
        Delete
      </button>
      <Result r={result} />
    </>
  );
}
