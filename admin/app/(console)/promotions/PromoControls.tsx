"use client";

import { useState, useTransition } from "react";
import ReauthPrompt from "../ReauthPrompt";
import { useStepUp } from "../useStepUp";
import { createPromotion, setPromotionStatus, mintCodes, editPromotion, clonePromotion, previewCost, type ActionResult, type CostEstimate, revokeGrant } from "./actions";
import { PRESETS, type Preset } from "./presets";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function Result({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  return <span className={`text-xs ${r.ok ? "text-green-700" : "text-red-600"}`}>{r.message}</span>;
}

export function CreatePromotion() {
  const stepUp = useStepUp();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [kind, setKind] = useState("fee_override");
  // Prefill state, so a preset can populate the form and still be edited before it is
  // created. Presets are a starting point, never a commitment — everything lands as a
  // draft either way.
  const [pre, setPre] = useState<Preset["fields"] | null>(null);
  const [chosen, setChosen] = useState<Preset | null>(null);
  const apply = (p: Preset) => { setChosen(p); setPre(p.fields); setKind(p.fields.kind); setEstimate(null); };

  // Live cost preview. Recomputed from the form on every change, through the SAME SQL
  // the charge path uses — so what this says and what the campaign bills cannot drift.
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [typicalGig, setTypicalGig] = useState("50");
  const [estPending, startEst] = useTransition();
  const refreshEstimate = (form: HTMLFormElement | null) => {
    if (!form) return;
    const fd = new FormData(form);
    fd.set("typical_gig", typicalGig);
    startEst(async () => setEstimate(await previewCost(fd)));
  };

  const input = "rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-sm";

  return (
    <form
      className="mt-4 rounded-xl border border-[var(--line)] bg-white p-4"
      onChange={(e) => refreshEstimate(e.currentTarget)}
      action={(fd) => start(async () => setResult(await stepUp.run(() => createPromotion(fd))))}
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
          {/* step is a VALIDITY constraint, not just the spinner increment: the browser
              only accepts min + (n x step). step="10" with min="1" made the valid
              budgets 1, 11, 21 ... 491, 501 — so a round 500 was rejected with
              "the two nearest valid values are 491 and 501". Whole dollars, any amount. */}
          <input key={`bd${chosen?.key ?? ""}`} name="budget_dollars" type="number" step="1" min="1" defaultValue={pre?.budget_dollars ?? 250} className={`${input} w-24`} required />
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
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
      </div>
      {/* WHAT WILL THIS COST. Answered before activating, rather than discovered from
          the burn-down bar two weeks later. */}
      <div className="mt-3 rounded-lg bg-[var(--surface)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
          <span>On a typical gig of $</span>
          <input
            value={typicalGig}
            onChange={(e) => { setTypicalGig(e.target.value.replace(/[^0-9]/g, "")); }}
            onBlur={(e) => refreshEstimate(e.currentTarget.form)}
            className="w-14 rounded border border-[var(--line)] px-1.5 py-0.5 text-xs"
          />
          {estPending && <span>calculating…</span>}
        </div>
        {estimate ? (
          <div className="mt-1.5 text-sm">
            <strong>{money(estimate.perUseCents)}</strong>
            <span className="text-[var(--muted)]"> per use · </span>
            <strong>{money(estimate.maxTotalCents)}</strong>
            <span className="text-[var(--muted)]"> if fully redeemed</span>
            <div className="mt-0.5 text-xs text-[var(--muted)]">{estimate.note}</div>
          </div>
        ) : (
          <div className="mt-1 text-xs text-[var(--muted)]">
            Change any field to see what this campaign would cost.
          </div>
        )}
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
  const stepUp = useStepUp();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const fire = (next: string) =>
    start(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("status", next);
      setResult(await stepUp.run(() => setPromotionStatus(fd)));
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
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
    </div>
  );
}

export function MintCodes({ id }: { id: string }) {
  const stepUp = useStepUp();
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
              setResult(await stepUp.run(() => mintCodes(fd)));
            })
          }
          className="rounded bg-[var(--surface)] px-2 py-1 text-xs font-medium disabled:opacity-40"
        >
          Mint
        </button>
      </div>
      <Result r={result} />
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
    </div>
  );
}

