# GoHustlr — Codebase, Admin Console Audit, Risk Engine Design, and Launch Readiness

**2026-08-04.** Prepared from a full read of `/Users/chrismalson/Documents/gohustle` (mobile app, web, admin, 30 edge functions, ~105 migrations). Every claim below is anchored to a file, table, or column in this repo.

Method: 4 agents mapped the subsystems; 5 audited the console (authz / money / queries / mutations / coverage), each paired with an adversarial verifier told to refute rather than confirm; 4 designed the gaps. 44 raw findings → **39 confirmed**, 5 refuted and dropped. The claims below marked ✅ were then re-verified by hand against the source.

## Verification baseline (checked directly, 2026-08-04)

| Check | Result |
|---|---|
| `admin` typecheck (`tsc --noEmit`) | clean |
| `admin` production build | clean — 17 routes, all server-rendered |
| Root test suite | **281 passed / 29 suites** |
| RPCs the console calls | all 4 exist in migrations (`admin_dashboard_metrics`, `admin_find_users`, `admin_revoke_sessions`, `admin_user_login_history`) |
| Tables read by the console | **19 of 45** — 26 have no admin surface at all |
| ✅ Tips take an application fee? | **No** — `application_fee` count in `stripe-tip` is 0, vs `application_fee_amount: feeCents` at `stripe-create-payment-intent:188` |
| ✅ Mobile app files support tickets? | **No** — 3 × `mailto:` (`ProfileScreen:565`, `SettingsScreen:129`, `PayoutSetupScreen:226`); `support-submit`'s only caller is `web/app/contact/page.tsx` |
| ✅ CI pipeline | **none** — `.github/workflows` does not exist |
| ✅ Stripe publishable key | **`pk_test_`** hardcoded in both `src/lib/stripeClient.js:4` and `web/lib/config.ts:14` |
| ✅ Live terms arbitration clause | still `[DRAFT PLACEHOLDER]` — `20260702020000_legal_docs_v2026_07_02.sql:51` |
| ✅ Core FK indexes | 32 indexes exist, but **none** on `bookings.earner_id`, `bookings.job_id`, `messages.booking_id`, `payments.booking_id`, `jobs.poster_id`, `job_slots.job_id` — the columns every screen filters on |
| ✅ Beta signup gate | open to all — the `'*'` row from `20260710070000_open_beta_signups.sql` is live, and the only way to change it is raw SQL |

---

## 1. What GoHustlr is

A two-sided local gig marketplace with real escrow, aimed at students. One account can both **earn** and **hire** — there is no role split at the auth layer, only a `profiles.role` preference.

**Three clients, one database.**

| Surface | Stack | Path |
|---|---|---|
| Mobile app (the product) | Expo SDK 54 / RN 0.81 / React 19, JavaScript | `App.js`, `src/` |
| Consumer web | Next.js 16, TypeScript | `web/` |
| Internal admin console | Next.js 16, TypeScript, service-role | `admin/` |
| Shared pure logic | JS, imported by mobile + web | `shared/` (transforms, filters, lifecycle, badges, finance, contentFilter, geo, taxFormat) |
| Backend | Supabase Postgres + RLS + Realtime + Storage, 30 Deno edge functions | `supabase/` |

**Booking lifecycle** (`shared/lifecycle.js`, enforced by DB guard triggers):

```
pending → confirmed → completed → verified
        ↘ declined / cancelled
```

Mutual completion is structural: `bookings.earner_done` **and** `bookings.poster_done` must both be true before status advances. `started_at` ("I'm on site") locks cancellation on both client and DB (`trg_guard_started_booking_cancel`).

**The money flow — this is the part that matters for everything below.**

1. Earner books a slot → `bookings` row, `status='pending'`. No money.
2. Poster accepts → `stripe-create-payment-intent` creates a PaymentIntent with `capture_method:'manual'`, `transfer_data.destination` = the earner's Connect Express account, `application_fee_amount` = **10%**. Card sheet collects payment. `accept-booking` verifies the PI is `requires_capture` **server-side** before flipping status to `confirmed`. This is an authorization hold, not a charge. **It dies at ~7 days.**
3. Work happens. Both sides mark done → `completed`.
4. Poster verifies + rates → `stripe-capture-payment` captures **full**, or **partial at pct ≥ 0.5** with a mandatory written reason (which inserts a `disputes` row). Only then does the status write happen; `credit_earnings` posts to `profiles.earnings_*`.
5. Optional tip → `stripe-tip`, a **separate off-session destination charge with no application fee** — 100% to the earner.
6. If the poster ghosts, `earner-claim-payment` lets the earner self-settle 3 days past the scheduled start, provided no open dispute/report and a payout account exists.

Because these are **destination charges**, the platform is merchant of record: a chargeback claws back from the *platform* balance 30–90 days later, while the earner's money already left via Connect (`payouts.schedule.interval:'daily'`, **no `delay_days`**).

**Everything else** the app carries: two-layer content moderation (`shared/contentFilter.js` blocklist + Claude-backed `moderate-text`/`moderate-image`), address masking (`jobs.location` is city-level, exact street address lives in `job_locations` and is revealed only to the poster or an accepted earner), DB-driven legal docs with a fail-closed re-acceptance gate, Stripe Identity + `.edu` student verification, a full Schedule-C Tax Center with GPS mileage tracking, XP/badges/challenges, referrals, notifications with per-category push/email prefs, and a Claude tool-use assistant ("Hustlr AI") that can post gigs, book work, and edit profiles on a user's behalf.

