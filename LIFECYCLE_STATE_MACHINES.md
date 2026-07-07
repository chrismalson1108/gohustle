# LIFECYCLE STATE MACHINES — GoHustlr

*Verified 2026-07-07 at commit a70c9b5 (master). All claims cited to `path:line` against real source under `/Users/chrismalson/Documents/gohustle/`. Read-only pass; nothing modified.*

This document maps every stateful lifecycle in the GoHustlr platform (mobile Expo app `src/`, Next.js web `web/`, admin console `admin/`, Supabase Postgres + **23** Deno edge functions (AUDIT_REPORT.md/CLAUDE.md say 24 — off by one vs. disk; verified 23 dirs under `supabase/functions/`, no `_shared`)). For each lifecycle it records: the exact state strings and where the CHECK/enum lives; the allowed transitions; who can trigger each; the server-side validation that is required and whether it exists; the client and server enforcement locations; what a malicious client could attempt; race-condition risks; and the tests that should exist.

---

## CANONICAL ENFORCEMENT NOTE (read this first)

The **bookings** state machine — the only lifecycle where money moves — is enforced by a single SECURITY DEFINER `BEFORE UPDATE`/`BEFORE INSERT` trigger function, `public.guard_bookings_write()`. This function has been redefined in full (each migration does a `create or replace`) roughly eleven times across review rounds. **The last-applied definition wins.** Migrations apply in timestamp order via `supabase db push`, so the authoritative current version is:

> **`supabase/migrations/20260702030000_guard_pins_and_slot_delete_policies.sql:14-119`**

Two properties of this guard are load-bearing for the whole audit:

1. ⚠️ **It SILENTLY REVERTS illegal writes. Risk:** for a disallowed field change or transition, the trigger sets the column back to its old value (`new.status := old.status`, `new.<field> := old.<field>`) rather than raising an exception. A malicious client PATCH therefore returns **HTTP 200 with the row unchanged** — no error surfaces to the attacker, so tests/monitoring that key on error codes will not detect a blocked-write attempt. Any test of this guard MUST assert the *row is unchanged after* a 200, not that an error was thrown. (The one exception is the separate `guard_started_booking_cancel` trigger, which RAISES.)
2. **The service role bypasses it** (`20260702030000...:22-24`). Every trusted state change that a client is forbidden to make directly (confirm, capture-gated verify) is therefore routed through a service-role edge function.

⚠️ **`jobs.status`, by contrast, has NO transition guard and is entirely client-trusted (see §1). Risk:** a poster can PATCH their own `jobs.status` to any allowed enum value at will. Blast radius is feed/UI integrity only (no money is tied to `jobs.status`). `bookings.status` is the heavily-guarded machine.

---

## 1. JOB LIFECYCLE (`jobs.status`)

### Current states
- DB CHECK on `jobs.status`: `'open'`, `'booked'`, `'completed'`, `'cancelled'` — `supabase/schema.sql:40`.
- Values actually written by application code: `'open'`, `'completed'`, `'cancelled'`.
- **`'booked'` is a DEAD enum value** — no code path in `src/`, `web/lib`, `web/components`, `shared/`, or `supabase/functions/` ever writes `jobs.status='booked'` (`bookedJobs` at `src/context/JobsContext.js:1051` is an unrelated local array name).

### Allowed transitions (as driven by code)
| From | To | Trigger |
|---|---|---|
| (insert) | `open` | `addJob` — DB default `'open'`; optimistic state uses `status:'open'` (`src/context/JobsContext.js:1025`; `web/lib/jobs.tsx:1050`) |
| `open` | `completed` | inside `verifyAndRate`, only when no other active booking remains on the job (`src/context/JobsContext.js:872-877`; `web/lib/jobs.tsx:884-887`) |
| `open` | `cancelled` | `deleteJob` — soft-delete (`src/context/JobsContext.js:949`; `web/lib/jobs.tsx:970`) |

### Who can trigger each transition
- **Poster only**, via direct PostgREST `.from('jobs').update(...)`. There is **no edge function** for job status; all writes are client-driven.

### Server-side validation — required vs. exists
- **RLS (exists):** `jobs_update_own ... using (auth.uid() = poster_id)` — `supabase/schema.sql:135`. Only the poster can update their own job. ✅
- **`guard_jobs_write()` trigger** (`supabase/migrations/20260702030000...:122-173`): pins **pay, pay_type, estimated_hours** always while a booking is active, and pins title/category/location/lat/lng/description/hazards unless an accepted amendment exists. It **does NOT reference `new.status`.**
- **MISSING — no transition guard on `jobs.status`.** The CHECK constrains only the *value set*, not the *transition graph*. No trigger validates status moves.

### Current code location enforcing it
- Client: `verifyAndRate` / `deleteJob` in `src/context/JobsContext.js` and `web/lib/jobs.tsx`.
- Server: `jobs_update_own` RLS (`schema.sql:135`) + `guard_jobs_write` (`20260702030000...:122-173`) — neither of which validates status.

### Missing validation (what a malicious client could attempt)
- ⚠️ **Risk:** A poster can PATCH their own `jobs.status` to any of `open`/`booked`/`completed`/`cancelled` at will, regardless of the booking state on that job. Setting `completed` on a live gig is a feed/UI-integrity issue; setting `cancelled` soft-deletes the poster's own gig (benign). **No money is tied to `jobs.status`**, so blast radius is feed integrity, not funds.

