# GoHustlr — Incentives & Abuse Audit

**Scope:** promotions, referral bonuses, fee credits, poster discounts, loyalty tiers, tips, the control framework, and the admin authorization model. Static analysis only — no production system was touched. Every claim below rests on the **last definition in timestamp order** of the relevant SQL function, verified by grep+sort before it was written down.

---

## 1. VERDICT

**No — the incentive layer's loss is not bounded by `budget_cents`.** On two rails the budget ledger is provably wrong in the platform's disfavour: `settle_booking_benefits` refunds every delivered poster discount back to its own campaign at capture, and `max_benefit_cents` clamps what a promotion is *charged* while the *discount it delivers* stays uncapped — so a campaign's real give-away exceeds its declared budget by 2× (poster discounts, at console defaults) to 4.73× (fee overrides on large gigs), and the burn-down bar on `/promotions` reads near-zero the whole time.

The single worst thing found is **not** in the incentive layer at all: a migration that meant only to re-anchor a control's clock silently deleted two predicates from `ctl_escrow_hold_expiring_work_done`, removing the *only* population it existed to watch — an earner who did the work, marked done, and is 24–48 hours from the escrow hold being voided with nothing left to capture. That is live today, costs the full gig value per event (up to $10,000), and every sweep reports it green.

The good news is real and worth stating up front: the write-path bounds (`consume_promo_grant`'s increment-is-the-check UPDATE, the two stacking indexes, the Stripe processing floor in `platform_fee_cents`, the vest-on-outcome referral design) all hold under adversarial reading. **Nothing here is extractable as cash by an outside attacker.** The losses are forgone margin, misreported budgets, unpaid workers, and detection you cannot trust.

---

## 2. FINDINGS, ranked by expected loss

Deduplicated: several dimensions reported the same root cause. Where that happened it appears once, with the merged evidence.

> **LIVE / DORMANT** — marked on each finding. Dormant means a specific precondition is not met today (all `fee_tiers` rungs seeded `enabled=false`; `redeem_promo_code` has zero product callers). Dormant is a scheduling fact, not a mitigation.

---

### F1 — The unpaid-worker control was silently gutted by a refactor
**Severity: HIGH · LIVE TODAY · confidence: high (mechanically verified)**

`supabase/migrations/20260806150000_authorized_at.sql:66-89` (live definition)
vs `supabase/migrations/20260806040000_control_library.sql:174-179` (original)

**Mechanism.** `20260806150000` exists only to re-anchor two escrow controls onto `payments.authorized_at` so a recovery re-hold isn't mis-aged. Its header says that is the only change. It isn't: it reproduced `ctl_escrow_hold_expiring_work_done` wholesale with a different `WHERE` and lost two predicates —

```
- and coalesce(b.earner_done, false)            -- gone entirely
- and b.status in ('confirmed','completed')     -- became ('completed','verified')
```

`'confirmed'` is the **only** status a ghosted booking can hold: `trg_advance_mutual_completion` (`20260624210000:43`) promotes `confirmed → completed` only when `earner_done AND poster_done`, and a ghosting poster never sets `poster_done`. The control's population no longer contains the shape it was written for. It also re-keyed `entity_id` from `b.id` to `p.id` and dropped `earner_id`/`poster_id`/`job_title`/`slot_id` from the detail — the fields its own registry text tells the operator to act on.

I parsed every `ctl_*` definition across all migrations in filename order and diffed each control's last body against its earlier ones. **This is the only control in the 42-control library that has silently lost a predicate.**

**Money.** The control's registered `why` prices the miss itself: "there is a 24–48 hour window in which capture can still take real money, after which no code change can conjure it back… Cost of a miss: a student worked for free." Loss per event is the full gig value — $200 gig: earner loses 18,000c, platform loses 2,000c of fee, poster pays **$0** because an uncaptured authorization is never charged. At the `MAX_JOB_PAY` ceiling a single event is 900,000c to the earner.

**Two things that make it worse than it reads.** (a) Once Stripe voids the hold, `stripe-webhook/index.ts:201` flips `payments.status` to `'cancelled'`, which silences `ctl_escrow_hold_lapsed_uncancelled` too (it requires `'authorized'`) — so on a *correctly configured* webhook the loss leaves **no open control finding anywhere, at any point in the booking's life**. (b) The poster takes zero reputational damage, because `EarnScreen.js:608` gates rating on `status === 'verified'`, which is unreachable. It is repeatable against the next earner.

The one thing that *does* fire is the `payment_intent.canceled` admin email at `stripe-webhook/index.ts:245` — whose own text reads "there is now nothing left to capture." You are told, after the money is gone.

**Fix.** Restore both predicates and the booking-keyed `entity_id` in a new migration, keeping the `authorized_at` anchor. Add a second, anchor-independent control (`ctl_work_done_never_paid`) keyed on `earner_done AND status in ('confirmed','completed') AND no captured payment AND age > 8 days`, which cannot be silenced by a hold expiring or a webhook being unregistered. Add a `controls.fn_body_sha` pin + `ctl_control_body_drift` so this class of regression reports itself.

---

### F2 — `settle_booking_benefits` is kind-blind: every poster discount is refunded to its campaign at capture
**Severity: HIGH · LIVE the moment a poster_discount campaign exists · confidence: high**

`supabase/migrations/20260806220000_benefit_lifecycle.sql:169-194` (only definition)
Call site: `supabase/functions/stripe-capture-payment/index.ts:241`

**Mechanism.** `20260806340000` taught the **consume** side that `promo_redemptions` holds one row per booking shared by two promotion kinds, and scoped every read by `p2.kind = 'poster_discount'`. The **settle** side never got that lesson. It loops over every unreleased redemption and re-prices it with `promo_benefit_cents(amount, r.fee_bps)` — a *fee-override* formula. A poster-discount redemption stores `r.fee_bps` = the booking's `fee_bps_quoted`, which absent a tier or earner promo **is** the standing rate. The two terms cancel:

```
actual := least(15000, promo_benefit_cents(20000, 1000)) = least(15000, 2000-2000) = 0
delta  := 0 - 1000 = -1000
UPDATE promotions SET spent_cents = greatest(0, 1000 + (-1000)) = 0
```

The poster was charged $10 less, `application_fee_amount` was $10 lower, the money really left — and the budget line item was handed back in full. `redemptions_used` is *not* decremented (only `release_booking_benefits` does that, and it early-returns on a captured payment), so `max_redemptions` becomes the only surviving bound.

**Arithmetic.** $200 gig at 1000 bps: fee 2,000c → 1,000c; Stripe's cut falls 610c → 581c; **platform margin 1,390c → 419c**, i.e. 971c really lost, and `spent_cents` back to 0.

| configuration | intended max | actual | overshoot |
|---|---:|---:|---:|
| shipped preset ($500 budget, 100 uses, $10) | $500 | **$1,000** | **2.0×** |
| console defaults ($250, 100, $5) | $250 | **$500** | 2.0× |
| operator raises uses to 1000 seeing a 0% bar | $500 | **$10,000** | **20×** |

The overshoot factor is `(max_redemptions × discount) / budget_cents` — a config choice, not a constant. `editPromotion` (`admin/app/(console)/promotions/actions.ts:175`) imposes **no upper bound** on `max_redemptions` and no relation to budget, and the operator raising it is reading a burn-down that says the budget is untouched.

**No attacker, and no profitable farm.** A colluding poster/earner pair is net **−$10.00 per cycle**; `uses_allowed` is forced to 1 for `poster_discount` (`actions.ts:63`) and one grant per user per promotion means every cycle needs a fresh account and real Stripe processing. This is pure platform loss distributed across honest first-time posters.

**No control catches it.** `ctl_redemption_double_charge` compares `redemptions_used` to the row count (consistent); `ctl_discount_charged_not_delivered` compares `reserved_cents`, which settle never rewrites; `ctl_poster_discount_underwater` passes; `ctl_benefit_never_settled` excludes settled rows.

**Fix.** Branch the settle loop on `promotions.kind`. A poster discount's cost is a fixed cents amount already clamped at booking — settle it as `least(reserved, discount × captured/quoted)`, giving `delta = 0` on a full capture. Only `fee_override` goes through `promo_benefit_cents`. Repair already-corrupted `spent_cents` from the immutable pins + captured split. Add `ctl_campaign_spend_understated` comparing recorded spend to discounts actually delivered on captured bookings — the one comparison no existing control makes.

---

### F3 — `max_benefit_cents` caps the CHARGE but never the DISCOUNT
**Severity: HIGH · reachable via console-issued grants · confidence: high**

`supabase/migrations/20260806220000_benefit_lifecycle.sql:269` (charge), `:178` (settle re-clamps)
`supabase/migrations/20260806320000_discount_headroom_after_credit.sql:180-183` (delivery is a bare rate)
`supabase/functions/stripe-create-payment-intent/index.ts:206` (no clamp on the money)

**Mechanism.** `consume_promo_grant` debits `hit := least(max_benefit_cents, promo_benefit_cents(...))`, but what it *delivers* is a rate: `pin_booking_amount` does `least(fee_bps_quoted, promoBps)` with no absolute cap, and the PaymentIntent derives `application_fee_amount` from `fee_bps_quoted` alone. Nothing downstream has ever seen `max_benefit_cents`. `settle_booking_benefits` re-applies the identical clamp at capture, so the understatement is written permanently into `benefit_cents`.

**The threshold is exact.** With standing 1000 bps and a 0-bps grant, the break begins at `0.071a − 55 > 15000`, i.e. **a > 212,042c ≈ $2,120**. Below that the ledger is correct to the cent — which is why this survived every review: ordinary $50–$300 gigs never trip it.

**At the $10,000 pay ceiling** (a *legal* listing):

```
platform_fee_cents(1000000, 1000) = 100,000c
platform_fee_cents(1000000,    0) =  29,055c   (Stripe floor)
true benefit                      =  70,945c   ($709.45 forgone)
hit = least(15000, 70945)         =  15,000c   ($150.00 charged)   → 79% understatement
```

Scaled: a $5,000 budget admits 33 redemptions (33×15,000 = 495,000 ≤ 500,000) forgoing **$23,411.85** — 4.69×. The console's **default $250 budget** admits one, which forgoes $709.45 — **2.84× the entire campaign** — and then reports itself as barely started.

**Not a farm.** Self-dealing a $10,000 gig costs the pair $290.55 in Stripe processing; the floor does its job. The rational actor is an ordinary grant holder steering one grant use to the largest gig they can reach: zero cost, +$709.45 to them, $150 charged. The platform still collects 29,055c and covers Stripe with 25c to spare — **forgone margin, not cash out the door.**

**Fix.** Cap the delivered *rate*, not just the ledger entry: `capped_promo_bps(amount, base, target, cap)` raises the promotional rate back up until the fee reduction fits inside `max_benefit_cents` (closed form, `bigint`-widened — `10000 × fee` overflows int4 near the pay ceiling, the same defect `20260806140000` fixed). Then drop the clamp from `hit`, so `spent_cents` becomes the truth. **Do not fix only the ledger** — the budget test `spent + hit <= budget` runs *after* the rate is chosen, inside the same trigger, so one redemption could still exceed a whole budget. Expose `max_benefit_cents` in `/promotions` (`createPromotion` never writes it and `editPromotion` cannot change it, so every campaign carries the 15,000c default). Copy change: "0% on your first gig" becomes "up to $150 off your platform fee."

---

### F4 — The admin login throttle has zero callers, and its control is permanently blind
**Severity: HIGH · LIVE TODAY · confidence: high**

`admin/app/login/page.tsx:20` · `supabase/migrations/20260806090000_admin_roles.sql:48,68,85,100,141`

**Mechanism.** `20260806090000` shipped `admin_login_attempts`, `admin_login_blocked()` and `record_admin_login()` as the documented "5 failures per account / 15 min, 20 per IP" lockout — and shipped no caller. `grep -rn "admin_login_blocked|record_admin_login|admin_login_attempts"` over `admin/`, `src/`, `web/`, `supabase/functions/` returns **nothing**. The console authenticates straight from the browser via `supabase.auth.signInWithPassword`, so no attempt is recorded and no block is consulted. `ctl_admin_login_bruteforce` SELECTs only from that table — it has returned zero rows on every sweep since it was registered and written `last_violations=0, last_error=null, last_run_at=now()`.

Commit-level: `admin/app/login/page.tsx` has one commit in its history, `8f17c3d`, predating the throttle migration. It was never wired.

**Cost delta.** Per-guess bandwidth ≈ 0.001¢. A 1M-candidate dictionary against a known admin address (`SUPPORT_EMAIL = mainmail@gohustlr.com` is published in the Terms every user is force-shown):

| | wall-clock, 1,000 IPs | detected? |
|---|---|---|
| today | **~2.8 hours, ~$9** | **no** |
| with the throttle wired | 5.7 years (480/day cap, IP-count-independent) | **yes, inside 30 min** |

**Direct yield: 0¢.** `requireAdmin` re-verifies the `aal2` claim on every request *and* requires `admin_users.status='active'`; online TOTP guessing needs ~5,500 req/s inside a 90-second window. A password-only compromise reaches nothing. This is a **detection** finding plus a missing first factor lockout, not a refund path — do not let anyone tell you otherwise.

**The generalisable defect, which matters more than the login page.** The control framework has four health signals — enabled, running, fresh, not throwing — and all four are about *execution*. None asks whether the data source has a producer. A control wired to a table nobody writes passes all four **by returning the passing value**. `ctl_control_disabled` (written after a control was switched off) cannot see it. That is a fourth way of not being told the truth, and F6 below is a second instance of it.

**Fix.** Move sign-in to a server action: `admin_login_blocked` → `signInWithPassword` → `record_admin_login` on both branches, generic failure string on every path (distinguishing them makes the page an admin-existence oracle). Add `ctl_admin_login_not_recorded`: GoTrue writes a `login` row to `auth.audit_log_entries` for every completed sign-in (the source `admin_user_login_history`, `20260705040000:78-95`, already reads) — if GoTrue saw an admin sign in and our attempt log has nothing for the same window, the throttle is decorative. **Do not simply re-point `ctl_admin_login_bruteforce` at the auth audit log**: GoTrue records *completed* actions, so a rejected password grant writes no row. You would get a compromise detector wearing a brute-force detector's name, which returns rows and therefore looks like it works.

---

### F5 — Turning off the alert-dispatch flags kills all alerting permanently, and no control can see it
**Severity: HIGH · LIVE TODAY · confidence: high**

`supabase/migrations/20260806160000_dispatch_monitoring.sql:34` (the only alerting control)
Early returns: `20260806330000:69` · `20260806030000:86` · `20260806020000:85`

**Mechanism.** `app_flags.controls_alert.enabled=false` (or `safety_alert=false`, or a blanked `value.url`) makes every dispatcher early-return **before** `net.http_post`. `ctl_alert_dispatch_failing` reads `net._http_response` — it can only observe dispatches that were *attempted* and came back non-2xx. A dispatch never attempted produces no row.

**The part that makes this likely rather than merely possible:** `run_control` auto-resolves any finding a control stops returning. So the natural sequence — pager is noisy → operator flips `controls_alert` off → next sweep at `:05` — makes the open `alert_dispatch_failing` finding **auto-resolve with the note "auto-resolved: no longer returned by the control"**, and `/controls` renders green. **The remedy erases the symptom that provoked it.**

`ctl_control_disabled` reads `public.controls`, not `app_flags`. Controls keep running, keep writing findings, and nobody is told. The migrations that moved this config out of a GUC promised the opposite twice, in writing: "a control can now check 'is alerting configured?' and page if not."

**Money.** Not a direct debit — and the finding is narrower than "every bound becomes unbounded." The promotions/budget bounds are enforced in the write path and hold with or without email. What becomes time-unbounded are the losses whose clock is **external or human**: Stripe's ~7-day authorization expiry (F1's window), `ctl_earner_credit_missing` (poster already charged, earner never credited), and the 14-day dispute SLA that gates `earner-claim-payment`. This codebase's own empirical value for "time until a human notices" is **27 days** (2026-07-10 → 2026-08-06, the identical failure on the safety channel).