Roughly 28 tables, 4 RPCs, 6 storage buckets, 22 edge functions touched from mobile alone.

---

## 2. Admin console: what it does today

`admin/` is a Next.js app, deployed separately to `admin.gohustlr.com`, holding the **service-role key** server-side only. Eight nav sections (`admin/app/(console)/layout.tsx`):

| Section | Reads | Writes |
|---|---|---|
| **Dashboard** `/` | `admin_dashboard_metrics` — 18 scalar counts (users, signups 1/7/30d, open gigs, bookings by status, GMV captured, fees, escrow held, disputes, suspended) + newest users + recent audit | — |
| **Users** `/users`, `/users/[id]` | `admin_find_users` (query required, max 25 rows), full profile, bookings both sides, payments, reports, notes, login history | suspend / unsuspend / force sign-out / set verified / reset profile fields / send password reset / confirm email / change email / grant + revoke student / notify / add note / delete account |
| **Moderation** `/moderation` | `reports` joined to reporter/reported/job, cap 100 | resolve / reopen (**`requireAdmin('admin')` only**) |
| **Payments** `/payments` | `payments` (limit 60) + `disputes` (limit 50), read-only | **none** |
| **Jobs** `/jobs`, `/jobs/[id]` | listings (limit 60), detail, slots, bookings | set job status (takedown) |
| **Bookings** `/bookings/[id]` | full booking, both parties, escrow panel, conversation | **none** — and there is no list page |
| **Support** `/support`, `/support/[id]` | `support_tickets` + messages (cap 100) | reply / set status / AI draft |
| **Errors** `/errors` | `client_errors` from the mobile `log-client-error` sink | — |
| **Audit** `/audit` (admin-only) | `admin_audit_log` | append-only; UPDATE/DELETE revoked even from service_role |

**19 server actions total. Not one of them moves money.**

**Security model** (`admin/lib/guard.ts`, the single enforcement point):

`supa.auth.getUser()` (real auth-server call, not cookie parsing) → **AAL2** read from the access-token JWT claim → `admin_users` membership lookup with the service client → role tier (`admin` full / `support` read-mostly). Every server page and every server action calls `requireAdmin()`; `proxy.ts` is UX redirects only. The browser holds only an anon-key session used to prove identity — no data fetching outside the server runtime. Suspension = GoTrue `banned_until` + `profiles.suspended_at/suspension_reason`. `admin_audit_log` has no FK to `auth.users` (dropped in `20260705020000_admin_audit_fk_fix.sql`) so audit rows outlive their actor.

This is a genuinely good design. The defects below are all *within* it, not bypasses of it.

---

## 3. Admin console: what's broken

39 findings were confirmed by adversarial verification. **There are no critical or high-severity defects.** Three are medium; the rest are low and cluster around two root causes (authorized-vs-captured amount labelling, and audit ordering). The 11 that carry real consequence:

### Medium

**M1 — Edge functions gate on `admin_users` *membership*, not `role`, so a support-tier token is full admin across the whole edge surface.**
`supabase/functions/support-reply/index.ts:38`, `support-ai-draft/index.ts:38`, `send-push/index.ts:60-61` all do `.from('admin_users').select('user_id')` — membership + AAL2 only. The console deliberately gates the equivalent capability at `admin` (`notifyUser` → `requireAdmin('admin')`), but a support user's own browser holds a valid AAL2 token. From devtools they can POST it to `support-reply` with an arbitrary `toEmail` (index.ts:54-55, passed straight to Resend at :66) and send mail as `GoHustlr Support <support@gohustlr.com>` to any address, or POST `send-push` with `adminNotice:true` and write attacker-chosen title/body to any user's lock screen and permanent Alerts inbox (send-push keeps literal wording when `isAdminNotice`, :203-209).
*Correction to note: admin notices are **not** exempt from block enforcement — the bidirectional check at send-push:108-120 runs unconditionally.*
**Fix:** have `isAdminCaller` in all three functions `select('role')` and require `role='admin'` (or a per-function allowed-role list); have `support-reply` validate `toEmail` against the referenced ticket. Also fix `admin/README.md:12-13,45`, which calls `support` "read-only" while `support/actions.ts:17` gates writes at `requireAdmin('support')`.

**M2 — Booking detail labels the authorized hold as "Charged", overstating a partially-captured booking by up to 2×.**
`admin/app/(console)/bookings/[id]/page.tsx:112` renders `fmtCents(pay.amount_cents)` under `<dt>Charged</dt>`. `payments.amount_cents` is the **immutable original authorization** — `stripe-capture-payment/index.ts:116-117` states it explicitly ("Keep amount_cents as the originally-AUTHORIZED hold… the captured total is derivable as earner_amount_cents + fee_cents"). On a $200 gig verified at pct=0.6, the panel reads "Charged $200.00 · Fee $12.00 · To earner $108.00" — three numbers that don't sum, on the exact page an admin opens *because* there's a dispute. Line 115 compounds it by labelling `captured_at` as "Captured", so the panel has a "Captured" field that is a date.
**Fix:** mirror `payments/page.tsx:126-131`, which already fixed this and documents why — rename to "Authorized" and add a real Captured field: `status === 'captured' ? fmtCents(earner_amount_cents + fee_cents) : '—'`.