### Race-condition risks
- The "close the job" step in `verifyAndRate` queries for other active bookings, then writes `completed` non-atomically (`src/context/JobsContext.js:868-877`). On a multi-slot gig, two concurrent verifiers could each see "no others remain," but the write is idempotent (`completed` either way). Low risk.

### Tests that should exist
- Non-poster cannot update a job's status (RLS).
- **Poster forcing `jobs.status='completed'` on a job with active bookings — currently UNGUARDED; a test would expose this.**
- Multi-earner gig: verifying one booking must not close the job while other bookings are active.

---

## 2. JOB / BOOKING ACCEPTANCE LIFECYCLE (`bookings.status: pending → confirmed | declined`)

### Current states
`bookings.status`: `'pending'`, `'confirmed'`, `'completed'`, `'verified'`, `'declined'`, `'cancelled'` — CHECK at `supabase/migration_fix_lifecycle.sql:25-27`. (The base `schema.sql:70` CHECK was narrower — `pending/confirmed/completed/cancelled` — and the lifecycle migration expanded it to add `verified` and `declined`.) Status metadata + display labels: `shared/lifecycle.js:5-12`.

### Allowed transitions
| From | To | Meaning |
|---|---|---|
| `pending` | `confirmed` | poster accepts (escrow verified) |
| `pending` | `declined` | poster rejects |

### Who can trigger each transition
- **`pending → confirmed`** — the poster who owns the job. Client: `acceptBooking` (`src/context/JobsContext.js:659-692`; `web/lib/jobs.tsx:671-697`) → edge fn `stripeEdge.acceptBooking(bookingId)` with a retry ladder (`acceptWithRetry`, delays `[1500,3500]`). Permanent (non-retried) codes: `NO_ESCROW`, `Unauthorized`, `Forbidden`, `Booking not found`, `This booking can no longer be accepted.` (`src/context/JobsContext.js:646-652`).
- **`pending → declined`** — the poster. Client: `declineBooking` (`src/context/JobsContext.js:694-721`; `web/lib/jobs.tsx:699-726`) — best-effort `stripeEdge.cancelPayment` to release any hold, then PATCH `status='declined'`.

### Server-side validation — required vs. exists (this is the strongest guard in the app)
**`pending → confirmed`:**
- **Edge fn `accept-booking`** (`supabase/functions/accept-booking/index.ts`), service role. Validates:
  - caller is `job.poster_id` (`:41`);
  - booking is `pending`, else 409 (`:43-45`);
  - a `payments` row with a `payment_intent_id` exists, else `NO_ESCROW` (`:48-52`);
  - **re-fetches the PaymentIntent from Stripe and requires `pi.status === 'requires_capture'`** — i.e. a real authorization hold (`:56-62`);
  - only then writes `status='confirmed'` **guarded by `.eq('status','pending')`** so a concurrent earner-withdraw can't be clobbered (`:72-77`; 0-row update → `BOOKING_CHANGED` 409).
- **`guard_bookings_write` FORBIDS a client from writing `pending→confirmed` directly** — the poster branch's allowed transition set excludes it (`20260702030000...:71-79`). The service-role edge fn (guard-exempt, `:22-24`) is therefore the **sole** confirm path. ✅ Rationale documented in `20260625030000_review11_escrow_confirm.sql`.

**`pending → declined`:**
- Guard poster branch allows `pending → declined` (`20260702030000...:72`). The earner branch has no `declined` path (earner can only reach `cancelled`) — correct. Slot freed by `sync_slot_taken` trigger on the status change (`20260624220000_review5_db_fixes.sql`). Hold release authorized in `stripe-cancel-payment` (poster or earner only, `:38-40`).

### Current code location enforcing it
- Client: `acceptBooking` / `declineBooking` (`src/context/JobsContext.js:659-721`; `web/lib/jobs.tsx:671-726`).
- Server: `accept-booking/index.ts` (whole file) + `guard_bookings_write` poster branch (`20260702030000...:71-79`).

### Missing validation
- None material for acceptance. The pre-round-11 hollow check (a `payments` row merely existing at PI-creation) was closed: the guard now forbids client confirm entirely and the edge fn re-fetches live Stripe state.

### Race-condition risks (all handled)
- Double-accept → edge fn returns `alreadyConfirmed` if already `confirmed` (`:42`).
- Concurrent earner-withdraw during accept → `.eq('status','pending')` predicate + `BOOKING_CHANGED` 409 means accept loses cleanly.
- Retry ladder is safe because the edge fn is idempotent.

### Tests that should exist
- Poster cannot confirm without a Stripe `requires_capture` PI (direct PATCH `pending→confirmed` → row stays `pending`, HTTP 200).
- `accept-booking` rejects non-poster (403), non-pending (409), missing payment (`NO_ESCROW`).
- Concurrent accept vs. earner-cancel → exactly one wins; never a confirmed booking with a released hold.
- Double-accept is idempotent.

---

## 3. JOB CANCELLATION LIFECYCLE (`bookings.status → cancelled`)