**Two variants behave differently and it matters.** `enabled=false` is the total-blindness case: the reconcile dispatch sits *before* the return, so `net._http_response` keeps receiving 2xx rows and even a naive "has pg_net seen traffic?" probe says yes. Blanking `value.url` returns *before* reconcile, so `stripe_reconciliation` goes stale and `/controls` shows an amber banner — one visible tell the other variant lacks.

**Also true, and it softens nothing:** `/flags` does render a red banner listing paused keys. But its "Where each flag is enforced" section documents only the five original feature switches — **neither alerting key appears** — and the toggle's success message says *"Users hitting that feature now get a 'temporarily paused' message,"* which is flatly false: no user ever hits these. The operator most likely to flip this switch is told the wrong thing about what it does.

**Fix.** Add `public.alert_dispatches` (channel, mode, pg_net request id) logged on every dispatch attempt — log the reconcile dispatch under its **own** channel, or its rows will certify a dead pager as alive. Add `ctl_alert_not_dispatching` reading `app_flags` directly for four shapes (missing row, `enabled=false`, blank url, blank secret) plus a >3h liveness gap on periodic channels. Give **only these two keys** a 24h `disabled_until` auto-expiry — applying it to `payments_enabled` would resume taking money 24 hours into a Stripe incident on a timer, which is the wrong-direction failure. Fix the `/flags` copy.

---

### F6 — `ctl_stripe_id_mode_mismatch` is structurally incapable of firing, and would be useless if armed
**Severity: HIGH · LIVE TODAY · confidence: high**

`supabase/migrations/20260806350000_controls_always_on.sql:180-201` · `admin/app/(console)/flags/actions.ts:42-50`

**Mechanism.** Every branch is gated on `app_flags.stripe_mode.value->>'mode' = 'live'`, defaulted to `'test'`. **No migration seeds `stripe_mode`**, and `setFlag` refuses unknown keys ("Flags are seeded by migration, not created here") *and* only ever writes `enabled`, never `value`. There is no route by which the row can come to exist from the console. The control has returned zero rows since it shipped, `last_error=null`, `last_run_at` fresh — registered **critical**, reporting green.

**Seeding the row would not fix it.** Stripe ids are shape-identical across modes. This repo's own **test-mode** account, `RUNBOOK_MONEY.md:188` `acct_1ThvnME0UZFlVCOp`, is 21 characters, so `account_id like 'acct_1%' and length < 22` matches it — and a live `acct_` id has the same 21-char shape and matches too. `cus_` ids are 18 in both modes. Armed it flags 100% of rows; unarmed, 0%. It has no state in which it discriminates. The migration's own comment concedes the only reliable signal is an API round-trip.

**Cutover consequence, and the app cannot self-heal.** The runbook's `delete from stripe_accounts; delete from stripe_customers;` gets skipped because the control says clean. Then: `stripe-create-setup-intent:29-53` reads the stored `cus_…` with no retrieve and no fallback → `resource_missing`. `stripe-create-payment-intent:117` guards its live probe on `if (!earnerOnboarded)`, and all stored rows carry `onboarded=true` from test mode, so the probe is **skipped** and the stale id goes straight into `transfer_data.destination`. Worst: `stripe-connect-onboard:143-147` swallows the failed retrieve and then reuses `existing.account_id` at `:147`, so `if (!accountId)` never fires and **no new live account is created** — the earner is hard-stuck until someone deletes the row server-side. Bounded population per the migration's own count: 7 earners cannot receive, 3–4 posters cannot pay. Each blind week at one $60 gig/earner/week = ~2,597c contribution and 37,800c of earner income, indefinitely.

**Fix.** Delete the shape heuristic; judge **provenance**, which SQL can decide: seed `stripe_live_mode` keyed on `enabled` (the one field the console can write, so arming it is a real audited click), stamp `value.live_since` once via trigger on the first arm, and flag any `stripe_accounts`/`stripe_customers` row whose `created_at` predates it. Report an *absent* declaration as a finding of its own — a control whose predicate cannot be satisfied must say so. Add `controls.requires_flags` + `ctl_control_dependency_missing` so the next control cannot repeat this.

