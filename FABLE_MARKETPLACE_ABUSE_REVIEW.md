# FABLE_MARKETPLACE_ABUSE_REVIEW.md

> **✅ RESOLVED (2026-07-11).** The High-severity blockers from this review — **H2** (server-enforced block), **H3** (guaranteed payment for completed work), **H6** (safety-report alerting), **H8** (prohibited-use terms) — are implemented and **deployed**. Deferred by scope: **H9/H10** (later-phase) and **H11/H12** (Stripe-dashboard config / before-OPEN). Full status + evidence: [FABLE_BETA_AUDIT_REPORT.md §4.1.1](FABLE_BETA_AUDIT_REPORT.md). Retained as the audit record.

*Independent review of marketplace abuse/fraud economics and physical-world trust & safety for GoHustlr at commit `a70c9b5`. Companion to [FABLE_BETA_AUDIT_REPORT.md](FABLE_BETA_AUDIT_REPORT.md).*

The differentiating risk of this product is not its fintech backend — that is sound (see the security report). It is that **the platform schedules in-person meetings between strangers, one side of whom is 17–22 years old and identifiable by name, campus, and schedule, and pays real money through instant payouts.** This report treats fraud economics and physical safety with equal weight, because for this population they are equally consequential.

**Confidence legend:** CONFIRMED (source) · CONFIRMED, live-conditional · DEPLOY/DASHBOARD STATE.

---

## Part A — Physical-world trust & safety

### A1. Block is UI-only and the UI lies about it — BLOCKING

**`block-not-server-enforced` — High, CONFIRMED (source), BETA-BLOCKING.** Blocking only inserts a `public.blocks` row and drives a **client-side Browse filter on the blocker's own device** (`blockedIds` is consumed in exactly one place: `src/screens/HomeScreen.js:153`). No RLS policy, trigger, or guard function consults `blocks` on message insert or booking insert:

- `messages_insert` checks only that the sender is a party to the booking (`migration_fix_lifecycle.sql:108-116`, re-asserted `20260624230000_review6_db_fixes.sql:130-138`) — **no block clause**.
- `bookings_insert_own` checks only `auth.uid() = earner_id` (`schema.sql:153`) — **no block clause**.

So a block does **not** sever an existing booking chat, does **not** stop the blocked party from continuing to message (and firing push via `notify()` on every message), and does **not** stop the blocked party from booking more of the blocker's gigs. Meanwhile the block dialog literally reads *"You won't see their gigs and they can't reach you here."* and the confirm toast says *"has been blocked."* (`src/components/MessageSheet.js:38,43`).

**Why this blocks even a closed beta:** it is a safety control on which the app makes a categorically **false promise** to a young user. A student who is being harassed taps Block, is told the channel is closed, and stops documenting the abuse — while the harasser keeps messaging. The minimum blocker is the copy lie (a trivial fix); the proper fix is bidirectional `NOT EXISTS(blocks)` enforcement on `messages_insert`/`messages_read` and on booking insert, plus filtering blocked-party conversations in the Messages hub.

### A2. Safety reports page no one — BLOCKING

**`safety-reports-no-alerting-sla` — High, CONFIRMED (source), BETA-BLOCKING.** `submitReport` is a bare `INSERT` into `reports` with no side effects (`src/lib/moderation.js:11-21`); every call site just shows a local "our team will review this" alert. A repo-wide search confirms **no DB trigger, edge function, email, or push fires on a new report**. The only surfacing is an on-demand admin console page and a count stat that updates when an admin opens it; analytics/error monitoring is stubbed to no-ops (`SENTRY_DSN`/`ANALYTICS_KEY` null). A "Harassment or abuse" report about an in-person incident sits invisible until a human happens to log in, and no code path restricts the reported user's ability to keep posting/booking/messaging pending review.