### Current states / transitions
| From | To | Who |
|---|---|---|
| `pending` | `cancelled` | earner (withdraw) or poster |
| `confirmed` | `cancelled` | earner or poster (records a cancellation *fee* if poster cancels) |

`completed`/`verified` → `cancelled` is **not** allowed (guard reverts).

### Who can trigger each transition
- Earner or poster of the booking, via client `cancelBooking` (`src/context/JobsContext.js:725-788`; `web/lib/jobs.tsx:728-785`). No dedicated edge function for the status change; the hold release goes through `stripe-cancel-payment`.

### Client-side flow (`cancelBooking`)
1. Blocks if status ∉ {pending, confirmed} (`:730`).
2. Blocks if `booking.startedAt` is set — "worker has started, open a dispute" (`:736`).
3. If poster + `confirmed`: computes a **display-only** cancellation fee = `max(5, round(effectivePay*0.15))` (`computeCancellationFeeAmount`, `:126-128`; effective pay `:118-124`). **No money moves** — recorded to `bookings.cancellation_fee` only (`:741-743`).
4. **Writes the guarded booking UPDATE FIRST, before releasing the hold** (`:764`) — deliberate ordering so a rejected cancel doesn't void a live hold (`:758-761`).
5. Then best-effort `stripeEdge.cancelPayment` with one retry (`:775-779`); frees the slot.

### Server-side validation — required vs. exists
- **Guard transition rules (exist):** poster branch allows `pending→cancelled` and `confirmed→cancelled` (`20260702030000...:72-73`); earner branch allows `cancelled` from `pending`/`confirmed` (`:109-111`).
- **Dedicated hard-error trigger `guard_started_booking_cancel`** (`supabase/migrations/20260629190000_job_start_cancel.sql:26-43`): RAISES `Cannot cancel a job that has already started` when `new.status='cancelled' and old.started_at is not null`. This is a **separate `BEFORE UPDATE` trigger** (`trg_guard_started_booking_cancel`) that raises (unlike `guard_bookings_write`, which silently reverts), so the client gets a real error and its rollback path fires.
- **`cancellation_fee` write authorization:** poster branch pins `cancellation_fee` to old unless `old.status='confirmed' and new.status='cancelled'` (`20260702030000...:64-66`); earner branch pins it always (`:101`). Only the poster's confirmed→cancelled path may author a fee. ✅
- **Hold release:** `stripe-cancel-payment` requires caller be poster or earner (`:38-40`), rejects `completed`/`verified` (`:43-45`), rejects if `started_at` set (`:49-51`), and rejects a captured payment (`:67-69`). ✅

### Current code location enforcing it
- Client: `cancelBooking` (`src/context/JobsContext.js:725-788`).
- Server: `guard_bookings_write` (`20260702030000...:64-66,72-73,101,109-111`), `guard_started_booking_cancel` (`20260629190000_job_start_cancel.sql:26-43`), `stripe-cancel-payment/index.ts:38-69`.

### Missing validation / product gaps
- ⚠️ **Risk (product gap):** the **cancellation fee is cosmetic** — no charge is levied and nothing is paid to the wronged worker; only `bookings.cancellation_fee` is recorded (display-only). This is clearly commented as intentional but is a *product gap* if beta expects TaskRabbit-style enforced fees.

### Race-condition risks
- **Cancel vs. start:** earner sets `started_at` concurrently with a poster cancel. Handled — the DB write runs first; if `trg_guard_started_booking_cancel` raises, the client rolls back optimistic state (`:765-769`), and the hold-release only runs *after* a successful DB write, so a started booking never has its hold voided. ✅
- **Cancel vs. accept:** earner withdraws `pending→cancelled` while poster accepts. `accept-booking`'s `.eq('status','pending')` predicate makes accept lose (`BOOKING_CHANGED`). ✅
- **Slot free is fire-and-forget** (`.update({taken:false})` not awaited, `:780`), but `sync_slot_taken` is the server-side source of truth on the status change, so `taken` self-heals. ✅

### Tests that should exist
- Cannot cancel `completed`/`verified` (guard revert + `stripe-cancel-payment` 409).
- Cannot cancel after `started_at` (hard raise).
- Poster confirmed-cancel records a fee; earner cancel and pending-cancel record none.
- Hold is released exactly once; webhook `payment_intent.canceled` reconciles a missed release.

---

## 4. JOB COMPLETION LIFECYCLE (`confirmed → completed → verified`)

### Current states / transitions
| From | To | Meaning |
|---|---|---|
| `confirmed` | `completed` | both `earner_done` AND `poster_done` are true (mutual completion) |
| `completed` | `verified` | poster verifies + rates; escrow captured |

`bookings.earner_done` / `bookings.poster_done` are the two boolean flags that gate the mutual step. Helper `nextStatusOnDone(booking, side)` advances only if the *other* side is already done (`shared/lifecycle.js:30-33`).