---

### F7 — Promo cost is measured against the standing rate, blind to the loyalty tier
**Severity: HIGH · DORMANT (all rungs `enabled=false`) — one click from live · confidence: high**

`supabase/migrations/20260806320000_discount_headroom_after_credit.sql:165-183` (live pin)
`supabase/migrations/20260806220000_benefit_lifecycle.sql:72-82, 269, 176-179`

**Mechanism.** `pin_booking_amount` applies the tier first (`fee_bps_quoted := least(standing, tierBps)`) and then calls `consume_promo_grant(earner, id, amount)` — **three arguments, no baseline** — while `consume_fee_credit` and `consume_poster_discount` are both handed the pinned rate. `promo_benefit_cents` counterfactuals against `fee_bps_at(now())`, the standing rate the earner was never going to pay. `settle_booking_benefits` recomputes with the same blind formula, so the error is permanent.

**Case A (promo ≥ tier):** standing 1000, tier 700, grant 800, $100 gig. Charge `hit = 1000−800 = 200c`, burn a grant use, write a redemption — then `least(700, 800) = 700`. **The promo moved nothing.** A 50,000c budget is exhausted after 250 such bookings having delivered $0 of discount, and then stops working for non-tiered earners who *would* have benefited.

**Case B (promo < tier):** grant 500 vs tier 700 → real delivered benefit 200c, campaign charged 500c. **Overcharge = 300c, exactly the tier's own contribution.** Budget bounds 60% less real discount than intended; every "what did this campaign cost us" number on `/promotions` is inflated by the tier's share. `promo_redemptions.fee_bps` records the grant rate, not the pinned rate — the audit trail disagrees with the charge.

**No user is overcharged** — lowest-wins means the earner always gets the best rate. The losses are budget consumed for undelivered benefit, users' grant uses destroyed, and inflated cost reporting.

**Fix.** Pass `new.fee_bps_quoted` as an explicit baseline; return `null` (charging nothing, burning nothing) when `g.fee_bps >= baseline` or when `hit <= 0` (both fees on the Stripe floor — a $5 gig at 1000 vs 500 bps both floor to 70c, and the current code burns a use for a 0c benefit *today*, with no tier involved). Snapshot `baseline_bps` on the redemption so settle reproduces it. **Drop the 3-arg overload** in the same transaction — leaving it resolvable lets a stale caller silently get the bug back, the same reason `20260806320000` dropped the 4-arg `consume_poster_discount`.

**Do not use the originally-proposed control** (`fee_bps_quoted >= r.fee_bps`): lowest-wins makes the pin *always* ≤ the grant rate, so that reduces to `=` and fires on every healthy redemption. Use three clauses instead — pin ≠ grant rate (Case A), charge > benefit against this booking's own baseline (Case B), and a post-migration redemption with a null baseline (the fix having been reverted is as important to hear about as the bug).

---

### F8 — Tips: no application fee, and the velocity cap is poster-scoped only
**Severity: MEDIUM · LIVE TODAY · confidence: high**

`supabase/functions/stripe-tip/index.ts:115-123` · `supabase/migrations/20260804000000_tip_caps.sql:145`

**Mechanism.** The tip PaymentIntent carries `transfer_data.destination` with **no `application_fee_amount`**, so the full amount transfers to the earner and Stripe's processing (2.9% + 30c) comes out of the **platform balance**. Every tip, including every legitimate one, is a negative-margin transaction. The `tip_caps` header names the 0% take rate and the chargeback exposure but not this. The velocity cap (`$500/24h`) is keyed on `j.poster_id` with **no per-earner and no global counterpart**, so tip *receipt* per earner is unbounded across shells.

**Arithmetic.** $500/day through tips costs the platform `2 × (580+30) + (290+30) = 1,540c = $15.40/day` per funded poster shell, against $0 revenue. The same $500 through the gig rail collects at least the floor `ceil(50000×0.029)+30+25 = 1,505c` and nets the platform +25c. Payouts are `interval: 'daily'` with no `delay_days` (`stripe-connect-onboard/index.ts:196`), so funds leave in ~2 business days.

**Correction to the original claim, which I am not going to repeat as fact:** the "$200 cap floor unlocked by an uncaptured booking" framing is wrong — the floor is unconditional and reached identically by a normally captured small gig; the uncaptured path saves the actor about $1 of platform fee. The real findings are the missing application fee, the missing earner-side cap, and that **no `ctl_*` control observes tip volume, tips-per-earner, or distinct-poster fan-in at all**.

**Fix.** (1) Charge an `application_fee_amount` on tips at least equal to the processing floor. (2) Add a per-earner 24h receipt cap in `guard_tip_caps`. (3) Add `ctl_tip_velocity_anomaly` on tips received per earner across distinct posters.

---

### F9 — Stolen-card cash-out: destination charges with no transfer reversal, daily payouts, no gig-rail velocity caps
**Severity: MEDIUM · LIVE TODAY · confidence: high on mechanism, medium on likelihood**

`supabase/functions/stripe-webhook/index.ts:281-307` · `admin-payment-action/index.ts:121-124, 186-187` · `stripe-connect-onboard/index.ts:196`

**Mechanism.** Every gig charge is a destination charge with no `on_behalf_of`, so the platform is merchant of record and bears disputes. The `charge.dispute.created` handler files a `disputes` row and emails an operator — it never reverses the transfer. The only `reverse_transfer` in the codebase is `admin-payment-action`'s `op='refund'`, which the code's own comment says Stripe rejects on a disputed charge (`charge_disputed`). `record_reversal` is **ledger-only**: it adjusts `refunded_cents` and debits the earner's dashboard number while the cash stays in the connected account and has already paid out.

**Arithmetic** ($10,000 gig at 1000 bps): platform nets +70,970c at capture; chargeback takes −1,000,000c plus a −1,500c dispute fee ⇒ **platform −$9,305.30, attacker's bank +$9,000.00 (90% recovery)**. With a 0-bps grant or tier the fee floors at 29,055c and recovery rises to 97.1%.

**What actually limits it today:** Stripe Radar (not configured in this repo) and Connect Express KYC on the *earner* side — real friction, but one-time per farm and reusable across unlimited stolen cards. **What does not:** poster ID verification is optional and drives only a badge; the disputes gate only blocks future auto-settlement on the *same* booking; there is no per-poster daily spend cap, no per-account booking-rate cap, no new-card cooling period, and no `ctl_*` on chargeback rate or new-account spend velocity. The contrast is stark — the tip rail carries three caps; the gig rail, which moves up to $10,000 per booking, carries none.

This outcome is already stated in `RUNBOOK_MONEY.md §2.4` and the `stripe-webhook` H12 comment. What is *new* is (a) the webhook comment says a human can "freeze/recover" but **no code path can reverse a transfer post-dispute**, and (b) the asymmetry with tips.

**Fix, in priority order.** (1) `delay_days` (7–14) on the Express payout schedule — post-payout reversal recovers little, so lengthening the window beats adding the reversal call. (2) Per-poster gig-rail velocity caps mirroring `guard_tip_caps`, tightened for accounts under N days old or a first-seen card, enforced at hold time. (3) `ctl_chargeback_rate_by_earner` + `ctl_new_account_spend_velocity` so the exposure is at least observed. (4) The transfer reversal in the dispute handler, last.

---

### F10 — A fee credit is burned in full at booking but delivered pro-rata at partial capture, and the fee can fall below Stripe's cost
**Severity: MEDIUM · LIVE TODAY · confidence: high**
*(This merges the credits-dimension and discounts-dimension reports of the same line.)*

`supabase/functions/stripe-capture-payment/index.ts:179` — `const feeCents = Math.min(captureCents, Math.round(fullFeeCents * capturePct));`
`supabase/migrations/20260806220000_benefit_lifecycle.sql:169` — settle iterates `promo_redemptions` only; `bonus_ledger` appears nowhere.

**Two consequences of one line.**

**(a) The earner loses up to half an earned credit.** `consume_fee_credit` flips `bonus_ledger` rows to `'applied'` for the full headroom computed at INSERT; the partial branch scales the credited fee by `pct`, so delivered relief is scaled too, and `settle_booking_benefits` — the function whose entire job is "settle the reserve to what actually happened" — never touches `bonus_ledger`. `capturePct` is clamped to `[0.5, 1]`, so the worst case is exactly half: a $100 gig at 1000 bps charges 655c and delivers 327c at `pct=0.5`. On a $500 gig that is 1,748c lost. The loser is a referrer who earned this by referring a real person who completed real work; the platform quietly keeps the difference on a booking the *poster* unilaterally disputed.

Note the correct settle figure is not `credit × pct` — it is the usable headroom recomputed at the **captured** amount (`fee(captured) − floor(captured)`), which on the worked $100/50% case is 300c, so the ledger should get back 355c, not 328c.

**(b) The platform pays Stripe's processing out of pocket** — the exact thing `consume_fee_credit`'s comment says "we never" do. The fixed 30c does not scale with `pct`. At `pct=0.5` on a $100 gig with a full credit: fee 173c against a Stripe cost of 175c ⇒ **−2c**. Worst case over the legal `[0.5,1]` range is 2–3c per booking, and it is **not** caused by poster discounts (the original discount example is safely +7c) — it is any 50% partial capture of a booking whose full fee sits at or near the processing floor, including a bare $5 gig at 500 bps with no benefits at all. Small, but it invalidates the "loss ceiling is structural" claim in `20260806080000`'s header.

**No control sees either.** `ctl_credit_stranded_on_dead_booking` requires `status in ('declined','cancelled')` and no capture; this booking is verified and captured. `__tests__/pricing.test.js` has zero references to `platform_fee_after_credit`, headroom, or credits.

**Fix.** Extend `settle_booking_benefits` (or a sibling called from the same site) to recompute usable headroom at the captured amount and return the difference as a fresh `payable` `bonus_ledger` row, leaving the `applied` row as the audit record. Independently, re-floor the scaled fee **unconditionally**: `feeCents = max(min(captureCents, round(fullFee×pct)), ceil(0.029×captureCents) + 30)`.

---

### F11 — A fee credit spent on a booking that is later refunded or charged back is lost permanently
**Severity: MEDIUM · LIVE TODAY · confidence: high**