You cannot broker in-person meetings between strangers, offer a "Report" button, and page no one. **Fix (≈ a day):** an insert trigger → edge function → email/push to a **named on-call human**, a published response SLA, and consideration of auto-mitigation (temporarily restrict a reported user's book/message ability) for high-severity reasons. Confirm the existing enforcement tooling (suspend/ban/delete/takedown exist — see A6) is drilled end-to-end so the paged human actually has a kill switch.

### A3. No age gate; unverified strangers; instant private chat

- **`no-age-verification` — High, BLOCKING (min DOB).** Covered in the security report §5. Relevant here because it compounds A1/A4: the platform may be putting minors in private chats and at strangers' addresses without ever asking their age.
- **`no-id-verification-post-or-book` — High, CONFIRMED (source), before OPEN (conditional on the invite gate).** Stripe Identity is optional and used only as a display badge; `bookJob` and `PostJob` have no verification check (`src/context/JobsContext.js:452-494`; `src/screens/PostJobScreen.js:84`). The higher-risk party — the **poster**, who controls the physical location a student travels to — has no identity requirement, and neither does a stranger who books a student's gig. For a *genuinely closed* invite cohort the invite list supplies vetting; before OPEN beta, gate the in-person flow on the location-controlling party's verified identity (the Stripe Identity plumbing already exists).
- **`grooming-funnel-instant-free-chat` — High, CONFIRMED (source), fast-follow.** Chat is booking-gated, but the gate is trivial: `bookJob` inserts a `pending` booking with **no payment, no poster acceptance, no verification** (`JobsContext.js:452-494`), and messaging is enabled the instant a booking exists (`canMessage` includes `'pending'`, `JobDetailScreen.js:62`; the RLS `messages_insert` has no status predicate). So any adult can post an attractive cheap/high-pay gig, have a student tap Book, and immediately hold a private line. The keyword filter does not detect phone numbers, socials, or "let's talk on Snapchat" — and a DB backstop trigger exists but reuses the same useless term list, so "add me on snap" passes both client and server filters. **Fix:** add contact-info/off-platform-solicitation pattern detection (warn + flag), and consider not enabling free-text chat until the poster accepts.

### A4. Review retaliation & missing safety scaffolding

- **`review-retaliation-no-protection` — Medium, CONFIRMED (source).** Reviews are mutual and the poster rates the student on verification, recomputing the student's public rating everywhere (`JobsContext.js:790,884-901`). There is no double-blind reveal and no shield when a student declines unsafe work or files a report — so a student who pushes back faces a retaliatory low rating, chilling honest safety reporting. **Fix (later):** double-blind reviews; suppress/flag ratings on bookings ended for a documented safety reason.
- **`no-safety-interstitial-runbook` — Medium, CONFIRMED (source).** A repo-wide search for safety guidance ("meet in public," "share location," "safety tips," SOS) returned nothing; the only "safety" UI is the poster-declared task-hazard card (heavy lifting), not personal-safety guidance. There is no first-booking interstitial, no in-gig "Get help / Report now," and no incident-response runbook in the repo. **Fix (an afternoon):** a one-time pre-first-booking safety interstitial, an always-available report/help control during active bookings, and a written incident-response + data-preservation/law-enforcement runbook.

### A5. Accepted residual (state it as a decision, not an oversight)

For a **genuinely closed, small, vetted** beta it is defensible to accept: no poster ID verification, no background checks, students traveling to strangers' addresses. This is a *decision*, not an oversight — it should be recorded in the launch decision with its acceptance conditions (cohort size, vetting method, safety runbook in place) so that in three months it reads as a considered tradeoff.

### A6. Enforcement tooling — what admins can and cannot do

Admins **can** (CONFIRMED sound): suspend/ban (GoTrue ban ~100y + session revoke), force sign-out, delete accounts (cascade), take down/restore jobs, resolve/reopen reports, grant/revoke verification — all audited. Admins **cannot** (see `no-payout-freeze-refund-tooling`, Medium): freeze payouts, reverse a Connect transfer, or issue a refund from the console — those are manual via the Stripe dashboard. That is acceptable at beta scale **only with a written money-incident runbook** (how to refund, reverse a transfer, pause payouts). Without it, the safety/fraud kill switch is incomplete.

---

## Part B — Money-path fairness & fraud economics

### B1. A student can do the work and never get paid — BLOCKING

**`poster-ghosting-hold-expiry` — High, CONFIRMED (source), BETA-BLOCKING.** There is **no auto-capture, cron, or timeout** anywhere (a repo-wide search for `cron|scheduled|auto-capture|auto-release|timeout` in `supabase/` is empty). Combined with Stripe auto-cancelling an uncaptured manual-capture hold ~7 days after **authorization**, this creates two ways a student who did the work goes unpaid:

1. **Poster never marks done.** The mutual-completion design requires both `earner_done` and `poster_done` before status reaches `completed`. If the earner marks done and the poster simply does nothing, the booking never reaches `completed`, verify/capture never becomes available, the hold expires, and the earner cannot be paid. The platform's own deadlock design creates this.
2. **Long-lead bookings.** A slot scheduled more than ~7 days after accept can expire the authorization **before the job even happens**, so capture at verify fails (`HOLD_EXPIRED`).

There is no earner-side escalation, no auto-advance, and no alerting on holds nearing expiry. "Student worked, hold expired, can't be paid" is the single most probable and most reputation-fatal event in this beta.

**Fix (re-scoped from the naive version):** the timeout must cover the *never-marks-`poster_done`* deadlock, not just post-`completed` ghosting — auto-advance / earner escalation N days after `earner_done` + the slot time has passed. Note the arithmetic ceiling: because the hold expires ~7 days after *authorization*, "capture N days after completion" can be impossible for late slots — prefer **capturing at mutual completion** (or at the escalation timeout) and using payout `delay_days` as the dispute window, rather than delaying capture. An open dispute/problem report must **suppress** the auto-capture (partial-capture wins). Add hold-expiry alerting + a manual-capture runbook in the interim.

### B2. Stolen-card cashout has no payout friction — HIGH (config fix)

**`stolen-card-no-payout-friction` — High, CONFIRMED (source), BLOCKING as a config item.** The Connect account is created with **automatic daily payouts and no `delay_days`, no reserve, no first-payout review** (`stripe-connect-onboard/index.ts:102-109`). The escrow PI is a **destination charge** (`application_fee_amount` + `transfer_data.destination`, no `on_behalf_of`, `stripe-create-payment-intent/index.ts:171-185`), making GoHustlr merchant of record and the party liable for a later chargeback while the earner is already paid. There is no per-account/per-card velocity limit anywhere in the money path and only a per-booking $10k cap (no rolling aggregate). The book→accept→done→verify→capture sequence has no time gate, so stolen-card funds convert to a bank payout within ~one payout cycle. The only real friction is Connect KYC (a mule can pass it) and Stripe Radar (DEPLOY/DASHBOARD STATE). **Beta fix is config, not code:** set new Connect accounts to `delay_days ≥ 7` + manual first-payout review in the Stripe dashboard; add velocity/reserve before OPEN signup.

### B3. No chargeback handling — the ring is never caught — HIGH (before OPEN)

**`no-chargeback-dispute-webhook` — High, CONFIRMED (source), before OPEN.** The webhook handles only `payment_intent.succeeded/failed/canceled`, `account.updated`, and the three `identity.*` events (`stripe-webhook/index.ts:60-181`). There is **no `charge.dispute.created`, `charge.refunded`, or transfer-reversal handler**. Because escrow uses destination charges, a stolen-card dispute debits the **platform** balance (plus the ~$15 dispute fee) while the net has already transferred to the earner and paid to their bank; nothing reverses the transfer, decrements `earnings_total`, freezes the account, or even records the dispute — so the ring is never detected reactively. For a closed low-volume beta with a payout delay and manual Stripe monitoring this is survivable; before OPEN it must gain a `charge.dispute.created` handler (record + alert + attempt transfer reversal + freeze pending review). For beta, an **alert-only** handler is acceptable.

### B4. Re-pricing during the pending window

**`job-price-repricing-pending-window` — Medium, CONFIRMED (source).** `guard_jobs_write` pins `pay/pay_type/estimated_hours` only when a booking is `confirmed/completed/verified`; while the booking is still `pending`, the poster may edit these freely (`20260702030000_...:136-154`), and the escrow amount is computed at accept-time from the current job row with no earner re-consent. A poster can list an hourly gig at $30 × 5h (~$150), let the earner book, edit `estimated_hours` 5→1, then accept — funding only $30 while the earner works 5 hours. Capped because an earner who notices before starting can cancel costlessly (and `counter_offer`, if set, pins the rate). **Fix:** treat a pending booking as pricing-locking (extend `has_active` to include `pending`), or snapshot the agreed gross onto the booking at book-time and charge that.

### B5. Collusion & Sybil economics (before OPEN)

- **`collusion-self-dealing-undetected` — Medium, CONFIRMED (source).** Only same-account self-booking is blocked (`earner_id = poster_id`). Two distinct accounts run by one person are indistinguishable from a real transaction; there is no shared-device/IP, saved-card-fingerprint, or payout-vs-card-owner correlation. Each cycle launders card funds A→B for the 10% fee and inflates B's public `earnings_total`, XP, completed count, and rating. Reviews are structurally constrained (verified booking + one-per-direction unique index), so review-ring flooding costs one real paid booking each — a deterrent, not a wall.
- **`sybil-multiaccount-cheap` — Medium, CONFIRMED (source).** Any email + email-verify only, no phone/device binding; `.edu` is an optional badge, not a signup/transaction gate. This makes the Sybil accounts that power B2/B5 essentially free. **The invite gate (security report §2) is the beta control for this**; before OPEN, add phone/OTP or device attestation and consider gating posting/booking or payout eligibility behind verification.

### B6. Notification-channel phishing

**`send-push-notification-abuse` — Medium, CONFIRMED (source) *(elevated from Low)*.** `send-push` authenticates the caller and requires a shared booking, but the anti-spoof check counts **any** booking regardless of status — a single declined or cancelled booking permanently entitles the caller to notify that user. Within those bounds the caller can set an authoritative-looking type from the whitelist (`system`/`payment`/`review`) plus arbitrary title/body, delivered to the target's push **and** persisted to their inbox; the 30/min cap **fails open** if `push_send_rate` is unreachable (`send-push/index.ts:38-45,53-67,72-101`). A declined counterparty sending `type='payment', title='GoHustlr Payments', body='Your payout failed, verify your card at …'` is a phishing primitive against students. **Fix:** restrict the anti-spoof query to active booking statuses; reserve `system`/`payment`/`review` for server-side triggers (force user sends to `message`/`update`); decide whether fail-open is acceptable and alert on the "cap NOT enforced" log line.

### B7. Cancellation & hold-release edges

- **`cancel-hold-failopen-7day` — Medium, CONFIRMED (source).** Best-effort hold release; on double failure the booking is `cancelled` in the DB but the authorization hold lingers on the payer's card up to ~7 days with no in-app indication and no proactive reconcile (`JobsContext.js:764-779`). No fund loss, but a poster believes they were refunded while their balance is short. **Fix:** capture the `bookingId`/`paymentIntentId` for proactive voiding and a short-interval reconcile instead of waiting out the 7-day expiry.
- **`decline-hold-before-write` — Low, CONFIRMED (source).** `declineBooking` releases the hold **before** the guarded status write — the reverse of `cancelBooking`'s deliberately safe ordering; if the write fails after a successful release, a re-acceptable pending booking has its hold voided (`JobsContext.js:694-721`). Mirror the cancel ordering.
- **`cancellation-fee-false-money-copy` — Low, PARTIALLY-CORRECT (recalibrated from Medium).** The poster-facing cancel copy says "a cancellation fee of $X applies to the worker," but no money moves (only a `cancellation_fee` number is written and the hold is released). The worker is **not** shown or told a fee (contradicting a broader initial reading), so this is one-sided misleading copy, not a two-party money defect. Also, the guard does not pin `cancellation_fee` (either party can write an arbitrary value), but nothing reads it to move money, so tampering is cosmetic. **Fix:** change the poster copy to "This releases the payment hold; no charge is made," or implement a real transfer; pin the column.

### B8. Tips & lifecycle nits

- **`tip-idempotency-key-design` — Low, CONFIRMED (source).** The key `tip_${bookingId}_${cents}` means a legitimate second same-amount tip is silently dropped and returns `{success:true}` (false success), while distinct amounts each mint a real charge with **no cumulative per-booking cap** — every charge is to the poster's own card and pays the real earner (not theft), but it enables unbounded aggregate charging and reputation inflation via collusion. Enforce a cumulative cap; distinguish the no-op replay from a fresh success; require `Number.isInteger(tipCents)`.
- **`hourly-topup-missing` — Low, CONFIRMED (source).** No path to pay for extra hours on an over-run hourly gig (capture is bounded by the authorized amount; the only extra channel is a tip). Product decision, not a launch blocker.
- **`jobs-status-unguarded` / `amendment-unscoped-core-unlock` — Low, CONFIRMED (source).** `jobs.status` is client-trusted (a poster can hide a live gig; a crafted insert can book a completed/cancelled job) — integrity/UX only, no money attached. The amendment `accepted` unlock is earner-self-settable, unscoped to the note, and persistent until cleared — but `pay/pay_type/estimated_hours` stay pinned, so the economic core is protected; this is term-drift/trust, not fund risk.

---

## Part C — Priority summary for this report

| Priority | Finding | Nature of fix |
|---|---|---|
| **Blocking** | A1 block enforcement + false copy | Code (copy now; enforcement fast-follow) |
| **Blocking** | A2 safety-report alerting + on-call + enforcement drill | Code + operational |
| **Blocking** | B1 poster-ghosting / hold-expiry (auto-capture + earner escalation + alerting) | Code + Stripe config |
| **Blocking (config)** | B2 payout `delay_days` ≥ 7 + first-payout review | Stripe dashboard |
| **Blocking (min)** | A3 age floor (DOB) | Code (see security report) |
| Before OPEN | A3 poster ID verification · B3 chargeback handler · B5 collusion/Sybil detection | Code + policy |
| Fast-follow | A4 review shield + safety interstitial/runbook · B4 pending re-price lock · B6 push type/status hardening · B7 hold-release reconcile | Code |

The physical-safety cluster (A1–A3, A6) and the pay-guarantee gap (B1) are where "we knew and shipped anyway" would be indefensible for a marketplace of students meeting strangers in person. Everything else is priced on the beta being **genuinely closed** — which is itself a blocking control (security report §2).