### Who can trigger each transition
- **`earner_done`** — the earner. Client `markEarnerDone` (aliased `markJobComplete`), sets `earner_done=true`; if `posterDone` already true, also sets `status='completed'` + `completed_at`; optionally writes `completion_photos`/`before_photos` (`src/context/JobsContext.js:531-558`; `web/lib/jobs.tsx:562-591`).
- **`poster_done`** — the poster. Client `markPosterDone`, symmetric (`src/context/JobsContext.js:561-579`; `web/lib/jobs.tsx:593-613`).
- **`completed → verified`** — the poster. Client `verifyAndRate` (`src/context/JobsContext.js:790-907`; `web/lib/jobs.tsx:798-913`) → edge fn `stripe-capture-payment`.

### Server-side validation — required vs. exists

**Mutual completion (genuinely enforced server-side, not just client):**
- Guard **poster branch:** `confirmed→completed` allowed **only when `new.earner_done AND new.poster_done`** (`20260702030000...:74`); the poster's own write of `earner_done` is pinned to old (`:54`) — a poster cannot forge the earner's done flag.
- Guard **earner branch:** `confirmed→completed` allowed **only when `old.poster_done`** (`:109-111`); the earner's write of `poster_done` is pinned to old (`:93`); the earner may set `earner_done` only while status ∈ {confirmed, completed} (`:105-107`).
- **Net effect:** neither party alone can reach `completed`; both flags must be true and each party may author only its own flag. ✅
- `completion_photos`/`before_photos`: poster branch pins both to old (`:55-56`) → a poster can't blank the earner's proof-of-work.

**`completed → verified` (round-13 fix):**
- Guard poster branch allows `completed→verified` **only when a `payments` row with `status='captured'` exists for the booking** (`20260702030000...:75-77`; introduced `20260625040000_review13_verify_capture.sql:76-78`). 'captured' is set only after a real Stripe capture that ran `credit_earnings`, so **a poster cannot verify without the earner having been paid.** A direct PostgREST verify with no capture is reverted. ✅
- **Edge fn `stripe-capture-payment`** (service role): caller must be poster (`:55`); status must be `completed`/`verified` (`:56-58`); handles partial capture for disputes, floored at 50% (`:44`), requiring a `disputeReason` (`:37-42`); re-checks the earner's payout account is still onboarded (`:86-95`); credits earnings via the atomic `credit_earnings` RPC (`:149`).

**`verifyAndRate` client sequence** (`src/context/JobsContext.js:790-907`):
1. Content-filters the review (`findProhibited`) before any money moves (`:795`).
2. Validates booking exists and status ∉ {verified, declined, cancelled} (`:803-811`).
3. Calls `stripeEdge.capturePayment(bookingId, pct?, disputeReason?)` — **capture happens BEFORE the status write** (`:815`).
4. Writes `status='verified'`, `earner_rating`, `review_text`, `payment_method` (`:823-831`); if this write fails it **throws** (money already moved) so the poster retries (`:836`).
5. Optional tip (`tipCents>=50`) via `stripeEdge.tip` (`:851`).
6. Closes the job if no other active bookings remain (`:867-879`).
7. Inserts one `reviews` row (guarded against double-insert, `:883-899`) + `recompute_user_rating` RPC.

### Earnings credit — atomicity
- `credit_earnings(p_payment_id)` (`20260624220000_review5_db_fixes.sql`): a single conditional UPDATE flips `earnings_credited` false→true **only if** `status='captured'` and amount>0, then increments `profiles.earnings_today/week/total` in the same transaction. Called by **both** the capture edge fn (`stripe-capture-payment:149`) and the `payment_intent.succeeded` webhook (`stripe-webhook:69-71`) — **idempotent, exactly-once** even under concurrent capture+webhook. EXECUTE revoked from public/anon/authenticated. ✅

### Current code location enforcing it
- Client: `markEarnerDone`/`markPosterDone`/`verifyAndRate` in `src/context/JobsContext.js` and `web/lib/jobs.tsx`.
- Server: `guard_bookings_write` (`20260702030000...:54-56,74-77,93,105-111`), `stripe-capture-payment/index.ts`, `credit_earnings` RPC.

### Missing validation / risks
- **Capture-before-status-write is deliberate ordering.** If the client dies between capture and the status PATCH, the earner is paid but the booking stays `completed`. The next verify retry is safe: capture is idempotent (payment already 'captured', edge fn falls through to credit), then the status write succeeds. Recoverable. ✅
- ⚠️ **Risk — fee inconsistency to flag [Needs Fable Review]:** the platform fee is hardcoded `10%` in `stripe-create-payment-intent:100` (`Math.round(amountCents*0.10)`) and in full-capture (`stripe-capture-payment:129`, `*0.10`), but the web UI references a `SERVICE_FEE_PCT` constant from `@/lib/config` for display. **Verify `SERVICE_FEE_PCT === 10%`** or the earner sees a different fee than is charged (`web/lib/config.ts` not read in this pass).
- **Tip double-credit** is prevented by a `tip_ledger` unique on `payment_intent_id` + `claim_and_credit_tip` claim flag (`20260624240000_review7_db_fixes.sql`) + Stripe idempotency key `tip_${bookingId}_${cents}` (`stripe-tip:78`). The old non-idempotent `credit_tip` was dropped (`20260707050000_drop_dead_credit_tip.sql`). ✅
- `recompute_user_rating` + review insert are separate PostgREST calls after the money write; a failure there leaves the rating stale but the money correct. Review insert is idempotency-guarded (`:883-887`).