`supabase/migrations/20260806260000_release_fee_credits.sql:44-51`

**Mechanism.** `release_booking_benefits` is the only function that moves a `bonus_ledger` row from `'applied'` back to `'payable'`, and it early-returns 0 whenever a payment for the booking is captured. The restore at `:78` sits below that return and is unreachable for any captured booking. A refund fully reverses the money — `admin-payment-action:187` passes `refund_application_fee: true`, so the platform hands back the very fee the credit discounted — but the credit stays `applied` forever.

`vest_bonuses` explicitly voids a *pending* bonus when its **source** booking is reversed, proving the system tracks reversals. There is no equivalent on the **spend** side, and the void keys on `source_booking_id`, never `applied_booking_id`.

**Money.** The earner loses the entire consumed portion (655c on a $100 gig, up to 3,495c on a $500 gig) for a booking whose money was 100% reversed. They received exactly nothing: the fee it offset was itself refunded. This is the identical harm `20260806260000`'s own header calls "value silently taken from a user for work that never happened" — that migration fixed decline/cancel and left refund/chargeback uncovered.

**One factual correction worth carrying:** nothing in the repo ever writes `payments.status = 'refunded'`. `record_refund` sets only `refunded_cents`/`refunded_at`, leaving `status='captured'`. (The conclusion is unchanged — the early return also tests `captured_at`.) Side effect: the `or p.status='refunded'` half of `vest_bonuses`' void predicate is dead code; the `refunded_cents > 0` half does the work.

**Fix.** Split the captured guard: keep refusing to claw back the promo campaign's reserve, but restore the fee credit in proportion to the reversal — in `record_refund`, or a trigger on `payments.refunded_cents`, return `round(delivered × refunded_cents / captured_total)` as a fresh `payable` row. Add a control asserting no `bonus_ledger` row is `applied` against a fully-reversed payment.

---

### F12 — Referral bonuses: vested ones are never clawed back, voided ones never return their budget, and there is no admin lever at all
**Severity: MEDIUM · LIVE TODAY · confidence: high**
*(Merges three referral-dimension findings sharing one root: `vest_bonuses` is the only writer that can void, and it is scoped `state='pending'`.)*

`supabase/migrations/20260806080000_referral_bonus.sql:133-141` · `20260806250000_referral_once_per_person.sql:37-39, 86-91` · `20260806260000_release_fee_credits.sql:55, 61-62`

**Three consequences.**

**(a) Post-vest reversals are never caught.** Once the 7-day timer flips a row to `payable`, no code path in the repository can reverse it. Stripe's chargeback window is up to 120 days and the console can refund at any time, so 7 days covers a fraction of the real reversal window. Exposure per event = `bonus_cents` of margin (a credit is only ever redeemable against platform margin, so this is not cash off the balance), aggregate capped by `promotions.budget_cents`.

**(b) A void never returns its campaign budget, and re-opens the pair.** `release_booking_benefits` — the only budget-returning function — walks `promo_redemptions` and knows nothing about `bonus_ledger`. So an **ordinary, legitimate refund inside the 7-day window** permanently overstates a campaign's spend: on console defaults (budget $250, $10 bonus = 25 fundable), five refunded referrals silently destroy $50 of campaign and deny five real referrers their reward. Worse, `bonus_ledger_one_per_referral` is a partial index predicated on `state <> 'void'`, so voiding drops the pair out of the uniqueness guard and their next gig mints and charges a second bonus.

*The "burn the budget on demand" version of (b) is weaker than it looks and I will not oversell it:* the void predicate needs `payments.refunded_cents > 0`, whose only writer is `record_refund` (service_role, admin console). A card chargeback does **not** set it. So burning $250 requires an operator to hand-issue 25 audited refunds.

**(c) There is no operator remedy for any of it.** `grep bonus_ledger` returns writers in exactly three places: `accrue_referral_bonus`, `vest_bonuses`, `consume_fee_credit`/`release_booking_benefits`. The console's `revokeGrant` updates `promo_grants` only; `/promotions` reads `bonus_ledger` read-only. **Support, trust, finance and admin all have literally no lever to cancel a fraudulent or reversed credit** short of raw service-role SQL — the exact failure `/promotions` and `/flags` were built to eliminate.

**Related, low:** `vest_bonuses`' void condition also misses reversals that never go through the console. Both `charge.refunded` and `charge.dispute.created` call `recordReversal`, which inserts a `disputes` row — and the vest pass *does* refuse to vest while a dispute is open, so an external reversal holds the bonus at `pending`. The genuine residual is narrow: an operator who resolves or rejects the dispute **without** pressing "Record chargeback" leaves `refunded_cents = 0`, and the bonus then vests. That is the known `ctl_external_reversal_not_ledgered` defect, with a consequence its rationale does not name.

**Fix.** Add a void/reverse pass for `state in ('payable','applied')` on refund/dispute signals, widened to Stripe's chargeback window. In the void pass, decrement the funding campaign in the same statement family. Drop `and state <> 'void'` from `bonus_ledger_one_per_referral` (gate a second chance on an explicit column if intended). Add an admin `revokeBonus` action with an audit row. Add a control asserting `promotions.spent_cents = sum(bonus_ledger.amount_cents where state <> 'void')` for `kind='bonus'`.

---

### F13 — `ctl_discount_without_grant` fires a permanent CRITICAL on every declined booking that carried a poster discount
**Severity: MEDIUM · confidence: high**

`supabase/migrations/20260806340000_discount_kind_confusion.sql:177-199` vs `20260806220000:134`

**Mechanism.** `release_booking_benefits` deliberately does not clear `bookings.poster_discount_cents` (it stamps `released_at` and explains why touching `bookings` would roll back the decline). `ctl_discount_without_grant` looks for exactly that state: `poster_discount_cents > 0` with no redemption whose `released_at is null`. So the routine, intended outcome of declining an applicant permanently satisfies a **critical** money control's violation predicate.

**Why it is worse than "noisy".** `run_control`'s upsert is `on conflict … where resolved_at is null` — so an operator who manually resolves one of these does **not** silence it: the next hourly sweep inserts a brand-new row with `created_at = now()`, which lands inside the 90-minute freshness window and **pages again**. Closing the ticket is what makes it recur. Each new decline is a new critical page indistinguishable from the real thing — and the real thing is the one bug class that moves money silently (the `20260806340000` regression, where 155c came off a charge with no poster-discount campaign in existence).

Mitigating: the detail payload includes `booking_status`, so a triaging operator can pattern-match `status='declined'` on sight, and the volume is zero until a poster_discount campaign exists.

**Fix.** Make the predicate match the bug shape it was written for: *no poster_discount redemption ever existed for this booking* — drop the `released_at is null` filter and add `and b.status not in ('declined','cancelled')`.

---

### F14 — A poster's single discount use is consumed by whichever stranger applies first, not by the hire they make
**Severity: MEDIUM · confidence: high**

`supabase/migrations/20260806320000_discount_headroom_after_credit.sql:152, 200-202` · `admin/app/(console)/promotions/actions.ts:62`

**Mechanism.** `consume_poster_discount` runs from `pin_booking_amount` on booking **INSERT** — when an *earner applies*, not when the poster accepts. The console forces `uses_allowed = 1` for `poster_discount`. The grant is scoped to the **poster, not the job**, so the collision does not even need a multi-slot gig: a poster with two open listings loses their single use to whichever applicant lands first across any of them, and hiring on the other listing pays full price. `bookings_one_active_per_slot` is partial on `slot_id is not null`, and `JobsContext.js:454` inserts `slot_id: slotId || null`, so null-slot bookings aren't constrained at all.

**Two harms.** (1) **Non-delivery:** "$5 off your first hire" silently fails for any poster who does not hire their first applicant; the campaign's `redemptions_used` and `spent_cents` both moved for a benefit worth zero to anyone until the poster performs the extra step of declining. (2) **Budget occupancy:** applying is free and needs no Connect account, so an account blanket-applying reserves one use per grant-holding poster. On a $250/$5 campaign, 50 applications exhaust the budget. It self-heals only when posters decline. `ctl_benefit_never_settled` cannot see it — its predicate is `b.status in ('verified','declined','cancelled')`, so a reservation parked on `pending` is invisible.

*(The occupancy half is weaker than "zero-cost DoS": an attacker cannot see who holds a grant, so it means blanket-applying across the marketplace hoping to hit 50 grant-holders. The novelty is the unwatched budget reservation, not the griefing, which `ctl_stranded_pending_booking` already documents.)*

**Fix.** Consume the poster discount at **accept**, when the counterparty is chosen and the hold is placed, and pin it then the way `fee_bps_quoted` is pinned. If it must stay at INSERT, add a control for redemptions reserved against a `pending` booking older than N hours, and release when a competing booking on the same job is confirmed.

---

### F15 — The loyalty tier threshold is a bare count of verified bookings
**Severity: MEDIUM · DORMANT (rungs disabled) · confidence: high**

`supabase/migrations/20260806120000_fee_tiers.sql:58-68` · `20260730140000:87` · `20260728120000:41`

**Mechanism.** `earner_completed_count` counts every `status='verified'` booking regardless of value, counterparty, or whether both accounts are the same person. The migration's header asserts this is uninflatable; the only barrier is that a booking needs a captured payment to reach `verified`, which makes each increment cost **one platform fee on a minimum-priced gig**, not one unit of real work. The only anti-self-deal check is `earner_id <> poster_id`, which two distinct accounts do not trip. Nothing checks counterparty diversity, and no control watches booking concentration between a pair.

**Arithmetic.** $10 pay floor. Fee per increment falls as you climb: 100c → 90c → 84c. Reaching Veteran (50 verified, 700 bps) costs **10×100 + 15×90 + 25×84 = 4,450c = $44.50**.

