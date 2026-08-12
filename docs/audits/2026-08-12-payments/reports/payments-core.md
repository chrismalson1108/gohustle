# GoHustlr Payments Audit — Findings Report
**Date:** 2026-08-12 · **Scope:** static analysis of `supabase/functions/`, `supabase/migrations/`, `admin/`, `src/`, `web/`, `shared/` · **No production system was touched.**

---

## 1. VERDICT

The core escrow path — pin at booking, authorize, capture, credit — is genuinely well built, and I found no way to create money, steal platform funds, or charge a party an amount they did not agree to on the main flow. But the money layer is **not ready for live keys today**: the two subsystems built most recently and least defended, **tips** and **promotions**, both have controls that do not actually bound what they claim to bound, and three settlement-path defects can leave a worker who did real work permanently unpaid.

The single worst thing found is the **tip subsystem**: the per-booking/per-count/per-24h caps are bypassable by simple concurrency (the check is a lock-free read in one transaction, the charge is in the next), and separately **a refunded or charged-back tip is reversed nowhere in the system** — no ledger row, no disputes row, no console path, and `ctl_earnings_total_drift` affirmatively certifies the inflated earner balance as healthy. Tips are a 100% pass-through, zero-fee, daily-payout channel with platform-balance chargeback liability; today it is the one money rail with no working ceiling and no working reconciler.

---

## 2. FINDINGS

Ranked by expected loss (severity × reachability). Deduplicated: the `settle_booking_benefits` defect was reported by three dimensions and appears once (F3); `refund_source` stickiness twice (F9); the accept/cancel race twice (F5); the missing settle in `earner-claim-payment` twice (F15).

---

### F1 — Tip caps are bypassable by concurrency, and the over-cap money erases its own ledger row
**Severity: HIGH** · `supabase/functions/stripe-tip/index.ts:86-96` · `supabase/migrations/20260804000000_tip_caps.sql:99-173`

**Mechanism.** `tip_headroom_cents` is a `stable`, lock-free read that runs in its own transaction and commits *before* the PaymentIntent is created. The advisory locks that serialise the caps live in `trg_guard_tip_caps`, which fires inside `claim_and_credit_tip` — one HTTP round-trip *after* the card has been charged. N concurrent calls with distinct `tipCents` (distinct amounts ⇒ distinct idempotency keys ⇒ genuinely distinct PaymentIntents) all read the same headroom, all pass, and all charge. Then exactly one `tip_ledger` insert commits; the other N−1 hit `raise exception 'tip_cap_*'`, which aborts each transaction and **rolls back its own ledger row**. The over-cap money therefore never counts toward the per-booking total, the count-of-3, or the $500/24h velocity sum — the cap never tightens.

Compounding it: `guard_bookings_write` lets a booking reach `completed` with **no captured payment** (the captured-payment `EXISTS` applies only to `completed → verified`), and `stripe-tip` accepts `completed`. So a colluding pair reaches a tippable booking with a headroom floor of `max(2 × captured, $200) = $200` having paid **nothing**.

**Money impact.** Modelled repro: 100 concurrent calls on one uncaptured booking move **1,995,050¢ ($19,950.50)** to the earner's connected account while `tip_ledger` records 20,000¢. Unconditional platform loss ≈ **60,856¢ (~$609)** of Stripe processing on money the platform never agreed to move and earns nothing on (no `application_fee_amount` on tips, no `on_behalf_of` anywhere, so the platform is merchant of record). Contingent: the full amount plus $15/dispute is chargeback-eligible **against the platform balance** for 30–90 days, after daily payout has already cleared the funds. Detection: 99 `fatal: true` rows land in `client_errors` (a separate service-role transaction that survives the rollback) — but no control and no alert reads that table; its only surface is a console tile a human must open.

**Reachability.** Attacker-only — the shipped clients send one awaited call at a fixed amount, and the idempotency key collapses an accidental double-tap. Needs a `for`-loop against a public function with the attacker's own JWT. There is **no rate limit on `stripe-tip`**.

**Fix.** Make the pre-check a *reservation*: a `reserve_tip_slot(booking, cents, key)` RPC that takes the same two advisory locks and **INSERTs an uncharged `tip_ledger` row** (so the existing trigger evaluates the caps at the moment headroom is consumed — no second copy of the arithmetic), then charge, then `confirm_tip_charge` attaches the PI and credits. Key Stripe idempotency on the reservation id, not on `booking+amount`. Release the reservation on a failed charge; expire abandoned ones on a TTL swept from `controls_sweep_and_page`. On a charged-but-not-credited failure, **refund the PaymentIntent** rather than leaving unrecorded funds in the earner's balance.

---

### F2 — A refunded or charged-back tip is reversed nowhere, and the drift control certifies the inflated balance as correct
**Severity: HIGH** · `supabase/functions/stripe-webhook/index.ts:57-61` · `supabase/migrations/20260806040000_control_library.sql:268-304`

**Mechanism.** Every reversal path is keyed on the `payments` table. Tip PaymentIntents are recorded only in `tip_ledger` — `stripe-tip` never writes a `payments` row — so `recordReversal` looks the PI up in `payments`, misses, and returns `null` before filing anything. No `disputes` row, no debit, no booking attribution. `reconcile-stripe` iterates `payments` rows only, so a tip PI is never retrieved from Stripe by anything, ever. `admin-payment-action` loads a `payments` row *by `booking_id`* before it will act, so there is **no console path to reverse a tip** — and an operator told to "reverse the tip on booking B" will instead refund the **escrow charge** and claw the earner's job pay out of their connected account (`reverse_transfer: true`).

Worst part: `ctl_earnings_total_drift` **adds** every credited tip to `expected` while drawing clawbacks only from `payments.refunded_cents`. A fully reversed tip makes `stored == expected` exactly. The control does not merely miss it — it reports the wrong number as healthy.

**Money impact.** The chargeback loss itself is inherent to card-funded pass-through tips. The **defect** is everything downstream: `profiles.earnings_total`, `bookings.tip_amount`, the earner's dashboard, and `src/lib/payments.js`'s money screen permanently overstate. In the refund-with-`reverse_transfer` variant, the earner is genuinely $X down in their bank while the app still shows the money — with no correction path and no operator handle. Worked example: $200 tip charged back ⇒ platform −21,500¢, earner's app overstates by 20,000¢ forever, all controls green. (Confirmed: the year-end **tax CSV** is *not* affected — `ExpensesScreen.js:99-118` derives income from verified bookings, not `earnings_total`. The `controls` registry text claiming otherwise is stale.)