### Tests that should exist
- Neither party alone advances to `completed` (attempt earner-only, then poster-only PATCH → stays `confirmed`).
- Poster cannot verify without a captured payment (direct PATCH `completed→verified` with no capture → reverts).
- Capture + webhook concurrency credits earnings exactly once.
- Partial capture requires a reason, floors at 50%, records a `disputes` row.
- Double-verify does not double-insert the review nor double-credit.
- Tip: idempotent replay + mid-way failure both credit exactly once.

---

## 5. AMENDMENT FLOW (`bookings.amendment_status`)

### Current states
`'none'`, `'pending'`, `'accepted'`, `'declined'` — CHECK at `supabase/migration_fix_lifecycle.sql:20-22`.

### Allowed transitions
| From | To | Who | Client fn |
|---|---|---|---|
| `none` | `pending` | **poster** proposes | `proposeAmendment` (`src/context/JobsContext.js:1118-1125`; `web/lib/jobs.tsx:1060-1065`) |
| `pending` | `accepted` / `declined` | **earner** responds | `respondToAmendment` (`src/context/JobsContext.js:1127-1136`; `web/lib/jobs.tsx:1067-1074`) |
| any | `none` (+ clear note) | poster (after edit / decline) | `clearAmendment` (`src/context/JobsContext.js:1138-1141`; `web/lib/jobs.tsx:1076-1079`) |

> **⚠️ DIRECTION CONTRADICTION — CLAUDE.md is WRONG here.** CLAUDE.md's "Amendment Workflow" section says *"Earner proposes ... Poster responds."* **The code is the opposite: the POSTER proposes, the EARNER responds.** Evidence: `proposeAmendment` reads from `state.posterBookings` and notifies `booking.earner.id` (poster is the caller); `respondToAmendment` notifies the poster (earner is the caller). The guard confirms the code direction (below). **Flag this doc/code contradiction to Fable.**

### Who can trigger each transition
- Poster: propose (`none→pending`) and clear (`→none`).
- Earner: respond (`pending→accepted|declined`).
- No edge function — all direct PostgREST writes gated by the guard.

### Server-side validation — required vs. exists
- **Guard poster branch (exists):** `if new.amendment_status is distinct from old and new.amendment_status not in ('pending','none') then new.amendment_status := old` (`20260702030000...:67-70`). So the poster can only *propose* (`pending`) or *clear* (`none`) — **cannot self-accept** an amendment (which would unlock core-term editing). ✅
- **Guard earner branch:** does **not** pin `amendment_status`, so the earner may set `accepted`/`declined`. (Asymmetry is intentional.)
- **Amendment-note authorship:** the latest guard poster branch does **not** pin `amendment_note`, so the poster authors the note (correct, since the poster proposes). The earner branch pins `amendment_note := old` (`:98`) so the earner can't rewrite the poster's note. ✅
- **Consequence gate (`guard_jobs_write`):** core job fields unlock for editing only when `exists(booking with amendment_status='accepted')` (`20260702030000...:145-163`). An amendment must be *earner-accepted* before the poster can change locked terms. ✅

### Current code location enforcing it
- Client: `proposeAmendment`/`respondToAmendment`/`clearAmendment` in `src/context/JobsContext.js` and `web/lib/jobs.tsx`.
- Server: `guard_bookings_write` (`20260702030000...:67-70,98`) + `guard_jobs_write` (`...:145-163`).

### Missing validation (what a malicious client could attempt)
- **No status/time constraint on proposing.** A poster can propose an amendment on any of their bookings regardless of booking status. Low impact — editing unlocks only if the earner accepts, and `guard_jobs_write` only pins while a booking is `confirmed/completed/verified`.
- **`accepted` is sticky.** Once `accepted`, core-edit stays unlocked until `clearAmendment` resets to `none`; `clearAmendment` is client-driven and could be skipped, leaving the job editable. Consider a server auto-clear after edit.
- **The earner branch does not pin `amendment_status`** — an earner could write `pending`/`none` in addition to `accepted`/`declined`. Likely harmless but not clearly intended.
- **No amendment audit trail** — the note is overwritten in place on the booking row; prior proposals are lost.

### Race-condition risks
- Low. The single-column status change is guarded; concurrent propose/respond would each pass or revert independently. No money is tied to amendment status directly.

### Tests that should exist
- Poster cannot set `amendment_status='accepted'` directly (guard revert).
- Core job fields remain locked until an accepted amendment exists.
- Verify the earner-branch behavior (earner CAN currently write `pending`/`none`) is acceptable.

---

## 6. EXPENSE LIFECYCLE

### There is NO approval/rejection/review machine. Expenses are a private personal tax tracker.

This is the explicit answer to "expense approval/rejection": **it does not exist, and here is why.**
- The `public.expenses` table is **owner-only RLS on all four verbs**: `expenses_select_own`, `expenses_insert_own`, `expenses_update_own`, `expenses_delete_own`, each `auth.uid() = user_id` (`supabase/migration_expenses.sql:20-27`).
- **No `status`, `approved`, `reviewed`, or `rejected` column exists** on `expenses` (schema `:5-14` + `20260629200000_job_tied_expenses.sql`, which only adds `booking_id` + `miles`).
- No edge function, admin action, or counterparty path touches expenses.
- The **admin console has no expenses page** (`admin/app/(console)/` contains audit, bookings, jobs, moderation, payments, support, users — no expenses).