**M3 — Dashboard GMV and Platform fees are never reduced by refunds or chargebacks.**
`supabase/migrations/20260726040000_gmv_uses_captured_amount.sql:49-51` sums over `payments where status='captured'`. `migration_stripe.sql:31` constrains status to `('authorized','captured','cancelled','failed')` — **a reversal is structurally unrepresentable**. The `charge.refunded` (stripe-webhook:298-322) and `charge.dispute.created` (:270-296) handlers only insert a `disputes` row and email; `payments` is untouched. So `page.tsx:114-115` overstates revenue permanently by the value of every reversal the platform ever takes.
**Fix:** add `payments.refunded_cents` (or a `'refunded'` status), write it from those two handlers, and subtract it in both aggregates.

### Low

| # | File:line | Failure | Fix |
|---|---|---|---|
| L1 | `users/[id]/actions.ts:28-35` | `assertActionableTarget` destructures only `{ data: peer }` and discards the error. A timed-out `admin_users` lookup yields `peer === null`, the guard passes, and an admin can suspend, take over the email of, or permanently delete **a fellow admin**. `lib/deleteUser.ts:37-58` and `guard.ts:64` both fail closed on the same pattern. | Capture and throw on `error`. |
| L2 | `users/[id]/actions.ts:53,57` | `run()` executes the mutation **then** audits; `lib/audit.ts:28` throws on insert failure and the catch turns it into `{ok:false}`. The ban landed, `profiles.suspended_at` is set, and the admin is told "audit write failed" — reading as *the action didn't happen*. Only `deleteAccount` (:391) audits first. README:14-15 claims fail-closed. | Audit before the side effect everywhere, or at minimum change the message to "the action SUCCEEDED but was not audited". |
| L3 | `lib/audit.ts:41-45` | `auditRead` swallows every insert failure with a `console.error`. Every sensitive read goes through it — `user.view`, `user.search`, `booking.view` (which exposes both parties, escrow amounts and the full DM transcript), `payments.view`, `support.ai_draft`. During an insert-failure window, an admin can read every private conversation on the platform and `admin_audit_log` shows nothing. | Keep rendering, but emit a structured alert and show a visible banner when the read couldn't be recorded. |
| L4 | `users/[id]/export/route.ts:54` | CSRF guard **blacklists** only `Sec-Fetch-Site: cross-site`. `gohustlr.com` → `admin.gohustlr.com` is *same-site*, so SameSite cookies are sent and the guard passes. An `<img src="https://admin.gohustlr.com/users/<uuid>/export">` on any same-site page forces a full PII assembly and writes a `user.export` audit row falsely attributed to the admin who loaded the page. (No CORS, so nothing is exfiltrated.) | Allowlist affirmatively: `if (s && s !== 'same-origin' && s !== 'none') return 403`. |
| L5 | `users/[id]/page.tsx:118,309` | Selects only `booking_id, status, amount_cents`, renders `${pay.status} · ${fmtCents(pay.amount_cents)}` — so a partially-captured booking reads "captured · $200.00" when $100 was collected and $90 credited. Same root cause as M2, second location. | Select `fee_cents, earner_amount_cents` and render the captured total. |
| L6 | `payments/page.tsx:23,31,58` | Section headers print `data?.length` as the count while the queries are `.limit(60)` and `.limit(50)`. The dashboard meanwhile shows uncapped `disputes_total`, so the two screens disagree. Same bug on `/moderation` (cap 100). | Use `{ count: 'exact', head: true }` for true counts; add pagination. |
| L7 | `supabase/functions/stripe-webhook/index.ts:130-141` | `payment_intent.succeeded` stamps `status='captured'` and calls `credit_earnings` **without reading `pi.amount_received`**. The two in-app paths reconcile first; a capture initiated from the Stripe Dashboard does not. A $100 partial capture on a $200 hold credits the earner $180 and counts $200 GMV. Since the console has **no capture UI at all**, the Dashboard is the only remediation path. Real money isn't misdirected (Stripe governs the destination transfer) — the earnings ledger and metrics drift. | Reconcile `earner_amount_cents`/`fee_cents` from `amount_received` before calling `credit_earnings`, exactly as `earner-claim-payment/index.ts:200-216` does. |
| L8 | `admin/app/mfa/page.tsx:40-63` | Trust-on-first-use TOTP: `bootstrap()` auto-enrolls a fresh factor for whoever presents valid credentials when no verified factor exists, and `guard.ts:56` only asks whether the JWT says `aal2`. Nothing binds an `admin_users` row to a pre-approved factor. README's setup order seeds `admin_users` (step 2) **before** enrollment (step 3), so every new admin has a password-only window into a service-role console, with no audit row on enrollment. (Post-enrollment the page cannot swap the factor — the exposure is genuinely bounded to that window.) | Add `admin_users.mfa_enrolled_at` / `mfa_factor_id`; `requireAdmin` throws `forbidden` when null. Audit + email on every enrollment. |

**Honest summary:** the console's authz spine holds. What's actually wrong is (a) three edge functions that check membership where the UI checks role, (b) the same authorized-vs-captured display bug in three places, and (c) audit ordering. All of it is a day or two of work.

---

## 4. What's missing to run the business

This is the larger story. The console is a competent **account support tool**. It cannot run a marketplace. The structural pattern: every surface where money, trust state, or platform configuration lives is **read-only in the console and write-only in the Supabase SQL editor or the Stripe Dashboard**.

### Beta-blockers — scenarios with zero in-console answer today

