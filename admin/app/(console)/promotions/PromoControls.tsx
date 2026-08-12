"use client";

import { useState, useTransition } from "react";
import { createPromotion, setPromotionStatus, mintCodes, type ActionResult } from "./actions";
import { PRESETS, type Preset } from "./presets";

function Result({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return <span className={`text-xs ${r.ok ? "text-green-700" : "text-red-600"}`}>{r.message}</span>;
}

export function CreatePromotion() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [kind, setKind] = useState("fee_override");
  // Prefill state, so a preset can populate the form and still be edited before it is
  // created. Presets are a starting point, never a commitment — everything lands as a
  // draft either way.
  const [pre, setPre] = useState<Preset["fields"] | null>(null);
  const [chosen, setChosen] = useState<Preset | null>(null);
  const apply = (p: Preset) => { setChosen(p); setPre(p.fields); setKind(p.fields.kind); };

  const input = "rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-sm";

  return (
    <form
      className="mt-4 rounded-xl border border-[var(--line)] bg-white p-4"
      action={(fd) => start(async () => setResult(await createPromotion(fd)))}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Start from a preset</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => apply(p)}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              chosen?.key === p.key
                ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                : "border-[var(--line)] hover:border-[var(--brand)]"
            }`}
          >
            {p.label}
            <span className="ml-1.5 opacity-60">
              {p.side === "earner" ? "→ students" : p.side === "poster" ? "→ posters" : "→ both"}
            </span>
          </button>
        ))}
      </div>
      {chosen && (
        <p className="mt-2 rounded-lg bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed text-[var(--muted)]">
          {chosen.why}
        </p>
      )}

      <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">New promotion</div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Name
          <input key={`n${chosen?.key ?? ""}`} name="name" defaultValue={pre?.name ?? ""} placeholder="UCLA launch" className={`${input} w-48`} required />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Type
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={input}>
            <option value="fee_override">Reduced fee</option>
            <option value="poster_discount">Poster discount</option>
            <option value="bonus">Referral bonus</option>
          </select>
        </label>

        {kind === "fee_override" ? (
          <>
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              Fee %
              <input key={`f${chosen?.key ?? ""}`} name="fee_pct" type="number" step="0.5" min="0" max="30" defaultValue={pre?.fee_pct ?? 0} className={`${input} w-20`} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              Gigs covered
              <input key={`u${chosen?.key ?? ""}`} name="uses_allowed" type="number" min="1" max="20" defaultValue={pre?.uses_allowed ?? 2} className={`${input} w-20`} />
            </label>
          </>
        ) : kind === "poster_discount" ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            Discount $
            <input key={`d${chosen?.key ?? ""}`} name="discount_dollars" type="number" step="1" min="1" max="500" defaultValue={pre?.discount_dollars ?? 10} className={`${input} w-20`} />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            Bonus $
            <input key={`b${chosen?.key ?? ""}`} name="bonus_dollars" type="number" step="1" min="1" max="500" defaultValue={pre?.bonus_dollars ?? 10} className={`${input} w-20`} />
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Budget $
          <input key={`bd${chosen?.key ?? ""}`} name="budget_dollars" type="number" step="10" min="1" defaultValue={pre?.budget_dollars ?? 250} className={`${input} w-24`} required />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Max uses
          <input key={`m${chosen?.key ?? ""}`} name="max_redemptions" type="number" min="1" defaultValue={pre?.max_redemptions ?? 100} className={`${input} w-20`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Runs for (days)
          <input key={`dy${chosen?.key ?? ""}`} name="days" type="number" min="1" max="365" defaultValue={pre?.days ?? 30} className={`${input} w-24`} />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? "Creating…" : "Create draft"}
        </button>
        <Result r={result} />
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Created as a <strong>draft</strong> — nothing spends until you activate it. A
        &ldquo;0% fee&rdquo; still collects card processing (~2.9% + 30&cent;), so a free
        gig is never a loss; the budget is charged only the margin actually given up.
        <br />
        <strong>Reduced fee reaches students only</strong> — the poster&rsquo;s price
        doesn&rsquo;t move, because the fee comes out of the earner&rsquo;s payout. To
        reach posters use a <strong>poster discount</strong>: the earner still receives
        their full agreed pay and you absorb it from margin. Discounts are capped at the
        margin available on each gig — on a $100 job at 10% that is <strong>$6.55</strong>.
      </p>
    </form>
  );
}

export function StatusButtons({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const fire = (next: string) =>
    start(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("status", next);
      setResult(await setPromotionStatus(fd));
    });
  const btn =
    "rounded-lg border border-[var(--line)] px-2 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-40";
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-1">
        {status !== "active" && (
          <button type="button" className={btn} disabled={pending} onClick={() => fire("active")}>
            Activate
          </button>
        )}
        {status === "active" && (
          <button type="button" className={btn} disabled={pending} onClick={() => fire("paused")}>
            Pause
          </button>
        )}
        {status !== "ended" && (
          <button type="button" className={btn} disabled={pending} onClick={() => fire("ended")}>
            End
          </button>
        )}
      </div>
      <Result r={result} />
    </div>
  );
}

export function MintCodes({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [count, setCount] = useState("10");
  const [seats, setSeats] = useState("1");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          value={count}
          onChange={(e) => setCount(e.target.value)}
          className="w-14 rounded border border-[var(--line)] px-1.5 py-1 text-xs"
          title="how many codes"
        />
        <span className="text-xs text-[var(--muted)]">×</span>
        <input
          value={seats}
          onChange={(e) => setSeats(e.target.value)}
          className="w-14 rounded border border-[var(--line)] px-1.5 py-1 text-xs"
          title="uses per code"
        />
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const fd = new FormData();
              fd.set("promotionId", id);
              fd.set("count", count);
              fd.set("seats", seats);
              setResult(await mintCodes(fd));
            })
          }
          className="rounded bg-[var(--surface)] px-2 py-1 text-xs font-medium disabled:opacity-40"
        >
          Mint
        </button>
      </div>
      <Result r={result} />
    </div>
  );
}
