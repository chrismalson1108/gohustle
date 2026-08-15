# Payments audit — 2026-08-12

Read-only adversarial audit of the entire money layer: Stripe escrow paths, fee and
incentive arithmetic, promotions, referrals, the controls engine, and admin money
authority. **61 Opus 5 agents across 22 dimensions. 72 findings survived adversarial
refutation, ~14 severe.**

**Nothing in this directory has been applied.** No code was changed, no migration was
pushed, no edge function was deployed. This is find-and-plan output only.

This directory exists because the machine that produced it was being reset — everything
here otherwise lived in a temp dir and in `~/.claude/`, both of which a wipe destroys.

---

## Start here

| File | What it is |
|---|---|
| `remediation-plan.html` | **The plan.** Verdict, six root causes, severe findings, phased fix order with deploy vectors and ordering hazards, test protocol, re-audit protocol. Open it in a browser. |
| `reports/payments-core.md` | Full report — Stripe money paths and fee math (29 findings). |
| `reports/incentives-and-abuse.md` | Full report — promotions, referrals, credits, tiers, controls, admin authority, fraud economics (43 findings). |
| `reports/findings-*.json` | Machine-readable findings with mechanism, trigger, cent-level money impact, evidence, and fix sketch. |

The plan is also published as an artifact:
<https://claude.ai/code/artifact/e1795d7e-21a9-4766-9482-b9ba648b774d>

---

## Verdict in one paragraph

The core escrow path is sound. No agent found a way to create money, steal platform
funds, or charge a party an amount they never agreed to on the main flow, and there is no
RLS or IDOR gap on any money table — every defect needs a legitimate role or an unlucky
ordering, never a privilege bypass. The losses are forgone margin, misreported budgets,
unpaid workers, and detection that cannot be trusted. **Not ready for the live-key
cutover.**

The two worst findings, both hand-verified against the final function definitions:

1. **`ctl_escrow_hold_expiring_work_done` was silently gutted.** `20260806150000` meant
   only to re-anchor the control's clock; it dropped the `earner_done` predicate and
   swapped `'confirmed'` for `'verified'`. A verified booking is already captured, so
   `p.status = 'authorized'` can never hold for it — the ghosted-poster population the
   control exists for is excluded twice over. Live today, full gig value per event, and
   every hourly sweep reports green.

2. **`settle_booking_benefits` is kind-blind.** It prices poster discounts with a fee-rate
   counterfactual that is always exactly zero (because `consume_poster_discount` stores
   the booking's *own* pinned rate), so the entire discount is credited back to the
   campaign at capture. `budget_cents` stops bounding the loss. Found independently by
   four separate dimensions — the strongest confidence signal in the set.

---

## `draft-fixes/` — NOT APPLIED, NOT VALIDATED

Two candidate migrations and two regression tests written by the exploit-stage agents.
They are written in the house style and look plausible, but **they have not been reviewed,
executed, or applied**, and they are deliberately kept outside `supabase/migrations/` so
`supabase db push --linked` cannot pick them up.

⚠️ **Both migrations carry the identical timestamp `20260812070000`.** Resolve that
collision before either is ever moved into `supabase/migrations/` — as-is their apply
order is ambiguous.

Treat these as a starting point for Phase 2, not as a shippable change.

---

## `workflows/` — how to re-run the audit

Two workflow scripts, re-runnable via the Workflow tool:

```
Workflow({ scriptPath: "docs/audits/2026-08-12-payments/workflows/payments-core-audit.js" })
```

⚠️ **Invoke them fresh. Never pass `resumeFromRunId`.** Resume replays cached results for
unchanged prompts — and after a fix round the prompts will be unchanged while the code has
changed, so a resumed run would confidently report the old findings against the new code.

Both scripts carry an explicit read-only constraint in every agent prompt. Keep it. A
round-1 agent in a previous audit disabled a live security control through the admin
console and it stayed off for hours unnoticed, because a disabled control reports neither
errors nor staleness.

---

## `memory-snapshot/` — restore on the new machine

Claude Code's per-project memory, which lives outside the repo and does not survive a
machine reset. To restore:

```bash
mkdir -p ~/.claude/projects/-Users-chrismalson-Documents-gohustle/memory
cp docs/audits/2026-08-12-payments/memory-snapshot/*.md \
   ~/.claude/projects/-Users-chrismalson-Documents-gohustle/memory/
```

That path is derived from the project's absolute location. It is correct only if the repo
sits at `/Users/chrismalson/Documents/gohustle` on the new Mac too. If you put it
somewhere else, the directory name changes to match the new path.

`MEMORY.md` is the index loaded each session; the rest are one fact per file.

---

## Environment constraints that shape the fix rounds

- **No Docker on this machine**, so there is no local Supabase and migrations cannot be
  dry-run locally. Runtime verification needs a **Supabase branch database** or **Stripe
  test mode**. This is why parsed-off-disk tests carry so much weight in the plan.
- **`gohustlr-admin` does not auto-deploy.** Pushing a migration without
  `cd admin && npx vercel --prod` half-deploys several of the fixes — and for the admin
  login throttle, that exact half-deployed state *is* the bug.
- **Budget ~13% fix-induced regressions.** July fixed 54 findings and introduced 7. Two of
  the findings in this report are regressions from earlier fix rounds.

---

## Known stale documentation (Phase 5 in the plan)

These root-level docs contradict the current code and will mislead the next audit:

- `KNOWN_RISKS.md`, `BETA_QA_PLAN.md`, `LIFECYCLE_STATE_MACHINES.md`, `PRODUCT_FLOW_MAP.md`
  all still describe a hardcoded 10% platform fee at line numbers that no longer exist,
  and flag "verify the web constant equals the backend 10%" as an open risk. That entire
  class was closed by the `platform_rates` work — the fee is now data, pinned per booking.
- `CLAUDE.md` states the test suite is 34 suites / 433 tests; it is **39 suites / 494
  tests**. It also states an admin login throttle exists — the audit found it has zero
  callers, so no lockout exists at all.