| Gap | Why it blocks | Build |
|---|---|---|
| **Refunds & payout intervention** | There is **no refund code anywhere in the repo**. `payments.status` can't represent a reversal. Every remediation is "open the Stripe Dashboard" — and that path corrupts the ledger (L7). A poster demanding a refund, an underpaid earner, and an expired hold on completed work all have no resolution. | `/payments/[bookingId]/resolve` showing authorized vs captured vs refunded, backed by a new `admin-payment-action` edge function (gate on `role='admin'`) that reconciles from `pi.amount_received` before every settle. Migration: `payments.refunded_cents/refunded_at/refund_reason/refunded_by` + `'refunded'` status. **L** |
| **Dispute resolution** | `public.disputes` has six columns — no status, assignee, earner response, or resolution. The row is inserted *after* the partial capture already executed, so the earner has been paid 50–90% with no appeal channel. `disputes_total` on the dashboard never drops. Worse: `earner-claim-payment/index.ts:135-139` refuses on any open dispute, and since there's no resolution column, **that lock is permanent by construction**. | `/disputes` queue + `/disputes/[id]` case page assembling evidence the app already stores (before/after photos signed from the private bucket, the full booking conversation, both ratings, the payment split). Migration adds `status/assigned_to/resolved_at/resolved_by/resolution_note/earner_response`. **M** |
| **Booking intervention** | `/bookings/[id]` is read-only and there is no list page. Mutual completion means a one-sided booking sits forever while the authorization lapses in ~7 days. `started_at` permanently locks cancellation. `earner-claim-payment` refuses with no override. The capability already exists and is unused: `guard_bookings_write` early-returns for `service_role` (`20260722000000:39`). | `/bookings` list with status/stuck filters and a standing "authorization expiring within 48h" view off `payments.created_at where status='authorized'`. Intervention panel: force-cancel + release hold, force-complete, re-open, clear `started_at`, override claim — via one `admin_force_booking_state()` SECURITY DEFINER RPC. **M** |
| **Report → evidence** | `submitReport` files profile-level reports with **no `booking_id`**, and the moderation row only offers "view conversation" when `booking_id` is set — so a harassment report against a person has **no path to any evidence at all**. No message search, no cross-thread view, no way to redact an abusive message or illegal image. `moderation_flags` (written by `moderate-image` for repeat-offender detection) is surfaced nowhere. | `/moderation/[reportId]` case page resolving the (reporter, reported) pair to every shared booking, inlining all threads with signed chat images. `admin_conversations_between(a,b)` RPC. `redactMessage` action + `messages.redacted_by/redacted_at/redaction_reason`. Flagged-uploads section. Assistant-activity drawer (`assistant_threads`/`assistant_messages`) for "the AI posted a gig I didn't ask for". **M** |
| **Beta invite / waitlist** | `beta_allowlist` is the real gate — `handle_new_user` raises `signup_not_allowlisted` and rolls back the auth insert. Inviting a tester and re-closing the beta (deleting the `'*'` row) are raw SQL. And a rejected signup **vanishes with no record** — there is no waitlist table, so everyone who tried while the beta was closed is thrown away. | `/access` page: search/add/remove entries, bulk invite, and a typed-confirmation "beta open / invite-only" toggle over the `'*'` row. `waitlist_requests` table populated by `handle_new_user` before it raises + a public `waitlist-submit` function for the landing page. **S** |
| **Feature flags / kill switches** | The entire runtime config surface of this product is one `'*'` row edited by hand. No way to pause payments during a Stripe incident, pause posting during a spam wave, pause signups, force `moderate-text` closed (it fails **open** on outage), or **switch off the Hustlr AI assistant** — which can post gigs and book work on a user's behalf, the widest blast radius in the product, with no off switch. | `app_flags(key, enabled, value jsonb, note, updated_by, updated_at)` + a STABLE `public.app_flag(key)` reader. `/flags` page, audited, per-flag confirms. Enforce at the top of `stripe-create-payment-intent`, `accept-booking`, `assistant`, and in `guard_jobs_write`. **S** |

### Launch-blockers

- **Verification review queues** — both ID and student paths are fully automated with no human queue. A user stuck at `id_verification_status='pending'` or `'rejected'` is invisible. The only lever is `setVerified`, a boolean with no reason and no evidence, that also rewrites `id_verification_status`. These flags drive the Verified badge and the "Verified students only" Browse filter — a wrong grant is a trust signal other users act on **in person**. Non-`.edu` students (community colleges, alumni) have no manual path at all. **M**
- **Admin user management** — `admin_users` is seeded by raw SQL and `assertActionableTarget` explicitly refuses to touch admins. Nobody can list who has console access, revoke a departing teammate, or reset a lost authenticator without Supabase SQL-editor credentials. Exactly the wrong dependency for an offboarding, and it's what makes L8 a recurring window rather than a one-time one. **M**
- **Legal publishing** — `checkNeedsAcceptance` fails **closed** and `ConsentScreen` blocks the whole app, making a `legal_documents` insert the highest-blast-radius write in the product — performed as a hand-typed SQL insert. A wrong slug or empty body locks out every user. No view of acceptance rate. The live terms still carry a literal `[DRAFT PLACEHOLDER]` on arbitration and governing law. **M**
- **Announcements / segmented broadcast** — `notifyUser` reaches exactly one user per form fill. There is no way to tell "everyone with a confirmed booking this weekend" that payouts are delayed. Needs an audience builder, dry-run, `announcements` table, and one server-side sender honoring `notification_preferences`, gated at `role='admin'` (a broadcast primitive reachable by a support token is a mass-phishing tool). **L**
- **Browsable lists, saved views, bulk actions** — `/users` renders nothing until you type and returns ≤25 rows: you cannot browse your own user base. Every list is capped, unpaginated, single-filter, with counts that are list lengths (L6). Every action is one row at a time — a scripted poster spraying 40 gigs takes 40 clicks. **L**
- **Compliance exports** — the only export is one user's JSON (with the L4 guard bug). No booking case packet for a subpoena, no date-ranged transactions CSV for 1099 reconciliation, no deletion certificate, and no `data_requests` log — which is the artifact that actually demonstrates you met a statutory deadline. Reuse `csvCell` from `shared/taxFormat.js` for formula-injection neutralization. **M**