### Current states
Effectively **{exists, deleted}** — a plain CRUD record with no lifecycle machine.

### Transitions & who
| Action | Client fn | Auth |
|---|---|---|
| create | `addExpense` (`src/lib/expenses.js:19-36`) | owner (RLS insert) |
| read | `fetchExpenses` (`src/lib/expenses.js:9-17`) | owner (RLS select) |
| delete | `deleteExpense` (`src/lib/expenses.js:56-59`) | owner (RLS delete) |
| income (parallel) | `addIncome`/`fetchIncome`/`deleteIncome` on `income_entries` (`src/lib/expenses.js:61-84`) | owner |

### Server-side validation — required vs. exists
- Owner-scope RLS is the whole guard. No amount/category CHECK beyond `amount numeric(10,2) not null` (`migration_expenses.sql:8`). `booking_id` FK is `on delete set null` (`20260629200000...:10`).
- **MISSING:** no server validation that `booking_id`, if set, belongs to the user. A user could tie an expense to any booking id they can guess — but the display-title lookup is client-side over the user's own bookings (`src/lib/expenses.js:41-54`), so the effect is cosmetic only. Low risk (private data).

### Race-condition risks
- None material — single-owner private records.

### Tests that should exist
- User A cannot read/delete User B's expenses (RLS).
- Deleting a booking nulls `expenses.booking_id` (FK), doesn't delete the expense.

---

## 7. RECEIPT / UPLOAD LIFECYCLE (Storage buckets)

### Bucket privacy posture (verified)
| Bucket | Public? | Stored as | Read policy | Migration |
|---|---|---|---|---|
| `receipts` | **PRIVATE** (`public=false`) | object path | owner-only `receipts_owner_read` (folder[1]=uid) | `migration_receipts_private.sql:3-9` (was public in `migration_expenses.sql:30-36`, flipped private) |
| `completion-photos` | **PRIVATE** | bare path (new) / legacy full URL | **party-scoped** `completion_party_read` — uploader OR either booking party | `20260707010000_private_completion_photos.sql:17-45` (was public in `migration_completion_photos.sql`) |
| `chat-photos` | **PRIVATE** | path | party-scoped | `20260701000000_private_chat_photos.sql` |
| `avatars` | public | full URL | public read | `migration_profile_photos.sql` |
| `job-photos` | **public** | full URL | public read `job_photos_public_read` | `migration_job_chat_photos.sql:7-14` |
| `certificates` | public | full URL | public read | `20260629160000_certifications.sql` |

### Upload flow (client)
- **Public buckets:** `uploadImage` → compress (expo-image-manipulator) → upload ArrayBuffer to `<userId>/<ts>-<suffix>.jpg`, `upsert:false`, return **public URL** (`src/lib/uploadImage.js:71-88`).
- **Private buckets:** `uploadPrivateImage` → same but returns the **bare object path** (`:92-108`); `uploadPrivateImages` for arrays (`:130-136`). Display via `getSignedUrl(bucket, path, expiresIn=3600)` (`:111-117`). `objectPath(stored, bucket)` normalizes legacy full-URL rows to a path for signing (`:140-145`).
- Receipts → `uploadPrivateImage` to `receipts`, path stored in `expenses.receipt_url`.
- Completion/before photos → `uploadPrivateImages` to `completion-photos`, paths stored in `bookings.completion_photos[]` / `before_photos[]`.

### Server-side validation — required vs. exists
- **Write policies (all private buckets):** INSERT/DELETE gated to `(storage.foldername(name))[1] = auth.uid()::text` — a user can only write under their own uid folder (`receipts` `migration_expenses.sql:38-46`; `completion` `20260707010000...:48-56`). ✅
- **Read policies:** receipts owner-only; completion/chat party-scoped. The completion policy joins `bookings`+`jobs`, unnests `completion_photos || before_photos`, and matches the object name against `earner_id`/`poster_id`, handling both bare-path and legacy `/completion-photos/<name>` forms (`20260707010000...:24-45`). ✅
- **MIME allowlist:** the four image buckets (`avatars`, `job-photos`, `chat-photos`, `completion-photos`) plus `certificates` carry a raster-only allowlist + 10 MB cap (`migration_security_hardening_2.sql`; certificates `20260707020000_certificates_mime_allowlist.sql`). ⚠️ **Risk — `receipts` has NO explicit MIME/size allowlist in any tracked migration [Needs Fable Review]** (possibly intentional for PDF receipts; a bucket-level allowlist could also have been set out-of-band in the Supabase Dashboard, which is not in source). Flag for Fable.

### Current code location enforcing it
- Client: `src/lib/uploadImage.js`.
- Server: `storage.objects` policies in the migrations above; `guard_message_image_path` write trigger for chat photos (`20260702010000_chat_photo_path_guard.sql`).