**Yield — corrected downward from the original, honestly.** The tier is legitimately attainable by any earner who does 50 real gigs, so $44.50 buys **acceleration**, not permanent free money. The platform's loss is the ladder differential over the first 50 real gigs: on $100 gigs, `10×$3 + 15×$2 + 25×$1 = $85` against $44.50 of cost — net **+$40.50, ~1.9×**. It scales sharply with ticket size: $500 gigs → ~$425 for the same $44.50 (**9.5×**); $2,000 gigs → ~$1,700 (**38×**). Note the platform doesn't even collect the $44.50 — at the 800/700 rungs the fee sits at the processing floor, so of 4,450c the platform nets **$2.50** and Stripe takes ~$42.

Profitable: yes. Unbounded: no.

**Fix.** Count **distinct posters** (or require `min_distinct_posters` alongside `min_completed`), and/or gate on cumulative verified GMV so a $10 booking contributes $10 of progress rather than a whole rung. Add a control flagging earners whose verified bookings concentrate on one or two `poster_id`s. Exclude refunded/disputed bookings from eligibility.

---

### F16 — A flexible-slot gig whose poster ghosts has no settlement path at all
**Severity: MEDIUM · LIVE TODAY · confidence: high**

`src/screens/PostJobScreen.js:201` · `shared/lifecycle.js:59` · `earner-claim-payment/index.ts` (`NO_SCHEDULE`) · `admin-payment-action/index.ts:49`

**Mechanism.** The fallback slot is created with no `startsAt`, so `job_slots.starts_at` is NULL and `bookings.starts_at` is NULL. Three doors close: `canClaimEarnerPayment` returns false, so the "Claim your payment" CTA is **never rendered** (the earner isn't merely blocked — they're never told a claim exists); `earner-claim-payment` returns `NO_SCHEDULE` with the message *"contact support to settle it"*; and `admin-payment-action`, the console's only money path, accepts exactly three ops — `release_hold`, `refund`, `record_reversal`. **There is no capture op.** Support cannot settle the booking, and `RUNBOOK_MONEY.md:105` forbids the remaining manual route ("Do not capture from the Stripe Dashboard as a shortcut").

Doors one and two are documented, tested residuals. The finding's value is narrower and sharper: **the fallback both of them route to does not exist.** The `NO_SCHEDULE` copy and `RUNBOOK_MONEY §1.4` promise a settlement the console cannot perform.

**Fix.** Add an admin `capture` op (admin tier + 300s step-up + written reason, reconciled against `amount_received` like `stripe-capture-payment`) — or correct the copy. Independently, require a concrete datetime when an earner books a flexible slot, which restores the self-service claim path and drains `ctl_live_booking_without_schedule_anchor`'s false-positive volume (it fires at day 0 on every ordinary flexible booking, so by day 5 the finding is stale and produces no page at the moment the money is dying).

---

### F17 — `/promotions` is the console's only budget-spending surface with no MFA step-up
**Severity: MEDIUM · LIVE TODAY · confidence: high**

`admin/app/(console)/promotions/actions.ts:54, 91, 118, 150, 207, 240, 268` (all `requireAdmin("admin")`)
vs `admin/app/(console)/pricing/actions.ts:106` (`requireFreshAdmin("admin")` for the *same* grant capability)

**Mechanism.** All seven mutating promotions actions use plain `requireAdmin`. `PromoControls.tsx` is the only money surface with no `useStepUp`/`ReauthPrompt` import at all. So the identical grant capability is gated or ungated depending on which page you route through. Threat model is the one `guard.ts:64-78` names: a hijacked-but-valid session whose TOTP was satisfied hours ago. That session cannot change the platform rate, flip a flag, touch the team, or refund a booking — but it **can** create a 0%-fee campaign with a self-declared budget, activate it, mint 200 codes × 1,000 seats, raise the budget and `ends_at` on a live campaign, and `revokeGrant` a named user's benefit.

`createPromotion` validates `budget_dollars > 0` with **no ceiling** and `maxRedemptions` with no cap — while `setPlatformRate` in the sibling file demands a typed `CHANGE RATE` and a mandatory note.

**Correcting the economics, which were overstated by orders of magnitude:** seats are not losses. Realised loss is bounded by actual bookings by grant holders during the window, at ≈6.8% of their GMV (the fee minus the Stripe floor), and drafts require a separate activation and codes must reach real users. It is a real authorization gap on the largest money lever outside the step-up set, not a $1M hole.

Note also: "every comparable surface has step-up" is **false** — `setControlEnabled` (turning *detection* off), jobs, categories, access, disputes and moderation all use plain `requireAdmin` too. Step-up covers exactly five surfaces.

**Fix.** Switch all seven to `requireFreshAdmin("admin")`, wire `useStepUp` + `ReauthPrompt` into `PromoControls.tsx`, and clamp `budget_cents`/`max_redemptions` the way `setPlatformRate` clamps the rate. Consider adding step-up to `setControlEnabled` at the same time.

---

### F18 — `admin-payment-action` can reach Stripe with no `admin_audit_log` row, and its own header asserts the opposite
**Severity: MEDIUM · confidence: high**

`supabase/functions/admin-payment-action/index.ts:15-17` · `20260804020000_refund_ledger_fixes.sql:109-114`

**Mechanism.** The header claims "The console writes its `admin_audit_log` row BEFORE calling this, so an action that reaches Stripe is always already on the record." Nothing enforces it. The function authenticates the admin's own user JWT — the token sitting in the operator's browser — performs no audit write of its own, and is reachable by a plain POST that never touches the Next.js console. The residual DB trail is `payments.refunded_by`/`refund_reason`, **single columns overwritten on every call**, so a sequence of partial refunds preserves only the last actor and reason.

**Softening, honestly:** every refund carries `metadata: { booking_id, admin_id, reason }` on the Stripe refund object (`index.ts:188`), so per-refund attribution *does* survive — outside the DB, in Stripe. And the actor must already hold an active `admin` row plus a second factor within 300s. This is an insider-accountability hole and a scripting bypass, not privilege escalation.

**No control detects it.** `ctl_external_reversal_not_ledgered` is explicitly blind to this shape: the function stamps `refund_source='admin'` before calling Stripe and the webhook early-returns for that source. There is no `ctl_*` relating money movement to `admin_audit_log`.

**Fix.** Have the function write its own audit row (`admin_id`, `action='payment.<op>.edge'`, booking/amount/reason/refund_id) immediately before the Stripe call, de-duplicated against the console's row on `/audit`. Or require a console-minted nonce verified against a freshly written audit row.

---

### F19 — Five console surfaces write the audit row *after* the mutation, so a committed change is reported as a failure
**Severity: MEDIUM · confidence: high**

`admin/app/(console)/pricing/actions.ts:47→55` (setPlatformRate), `:122→127` (grantToUsers), `:77→79`, `:174→185`, `:212` · `promotions/actions.ts:68→71, 92→94, 125→127, 190→192, 211→222, 243→247` · `controls/actions.ts:36→41, 63→65` · `moderation/actions.ts:27→30, 51→54`
Contrast, same file: `pricing/actions.ts:257-261` gets it right and states the rule.

**Mechanism.** `audit()` throws on any error by design. When the mutation lands and the audit insert then fails (transient DB error, connection reset, PostgREST timeout), the catch swallows it and returns `{ ok: false, message: "Could not set the rate." }` — with the new rate live for every subsequent booking, no audit row naming who changed it or why, and the operator believing nothing happened.

The `control.disable` case is the nastiest: `ctl_control_disabled` derives `disabled_by` from `admin_audit_log`, so a control switched off without its audit row shows **`disabled_by: null` — detection turned off by nobody**.

**Two overstatements corrected.** (1) `admin/lib/audit.ts`'s own header instructs the *opposite* convention ("call audit() after the action succeeds"); the console carries two contradictory documented conventions, and audit-first is documented only in the two `run()` helpers. (2) The retry hazards are weaker than claimed — `grant_promotion_to_users` inserts `ON CONFLICT DO NOTHING` behind the unique index, and a repeated `setPlatformRate` at the same bps is a no-op for `fee_bps_at()`.

**Fix.** Wrap these in the same `run()` helper `bookings/actions.ts` and `users/[id]/actions.ts` already use: `requireFresh → audit(intent) → mutate → auditRead(outcome)`. At minimum move `audit()` above the write in `setPlatformRate`, `grantToUsers` and `setControlEnabled`. Pick one convention and delete the other from the docs.

---

### F20 — `addTeamMember` can strand the console with no admin
**Severity: MEDIUM · confidence: high**

`admin/app/(console)/team/actions.ts:108-125` vs `:130-134, 157-161` · `admin/lib/guard.ts:151`

**Mechanism.** `setTeamStatus` and `setTeamRole` guard against lockout; `addTeamMember` has neither guard and upserts on `user_id` with `status` forced to `'pending'`. `requireAdmin` refuses any row whose status isn't `'active'`, so re-adding an existing active admin — including yourself — instantly revokes their access. The sole admin (the current production state) typing their own address in to correct a role or note locks themselves out permanently; recovery requires direct DB credentials, which `20260804030000:12-15` names as "exactly the wrong dependency."

Note the two guarded paths are **vacuous**: the actor is by construction an active admin and cannot target themselves, so `admin_active_admin_count()` is always ≥2 when `assertNotLastAdmin` runs. The one path that can actually produce the lockout is the one without the guard. Separately, `setTeamRole` calls `assertNotLastAdmin` only when `role === 'support'`, so demoting an admin to `finance` or `trust` skips it entirely — while the code's own comment at `:168-170` says that would strand the console.

**Blast radius.** No admin can sign in ⇒ no refunds, no hold releases, no chargeback recording, no dispute resolution (which is what unblocks `earner-claim-payment` settlement), no flags, no promotions kill switch — while holds near their ~7-day expiry.

**Fix.** In `addTeamMember`: refuse when `userId === ctx.user.id`, call `assertNotLastAdmin`, and don't downgrade an already-active row (set `status:'pending'` on insert only). Fix `setTeamRole` to guard for any role other than `'admin'`.

---

### F21 — The daily controls digest still dispatches at pg_net's 5s default while its handler makes a synchronous Anthropic call
**Severity: MEDIUM · confidence: medium-high**

`supabase/migrations/20260806030000_schedule_controls.sql:89-94` (only definition of `controls_digest`) · `supabase/functions/controls-alert/index.ts:130-166`