### Post-launch

- **Analytics** — `admin_dashboard_metrics` is 18 scalar counts, no time series, no cohorts, no funnel. This marketplace has specific instrumented drop-offs nobody can see: signup → `onboarding_done` → first booking → accept (needs poster card on file) → verified (needs earner Connect, fails hard with `EARNER_NO_PAYOUT`). Liquidity — open gigs that never got an applicant, time-to-first-application by category/city — decides whether to open a new city and is computed nowhere. Needs `admin_metrics_daily` rollup + `/analytics`. **L**
- **"View as user"** — support tickets here are overwhelmingly visibility questions ("my gig isn't showing", "I can't message them"). The answer lives in `isJobBookable`/`isHiddenForViewer`, the silent block set, address-masking entitlement, suspension, the age floor, and RLS — none of which an admin reading with the service role can reproduce. Strictly read-only, audited as `user.view_as`. **L**

---

## 5. Fraud & risk: auto-flagging suspicious transactions

Yes, and most of the highest-value signal is free — you're already paying for it and throwing it away.

### The four structural exposures

1. **Tips are the cleanest laundering channel in the repo.** `stripe-tip/index.ts` bounds a *single* call to 50¢–$1000, its idempotency key is `tip_${bookingId}_${tipCents}` (so varying the amount always makes a fresh PaymentIntent), there is **no per-booking cap anywhere**, and there is **no `application_fee_amount`** — 100% routes to the earner's connected balance and pays out daily. `claim_and_credit_tip` only dedupes per PI. A colluding pair with one real $10 gig can move six figures at 0% take rate, all chargeback-eligible against the platform.
2. **Payout-and-run.** Destination charges + `interval:'daily'`, `delay_days` unset. The earner's bank has the money tomorrow; the chargeback hits the platform in 30–90 days.
3. **Stripe's telemetry is discarded.** `radar.early_fraud_warning.created`, `review.opened/closed`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `payout.failed`, `account.application.deauthorized`, `capability.updated`, `transfer.reversed` all fall through the `default:` no-op in `stripe-webhook/index.ts`. `charge.outcome.risk_level` (the Radar verdict) and the **card fingerprint** — the single best cross-account identifier — are never persisted.
4. **No risk primitive exists.** The only machine-generated flag is a `reports` row with `source='auto'` from a keyword hit, which `earner-claim-payment` deliberately excludes from settlement gating. No score, no severity, no decay, no queue.

### Architecture — tier chosen per signal by whether the money has already moved

| Tier | Use for | Idiom to copy |
|---|---|---|
| **BEFORE-INSERT trigger** | Anything that must refuse synchronously and atomically: velocity caps, the tip cap | `guard_report_rate_limit()` in `20260726020000` — SECURITY DEFINER, `if auth.role()='service_role' then return new`, `raise check_violation` with user-facing copy |
| **AFTER-INSERT trigger** | Cheap single-row detections that only *emit* a signal: contact-info patterns, tip ratio, dispute inserts. Never blocking, never able to roll back the user's action | `notify_safety_report()` |
| **Scheduled scorer** (pg_cron, 15 min → `public.risk_rescore()`) | Every cross-user graph query: collusion pairs, review rings, referral farms, identity links. Must never sit on a booking's critical path | — |
| **Stripe webhook** | Everything only Stripe knows | existing `stripe-webhook` |

Enforcement lives in `private.risk_state(uuid)`, SECURITY DEFINER in the non-PostgREST-exposed `private` schema (same reasoning as `private.is_suspended` in `20260726070000`) so it can never become an oracle over who is flagged.

**Human in the loop is enforced by construction.** No automated response deletes data, bans an account, or moves money. The strongest auto-action is `capture_hold` — escrow stays held, nobody is paid, both sides see an honest "under review". That's safe *because* the money is already authorized and nothing is destroyed. But it has a fuse: the authorization dies at ~7 days, so **every hold carries a hard 48h paging SLA** (escalate at 96h) via the existing `pg_net → safety-alert` channel. A stale hold is an unpaid student.

**Population caveat:** this is a student marketplace. Shared campus IPs, shared devices, and cohorts created hours apart during a campus launch are *normal*. IP/timing similarity is only ever a "watch" contribution. Only hard links (identical card fingerprint, identical device token) and money-shaped patterns escalate.

### Signal table

