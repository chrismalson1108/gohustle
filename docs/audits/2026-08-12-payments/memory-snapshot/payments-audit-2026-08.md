---
name: payments-audit-2026-08
description: "Aug 2026 read-only adversarial payments audit — 72 findings, 6 root causes, phased fix plan; NOTHING fixed yet"
metadata: 
  node_type: memory
  type: project
  originSessionId: 595777bc-69e6-4966-9ddb-23ca486aa728
  modified: 2026-08-12T17:34:01.554Z
---

Read-only adversarial audit of the whole money layer completed **2026-08-12** (61 Opus 5
agents, 22 dimensions, two workflows). **72 findings survived refutation, ~14 severe.
Nothing has been fixed** — the user explicitly scoped this round to find + plan only.

Plan artifact: https://claude.ai/code/artifact/e1795d7e-21a9-4766-9482-b9ba648b774d

**Verdict:** the core escrow path is sound — no way found to create money, steal platform
funds, or charge a party an amount they didn't agree to; no RLS/IDOR gap on any money
table. Losses are forgone margin, misreported budgets, unpaid workers, and detection that
lies. Not ready for the live-key cutover.

**Six root causes** (fix the pattern, not the 72 instances):
1. `create or replace` drift — last definition in timestamp order wins; `pin_booking_amount`
   is redefined 9×. Caused the two worst findings and the July escrow drain.
2. Check-then-act across an I/O boundary (tip caps, accept-vs-cancel, concurrent captures).
3. Everything that reverses money is keyed on `payments` — tips and bonuses have no row
   there, so reversal is structurally blind to them.
4. Four controls that cannot fire while reporting green.
5. Budget accounting measures the wrong quantity — both ledger sides written consistently
   wrong, so no bookkeeping-vs-bookkeeping control sees it.
6. Console audit-after-mutate + missing step-up on `/promotions`.

**Worst two, both hand-verified by me:**
- `ctl_escrow_hold_expiring_work_done` (20260806150000) silently dropped the `earner_done`
  predicate and swapped `'confirmed'`→`'verified'`; a verified booking is already captured
  so `p.status='authorized'` never holds. The ghosted-poster population it exists for is
  excluded twice over. Live, up to $10k/event, every sweep green.
- `settle_booking_benefits` (20260806220000, sole definition) has no `kind` filter and
  prices poster discounts with a fee-rate counterfactual that is always 0, refunding the
  whole discount to the campaign at capture. Found independently by 4 dimensions.

**Key constraints for the fix rounds:** no Docker on this machine → no local Supabase, so
runtime verification needs a **branch database** or Stripe test mode; parsed-off-disk tests
are the primary defence (see [[categories-taxonomy-2026-08]]). Budget ~13% fix-induced
regressions — July fixed 54 findings and introduced 7. Re-audit must be a FRESH workflow
run, never `resumeFromRunId` (cached prompts would replay old findings against new code).
Audit agents stay read-only — see [[audit-agents-read-only]].

Related: [[payments-architecture]], [[prelaunch-audit-2026-07]], [[ship-when-green]]