**Mechanism.** `20260806330000` raised `net.http_post` timeouts to 120s/30s precisely because a 5s timeout wrote a null-status row that `ctl_alert_dispatch_failing` reported as the alerting channel being broken. It redefined only `controls_sweep_and_page`. `controls_digest` was never redefined — and the digest is the mode that awaits a 1,200-token Claude completion plus a Resend POST.

**Self-sustaining, which is the strong form of the argument.** Triage is gated on `open.length || errored.length || stale.length`, so a clean board yields a fast digest. But once it fires *once*, the timeout row itself becomes an open finding, guaranteeing `open.length ≥ 1` the next morning. The cost is the credibility of the one channel that must never cry wolf — the migration that fixed the identical mechanism records it in its own words: "Three findings had accumulated from this, at high severity, on the one channel that must never cry wolf."

Corrections: the digest **email still arrives** (pg_net abandoning the wait doesn't kill the edge function), and the finding likely auto-resolves the same evening on pg_net's response TTL rather than persisting 25h — so this is one false page per morning, not a permanent open finding.

**Fix.** `timeout_milliseconds := 120000` on `controls_digest`. Make `ctl_alert_dispatch_failing` distinguish a client-side timeout (`status_code null` + `Timeout` in `error_msg`) from a real non-2xx and rank it lower.

---

### F22 — Compact register of remaining findings (all LOW)

| # | Finding | File:line | Why it's low | Fix |
|---|---|---|---|---|
| L1 | **`redeem_promo_code` has zero product callers** — every minted code is undeliverable; `/promotions` shows "0/1 used", which an operator reads as "no demand" | `admin/app/(console)/promotions/page.tsx:141` | No margin moves; operability only. **But it is the root cause of L2–L4 and the reason F3 hasn't cost real money yet** | Ship a code-entry screen, or hide MintCodes behind a flag until you do |
| L2 | **A `bonus`-kind code redeems TRUE and delivers nothing** — no consumer can match a grant with `fee_bps NULL`; the code seat burns and the unique index makes it permanent | `20260806070000:305-317` | Unreachable (L1). **But the same missing kind-gate exists in `grant_promotion_to_users` (`20260806120000:178-205`), which IS wired** to `/pricing` → grantToUsers | Gate `kind not in ('fee_override','poster_discount')` at both entry points, before the seat increment |
| L3 | **The redeem rate limiter is read-then-decide** — the exact anti-pattern the same file forbids for budgets | `20260806070000:267-273` | Self-limiting (one burst of C, then an hour of silence), and 32^8 entropy on console-minted codes makes it moot. Table stays empty (L1) | Insert the attempt row first, then count; or `pg_advisory_xact_lock` |
| L4 | **`exception when others` rolls back the attempt row** | `20260806070000:327-330` | The rollback is load-bearing in the safe direction — it also unwinds the seat increment, so the function is atomic. No reachable trigger | Add `raise warning '…: %', sqlerrm` so an operational failure is distinguishable from a wrong code |
| L5 | **The earner never sees a credit, and the receipt reports the pin, not what was delivered** | `src/screens/PaymentsScreen.js:417`, `src/lib/payments.js:73,101` | Disclosure — but it's *why* F10 and F11 are invisible to the people they cost. **Independent bug:** on any partial capture "Gig total" is the authorized hold, so the line items never sum to the sheet's own total | Store `fee_credit_applied_cents`; derive Gig total from `earner_amount_cents + fee_cents`; show a `bonus_ledger` balance (RLS already permits it) |
| L6 | **A credit is frozen on an application the poster ignores** | `20260806260000:105` | Recoverable — cancelling the pending booking releases it. Real residual: `ctl_credit_stranded_on_dead_booking` doesn't cover `'pending'`, and the earner is never told a credit was spent | Add `pending` + an age threshold to the control; sweep-release aged pendings |
| L7 | **`bonus_cash_payout_enabled` is read by nothing** — the flag credited with closing the cash-farming rail | `20260806070000:224` | Fails safe today; no console route creates a cash campaign. **Live consequence if one is hand-created:** vest moves cash rows to `payable` with no delivery filter, and nothing can ever discharge them — a permanently growing "Bonus owed" tile | Make `vest_bonuses` refuse `delivery='cash'` while the flag is off, so the future implementer inherits a guard rather than a comment |
| L8 | **`promotions_enabled` doesn't cover referral accrual or fee-credit spending** while `/promotions` says "All promotions are switched off" | `20260806080000:160`, `20260806250000:62`, `promotions/page.tsx:50-56` | Bounded, and per-campaign `status='paused'` stops accrual. **The genuinely unreachable half is spending** — `consume_fee_credit` consults no flag, no campaign status, no expiry, no revocation | Add the guard to `consume_fee_credit`; fix the banner copy either way |
| L9 | **No client surface reads `fee_tiers`** — margin spent, retention never delivered, and the quote misstates the earner's net | `src/screens/JobDetailScreen.js:59-60`, `src/lib/pricing.js:31-50` | Zero impact while rungs are disabled; the disclosure error runs in the user's favour | Return `tier_fee_bps` from `my_profile()`; use `least(standing, tier)` in the quote; surface the ladder |
| L10 | **A failed tier lookup is a log warning, and no control checks tier *delivery*** | `20260806320000:167-175` | The stated trigger (unindexed count timing out) isn't credible at this table size; the `exception when others` wrapper is the consistent house pattern and fails in the right direction | Add `ctl_tier_not_honoured` with **as-of-`created_at`** logic (the naive query is all false positives) |
| L11 | **`saveTier` re-rates a live rung with no confirmation while `deleteTier` refuses to touch one** | `pricing/actions.ts:170-176` vs `:205-209` | A speed bump, not a gate — disable-then-delete is two clicks. Already-pinned bookings are genuinely protected | Require the `CHANGE RATE`-style typed confirm + note when raising `fee_bps`/`min_completed` on an enabled rung; record before/after in the audit payload |
| L12 | **The `finance` tier cannot move money** — three layers disagree | `_shared/adminAuth.ts:18,158-160` vs `bookings/actions.ts:27` vs `bookings/[id]/page.tsx:170` | Fails closed, and there are no finance rows today. **Residual:** `forceComplete`/`reopenBooking`/`clearStartedAt` *are* direct service-role writes a finance operator can make | Pick one layer as truth. Note the predictable response — granting `admin` to whoever needs to refund — collapses the whole tier model |
| L13 | **Support tier browses the full user table with emails** | `users/page.tsx:40,155` | Latent (no support rows) and fully audited | Gate the email column on `roleSatisfies(ctx.role,"trust")`, or amend the tier definition |
| L14 | **`/flags` renders config rows as boolean kill switches and documents 5 of 9 keys** | `flags/page.tsx:46-52, 82-89` | No direct loss. **Sharper version:** `bonus_cash_payout_enabled` is seeded `false`, so the red "1 feature is currently paused" banner is *permanently lit* — which is how flipping `controls_alert` off gets absorbed without registering | Add a `kind` distinction; generate the enforcement list from the table |
| L15 | **A broken vesting job can never page** — `vest_bonuses` isn't a registered control; its only detector is `medium` and the pager filters to `critical`/`high` | `20260806330000:31`, `20260806080000:316-322`, `controls-alert:115-117` | No platform loss; rows stay `pending` rather than being lost. Debt to users who earned a credit | Cheapest fix: raise `ctl_bonus_vesting_stalled` to `high` and cut its 2-day grace to a few hours (the sweep is hourly) |
| L16 | **Referral farming is bounded but profitable at ~10:1 on fee cost** | `migration_referrals.sql:6,12` | The "mutual referrals halve the cost" claim is **refuted** — `referred_id` is the primary key, so an account can be referred at most once ever. Loss is capped by `budget_cents`; the attack needs N KYC'd Connect accounts and thousands of dollars of genuine work to realise the credits | The durable point: the header overclaims, and a $10 pay floor makes the mint cost trivial. Raise the qualifying-gig threshold; require `referrals.created_at < booking.created_at`; reject reciprocal pairs |

---

## 3. BOUNDEDNESS TABLE

| Rail | What is supposed to bound the loss | Does the bound hold? |
|---|---|---|
| **Promo (`fee_override`)** | `budget_cents` + `max_redemptions`, enforced by the increment-is-the-check UPDATE (`20260806220000:274-276`) | **NO.** The UPDATE mechanism is sound, but it counts the wrong quantity. `max_benefit_cents` clamps the charge while the delivered rate is uncapped, so real give-away = up to **4.73× budget** above ~$2,120 gigs (F3). Tier-blindness (F7) charges for benefit the tier delivered, so the budget also bounds *less* real discount than intended. Below $2,120 with no tier enabled, the ledger is exact. |
| **Poster discount** | Same `budget_cents` + `max_redemptions`; per-use headroom clamp | **NO.** `settle_booking_benefits` refunds the whole delivered discount at capture without decrementing `redemptions_used`, so the real ceiling becomes `max_redemptions × discount` — **2× budget at shipped defaults, 20× if an operator raises uses reading a 0% burn-down** (F2). |
| **Referral bonus** | `budget_cents`, `max_redemptions`, one-bonus-per-pair index, vest-on-outcome, delivered as a credit not cash | **PARTIALLY.** The accrual UPDATE is the check and the ledger is funded before it exists — that half is sound. But the pair index is predicated on `state <> 'void'`, so a voided pair can be charged again; voids never return budget; and post-vest reversals are uncatchable (F12). Bound holds in aggregate, leaks per-event. |
| **Fee credit** | Structural: a credit can only ever be spent against the headroom between the platform fee and the Stripe floor | **YES for the platform, NO for the user.** The platform never pays cash for a credit (except 2–3c on partial captures, F10b). But the *user's* credit is destroyed by partial capture (F10a), by refund/chargeback on the booking it was spent on (F11), and there is **no expiry, no revoke, and no admin lever** on `bonus_ledger` at all. |
| **Loyalty tier** | Nothing. No budget, no expiry, no re-evaluation by design | **N/A — by construction there is no bound.** Currently dormant (all rungs `enabled=false`). The threshold is a bare count, so a $44.50 self-dealing run buys ~$85 of acceleration on $100 gigs (1.9×) and ~$1,700 on $2,000 gigs (38×) (F15). The differential over 50 real gigs is the real ceiling. |
| **Tips** | `guard_tip_caps`: per-booking `max(2×captured, $200)`, per-count, `$500/24h **per poster**` | **NO on the platform side.** No `application_fee_amount` means the platform funds Stripe processing on every tip; the velocity cap has no earner-side counterpart, so receipt per earner is unbounded across shells. Max subsidy ≈ **$15.40/day per funded poster shell** (F8). |
| **Self-dealing (gig rail)** | `platform_fee_cents`'s Stripe floor (`ceil(0.029a)+30+25`) + `earner_id <> poster_id` | **YES.** A wash trade costs ~3.2%, so it is never profitable — a $10,000 self-dealt gig loses the pair $290.55. This is the single best-designed guard in the money layer. |
| **Stolen card** | Nothing in this codebase. Stripe Radar (unconfigured) + Connect Express KYC on the earner | **NO.** Destination charges with no `on_behalf_of`, no transfer reversal on dispute, daily payouts with no `delay_days`, no per-poster/per-card gig-rail velocity cap, no chargeback-rate or new-account-spend control. ~90–97% recovery on a stolen card, platform eats the full charge plus the dispute fee (F9). |

---

## 4. CONTROL GAPS

Money invariants that are breakable today with **no `ctl_*` watching**:

1. **Campaign recorded spend vs. margin actually given away.** Every existing promo control compares bookkeeping to bookkeeping (`redemptions_used` vs row count, `reserved_cents` vs delivered). None recomputes the fee genuinely foregone. F2 and F3 both write *both sides consistently wrong* and are therefore invisible to all of them.
2. **Fee credit delivered vs. charged.** Nothing asserts `bookings.fee_credit_cents` delivered equals the `bonus_ledger` rows burned against that booking. `ctl_credit_stranded_on_dead_booking` filters `status in ('declined','cancelled')` and no captured payment, so it covers neither the partial-capture shortfall (F10) nor the refunded-booking loss (F11) nor the frozen-on-pending case (L6).
3. **`promotions.spent_cents` for `kind='bonus'` vs `sum(bonus_ledger.amount_cents where state <> 'void')`.** Nothing reconciles them, so voids permanently overstate spend (F12b).
4. **Tier delivery.** Two tier controls exist and both check *configuration* (`below_floor`, `ladder_inverted`). Nothing asserts a booking's pinned rate honoured an enabled rung, so a swallowed `tier_fee_bps` failure is invisible on both the operator and user side (L10).
5. **Tip volume, tips-per-earner, distinct-poster fan-in.** The registry has `ctl_earner_credit_missing` (tips charged but not credited) and nothing else on tips (F8).
6. **Chargeback rate by earner; spend velocity by new account.** Nothing (F9).
7. **Booking concentration between a poster/earner pair.** Nothing — which is what makes the tier count farmable and would also be the first signal of a wash-trading ring (F15).
8. **Reservations parked on `pending` bookings.** `ctl_benefit_never_settled` requires `status in ('verified','declined','cancelled')`, so budget held by an unanswered application is unwatched (F14, L6).
9. **Whether alerting is dispatching at all.** `ctl_alert_dispatch_failing` reads `net._http_response`, so it sees only *attempted* dispatches. No control reads `app_flags` (F5).
10. **Whether a control's data source has a producer.** The framework's four health signals are all about execution. A control reading a table nobody writes returns the passing value and passes all four (F4, F6).
11. **Whether a control's body still matches the one that was reviewed.** `create or replace` is silent; F1 is what that costs.
12. **Money movement vs. `admin_audit_log`.** No control relates Stripe refunds or `payments.refunded_at` to the audit trail (F18).
13. **A `promo_grants` row whose `(kind, fee_bps)` shape no consumer can match** (L2).

---

## 5. FIX ORDER

Grouped by deploy vector. **Ordering hazards are called out inline.**

### Phase 0 — LIVE money and detection defects (this week)

1. **F1 — restore `ctl_escrow_hold_expiring_work_done`** + add anchor-independent `ctl_work_done_never_paid` + `controls.fn_body_sha` / `ctl_control_body_drift`.
 → `supabase db push --linked`. Monitoring only, no app behaviour changes.
 ⚠️ **Hazard:** re-keying `entity_id` from payment to booking will auto-resolve the existing findings with a misleading "no longer returned" note. Resolve them explicitly in the same migration with a truthful note; the same violations reopen under booking ids within the hour.

2. **F5 — `ctl_alert_not_dispatching` + `alert_dispatches` liveness log + 24h expiry on the two alerting flags only.**
 → `supabase db push --linked`, then `cd admin && npx vercel --prod` for the `/flags` copy.
 ⚠️ Log reconcile under its **own** channel or its rows certify a dead pager as alive. ⚠️ Do **not** extend the auto-expiry to `payments_enabled`/`posting_enabled`.

3. **F4 — wire the admin login throttle** (server action) + `ctl_admin_login_not_recorded`.
 → **Both halves, in either order but both.** `supabase db push --linked` **and** `cd admin && npx vercel --prod`.
 ⚠️ **Hazard, and it is the realistic failure:** `gohustlr-admin` does not auto-deploy. Pushing the migration without deploying the console reproduces the exact bug. The new control is written to fire on precisely that half-deployed state — which is the point.

4. **F21 — `controls_digest` timeout → 120000ms** + teach `ctl_alert_dispatch_failing` to rank client-side timeouts lower.
 → `supabase db push --linked`. Do this **before** the noise from #1 and #2 lands, or the false HIGH competes with real findings.

5. **F6 — replace the `stripe_mode` shape heuristic with a provenance check**, seed `stripe_live_mode`, add `controls.requires_flags` + `ctl_control_dependency_missing`.
 → `supabase db push --linked`. **Must land before the live cutover**, and the flag must be flipped **before** the keys are swapped so it lists the rows to delete.

### Phase 1 — Incentive-layer boundedness (before any promo/discount campaign runs, and before a redeem surface ships)

6. **F2 — kind-aware `settle_booking_benefits`** + repair corrupted `spent_cents` from immutable pins + `ctl_campaign_spend_understated`.
 → `supabase db push --linked`. Signature unchanged ⇒ **no edge-function redeploy needed**.

7. **F3 — `capped_promo_bps`; charge what is delivered** + expose `max_benefit_cents` in the console.
 → migration + `cd admin && npx vercel --prod`.
 ⚠️ Drop the superseded `consume_promo_grant` overload **in the same transaction** as the new one — a resolvable stale signature silently restores the bug. ⚠️ Copy change on any live "0% fee" campaign.

8. **F7 — pass the pinned baseline into `consume_promo_grant`;** snapshot `baseline_bps` on the redemption; return `null` when the grant can't beat the baseline or `hit <= 0`.
 → `supabase db push --linked`. **Do 7 and 8 as one migration** — both rewrite `consume_promo_grant` and `settle_booking_benefits`; splitting them means writing the same bodies twice and inviting exactly the reproduction error that caused F1.
 ⚠️ **Do this before enabling any `fee_tiers` rung.** No backfill needed today precisely because no rung is enabled.

9. **F10 + F11 — settle fee credits at the captured amount; restore credits on refund/reversal; re-floor the partial-capture fee unconditionally.**
 → migration **and** `supabase functions deploy stripe-capture-payment`.
 ⚠️ Order: migration first (the function calls the RPC), then the function.

10. **F12 — post-vest void/reverse pass; return budget on void; fix the partial index predicate; add an admin `revokeBonus` with an audit row.**
 → migration + `cd admin && npx vercel --prod`.

11. **F13 + F14 — fix `ctl_discount_without_grant`'s predicate; move poster-discount consumption to accept.**
 → `supabase db push --linked`. Do F13 **before** any poster_discount campaign goes live or the pager becomes noise on day one.

### Phase 2 — Authorization and audit hygiene (console-only, one deploy)

12. **F17** step-up on all seven promotions actions + budget/uses ceilings; **F19** audit-before-mutate on the five surfaces; **F20** `addTeamMember` guards + `setTeamRole` role check; **L11** `saveTier` confirmation; **L12** pick one truth layer for `finance`; **L13** gate the email column.
 → `cd admin && npx vercel --prod`. **Single deploy.**

13. **F18 — `admin-payment-action` writes its own audit row.**
 → `supabase functions deploy admin-payment-action`.

### Phase 3 — Abuse rails (before meaningful live volume)

14. **F8** — application fee on tips + per-earner 24h cap + `ctl_tip_velocity_anomaly`.
 → migration + `supabase functions deploy stripe-tip`.
15. **F9** — `delay_days` on the Express payout schedule; per-poster gig-rail velocity caps at hold time; chargeback-rate and new-account-velocity controls.
 → `supabase functions deploy stripe-connect-onboard stripe-create-payment-intent` + migration. ⚠️ `delay_days` affects only *newly created* Connect accounts; existing ones need a Stripe-side account update.
16. **F16** — admin `capture` op, or correct the runbook and `NO_SCHEDULE` copy. **F15** — distinct-poster or GMV-based tier threshold, **before** enabling any rung.
17. **L1** — ship the promo-code entry screen (client release), **only after** #7, #8 and F2 have landed. Shipping it first makes F3 and L2 live.

---

## 6. TEST GAPS

Following the existing conventions — pure logic in `__tests__/`, migrations parsed off disk with last-writer-wins resolution (`pricing.test.js`, `categories.test.js`), no DB required.

1. **`controlPopulation.test.js` — the highest-value test in this list.** Parse every `create or replace function public.ctl_*` across migrations in filename order; for each control, assert that any load-bearing token present in *any* definition (`earner_done`, `poster_done`, `resolved_at`, `'confirmed'`, `'captured'`, `for update`, `budget_cents`, `max_redemptions`) is still present in the **last** one. I ran this logic against the current tree: **it finds exactly one violation — F1 — and zero false positives across the other 41 controls.** Exclude `entity_id` from the token list (`20260806150000` dropped a benign alias elsewhere; a guard with a known-benign failure gets ignored).

2. **`promoBenefitCap.test.js`** — assert the 4-arg `consume_promo_grant` signature; that `capped_promo_bps` is applied to the returned rate; that `hit` is **not** `least(max_benefit_cents, …)` (pin the original defect textually); that no use is burned when the cap leaves nothing; that the `10000::bigint` widening is present (JS has no int32 overflow, so only reading the cast out of the SQL catches it); and a JS mirror asserting `delivered ≤ cap` across a 4×4×4 amount/bps/cap matrix, including no-tier parity proving the fix is a provable no-op today.

3. **`benefitSettle.test.js`** — assert the live `settle_booking_benefits` branches on `promotions.kind`, and that `promo_benefit_cents` does **not** appear inside the `poster_discount` branch. Plus a JS mirror: full capture of a poster discount settles to `delta = 0`; partial capture scales and never zeroes; and an explicit test documenting that the old fee-counterfactual formula returns 0 at the standing rate, so nobody re-derives it as "equivalent".

4. **`promoBaseline.test.js`** — assert `tier_fee_bps` resolves **before** `consume_promo_grant` in the pin body (if those ever swap, the baseline silently becomes the standing rate again and every other assertion still passes); that the 3-arg overload is dropped; and that every guard the live function accumulated survives (`promotions_enabled`, `revoked_at`, `kind='fee_override'`, `for update of g2`, one conditional UPDATE carrying both ceilings, and **no** `select … budget_cents … into`).

5. **`alertingWatched.test.js`** — assert a control reads `app_flags` for both alerting keys and covers all four config shapes; that liveness comes from an attempts table and **not** `net._http_response`; that reconcile is logged under a different channel than the pager; that every dispatcher logs its attempt (checked on each one's *last* definition); and that the auto-expiry is scoped to the two alerting keys and touches none of `payments_enabled`/`posting_enabled`/`signups_enabled`/`tips_enabled`/`assistant_enabled`/`promotions_enabled`/`bonus_cash_payout_enabled`.

6. **`appFlagsDeclared.test.js`** — parse every `insert into public.app_flags` for seeded keys and every read (`where key = '…'`, `app_flag('…')`, `alert_config('…')`, `.eq("key","…")` in TS) and assert the read set ⊆ the seeded set. **This fails on the current tree with exactly one orphan: `stripe_mode`.**

7. **`adminLoginThrottle.test.js`** — the general rule, not the specific string: any throttle/audit RPC that migrations define and a `ctl_*` reads must have a caller **outside** `supabase/migrations/`. Plus: the caller is `"use server"` and not `"use client"`; `admin_login_blocked` is invoked **before** `signInWithPassword` (reordering makes the throttle a log and every other assertion still passes); the login page no longer contains `signInWithPassword`; and the documented limits (5/15min, 20/15min) are parsed out of the SQL rather than assumed.

8. **`controlRegistryIntegrity.test.js`** — every `fn_name` in a `controls` insert resolves to a `create or replace function public.<name>(` somewhere in the migrations (external checkers excepted).

9. **`feeCreditSettle.test.js`** — JS mirror of the partial-capture matrix asserting that the credit returned to the ledger equals `charged − delivered` computed at the **captured** amount, and that `feeCents ≥ ceil(0.029 × captureCents) + 30` for every `pct ∈ [0.5, 1]` across a bps × amount grid. `__tests__/pricing.test.js` currently has zero references to `platform_fee_after_credit`, headroom, or credits.

---

## 7. WHAT IS SOUND

Do not churn on these; they were attacked and held.

- **`platform_fee_cents`'s Stripe processing floor.** `max(round-half-up(a×bps/10000), ceil(a×0.029)+30+25)`, capped at the amount, `bigint`-widened. It is the single load-bearing guard in the money layer: it makes self-dealing cost ~3.2% (a $10,000 wash trade loses the pair $290.55), it means a 0% promotion never settles at a loss, and it caps what a fee credit can ever be worth. `__tests__/pricing.test.js` parses it off disk so JS and SQL cannot drift.
- **Three immutable pins at booking INSERT** (`amount_cents_quoted`, `fee_bps_quoted`, `fee_credit_cents`, plus `poster_discount_cents`), with the UPDATE branch rewriting them back to `old` for any non-`service_role` caller. This is what makes capture idempotent and what guarantees a rate change never re-prices agreed work — verified: the `saveTier`/`setPlatformRate` comments claiming this are correct.
- **`consume_promo_grant`'s increment-IS-the-check UPDATE.** One conditional statement carrying both `redemptions_used < max_redemptions` and `spent_cents + hit <= budget_cents`, never read-then-decide. Same for `accrue_referral_bonus`, which additionally **deletes** the ledger row when the UPDATE matches nothing — so every credit on the ledger is funded and counted.
- **The two stacking indexes.** One grant per user per promotion, one redemption per booking. `grant_promotion_to_users` inserts `ON CONFLICT DO NOTHING` behind the first, so even a retried admin action cannot double-grant.
- **Vest-on-outcome for referrals.** Requires the referred person's gig to reach `verified`, which requires a captured payment, which requires real Stripe processing on both sides. It genuinely defeats the non-working farmer: a fee credit has zero cash-out value to someone who does no work.
- **Delivering bonuses as credits rather than cash.** `consume_fee_credit` spends only the headroom between the fee and the floor and splits the remainder back — the platform never pays Stripe's processing to honour a credit.
- **`release_booking_benefits` on decline/cancel.** Returns the campaign reserve, the grant use, and the fee credit; deliberately does not touch `bookings` (which would roll back the decline) and explains why.
- **Escrow lifecycle guards.** `completed → verified` requires a captured payment. `bookings_one_active_per_slot`. Mutual completion — neither party alone advances status.
- **MFA/AAL2 re-verified on every request** from the JWT claim, plus `admin_users.status = 'active'`. This is what makes F4 a detection finding rather than a refund path.
- **Audit-before-mutate in `bookings/actions.ts` and `users/[id]/actions.ts`**, with `forceCancel` correctly releasing the hold *before* writing status and throwing "Booking NOT cancelled" on a 403.
- **The control framework's core.** Findings unique on `(control_key, entity_id) where resolved_at is null`; auto-resolve on a control ceasing to return an entity; `run_control` validating `fn_name` against `^ctl_[a-z0-9_]+$` **and** `pg_proc` rather than storing executable SQL in a table; `pg_cron` entries created idempotently; disabled controls auto-re-enabling after 24h. The engine is right — what it lacks is a way to notice that a control's *inputs* or *body* changed.
- **Alert config in `app_flags` rather than a GUC.** The reasoning is correct and the fix for F5 depends on it being a table you can assert on.

---

## 8. RESIDUAL RISK — what only runtime observation can settle

Everything above is static analysis. Six things I could not settle from the code, with exactly what to run.

1. **Does `pg_net` actually abandon the digest dispatch at 5s, and how long does the resulting finding live?** (F21.) `net._http_response` rows are pruned on a TTL, so the false HIGH may auto-resolve the same evening rather than persisting 25h — which changes this from "a standing finding" to "one false page per morning."
 → In a branch DB: `select min(created), max(created), count(*) from net._http_response;` and `select id, status_code, error_msg, created from net._http_response where status_code is null order by created desc limit 20;`

2. **Does GoTrue write an `auth.audit_log_entries` row for a *failed* password grant?** The whole shape of the F4 fix depends on it not doing so. I am confident from the action enum and from `admin_user_login_history` keying on `payload->>'actor_id'`, but I could not execute against the auth schema.
 → In a branch DB: attempt three bad passwords against a throwaway account, then `select payload->>'action', count(*) from auth.audit_log_entries where created_at > now() - interval '5 min' group by 1;` If failures *are* recorded, the control can be simplified — but the throttle still needs wiring, because the audit log cannot *block*.

3. **Whether `payment_intent.canceled` is registered on the live webhook destination.** (F1.) Registered → the row flips to `cancelled`, the admin post-mortem email fires, and `ctl_escrow_hold_lapsed_uncancelled` goes permanently silent. Not registered → the row stays `authorized` and that control fires at day 8. Both are after the money is gone, but they produce opposite `/controls` states.
 → Stripe Dashboard (test mode) → Webhooks → confirm the enabled event list. Then, in test mode, place a manual-capture PI, let it lapse, and check `select status, cancelled_at from payments where …`.

4. **The exact `capturePct` clamp behaviour end-to-end, and the true out-of-pocket on a partial capture.** (F10b.) I derived 2–3c algebraically; I want it observed.
 → Stripe test mode: book a $100 gig, apply a full fee credit, capture at 50% via `CompletionModal` "report a problem", then compare `application_fee_amount` on the resulting balance transaction against Stripe's actual fee on the captured amount. Also read back `bonus_ledger` state for that user — the finding predicts a row stuck at `applied` with 328c of value destroyed.

5. **The real counts behind F6.** `20260806350000:31` says "7 connected accounts and 4 customers"; `PRE_LAUNCH_DATA_RESET.md:173` says 7 and 3. Nobody has recounted, and this is the population that breaks at cutover.
 → Read-only: `select count(*) from stripe_accounts; select count(*) from stripe_customers; select count(*) from stripe_accounts where onboarded;`

6. **Whether any live `fee_override` or `poster_discount` campaign already has corrupted counters, and whether any historical redemption was under-charged.** F2's repair statement is written to reconstruct spend from immutable pins and the captured split — but if any of those pins were ever service-role-rewritten, the reconstruction is wrong.
 → Read-only, before applying the repair: `select p.id, p.kind, p.name, p.spent_cents, p.budget_cents, p.redemptions_used, count(r.*), sum(r.reserved_cents), sum(r.benefit_cents) from promotions p left join promo_redemptions r on r.promotion_id = p.id group by 1,2,3,4,5,6;` Any row where `kind='poster_discount'` and `spent_cents` is well below `sum(reserved_cents)` is a confirmed F2 instance. Do this in a branch DB restored from a production snapshot, not against production.

**One methodological caution for whoever acts on this.** Three of the highest-value findings here (F1, F2, F7) are the same failure: a migration reproduced a function body to change one thing and silently altered another. The fixes above all reproduce bodies again. The `controls.fn_body_sha` pin and the `controlPopulation.test.js` guard are not nice-to-haves — they are the only things standing between this fix round and the next one.