| Pattern | Rule | Tables / columns | Threshold | Response |
|---|---|---|---|---|
| Tip laundering | `tip.ratio_high` / `tip.velocity` | `tip_ledger`, `payments.earner_amount_cents/fee_cents` | tips on a booking > `max(2× captured, $200)` or >3 tips/booking; poster >$500 tips/24h | **Refuse** (`TIP_LIMIT` 409) + signal sev 60 |
| Early fraud warning | `stripe.early_fraud_warning` | webhook `radar.early_fraud_warning.created` | any | sev 95 → **capture_hold both parties** + page |
| Radar manual review | `stripe.radar_review` | `review.opened` | any | sev 55 → watch |
| Dispute outcome | `stripe.dispute_closed` | `charge.dispute.closed/funds_withdrawn` | any | update `disputes`, reduce GMV |
| Mule / dead bank | `stripe.payout_failed` | `payout.failed` | any | sev 45 |
| **Collusion / self-dealing** | `collusion.pair_concentration` | `(jobs.poster_id, bookings.earner_id)` pair over 30d + `payments`, `bookings.started_at/completed_at/completion_photos`, `messages` | ≥3 pair bookings in 14d **and** ≥$300 captured **and** ≥0.8 share on *both* sides **and** (median lifecycle <60min **or** ≥2 bookings with zero messages) | sev 80 → review. sev **95 → capture_hold** if also shared card fingerprint, or profiles created within 24h + a `referrals` link |
| Card testing | `velocity.jobs` / `velocity.holds` | BEFORE INSERT on `jobs`; `payments` count in `stripe-create-payment-intent` | >5 listings/hr or 15/day; >5 holds/hr; ≥3 `status='failed'` in 24h | **Refuse** (`VELOCITY_LIMIT`) |
| High-value unverified | `require_id` | `profiles.id_verification_status` | `amountCents > 50000` and not `'verified'` | **Refuse**, route to Stripe Identity |
| Ban evasion | `evasion.card_fingerprint` / `evasion.device` / `link.shared_ip` | new `device_links`, `payments.card_fingerprint`, `admin_user_login_history()` | fingerprint or device token shared with a `suspended_at IS NOT NULL` profile | sev 90 / 85 → review. IP sev **15 only, never escalates alone** |
| Off-platform solicitation | `offplatform.contact_shared` | `messages`, `jobs` via `contains_contact_pattern()` | ≥3 trips in 7d across ≥2 counterparties, weighted higher **before** a confirmed booking | sev 25 → 70. **Never blocks** |
| Contact harvesting | `fakegig.harvester` | `jobs`, `messages`, `payments` | ≥3 jobs, ≥5 distinct message counterparties in 7d, **zero** payments rows ever | sev 75 → review |
| Review ring | `reviews.cheap_reputation` / `reciprocal_ring` | `reviews`, `payments.earner_amount_cents`, `bookings` | ≥5 reviews with <$100 lifetime earnings; ≥3 reciprocal 5.0s on <$15, <30-min bookings | sev 55 / 70 → banner on the user page, **never auto-adjust the rating** |
| Referral farm | `referral.farm` | `referrals`, `jobs`, `bookings` | ≥5 in 24h or ≥10 in 7d with <10% ever transacting | sev 50 / 75 → review, **never auto-void** |
| Serial dispute reducer | `dispute.serial_reducer` | `disputes.pct_paid`, verified bookings | ≥40% of verified bookings reduced over ≥4 | sev 65 → 85 |
| Repeat unilateral claim | `claim.unilateral_repeat` | `bookings` fingerprint (`verified` + `poster_done` + no `reviews` role='earner') | ≥2 in 30d → sev 60; ≥4 → sev 85 + **capture_hold** |
| Repeat chargeback poster | — | `disputes.reason ilike 'Stripe chargeback%'` | 2nd occurrence | sev 95 — should never place another hold |

### Free from Stripe vs. must be built

| Free / near-free | Must build |
|---|---|
| Radar base rules + `charge.outcome.risk_level` on every charge | The `risk_signals`/`risk_scores` schema and scorer |
| `radar.early_fraud_warning.created` — issuer says fraud *before* the chargeback | Enforcement in `stripe-capture-payment` + `earner-claim-payment` |
| Card **fingerprint** (`payment_method_details.card.fingerprint`) — stable across email/name/device | Every cross-user graph rule (collusion, rings, farms) |
| Dispute/payout/Connect lifecycle events | The tip cap and velocity caps |
| Dashboard Radar rules, **zero code**: `Block if :card_number_attempts_1h: > 3`; `Block if :ip_country: != :card_country:` (US-only); `Review if :card_funding: = 'prepaid' and :amount_in_usd: > 100` | The `/risk` admin queue |
| `outcome.risk_score` needs Radar for Fraud Teams (**$0.07/txn** — cheap against one chargeback) | Payout `delay_days` + the reversible freeze primitive |

### Proposed schema

```sql
-- append-only; dedupe_key is mandatory (Stripe redelivers, cron re-runs)
public.risk_signals(
  id bigint generated always as identity,
  subject_type text check (subject_type in ('user','booking','job','payment','pair')),
  subject_id text, user_id uuid references profiles, counterparty_id uuid,
  booking_id uuid, rule text, severity smallint check (severity between 1 and 100),
  evidence jsonb, source text check (source in ('trigger','cron','stripe','manual')),
  dedupe_key text, created_at timestamptz default now()
);
create unique index on risk_signals(dedupe_key) where dedupe_key is not null;

public.risk_scores(
  user_id uuid primary key, score smallint, top_rule text,
  state text check (state in ('clear','watch','review','restricted')),
  capture_hold boolean default false, capture_hold_at timestamptz,
  payouts_frozen boolean default false,
  velocity_tier text check (velocity_tier in ('normal','limited','frozen')),
  cleared_rules text[], reviewed_by uuid, reviewed_at timestamptz,
  review_note text, updated_at timestamptz
);
-- RLS enabled with ZERO policies, grants revoked from anon/authenticated
-- (the moderation_flags / client_errors / push_send_rate pattern)
```