**Reachability.** Happy path. No attacker, no patched client — an ordinary chargeback or a Dashboard refund on any tip.

**Fix.** Add `reversed_cents` / `reversed_at` to `tip_ledger`. In `recordReversal`, fall back to a `tip_ledger` lookup on `payment_intent_id` when the `payments` lookup misses (the tip PI already carries `metadata.type='tip'` and `metadata.booking_id`), calling a `record_tip_reversal` RPC with **cumulative-target semantics** (pass Stripe's total, debit only the delta — redelivery-safe by construction) that reverses `tip_amount` and `earnings_*` and files the disputes row. **Add a `tip_clawed` CTE to `ctl_earnings_total_drift`** — this is required, not optional: without it every *correctly* handled reversal becomes a false positive. Extend `reconcile-stripe` with a `tip_ledger` loop for the Stripe→DB direction.

---

### F3 — `settle_booking_benefits` prices a flat-cent discount with a fee-rate formula, so `budget_cents` stops bounding poster-discount campaigns
**Severity: HIGH** · `supabase/migrations/20260806220000_benefit_lifecycle.sql:155-197` (sole and final definition)

**Mechanism.** The settle loop selects **every** `promo_redemptions` row for the booking with no `kind` filter and prices each with `promo_benefit_cents`, which is a fee-override counterfactual: `fee(amount, standing_rate) − fee(amount, r.fee_bps)`. For a `poster_discount` row, `consume_poster_discount` stores the **booking's own pinned rate** in `fee_bps` (a flat discount has no rate of its own), so the differential is **0**. `actual = 0`, `delta = −reserved_cents`, and `promotions.spent_cents` is credited back the entire discount on every captured booking — while the poster really was charged less and the platform really absorbed the margin.

This is the same kind-confusion class `20260806340000` fixed *inside* `consume_poster_discount`; the sibling settle function was never touched.

**Money impact.** `budget_cents` only ever constrains concurrently-in-flight discounts; lifetime exposure becomes `max_redemptions × per-use cap`. On the shipped `first_hire_discount` preset (budget $500, 100 redemptions, $10 off) that is **$1,000 against a $500 budget** for gigs ≳ $149. An operator following the documented "small budget, generous redemption count" pattern (the console imposes no upper bound on `max_redemptions`, and `estimate_campaign_cost` prices on a $50 gig where headroom is only 300¢, so it reports slack) is exposed to **$10,000 against a $500 cap**. Silent: the `/promotions` burn-down bar reads **$0.00** for the campaign's life, and `editPromotion`'s "can't lower below what's committed" guard reads the same reset counter, so it is toothless.

Settle-to-zero is only the *common* case. With a loyalty rung enabled, `r.fee_bps < standing`, and the discount settles to the **earner's** tier differential — a number with no relation to the discount, which can land either side of the reserve (on a $1,000 gig at 700 bps it charges **3,000¢ for a 500¢ discount**, burning the budget 6× too fast and silently cutting off posters who hold a valid grant).

No control fires: `reserved == delivered` so `ctl_discount_charged_not_delivered` is quiet; `settled_at` is stamped so `ctl_benefit_never_settled` is quiet; `ctl_redemption_double_charge` computes both `spent_cents` and `reserved_sum` into its detail JSON but its `HAVING` compares only row counts — the reconciliation was written and then not asserted on.

**Reachability.** Deterministic happy path on every captured poster-discount booking. No attacker. One caveat: no shipped client screen calls `redeem_promo_code` yet, so grants are currently issued by hand — the moment that UI ships or a launch campaign is granted, this is one tap away.

**Fix.** Branch on `promotions.kind` inside the loop. For `poster_discount`, the true cost is the discount **delivered** (`bookings.poster_discount_cents`, clamped to the reserve), pro-rated by the captured share. Keep `promo_benefit_cents` for `fee_override` only, and make any unrecognised kind `delta = 0` — **fail closed**; today's default for anything it cannot price is a full refund of the reserve. Add a control asserting `promotions.spent_cents >= sum(reserved_cents)` for settled, unreleased rows.

---

### F4 — Refund idempotency is keyed on the running total, so an operator retry after the 20 s console timeout refunds twice — undetectably
**Severity: HIGH** · `supabase/functions/admin-payment-action/index.ts:154,190` · `admin/app/(console)/bookings/actions.ts:76`

**Mechanism.** The Stripe key is `refund_${pi}_${alreadyRefunded + refundCents}`, where `alreadyRefunded = payments.refunded_cents` — a value that `record_refund` itself advances. There is therefore no window in which retrying is safe in both directions. `callPaymentAction` aborts at 20 s and reports **failure** while the edge function runs to completion; on failure the console does not `revalidatePath` and does not clear the inputs, so the operator sees a red error, their `30.00` still in the box, and a stale "Up to $100.00 refundable" — and clicks again. The retry builds a *different* key and Stripe issues a **second real refund** with `reverse_transfer: true`.

**Money impact.** Worked repro on a $100 captured booking with a $30 partial: two 3,000¢ refunds. The earner is **−2,700¢ twice** (5,400¢ out of their connected balance for a 3,000¢ decision), the platform −300¢ of fee revenue, the poster +3,000¢ they were never awarded. Bounded by remaining refundable balance — up to three duplicates on this example before `over_refund` bites.

**It is invisible afterwards.** Stripe and the DB both end at 6,000¢, so `reconcile-stripe`'s `refund_mismatch` sees a clean match. `ctl_earnings_total_drift` reconstructs the debit from the doubled `refunded_cents` and gets exactly the doubled debit (`round(3000·0.9)·2 == round(6000·0.9)`). The webhook early-returns on `refund_source='admin'`. The only contradicting artifact is the audit log, which says the refund **failed**. The first Stripe refund id exists nowhere in the database.

**Corrections to note:** a *full*-amount refund retry is already blocked (`remaining <= 0` → 409), so this is **partial refunds only**. The `ledger_desync` path is genuinely safe by construction. The `record_reversal` op is **also safe** (it computes `cents = captured − refunded`, so a retry gets 0 → `bad_amount`) — do not report it as a defect, though it should take the op id for uniformity.

**Fix.** Mint a `opId` UUID in the console **per decision** (not per click; re-mint on success or on an amount change, reuse on retry), pass it through, use it as the Stripe idempotency key, and insert it into a new `payment_refunds` table with a **unique index on `op_id`** inside `record_refund` — refusing an anonymous refund (`op_id_required`) and returning `applied: false` on a replay. Record Stripe's `refund.id` too.

---

### F5 — `accept-booking` and `stripe-cancel-payment` both do check-then-act around a Stripe round-trip, producing a confirmed booking behind a dead hold
**Severity: HIGH (conditional)** · `accept-booking/index.ts:65-82` · `stripe-cancel-payment/index.ts:67,99-104`

**Mechanism.** The hold is placed *before* accept (`payments.status='authorized'` with a live `requires_capture` PI while the booking is still `pending`), and `pending` is in `CANCELLABLE_STATUSES`. Both endpoints read state, make a multi-hundred-millisecond Stripe call, then write. `accept-booking`'s payments write has **no status predicate** (contrast the very next statement, which correctly guards the bookings write, and `admin-payment-action:94`, which guards the identical class of write). Two concurrent poster-authenticated calls land a `confirmed` booking against a **canceled** PaymentIntent.

The window is wide, not hairline: accept's blocking Stripe op is a *read*, cancel's is a *write*. Failed attempts are free and unbounded (`isRecovery` lets the poster re-hold and retry; no rate limit, no log).

**Money impact.** $0 in the common case, **18,000¢ on a $200 gig** in the bad one. `stripe-webhook`'s `payment_intent.canceled` handler demotes exactly this state (`confirmed` + `!earner_done`) back to `pending` seconds later — so in practice this is usually a UX defect plus a false "Booking accepted!" push to the earner. **But that heal is the only thing standing between this and free work, and it is an asynchronous third-party callback whose live-mode registration `KNOWN_RISKS.md §8.1` flags as unverified and which does not carry over from test mode.** At the live-key cutover, before events are re-registered, every accept/cancel overlap lands in the unhealed branch — and there the state (booking `confirmed`, payments `cancelled`, PI canceled) is invisible to **every** control: `ctl_settled_without_captured_payment` needs `p.id is null`; `ctl_money_exposed_on_dead_booking` needs the booking declined/cancelled; both `ctl_escrow_hold_*` need `p.status='authorized'`; `reconcile-stripe` check 4b needs `receivedCents > 0`.

**Reachability.** Requires two parallel calls (browser console with the user's own session suffices — both function names are in the shipped web bundle). Not an IDOR: the caller must be the poster. There is also a benign accidental path — `declineBooking` calls `cancelPayment` *while the booking is still pending*, so a poster on two sessions can hit the window.

**Fix.** Use the `payments` row as a CAS token; no migration needed (both status values are already legal). In `accept-booking`, publish the booking transition **first**, then claim the payments row with `.eq('status','authorized').select('id')`, and roll the booking back to `pending` if the claim returns zero rows. In `stripe-cancel-payment`, claim the row **before** the irreversible Stripe call, then re-read the booking and roll the claim back if it is no longer cancellable. **Do not** remove `pending` from `CANCELLABLE_STATUSES` — `declineBooking` depends on it and `__tests__/cancelPaymentContract.test.js:43-49` pins it.

---

### F6 — A redelivered `payment_intent.payment_failed` kills a live hold, and the recovery path then mints a second authorization
**Severity: HIGH** · `supabase/functions/stripe-webhook/index.ts:165-187`

**Mechanism.** The handler's precondition is `.in('status', ['pending','authorized'])`. But `'authorized'` is written at two moments that mean opposite things — optimistically by `stripe-create-payment-intent:405` before the client confirms anything, and by `accept-booking:75` *after* verifying `pi.status === 'requires_capture'` live at Stripe. **No precondition on that column can be correct.** `AcceptPaymentModal` fetches the client secret once per modal open and reuses it for the "use a different card" retry (effect keyed on `[booking?.id]`), so a declined-then-retried card produces a `payment_failed` for a PI that later authorizes for real. If that event's first delivery fails (non-2xx **or timeout** — and the DB writes at `:165-168` have already committed), Stripe redelivers for ~3 days; landing after acceptance it stamps a live $200 hold `'failed'` and demotes the confirmed booking to `pending` (the demotion is not gated on the update having matched a row).

Both settlement paths then hard-refuse (`HOLD_EXPIRED`), which appears in **zero** client files — nothing translates or routes it. And `guard_bookings_write` silently reverts `earner_done` on a `pending` booking without raising, so `markEarnerDone` toasts success and the flag vanishes.

**Money impact.** $180 of completed work unpayable on a $200 gig; the hold lapses at ~7 days and refunds the poster, who receives the work free. Then, if the poster re-accepts: `:307` gates the orphan-hold reconciler on `existingPay.status === 'authorized'`, so a `'failed'` row **skips it entirely** — the old PI is never cancelled, a second is created, and the poster carries **two simultaneous $200 authorizations**. The orphan is referenced by no DB row, so `reconcile-stripe` (which retrieves only PIs a `payments` row names) can never see it again.

**Fix.** Drop `'authorized'` from the allow-list; re-derive truth from Stripe — retrieve the PI and no-op unless its status is `requires_payment_method` / `requires_confirmation` / `canceled`. **Fail closed** on an unretrievable PI (`break`, don't fall through). Gate the booking demotion on `.select('booking_id')` returning a row. Separately, run the orphan-hold reconciler for **any** prior PaymentIntent, not just `'authorized'` ones, and repair a mis-stamped row when the PI is `requires_capture`.

---

### F7 — Both claim time-gates read `payments.created_at`, which a recovery re-hold never updates
**Severity: MEDIUM** · `supabase/functions/earner-claim-payment/index.ts:111-115, 193-201`

**Mechanism.** `20260806150000_authorized_at.sql` added `authorized_at` precisely because `created_at` records the *first* hold, and switched both escrow-age controls to `coalesce(authorized_at, created_at)`. The money gate was never migrated — `grep -rn authorized_at supabase/functions/` returns only the writer. On any re-held booking (webhook-demoted after an expiry, or a `payment_failed` retry days later), the belt-and-suspenders check `Date.now() < created_at + GRACE_MS` evaluates against a timestamp that is by construction 7+ days old.

**Money impact.** The poster loses the intended 3-day window between hold placement and claim — it becomes zero seconds. They cannot run the partial-capture remedy (floored at 50%, so up to half the amount) or file a booking-scoped report that arms the fail-closed gates. No money is created; the amount captured is the pinned, agreed figure on a booking whose slot has passed and which the earner flagged done. The `holdNearlyExpired` anchor is *not* load-bearing — `eligibleAt` (slot + 3 days) has almost always passed already, so `:196` is the single line that matters.

**Fix.** Select `authorized_at, created_at` and use `coalesce(authorized_at, created_at)` for both `holdPlacedAt` and the grace check, matching the two controls the same migration corrected. One-line change, no migration.

---

### F8 — `payment_intent.succeeded` credits the earner from a pre-computed split and never reconciles to `amount_received`
**Severity: MEDIUM** · `supabase/functions/stripe-webhook/index.ts:144-152`

**Mechanism.** The handler stamps `captured` and calls `credit_earnings`, which credits whatever `payments.earner_amount_cents` holds. Neither ever reads `pi.amount_received`. This is the only one of the three credit paths that does not reconcile — `earner-claim-payment:232-290` retrieves the PI, reads `amount_received` and `application_fee_amount`, and rewrites the row *before* crediting, with the comment "STRIPE is the sole source of truth for the amount — we NEVER pre-write a computed amount." `admin-payment-action`'s header names this exact defect as the reason that function exists; the remedy shipped was new console tools, not the reconcile.

**Money impact.** Two reachable sequences. (A) A **Dashboard partial capture** — the console has no capture op, so the Dashboard is the only route — credits $180 against $45 transferred. (B) Entirely in-app: a partial capture at `pct=0.6` whose HTTP response times out (row still `authorized`), followed by a poster retry without `pct`, which recomputes and **persists** the full split at `:208-211` before `capture()` throws — the queued webhook then credits $90 against $54. Ledger-side only (Stripe collected correctly), but `profiles.earnings_*` is the earner's dashboard and the Tax Center income figure. `ctl_earnings_total_drift` cannot catch it — it sums the same wrong value. `reconcile-stripe` check #1 (`TOLERANCE_CENTS = 0`) *does* catch it hourly, but only files a finding and only within a 14-day / 200-row window keyed on `created_at`, which a recovery re-hold preserves.

**Note in the platform's favour:** both in-app capture branches deliberately persist the split *before* calling Stripe so the webhook credits the right number. This is not a happy-path bug.

**Fix.** Compare `pi.amount_received` (already on the event) to `earner_amount_cents + fee_cents`; on disagreement, fetch the charge, rewrite the row from Stripe's numbers, then credit. Fail closed rather than crediting a figure Stripe does not confirm.

---

### F9 — `payments.refund_source='admin'` suppresses the disputes row for genuine chargebacks, disabling the control built to catch them
**Severity: MEDIUM** · `admin-payment-action/index.ts:178` · `stripe-webhook/index.ts:68-71`

**Mechanism.** `recordReversal` early-returns for `refund_source === 'admin'`, and that check is in the **shared** helper — so it suppresses `charge.dispute.created` (a customer chargeback) exactly as it does `charge.refunded` (an admin remediation). The marker is written per-**payment**, before the Stripe call. `ctl_external_reversal_not_ledgered` detects unledgered reversals by INNER-joining precisely the `disputes` rows `recordReversal` declines to write, so the detector goes dark for that payment too.

**Money impact.** Sequence: $10 console refund on a $100 charge → weeks later a $90 chargeback → no disputes row, so no `/disputes` queue entry and no control finding. `refunded_cents` and `debit_earnings` are never corrected; GMV and `admin_dashboard_metrics` overstate permanently. `reconcile-stripe` cannot cover for it — a dispute does not increment `charge.amount_refunded`, so `refund_mismatch` passes cleanly.

**Two things it is not:** the alert still fires (`emailAdmin` is called unconditionally *outside* `recordReversal`), and the blackout is not literally permanent (`record_reversal` overwrites the marker to `'chargeback'`). So this is a **fail-open detection guard** — the automated backstop for a human ignoring the email — not a money-movement defect.

**Fix.** Never suppress on `charge.dispute.created` — a chargeback is never operator-initiated. For `charge.refunded`, key the suppression to the specific Stripe refund id the console created (e.g. `admin_refund_ids text[]`), not to the payment row.

---

### F10 — A vested referral fee credit is consumed in full but delivered in part, and never restored after a partial capture or a reversal
**Severity: MEDIUM** · `supabase/migrations/20260806260000_release_fee_credits.sql:78-84`

**Mechanism.** `consume_fee_credit` flips `bonus_ledger` rows to `'applied'` at booking INSERT. The only restore is `release_booking_benefits`, which runs solely from the `declined`/`cancelled` trigger and early-returns when any payment is captured. Two ordinary outcomes therefore burn 100% of an earned credit: a **partial capture** delivers only `pct` of it (the credit is applied to the full-gig fee basis, then the result is scaled), and a **refund or chargeback** delivers none while the row stays `'applied'` forever pointing at a `verified` booking.

**Money impact.** Up to the full face value of a bonus the earner earned by referring a real person who completed real work; the residual can never be applied to any future booking. `PaymentsScreen.js:417` renders "Fee credit applied + $6.55" from `payments.fee_credit_cents` — the amount *consumed* — on a booking where only part of it reached them. `ctl_credit_stranded_on_dead_booking` requires `declined`/`cancelled` with no captured payment, so it matches neither case.

**Refuted sub-claim:** the "ghosted pending booking holds the credit hostage" variant is **not** a permanent loss — `JobsContext.cancelBooking` lets either party cancel from `pending`, which fires the release trigger. That is a discoverability problem, not a defect.

**Fix.** Settle the credit alongside the promo in `settle_booking_benefits`: split the `bonus_ledger` row and return the undelivered portion to `'payable'`. Extend release to reversal — when `record_refund` brings `refunded_cents` to the captured total, restore pro rata — and broaden the control to match fully-refunded payments.

---

### F11 — The dispute-recording branch is gated on the requested `pct`, not on whether a capture happened
**Severity: MEDIUM** · `supabase/functions/stripe-capture-payment/index.ts:255`

**Mechanism.** The `if (capturePctFinal < 1)` block that inserts the `disputes` row sits **outside** the `if (payment.status !== 'captured')` capture block, and the status gate admits `'verified'`. So a second call on an already-settled booking with `{pct: 0.5, disputeReason}` skips all money movement but still inserts an open disputes row recording `pct_paid = 50`. It is not conditioned on `capturedGigCents !== null` — the flag the `settle` call two blocks above correctly uses.

**Money impact.** Two harms. (a) A **third party** loses vested money: `vest_bonuses` refuses to promote a referral bonus while any open dispute exists on the source booking, so the **referrer** — not a party to this booking, unable to see or contest it — is denied their bonus indefinitely. (b) The disputes row is the audit record support and the earner read (`{pct_paid}% paid`), now asserting the earner was paid 50% of a charge captured and transferred at 100% — exactly the evidence an operator would act on when deciding a refund. Obtainable by any poster with a session token, with no money at stake.

**Fix.** `if (capturedGigCents !== null && capturePctFinal < 1)`, and reject up front with a 409 when `payment.status === 'captured'` and a `pct` was supplied.

---

### F12 — `ctl_stripe_id_mode_mismatch` detects nothing, either way
**Severity: MEDIUM** · `supabase/migrations/20260806350000_controls_always_on.sql:192,199`

**Mechanism.** The control spots test-mode ids after cutover using `length(account_id) < 22` and `length(customer_id) < 19`. Stripe account ids are 21 chars and customer ids 18 chars **in both modes** — the two modes are format-identical — so both predicates are always true. And `app_flags.stripe_mode` is **never seeded** anywhere in `supabase/`, `admin/`, or any runbook; `PRE_LAUNCH_DATA_RESET.md §5` tells the operator to delete the rows and flip the keys without mentioning the flag. With `coalesce(..., 'test')`, both arms are gated on `mode.m = 'live'` and return zero rows forever.

**Money impact.** No money moves wrongly, but the control the registry itself calls the guard for "the single most likely way the live cutover breaks" either sits silently dormant (likely) or fires critical on 100% of legitimate rows (if someone sets the flag) — teaching operators to disable it. Either way it fails open at exactly the moment it was written for.

**Fix.** Length is not a mode signal. Have `reconcile-stripe` (which already holds the key and writes findings) attempt `accounts.retrieve` / `customers.retrieve` on each stored id and file on `resource_missing` — the only test that distinguishes the two universes. Failing that, stamp `stripe_mode` on the row at insert time. **Add the missing `app_flags.stripe_mode` step to the cutover runbook regardless.**

---

### F13 — Settlement is gated on a cached `onboarded` flag with no live re-verification
**Severity: MEDIUM** · `stripe-capture-payment/index.ts:116-125` · `earner-claim-payment/index.ts:205-209`

**Mechanism.** Both refuse with `EARNER_PAYOUTS_DISABLED` on a cached column. The identical live re-check already exists in `stripe-create-payment-intent:117-125` but was not carried to the two paths that have a deadline. The failing state is a **stale-FALSE**: Stripe re-enables the account and nothing server-side refreshes the cache — no cron, no control, and `reconcile-stripe` reads only `payments`.

**Money impact.** The hold ages out at ~7 days and the earner is unpaid; the poster's card is released. The earner-claim leg is largely self-healed (EarnScreen calls `getPayoutStatus()` — a live retrieve that syncs both ways — on mount, and the Claim button lives on that screen; residual is a tab left mounted for days). The surviving leg is **poster-initiated capture**, where the poster's app has no reason to refresh the earner's flag. Not silent: `ctl_escrow_hold_expiring_work_done` matches exactly this shape at 5–8 days and pages hourly, ~2 days before Stripe cancels.

**Fix.** Lift the live re-check into `_shared` as `assertPayoutCapable()`; retrieve, sync the flag both ways, and refuse only if Stripe still says no.

---

### F14 — Two concurrent captures with different `pct` race the pre-capture split write
**Severity: LOW** · `supabase/functions/stripe-capture-payment/index.ts:187,208`

Both branches persist the computed split before calling Stripe with no row lock, no conditional predicate, and no capture-side idempotency key. Whichever capture wins at Stripe leaves the row holding the *other* call's numbers, and `credit_earnings` reads it — crediting the full net against a 50% capture (or, in the symmetric ordering, under-crediting). Corrupts `profiles.earnings_*`, `admin-payment-action`'s refundable ceiling, and Tax Center income. **Adversarial-only and unprofitable** — identical `pct` (a double-tap or client retry) writes identical numbers. The neighbouring `earner-claim-payment` is already immune by reconciling from Stripe after capture, which is exactly the pattern to port.

**Fix.** Claim the capture (`update payments set status='capturing' where id=$1 and status='authorized' returning *`, 409 on zero rows), pass an idempotency key, and reconcile the split from the returned PI's `amount_received` / `application_fee_amount` after capture.

---

### F15 — `earner-claim-payment` never calls `settle_booking_benefits`
**Severity: LOW** · `supabase/functions/earner-claim-payment/index.ts:293`

The reserve-at-booking / settle-at-capture contract is honoured only by `stripe-capture-payment`. The claim path captures, credits, and drives the booking to `verified` without settling, and no trigger covers it (`trg_zz_release_benefits` fires only on `declined`/`cancelled`). The residual **money** delta is essentially zero (the reserve and true cost diverge only on a standing-rate change mid-flight). The real cost is a **permanently open `high`/`money` `ctl_benefit_never_settled` finding per self-settled promoted booking** — a recurring false page that trains operators to ignore a money control — plus wrong `benefit_cents` in campaign reporting.

**Fix.** Mirror the capture path (`p_amount_cents: capturedCents + poster_discount_cents`), non-fatal and logged. **Order matters: fix F3's kind branch first** — adding this call today would import the poster-discount reserve-refund into the one capture path that currently accounts discounts correctly.

---

### F16 — Poster discounts are charged but not disclosed at the moment of consent
**Severity: LOW** · `stripe-create-payment-intent/index.ts:434-442`

The function authorizes `amountCents − discountCents` but returns only `amountCents`, so `AcceptPaymentModal` renders "Hold $100.00 & accept" for a $98.45 authorization — and on web that button text is the only amount the poster sees before authorizing (Stripe's element shows none). Same in the mobile receipt. Error direction is **in the poster's favour**, so nobody is charged more than they agreed, and `PaymentsScreen.js:313,423` *does* render the discount after the fact. Residuals: the discount buys no perceived value at the moment it matters, and the partial-capture figure shown to the poster derives from the pre-discount `heldCents` while capture computes off the discounted authorization (sub-dollar mismatch on a disputed gig).

**Fix.** Return `authorizedCents` and `discountCents`; render the hold from `authorizedCents` with the discount as an explicit line. Expose `poster_discount_cents` so `verifyHeldCents` subtracts it too.

---

### F17 — A no-show report filed from the earner's profile carries no `booking_id`, so the fail-closed claim gate never sees it
**Severity: LOW** · `earner-claim-payment/index.ts:178`

The gate is `.eq('booking_id', bookingId)`, but three report entry points (mobile `PublicProfileScreen`, web `/u/[id]`, mobile `JobDetail`) call `submitReport` without a booking id — and their reason list includes "No-show / did not complete", the exact scenario the gate exists to block. Only the in-chat path sets it. Combined with the removal of the `disputes_insert_party` policy, a poster who reports from the profile screen has armed nothing.

**Fix.** Take only the cheap half: have those screens pass `bookingId` when a booking connects the two users (already in `JobsContext.posterBookings`). **Explicitly reject** widening the server-side gate — that would restore the permanent-payout-block attack `20260726000000` was written to eliminate.

---

### F18 — `recordReversal`'s idempotency key is the charge id, so only the first refund of a charge is ever ledgered
**Severity: LOW** · `stripe-webhook/index.ts:86`

`charge.refunded` fires once per refund, always with the same `charge.id` and a *cumulative* `amount_refunded`. The dedupe is `ilike '%charge.id%'` against the disputes reason text, so later refunds match the existing row and are dropped — and `ctl_external_reversal_not_ledgered` parses the amount out of that frozen string. **Backstopped**, though: `reconcile-stripe` check #4 reads `charge.amount_refunded` directly from Stripe with zero tolerance and files a `refund_mismatch` hourly. The residual gap is only refunds landing outside its 14-day / 200-row window.

**Fix.** Key on the individual Refund id in a dedicated indexed column, or at minimum update the existing row's recorded total when `amount_refunded` exceeds it. (Note: `charge.refunds.data[0].id` is not reliable — that list is expandable/paginated; key off a `refund.created` event instead.)

---

### F19 — `record_reversal` writes a `refunded_cents` Stripe cannot corroborate, manufacturing a critical reconcile finding
**Severity: LOW** · `reconcile-stripe/index.ts:158-169`

A lost chargeback creates no Refund object and does not increment `amount_refunded`, which is why the ledger-only `record_reversal` path exists — but `reconcile-stripe` derives "what Stripe refunded" solely from `amount_refunded`, with `TOLERANCE_CENTS = 0`. Doing the correct thing manufactures a `refund_mismatch` critical on a healthy payment. **Bounded**: the scan window is 14 days / 200 rows, and chargebacks typically arrive at 30–90 days, so most never fire at all; those that do stop being re-asserted once the row ages out and can be resolved by hand. Queue hygiene, not a standing blackout.

**Fix.** Select `refund_source` and exclude `'chargeback'` rows from the mismatch check, covering them with a dedicated check driven by `stripe.disputes.list`.

---

### F20 — `stripe-connect-onboard` creates the Stripe account with no idempotency key and discards the insert error
**Severity: LOW** · `stripe-connect-onboard/index.ts:167,201`

Non-atomic get-or-create; two overlapping POSTs mint two Express accounts, the loser's insert violates the PK silently, and the function still returns an onboarding link for the orphan. The earner completes full KYC on an account no code path can reach. No money is misdirected, and it **self-recovers** on the next call (the function live-retrieves the id the DB actually holds and issues a link for it). Likelihood is low — the button is disabled while in flight and there is no automatic retry.

**Fix.** `{ idempotencyKey: 'connect_acct_' + user.id }` on `accounts.create` (and `'cus_' + user.id` on `customers.create`), `.upsert({onConflict:'user_id'})`, check the error, and link against the winning row.

---

### F21 — The payout gate requires `charges_enabled`, which a destination charge never needs
**Severity: LOW** · `supabase/functions/_shared/connectStatus.ts:129`

`onboarded = details_submitted && charges_enabled && payouts_enabled`. In the destination-charge model the connected account only needs `transfers` — but onboarding requests `card_payments` anyway, importing its entire requirement set into the settlement gate (and forcing the BUSINESS_PROFILE prefill workaround for a capability the platform never exercises). If `card_payments` goes inactive while `transfers` stays active, a payable earner is refused. **How often Stripe actually diverges those two for a US individual Express account is a runtime question I cannot settle from the repo** — that is the only thing separating this from theoretical. Not silent: the stuck hold pages via `ctl_escrow_hold_expiring_work_done`. Worse than stated in one respect: a `restricted`/`pending` earner gets **no account link** (`:123-126`) *and* `NOT_ONBOARDED` from the login link — no path to Stripe at all.

**Fix.** Request `transfers` only; gate on `details_submitted && payouts_enabled && capabilities.transfers === 'active'`; drop the `onboarded` precondition on `stripe-payout-login-link`.

---

### F22 — The assistant's take-home mirror maps a legitimately pinned 0 bps to 10%
**Severity: LOW** · `supabase/functions/assistant/index.ts:1164`

`netOf` coerces with `... && Number(feeBps) > 0`, so a pinned `0` — exactly what a "first 2 gigs free" promotion and a 0% loyalty rung store — falls back to 1000 bps. This is the identical `> 0` vs `>= 0` defect that `safeBps()` in all three money functions was explicitly rewritten to fix; the assistant copy was left behind. Advisory JSON only, and the error is conservative (understates earnings), so nobody is induced to under-collect. It also fails to reject out-of-range rates, which `safeBps` clamps at 3000.

**Fix.** Import `shared/pricing.js`'s `coerceBps`/`earnerNetCents` rather than keeping a fourth hand-written transcription of `platform_fee_cents` that the drift test does not cover.

---

## 3. FIX ORDER

Each item is tagged **[M]** migration (`supabase db push --linked`), **[F]** edge-function redeploy, **[C]** client release, **[A]** admin console (`cd admin && npx vercel --prod` — it does **not** auto-deploy), **[CFG]** config/runbook only.

### Before the live-key cutover — non-negotiable

1. **[CFG] Verify Stripe webhook registration in live mode.** Test-mode registration does not carry over. `payment_intent.canceled` is the *only* thing healing F5 today, and F6/F8/F9 all live in that handler. Confirm all required events, then re-verify after the cutover.
2. **[CFG] Add `app_flags.stripe_mode` to `PRE_LAUNCH_DATA_RESET.md §5`** (F12). One line; without it the cutover control is dormant.
3. **[F] `stripe-tip` + [M] tip reservation** (F1). Migration first (new table columns, `reserve_tip_slot` / `confirm_tip_charge` / `release_tip_reservation` / reservation-aware `guard_tip_caps`), then the function. **Ordering hazard:** the function must not ship before the RPCs exist, and `guard_tip_caps` / `tip_headroom_cents` must be updated in the *same* migration or the caps disagree with each other mid-deploy.
4. **[M] + [F] Tip reversal ledger** (F2). Migration adds `tip_ledger.reversed_cents`, `record_tip_reversal`, **and the `tip_clawed` CTE in `ctl_earnings_total_drift`** — all three together, or every correctly handled reversal becomes a false positive. Then redeploy `stripe-webhook`.
5. **[M] `settle_booking_benefits` kind branch** (F3) + the new `spent_cents >= sum(reserved_cents)` control. **Must land before F15.**
6. **[F] `stripe-webhook` `payment_failed` re-derivation + gated demotion, and `stripe-create-payment-intent` orphan-reconciler widening** (F6). Ship together — the second half is what prevents the double authorization. Then run the operator query in the finding to find any already-broken rows.
7. **[F] `accept-booking` + `stripe-cancel-payment` CAS** (F5). No migration — both status values are already legal. Ship both endpoints in one deploy; fixing only one leaves the wider ordering open.

### Next — before meaningful volume

8. **[M] + [F] + [A] Refund operation idempotency** (F4). Order: migration (new `payment_refunds` table, 7-arg `record_refund` **plus** a transitional 4-arg shim so the currently-deployed function keeps working) → edge function → console. Delete the shim in a follow-up migration.
9. **[F] `earner-claim-payment`: `coalesce(authorized_at, created_at)`** (F7). One line.
10. **[F] `stripe-webhook` `payment_intent.succeeded` reconcile to `amount_received`** (F8).
11. **[F] + [A] `refund_source` per-event suppression** (F9): never suppress on `charge.dispute.created`; stamp specific refund ids.
12. **[F] `stripe-capture-payment` dispute-row guard** (F11) — `capturedGigCents !== null && pct < 1`, plus the up-front 409.
13. **[F] `stripe-capture-payment` capture claim + idempotency key + post-capture reconcile** (F14).
14. **[F] Shared `assertPayoutCapable`** used by capture and claim (F13).
15. **[M] Fee-credit settle + release on reversal** (F10), plus the widened stranded-credit control.

### Cleanup

16. **[F] `earner-claim-payment` settle call** (F15) — **only after item 5.**
17. **[F] `reconcile-stripe`:** Stripe→DB tip loop (F2), account/customer live-retrieve mode check (F12), `refund_source='chargeback'` exclusion (F19).
18. **[F] + [C] Return `authorizedCents`/`discountCents` and render the discount at consent** (F16). Migration-free; client release.
19. **[C] Pass `bookingId` from the three report entry points** (F17).
20. **[F] `stripe-webhook` refund idempotency on the Refund id** (F18); **[F] Connect onboard idempotency keys** (F20); **[F] `transfers`-only capability gate + login-link ungating** (F21); **[F] assistant `coerceBps`** (F22).

### Ordering hazards, called out

- **F3 before F15.** Adding the settle call to the claim path first would extend the poster-discount reserve-refund to the one capture path that currently gets it right.
- **F4's migration must ship before its edge function**, and must keep the 4-arg shim alive for the deploy window or refunds break mid-rollout.
- **F2's control change is part of F2's migration**, not a follow-up.
- **No new client build reads a new column** in any of these fixes except F16 (`authorizedCents` comes from the edge function, not the DB), so the usual migration-before-build hazard is limited to F1/F2, where the RPCs must exist before the functions call them.
- **Admin console changes (F4, F9) do not auto-deploy** — `cd admin && npx vercel --prod`.

---

## 4. TEST GAPS

Following the existing pure-logic + migration-parsing conventions (`pricing.test.js`, `categories.test.js`, `tipCaps.test.js`, `cancelPaymentContract.test.js`).

**The single highest-value addition: a `finalDefinition(fnName)` helper.** Migrations redefine money functions with `create or replace` many times (`pin_booking_amount` nine times), and a test that reads a *named* file is testing a dead body. Add a shared helper that walks `supabase/migrations/` in filename order and returns the **last** definition of a function, then route every SQL assertion in the suite through it. This alone would have caught F3 at the moment `settle_booking_benefits` was written.

Then:

1. **`benefitSettle.test.js`** (F3). Assert the final `settle_booking_benefits` reads `promotions.kind` and that `promo_benefit_cents` is only reachable on the `fee_override` arm. Mirror the arithmetic in JS from the parsed constants and pin the *wrong* answers by value — `promoBenefitCents(20000, 1000, standing=1000) === 0` — so a revert cannot be made to pass by editing the mirror. Simulate 100 book+capture cycles and assert `granted <= budget_cents` (fails at 2× today). Also pin the *premise*: `consume_poster_discount` stores the booking's rate in `fee_bps`.
2. **`tipCaps.test.js` extension** (F1). The existing 12 tests assert "checked before the charge" and "the caps are serialised" — both true, both green, neither catches this, because they examine two transactions in isolation. Add an N-way interleave model asserting `charged <= cap` **and** `charged === recorded`, plus source assertions that the pre-charge gate is `reserve_tip_slot` (a write) and that the idempotency key is the reservation, not `booking+amount`.
3. **`tipReversal.test.js`** (F2). Assert `stripe-tip` never writes to `payments` (the premise); assert `recordReversal` contains a `tip_ledger` fallback *inside* the `!bookingId` branch with no `return null` before it; assert cumulative-delta semantics (`clamp(20000, 20000, 20000) === 0`). Then model `ctl_earnings_total_drift` in JS and assert the pre-fix formula reports 308.00 as healthy — encoding the lie as a passing assertion about the broken code.
4. **`refundOperationIdempotency.test.js`** (F4). Assert the Stripe key contains `${opId}` and contains **none** of `alreadyRefunded` / `refundCents` / `refunded_cents`; assert the console reuses the op id on failure and re-mints only on success or an amount change; assert the final `record_refund` refuses a null `op_id` and that both mutations sit after the already-applied guard. Pin the arithmetic that makes this invisible: `round(3000·0.9)·2 === round(6000·0.9)`.
5. **`acceptCancelRace.test.js`** (F5). Assert `accept-booking` selects `payments.status`, CASes on it with a checked `.select('id')`, and publishes the booking transition **before** the claim; assert `stripe-cancel-payment` claims the row before `paymentIntents.cancel` and re-asserts booking status after. Add a note to `cancelPaymentContract.test.js` that `'pending'` stays in `CANCELLABLE_STATUSES` *because* the race is closed by the CAS.
6. **`webhookHoldClobber.test.js`** (F6). Assert both writers spell the live state `'authorized'` (the ambiguity that makes any column predicate wrong); assert `'authorized'` is not in the `payment_failed` allow-list; assert `paymentIntents.retrieve` is called and the DEAD-status guard precedes the `'failed'` write (fail-closed); assert the demotion is gated on a matched row; assert the orphan reconciler is not gated on `status === 'authorized'`.
7. **A grants-drift test.** Several fixes add `SECURITY DEFINER` functions. Extend the existing grant assertions to require `revoke execute ... from public, anon, authenticated` on **every** `ctl_*` and money RPC at its final definition — a later `create or replace` silently restores default grants.
8. **A dropped-guard diff test.** Given how many functions are redefined, add a test that, for each money function, compares the final definition against the previous one and fails if a `raise exception`, a `least`/`greatest` clamp, a `.eq(...)` predicate, or a `revoke` present earlier is absent later. This is the class of regression this codebase is structurally most exposed to.

---

## 5. WHAT IS SOUND — do not churn these

These held up under adversarial probing. They are genuinely well defended:

- **The three-value pin at booking INSERT** (`amount_cents_quoted`, `fee_bps_quoted`, `fee_credit_cents`, plus `poster_discount_cents`) and its inheritance by `payments`. Rate changes do not re-price existing bookings, and **capture idempotency genuinely follows from deriving only from immutable values** — the `fee × pct²` retry hazard is closed.
- **`platform_fee_cents` as the single definition of the fee**, with half-up rounding matching the JS it replaced, the Stripe-cost floor, and the amount cap. `__tests__/pricing.test.js` parsing the migration off disk is the right pattern and it works.
- **`guard_bookings_write`'s `completed → verified` gate** requiring a captured `payments` row. This is what turns several of the defects above into "stuck" rather than "settled without payment."
- **Promotion anti-stacking**: one grant per user per promotion, one redemption per booking, both enforced by unique indexes. `consume_promo_grant`'s increment-is-the-check (`UPDATE ... WHERE spent + hit <= budget`) is the correct shape — F3 defeats it downstream, not here.
- **`redeem_promo_code`'s design**: string-only input, boolean-only output (no existence oracle), rate-limited on *attempts* rather than successes.
- **`earner-claim-payment`'s post-capture reconcile** — retrieving the PI and rewriting `earner_amount_cents` from `amount_received` and the charge's `application_fee_amount`. This is the correct discipline and is exactly what F8/F14 should copy.
- **`reconcile-stripe` checks #1, #4 and #5** are real, working, hourly detectors with zero tolerance, and they backstop several findings above (F8, F18, and the detectable variant of F5).
- **The controls framework itself**: functions rather than stored SQL text, `fn_name` validated against `^ctl_[a-z0-9_]+$` *and* `pg_proc`, findings unique per `(control_key, entity_id)` with auto-resolve, config in `app_flags` rather than a GUC. The failures found are in individual control *predicates*, not in the engine.
- **Grants discipline on money RPCs** — `revoke execute ... from public, anon, authenticated` is applied consistently; I found no RLS or IDOR gap on a money table or endpoint. Every defect above requires either a legitimate role or an unlucky ordering, never a privilege bypass.
- **`stripe-cancel-payment`'s `started_at` guard** and `trg_guard_started_booking_cancel` correctly prevent voiding a hold on started work.

---

## 6. RESIDUAL RISK / OPEN QUESTIONS

These are settleable only by runtime observation. Run all of them in **Stripe test mode** or a branch database — none requires touching production.

1. **Is `payment_intent.canceled` (and the full required event set) registered on the live endpoint?** This is the highest-leverage unknown in the report: it is the sole heal for F5 and the delivery path for F6/F8/F9. *To settle:* after the live-key cutover, trigger one cancel and one refund in live mode against a $1 test booking and confirm the handler ran. Do this **before** any real earner works a gig.
2. **Does Stripe Radar throttle a concurrent off-session tip burst?** Nothing in the repo bears on it, and it could reduce the multiplier in F1 — but a bypass whose bound is "whatever Radar allows" is not a $200 cap, so this does not change the fix. *To settle:* in test mode, fire 20 concurrent `stripe-tip` calls at distinct amounts against one booking and count the succeeded PaymentIntents.
3. **How often does Stripe hold `card_payments` inactive while `transfers` stays active and `payouts_enabled` stays true?** (F21.) This is the only thing between "over-strict gate" and "theoretical." *To settle:* create a test Express account, let it go restricted, and read `capabilities` and the three booleans.
4. **Is `charge.amount_refunded` really unmoved by a lost dispute?** (F19's premise, and the reason `record_reversal` exists.) *To settle:* in test mode, force a dispute with `4000000000000259`, lose it, and read the charge.
5. **The 14-day / 200-row `reconcile-stripe` window keyed on `payments.created_at`.** A recovery re-hold preserves `created_at`, so an over-credit or refund drift on an old re-held payment can age out unexamined (F8, F18). *To settle:* seed a branch DB with a payment whose `created_at` is 20 days old and an `authorized_at` of today, and confirm the reconciler skips it. Consider keying the window on `coalesce(authorized_at, created_at)` — the same correction `20260806150000` applied to the controls.
6. **Whether any `poster_discount` campaign has already run.** F3 corrupts `promotions.spent_cents` historically, and I deliberately did not propose a blind backfill. *To settle:* `select id, name, kind, budget_cents, spent_cents, redemptions_used from promotions where kind='poster_discount'` — if `spent_cents` is near zero with a nonzero `redemptions_used`, that campaign has already overspent and needs an audited one-off recompute from `sum(least(reserved_cents, poster_discount_cents))`.
7. **Whether `redeem_promo_code` is reachable by any shipped surface.** I found no client caller, which is the only thing keeping F3 off the happy path today. *To settle:* confirm before shipping any promo-redemption UI that F3's fix has landed.

**Confidence.** F1–F4 and F6 I traced end to end with cent-level arithmetic against the final function definitions and would defend line by line. F5 and F7–F15 are confirmed mechanisms with impact I have deliberately stated conservatively where a heal, a control, or a UI constraint narrows them — several of these were over-severitised on first pass and I have corrected them downward rather than leave them inflated. F16–F22 are real but small; fix them when convenient, not before launch.