// Edit a live campaign: rename, top up the budget, raise the cap, extend the run.
//
// Top-up and extend are the two operations you actually reach for — a campaign that is
// working and about to expire, or one that exhausted its budget mid-launch. Neither was
// possible without SQL. Extend is expressed in DAYS FROM NOW rather than as a date,
// because "give it another two weeks" is the real thought and a date picker makes you
// do the arithmetic yourself.
export function EditPromotion({
  promo,
}: {
  promo: { id: string; name: string; budget_cents: number; spent_cents: number; max_redemptions: number };
}) {
  const stepUp = useStepUp();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [open, setOpen] = useState(false);
  const input = "rounded-lg border border-[var(--line)] px-2 py-1 text-xs";

  if (!open) {
    return (
      <div className="flex gap-2">
        <button type="button" onClick={() => setOpen(true)} className="text-xs text-[var(--brand)] underline">
          edit
        </button>
        <CloneButton id={promo.id} />
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-1"
      action={(fd) => start(async () => setResult(await stepUp.run(() => editPromotion(fd))))}
    >
      <input type="hidden" name="id" value={promo.id} />
      <div className="flex flex-wrap items-end gap-1.5">
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
          Name
          <input name="name" defaultValue={promo.name} className={`${input} w-36`} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
          Budget $
          {/* Same step-as-constraint bug as the create form, but worse here: the min was
              a raw float (spent_cents/100), so the valid budgets were 3.47, 13.47,
              23.47 … and almost no round number could be typed at all. Whole dollars,
              floored at what the campaign has already spent — rounded UP so the min
              lands on a whole dollar and stays reachable with step=1. */}
          <input name="budget_dollars" type="number" step="1" min={Math.ceil(promo.spent_cents / 100)}
                 defaultValue={promo.budget_cents / 100} className={`${input} w-20`} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
          Max uses
          <input name="max_redemptions" type="number" min="1" defaultValue={promo.max_redemptions} className={`${input} w-16`} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-[var(--muted)]">
          Extend (days)
          <input name="extend_days" type="number" step="1" defaultValue="0" className={`${input} w-16`} />
        </label>
        <button type="submit" disabled={pending} className="rounded bg-[var(--brand)] px-2 py-1 text-xs font-medium text-white disabled:opacity-40">
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-[var(--muted)] underline">
          cancel
        </button>
      </div>
      <span className="text-[10px] text-[var(--muted)]">
        Budget can&rsquo;t go below the ${(promo.spent_cents / 100).toFixed(2)} already committed.
      </span>
      <Result r={result} />
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
    </form>
  );
}

function CloneButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const stepUp = useStepUp();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          const fd = new FormData();
          fd.set("id", id);
          setResult(await stepUp.run(() => clonePromotion(fd)));
        })}
        className="text-xs text-[var(--brand)] underline disabled:opacity-40"
      >
        clone
      </button>
      <Result r={result} />
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
    </>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Revoking one person's grant.
//
// revokeGrant has existed and been correct since the promotions system shipped — it
// demands a reason because "this takes something away from a named person" — and it had
// ZERO callers. An admin could mint codes and grant a promotion directly to a list of
// users, and then had no way to take one back: pausing the campaign stops NEW claims and
// does nothing about someone already holding a grant.
//
// The reason field is required by the server action, so it is required here too rather
// than being sent empty and bouncing.
// ─────────────────────────────────────────────────────────────────────────────
export function RevokeGrant({ grantId }: { grantId: string }) {
  const stepUp = useStepUp();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-[var(--muted)] underline hover:text-[var(--ink)]"
      >
        Revoke
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="why?"
          className="w-40 rounded border border-[var(--line)] px-1.5 py-1 text-xs"
        />
        <button
          type="button"
          disabled={pending || !reason.trim()}
          onClick={() =>
            start(async () => {
              const fd = new FormData();
              fd.set("grantId", grantId);
              fd.set("reason", reason.trim());
              setResult(await stepUp.run(() => revokeGrant(fd)));
            })
          }
          className="rounded bg-[var(--ink)] px-2 py-1 text-xs font-semibold text-white disabled:opacity-40"
        >
          {pending ? "…" : "Revoke"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-[var(--muted)]">
          cancel
        </button>
      </div>
      {result ? (
        <span className={`text-xs ${result.ok ? "text-green-700" : "text-red-700"}`}>{result.message}</span>
      ) : null}
      {/* This one renders its own result inline rather than via <Result>, so it needed the
          prompt added by hand. Without it the operator hits stale_mfa on a revoke and has
          no way forward — a step-up with no recovery path is worse than no step-up, which
          is the argument useStepUp's own header makes. */}
      {stepUp.needed && <ReauthPrompt onVerified={stepUp.retry} onCancel={stepUp.cancel} />}
    </div>
  );
}