Score = `least(100, sum(severity * exp(-age_days/14.0)))` over uncleared signals — a 14-day half-life so old noise decays out.

Plus on `payments`: `risk_level`, `risk_score`, `card_fingerprint`, `card_funding`, `ip_country`, captured at hold time by expanding `latest_charge.payment_method_details`.

### Three enforcement flags, all reversible

- **`capture_hold`** — escrow stays held; can only be set while the payments row is still `'authorized'`, never on captured money.
- **`payouts_frozen`** — `stripe.accounts.update(acct, { settings: { payouts: { schedule: { interval: 'manual' }}}})`. Funds stay in the connected balance, charges keep working, fully reversible.
- **`velocity_tier`** — `normal` / `limited` / `frozen`.

Also: set `delay_days: 7` for new Connect accounts in `stripe-connect-onboard`, relaxed by `risk_rescore` once the earner has ≥3 verified bookings, ≥30 days of account age, and zero open signals.

### Admin review queue

`admin/app/(console)/risk/page.tsx` (filter by state / rule / min score; each row shows score, top rule, decayed signal list, links to `/users/[id]` and `/bookings/[id]`), `risk/[userId]/page.tsx` (evidence timeline — render `evidence` jsonb as **text, never markup**), `risk/actions.ts`. All `requireAdmin('admin')` and — unlike today's `run()` — **audit before mutating**, using a fixed synthetic system uuid as `admin_id` (safe because the FK was dropped). Actions: `risk.clear` (writes `cleared_rules` so the same rule can't re-fire → this is your false-positive feedback loop), `hold_capture` / `release_hold`, `freeze_payouts` / `release_payouts`, `require_id`, `escalate`.

Wire `risk_open_review`, `risk_capture_holds`, `risk_holds_over_48h` into `admin_dashboard_metrics` and the attention row. Add a weekly `admin_risk_precision()` RPC (raised vs cleared per rule) so thresholds are tuned on measured precision, not vibes. And ship a documented kill switch: one `app.risk_engine_enabled` GUC that makes every enforcement read return `'clear'`, so a bad rule deploy degrades to today's behavior instead of freezing the marketplace.

---

## 6. Beta & launch readiness

The engineering layer is deep — 29 Jest suites / 281 tests green, ~105 tracked migrations, guard triggers, structural-invariant tests. Several things the internal docs list as open are in fact **closed**: the geocode per-IP throttle exists (`web/app/api/geocode/route.ts:23-47`), safety reports now page a human (`trg_notify_safety_report → pg_net → safety-alert`), and a client-error sink + `/errors` page exist. `KNOWN_RISKS` §1.4 and §1.1 are stale in the pessimistic direction.

The **operational** layer is about a weekend behind.

### Beta-blockers

| # | Item | Evidence |
|---|---|---|
| 1 | **Route alerts to a real on-call address; write `RUNBOOK_MONEY.md` + `RUNBOOK_SAFETY.md`** | Every alert — chargeback, refund, escrow-expiry-on-completed-work (`stripe-webhook:235,285,311`), safety report (`safety-alert:66`), new support ticket (`support-submit:12`) — hard-defaults to `mainmail@gohustlr.com` with no paging, ack, retry or escalation. Unset `RESEND_API_KEY` degrades all of them to a `console.error`. `grep -r runbook` finds nothing. Drill both once against a seeded booking before opening. **S** |
| 2 | **Money-remediation actions + resolvable disputes** (§4) | 19 server actions, none moves money. `disputes` has no resolution column, so `earner-claim-payment:135-139` locks that booking permanently. **L** |
| 3 | **In-app support intake** | The mobile app's only support path is a `mailto:` (`SettingsScreen.js:127-129`, `ProfileScreen.js:565`, `PayoutSetupScreen.js:226`). `support-submit`'s only caller is `web/app/contact/page.tsx:41`. On TestFlight — the actual beta channel — **no user request ever enters the ticket system the console was built around.** **S** |
| 4 | **Edge-function error sink** | Edge functions have no error reporting at all. A failed escrow capture only `console.error`s (`stripe-capture-payment:177`) — the poster-tries-to-pay-and-can't failure pages nobody. Reuse the `client_errors` sink. **S** |
| 5 | **Tip cap** (§5) | Unbounded, fee-free, card-funded transfers. **S** |
| 6 | **Stripe risk-event ingestion + persist card fingerprint** (§5) | **M** |
| 7 | **Feature flags / kill switches** (§4) | No way to pause payments, posting, signups, or the AI assistant. **S** |
| 8 | **Beta invite + waitlist** (§4) | **S** |
| 9 | **Report → conversation evidence** (§4) | Profile-level reports have no evidence path at all. **M** |
| 10 | **Booking intervention** (§4) | **M** |
| 11 | Fix M1 (edge-function role gate) and M2/L5 (authorized-vs-captured labels) | §3. **S** |

### Launch-blockers