### Missing validation / race risks
- **No MIME/size allowlist on `receipts`** — a direct PostgREST/Storage upload could put arbitrary content types under the uid folder (client compresses to JPEG, but that's client-side only).
- `before_photos`/`completion_photos` array columns: poster branch pins them; the earner authors them (earner branch does not pin). An earner overwriting their own arrays is benign.
- Legacy rows stored full public URLs to a now-private bucket; `objectPath` + the `like '%/completion-photos/' || name` policy clause keep them viewable. A stale UI still holding an old public URL would now 400 (bucket is private). Flag.

### Tests that should exist
- User B cannot fetch a signed URL for User A's receipt (owner-only).
- A third party (not earner/poster) cannot read completion photos of a booking (party-scope).
- Upload to another user's uid folder is rejected (insert policy).

---

## 8. DISPUTE / SUPPORT LIFECYCLE

### 8a. Dispute — a terminal audit row with NO adjudication/refund path
- **`disputes` is NOT a status machine.** It is an append-only audit record (`id, booking_id, raised_by, reason, pct_paid, created_at`) — `migration_location_tips_disputes.sql:10-17`; `pct_paid` bounded 0..100 (`20260624240000_review7_db_fixes.sql:162-164`). There is no `status`/`resolved` column.
- **Creation is server-side** inside `stripe-capture-payment` when `pct < 1` — inserts one dispute row idempotently per booking (`:154-165`), requiring a non-empty `disputeReason` (`:37-42`). The client no longer inserts disputes (`src/context/JobsContext.js:838-839`).
- **Effect:** a partial escrow capture, floored at 50% (`:44`); the remainder is released to the poster; the earner is credited the reduced net (persisted BEFORE capture to avoid a webhook over-credit race, `:104-113`).
- **RLS:** both booking parties can SELECT; only a party can INSERT (`migration_location_tips_disputes.sql:21-38`) — but in practice only the service role inserts now.
- ⚠️ **Risk — RESOLUTION / REFUND WORKFLOW: NONE beyond the initial partial capture.** The admin `payments` page **reads** disputes + payments and enriches with booking context (`admin/app/(console)/payments/page.tsx:26-52`) but has **no write/resolve/refund action**. A dispute, once recorded, is terminal from the system's view; any remedy is manual/out-of-band. **No dispute adjudication or refund path exists** — a beta-readiness gap for a money-handling marketplace.

### 8b. Support tickets — a real open/pending/closed machine
- **Current states (`support_tickets.status`):** `'open'`, `'pending'`, `'closed'` — CHECK at `20260705040000_admin_console_v2.sql:17`. Messages carry `support_ticket_messages.author` CHECK `in ('user','admin')` (`:32`).
- **Allowed transitions:**
  | From | To | Who | Fn |
  |---|---|---|---|
  | (insert) | `open` | public Contact form | `support-submit` edge fn (`verify_jwt=false`, `config.toml:28-29`), service role, creates ticket + first message (`supabase/functions/support-submit/index.ts:67-85`) |
  | `open` | `pending` | admin replies | `replyTicket` sets `status='pending'` (`admin/app/(console)/support/actions.ts:74-77`) |
  | any | `open`/`pending`/`closed` | admin (support tier or higher) | `setTicketStatus`, validates the 3-value set (`support/actions.ts:90-114`, set-check `:93`) |
- **Who / server-side auth:** the `support_tickets` and `support_ticket_messages` tables are **service-role-only** — `revoke all from anon, authenticated` (`20260705040000...:23,:36`); user apps never read them. Admin actions go through `requireAdmin("support")` (`support/actions.ts:16-18`) and audit-log every action.
- **Anti-abuse on intake:** layered fail-closed rate limits — per-email 5/hr, per-IP 8/hr, global 60/hr (`support-submit:52-65`); no CAPTCHA (noted in-code `:51`).

### Current code location enforcing it
- Dispute: `stripe-capture-payment/index.ts:37-42,154-165`; `disputes` RLS (`migration_location_tips_disputes.sql:21-38`); admin read-only `admin/app/(console)/payments/page.tsx:26-52`.
- Support: `support-submit/index.ts`, `admin/app/(console)/support/actions.ts`, tables in `20260705040000_admin_console_v2.sql`.

### Missing validation / risks
- Dispute has **no resolution lifecycle** (biggest gap in this section).
- `support-submit` is `verify_jwt=false` (public), mitigated by rate limits but no CAPTCHA.
- Ticket status is admin-trusted; there is no user-facing state. Acceptable.

### Tests that should exist
- Partial capture always writes exactly one dispute row (idempotent on retry) and requires a reason.
- `disputes` insert by a non-party is rejected (RLS) — even though only the service role inserts now.
- `anon`/`authenticated` cannot read `support_tickets` / `support_ticket_messages` (revoked).
- `setTicketStatus` rejects out-of-enum values and non-support callers.
- Report resolution: `resolveReport`/`reopenReport` gated to `requireAdmin("admin")`; the reporter cannot read `resolved_by`/`resolution` (revoked in `20260705060000_v2_hardening.sql:16-20`).

---

## CROSS-CUTTING: `guard_bookings_write` evolution (for auditor traceability)

The same function was redefined in, in order: review5 (`20260624220000`), review7 (`…240000`, + slot FK), review8/9/10 (`20260625000000`/`010000`/`020000`), review11 (`…030000`, forbids client confirm), review13 (`…040000`, requires captured for verify), review14 (`20260630000000`, pins `started_at`/`before_photos`/`application_note`/`cancellation_fee`), and finally **`20260702030000` (pins `poster_rating`/`poster_review`/`estimated_hours`, re-declares slot DELETE policies)** — the authoritative current version. Because migrations apply in timestamp order via `supabase db push`, `20260702030000` is the live definition. All SECURITY DEFINER functions had EXECUTE revoked from public in `20260702000000_revoke_definer_function_execute.sql` (a wrong-signature bug there was fixed in `20260702040000`).

Companion server enforcers: `guard_jobs_write`/`guard_jobs_delete` (job core-term pins), `guard_profiles_write` (trust/rating/earnings pins), `guard_started_booking_cancel` (hard raise on started-job cancel), `sync_slot_taken` (authoritative slot state), `advance_mutual_completion` (server arbiter for `confirmed→completed`), `credit_earnings` / `claim_and_credit_tip` (atomic exactly-once money credit), `contains_prohibited`/`guard_prohibited_content` (DB-level moderation backstop).

⚠️ **Deploy caveat [Needs Fable Review]:** Many of these hardening fixes are code-complete on master but require `supabase db push` (and edge redeploy) to be live. **Whether every tracked migration has actually been pushed to the live DB in order is unverifiable from the repo** (no `supabase_migrations.schema_migrations` snapshot is present in source). The running system may lag the tracked migrations — see BASELINE_STATUS.md.

---

## OPEN QUESTIONS / FOR FABLE TO VERIFY

1. **`jobs.status` has no transition guard** — a poster can set their own job to any value client-side; `guard_jobs_write` verified to never touch `new.status`. `'booked'` is a dead enum value. Confirm this is intended.
2. **Amendment direction contradicts CLAUDE.md.** Code is poster-proposes / earner-responds; CLAUDE.md says the reverse. The guard enforces the code's direction. Which is the product intent?
3. **Fee constant mismatch risk.** Backend hardcodes 10% (`stripe-create-payment-intent:100`, `stripe-capture-payment:129`); the web UI uses `SERVICE_FEE_PCT` from `@/lib/config` for display. Not verified equal (`web/lib/config` not opened). Confirm they agree.
4. **No dispute adjudication/refund path.** Disputes are a terminal audit row; the admin payments page is read-only. Is manual/out-of-band resolution acceptable for beta?
5. **No MIME/size allowlist on `receipts`** (only the four image buckets + `certificates` have one). Direct-Storage uploads under the uid folder could store non-image content. Verify Storage-level restrictions or bucket config outside these migrations.
6. **Amendment `accepted` is sticky** and cleared only by the client `clearAmendment`; a skipped clear leaves core terms editable. No server auto-clear.
7. **Earner branch of the guard does not pin `amendment_status`** — an earner could write `pending`/`none` (not only accept/decline). Likely harmless but not clearly intended.
8. **UI-level gating not audited.** This document traces each state machine through the context/edge/DB layers, where enforcement lives. Which buttons appear when (EarnScreen/GigsScreen/CompletionModal) was not audited and may differ from what the server allows.
9. **Booking status CHECK layering.** The base `schema.sql` CHECK (`pending/confirmed/completed/cancelled`) is superseded by `migration_fix_lifecycle.sql` (adds `verified`,`declined`). Confirmed applied per CLAUDE.md, but a rebuild-order dependency exists (schema.sql must run before the lifecycle migration).
10. **Live DB may lag tracked migrations [Needs Fable Review].** Every guard/transition rule cited here is authoritative *in source*, but whether all tracked migrations have been `db push`ed to the live DB in order is unverifiable from the repo (no `supabase_migrations.schema_migrations` snapshot present). The running system's guards may lag master.
11. **Stripe is in TEST mode for beta [Needs Fable Review].** Every money-moving path in §§2–4/8a (escrow authorize, capture, partial-capture disputes, tips, payouts) is exercised against Stripe **test** keys/mode for the beta. No real funds move; the switch to live mode is a Dashboard/key change not visible in source. Confirm the live/test posture and Connect-payout readiness before any real-money launch.

**Key files:** `shared/lifecycle.js`; `src/context/JobsContext.js`; `web/lib/jobs.tsx`; `src/lib/expenses.js`; `src/lib/uploadImage.js`; `supabase/functions/{accept-booking,stripe-capture-payment,stripe-cancel-payment,stripe-create-payment-intent,stripe-tip,stripe-webhook,support-submit}/index.ts`; `supabase/migrations/20260702030000_guard_pins_and_slot_delete_policies.sql` (authoritative bookings guard), `…20260625030000_review11_escrow_confirm.sql`, `…20260625040000_review13_verify_capture.sql`, `…20260629190000_job_start_cancel.sql`, `…20260624220000_review5_db_fixes.sql`, `…20260624240000_review7_db_fixes.sql`, `…20260707010000_private_completion_photos.sql`, `migration_expenses.sql`, `migration_receipts_private.sql`, `migration_location_tips_disputes.sql`, `20260705040000_admin_console_v2.sql`; `admin/app/(console)/{support/actions.ts,payments/page.tsx}`.