| # | Item | Evidence |
|---|---|---|
| 12 | **Live Stripe key cutover** | `src/lib/stripeClient.js:3` hardcodes `pk_test_`; `eas.json` has no `env` block on any profile. Blocked in source. **S** |
| 13 | **Staging environment + CI** | Exactly one Supabase project ref in the tree (`nfioebqsgmmzhbksxozc`) and **zero** `.github/workflows`. Every migration and function deploy lands straight on production, ungated. Web auto-deploys on each master push; admin needs a manual `vercel --prod`. **M** |
| 14 | **Database indexes** | `supabase/schema.sql` declares none. No index on `bookings.earner_id`, `messages.booking_id`, `payments.booking_id`, `job_slots.job_id`, `jobs.poster_id`. Invisible at 16 profiles; a seq scan per screen at 5,000. **S** |
| 15 | **Backup + restore drill** | Confirm PITR retention and actually restore into a scratch project once. **S** |
| 16 | **Capture-hold enforcement + 48h SLA** (§5) | **M** |
| 17 | **Payout `delay_days` + freeze primitive** (§5) | **S** |
| 18 | **Collusion, velocity, off-platform, identity-link rules + `/risk` queue** (§5) | **M + L** |
| 19 | **Verification review queues** (§4) | **M** |
| 20 | **Admin lifecycle management + close the MFA TOFU window** (§4, L8) | **M** |
| 21 | **Legal publishing UI + replace the `[DRAFT PLACEHOLDER]` arbitration/governing-law text** (§4) | **M** |
| 22 | **Moderation SLA + pagination** | `resolveReport` requires `requireAdmin('admin')`, so support can read the queue but not clear it — and an unresolved report **blocks an earner's payout**. One person's response time is a money-harm control with no SLA, on a newest-first, 100-row, unpaginated queue that buries the oldest cases. **S** |
| 23 | **Announcements / broadcast** (§4) | **L** |
| 24 | **Compliance export centre + `data_requests` log; fix L4** (§4) | **M** |
| 25 | **Browsable lists, saved views, bulk actions** (§4) | **L** |

### Post-launch

26. Analytics: funnel, cohorts, liquidity, net GMV (**L**) — `ANALYTICS_KEY` is null and `admin_dashboard_metrics` is all-time counters, so the beta currently cannot answer the one question a beta exists to answer.
27. Review-ring, referral-farm, dispute-abuse rules (**M**).
28. "View as user" (**L**).
29. App Store / Play risk review: 1099 contractor framing, in-person safety copy, UGC moderation evidence, account deletion path (already built).

---

## 7. Recommended build order

**Phase 0 — this week, before any tester touches it (≈3–4 days)**

1. On-call alias + pager wiring; write both runbooks; drill each once. *(S)*
2. In-app support intake — replace the three `mailto:`s with `support-submit`. Without this the console's support section is dead on TestFlight. *(S)*
3. Tip cap in `stripe-tip` + a BEFORE-INSERT trigger on `tip_ledger`. This is the cheapest six-figure hole in the product. *(S)*
4. Stripe Dashboard Radar rules (card attempts, IP≠card country, prepaid review). Zero code, effective immediately.
5. Edge-function error sink. *(S)*
6. Fix M1 (role gate in `support-reply`/`support-ai-draft`/`send-push`), M2 + L5 (authorized vs captured labels), L1 (fail-closed peer check), L2 (audit before mutate). *(S — half a day total)*

**Phase 1 — the console can respond (≈1.5 weeks)**

7. `app_flags` + `/flags`. Build this before opening the beta so incident response exists at all. *(S)*
8. `/access` + `waitlist_requests`. *(S)*
9. Refunds & payout intervention: `payments.refunded_cents`, `'refunded'` status, `admin-payment-action` function, `/payments/[id]/resolve`, and fix L7 + M3 in the same migration. *(L)*
10. Dispute workflow — unblocks `earner-claim-payment`. *(M)*
11. Booking intervention + `/bookings` list with the "authorization expiring <48h" view. *(M)*
12. Moderation case page with cross-thread evidence + redaction. *(M)*

**Phase 2 — risk engine (≈2 weeks)**

13. `risk_signals` / `risk_scores` / `private.risk_state()` schema. *(M)*
14. Stripe telemetry ingestion + persist `card_fingerprint`/`risk_level` on `payments`. *(M)*
15. Capture-hold enforcement in both settlement paths + the 48h pager. *(M)*
16. Payout `delay_days: 7` + freeze/release helpers. *(S)*
17. Velocity caps + collusion detector + off-platform + identity links via `risk_rescore()`. *(M)*
18. `/risk` queue + dashboard tiles + `admin_risk_precision()` + the `risk_engine_enabled` kill switch. *(L)*

**Phase 3 — launch hygiene (≈1.5 weeks, parallelizable)**

19. Staging project + GitHub Actions running the 281 tests, `supabase db push --dry-run`, and gating function deploys. *(M)*
20. Indexes + a load sanity pass. *(S)*
21. Backup/restore drill. *(S)*
22. Live Stripe key cutover: `eas.json` env blocks, remove the hardcoded `pk_test_`. *(S)*
23. Verification queues; admin lifecycle + MFA binding; legal publishing + real arbitration text. *(M each)*
24. Compliance exports + `data_requests`; fix the export CSRF guard. *(M)*

**Phase 4 — scale the operator (post-launch)**

25. Shared table shell → pagination, true counts, saved views, bulk actions across all six lists. *(L)*
26. Announcements + segmented broadcast. *(L)*
27. `admin_metrics_daily` rollup + `/analytics` funnel, cohorts, liquidity. *(L)*
28. Review-ring / referral-farm / dispute-abuse rules. *(M)*
29. "View as user". *(L)*

**Two rules that apply to everything new**, both grounded in confirmed defects: every new mutation writes its `admin_audit_log` row **before** the side effect (only `deleteAccount` does this today), and every new edge function gates on `admin_users.role`, **not** bare membership.