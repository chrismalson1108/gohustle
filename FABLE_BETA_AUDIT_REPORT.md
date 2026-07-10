# FABLE_BETA_AUDIT_REPORT.md — Independent Beta-Readiness Audit

*GoHustlr — TaskRabbit-style gig marketplace for college students (mobile Expo/RN + web Next.js + admin Next.js, one Supabase Postgres/RLS/Storage backend + Stripe manual-capture escrow + 23 Deno edge functions).*

**Reviewer:** Fable (executor) with a Fable advisor consulted at three checkpoints. **Scope of work:** commit `a70c9b5` (master). **Method:** defensive, read-only. No code changed, no production infra touched, no destructive commands, no external network calls.

---

## 1. Executive summary

GoHustlr is **feature-complete and its money/authorization/data-isolation core is verified sound in source.** I independently re-derived the prior audit's central claims by reading the actual code — the escrow money path, the booking state-machine guard, the exactly-once earnings/tip RPCs, the admin authorization chain, and the RLS/column-lockdown model — and they hold up. Several plausible attacks (tip IDOR, cash-path escrow bypass, counter-offer TOCTOU, double-booking) were traced and **refuted**.

The gaps that remain are not in the fintech core. They cluster in three areas that a pure code-security audit under-weights and that matter most for *this* product — **an app that arranges in-person meetings between strangers, one side of whom is 17–22 years old and identifiable by name, campus, and schedule**:

1. **Physical-world trust & safety** — a "Block" that doesn't block (and lies to the user that it does), safety reports that page no one, no age gate beyond a checkbox, and unverified adults arranging meetings at private addresses.
2. **Privacy exposure of a minor-inclusive student population** — the entire student directory *and* job feed (name, school, major, class year, city, free-text location, coarse coordinates, schedule) is readable by an **unauthenticated** caller holding the embedded anon key.
3. **A money-path fairness gap** — a poster who simply does nothing leaves an earner who did the work permanently unpaid when the ~7-day authorization hold expires. There is no auto-capture, no earner escalation.

Layered on top is an **epistemic gate**: every database-layer assurance in this report is conditional on the tracked migrations being fully applied to the live database *and* the Stripe webhook being registered live with the correct signing secret. Neither is verifiable from the repository. This is checkable — you have a linked CLI and dashboard access — but it has not been checked, so it must be, with saved evidence, before launch.

**Verdict (detailed in [FABLE_BETA_LAUNCH_DECISION.md](FABLE_BETA_LAUNCH_DECISION.md)): default NO-GO, flipping to GO once a defined verification checklist carries attached evidence.** The blocking set is small and mostly cheap. This is a "close a handful of specific gaps and prove the hardening is live," not a "the architecture is wrong."

> **Remediation update (deployed 2026-07-10).** The High-severity code blockers **H1–H8** are implemented (smallest safe changes, `npm test` green: 16 suites / 111 tests) **and now deployed to production**:
> - **Supabase** — all 7 migrations applied via `supabase db push` (verified: `supabase migration list` shows them remote; an anon-key `curl` to `/rest/v1/profiles` and `/rest/v1/jobs` now returns **HTTP 401 permission denied**, while `legal_documents` still returns 200 — the exact §9 checklist evidence). Edge functions `safety-alert`, `earner-claim-payment`, and the updated `assistant` deployed (verified: `safety-alert` → 503 `not_configured` fail-closed with `verify_jwt=false`; `earner-claim-payment` → 401 JWT-gated).
> - **Web (Vercel)** — merged to `master`, production deploy **Ready** (`gohustlr.com` 200, `/onboarding` 200). Full `next build` + `tsc` pass.
> - **Two live consequences now in effect:** signups are **closed** to all but the seeded founder email (add invitees to `beta_allowlist`), and anonymous reads of `profiles`/`jobs` are revoked.
>
> **Still required (cannot be done from the repo / need DB-password or dashboard):** (a) H6 activation — set the `app.safety_alert_url`/`app.safety_alert_secret` GUCs + `SAFETY_ALERT_SECRET` secret (RESEND_API_KEY is already set); (b) **mobile EAS build/OTA** — the RN client changes (DOB collection, earner-claim CTA, block hub filter, gate copy) reach devices only after a build (server-side enforcement is already live for all clients); (c) seed `beta_allowlist` with invitees. Config-only / later-phase High items **H9/H10/H11/H12** remain out of this pass. The launch decision's evidence checklist still governs GO.

---

## 2. Scope, method, and confidence

**What I did.** Read the nine handoff docs; then independently read the load-bearing source myself (the six Stripe edge functions, `accept-booking`, the webhook, `guard_bookings_write`/`guard_jobs_write`, `credit_earnings`/`claim_and_credit_tip`, the admin `requireAdmin` chain, the profile column-lockdown, storage policies); then ran a 19-agent independent-verification workflow (each agent reading real source, not the docs), producing 84 candidate findings deduplicated to 42, with the high-severity and blocking ones adversarially re-verified against source. I consulted a Fable advisor after establishing the architecture, before finalizing findings, and before finalizing the launch decision.

**Confidence labels used below:**
- **CONFIRMED (source):** grounded in code I or a verifier agent read and an adversarial pass did not overturn. True regardless of deploy state.
- **CONFIRMED (source), live-conditional:** true in the fully-applied tracked state; whether production matches is unverifiable from the repo.
- **DEPLOY/DASHBOARD STATE:** cannot be determined from source at all (Stripe mode, webhook registration, Supabase auth settings, realtime authorization, Vercel env).

**What I did NOT do:** run anything against live Supabase/Stripe/Vercel, execute the manual QA matrix, or verify dashboard state. Those are the launch-decision verification items.

---

## 3. What is sound (independently verified)

These were checked against source and found working. They are the reason this is a "close specific gaps" audit and not a rebuild. Fuller detail in [FABLE_SECURITY_PRIVACY_REVIEW.md](FABLE_SECURITY_PRIVACY_REVIEW.md).

**Escrow money-math is server-authoritative and correct.** The charge amount is computed purely from DB rows (`rate = counter_offer ?? job.pay`, `× hours` for hourly, `× 100`), never from the request body; bounded to [50¢, $10,000] before reaching Stripe; the 10% fee is recomputed identically at create and full-capture; the web `SERVICE_FEE_PCT` is display-only so there is no charge-vs-display divergence. Partial capture is clamped to [0.5, 1.0] and can never over-capture, and the reduced net is persisted **before** `stripe.capture` so a racing webhook credits the reduced value. (`stripe-create-payment-intent/index.ts:92-100`; `stripe-capture-payment/index.ts:36-44,100-135`.)

**Crediting is exactly-once.** `credit_earnings` is a single conditional `UPDATE` that flips `earnings_credited` only when `status='captured'` and amount > 0 — safe against the capture-retry + webhook race. `claim_and_credit_tip` uses a unique `tip_ledger` PaymentIntent insert plus a `credited`-flag claim in one transaction. Both RPCs have `EXECUTE` revoked from `public/anon/authenticated`; only service-role edge functions call them. (`20260624220000_review5_db_fixes.sql`; `20260624240000_review7_db_fixes.sql`.)

**Free work is impossible.** `accept-booking` is the sole confirm path and requires a real Stripe `requires_capture` hold before flipping to `confirmed`; `guard_bookings_write` forbids a client setting `confirmed` directly, and gates `completed→verified` on an `EXISTS` captured-payment predicate. (`accept-booking/index.ts:56-77`; `20260702030000_...:75-77`.)

**The booking guard is authoritative.** `guard_bookings_write` forces `INSERT status='pending'`, raises on self-booking, pins every counterparty-owned column (earner_id, job_id, counter_offer, tip_amount, the ratings each side receives), and whitelists status transitions per party. Double-booking is prevented atomically by `UNIQUE(job_id, earner_id)` + the `bookings_one_active_per_slot` partial index; `accept-booking` is idempotent and gated with `.eq('status','pending')`.

**Refuted attacks:** tip IDOR (the charged customer is always the caller's own; caller must be the booking's poster; `tipCents` bounded), cash-path bypass (`paymentMethod` is a cosmetic label hardcoded to `'card'`; the guard reads only the captured-payment predicate), counter-offer TOCTOU (`counter_offer` is pinned in both guard branches post-insert), and capture-after-cancel (cancel and capture operate on disjoint status sets, both re-read status server-side).

**Admin authorization is complete.** Every mutating server action, route, and console page funnels through `requireAdmin()`/`requireAdminPage()` (`getUser` → AAL2/MFA → `admin_users` membership → tier, fail-closed). Support tier is read-only + ticket triage. The audit log is append-only even to `service_role`; `audit()` is awaited before irreversible actions; `assertActionableTarget` blocks self/other-admin. The PII export rejects cross-site requests and UUID-validates its input.

**Web data protection is sound by design:** every `(app)` page is a client component with no server-side data fetch and no service-role key; no XSS sink exists anywhere in `web/`; the CSP is enforcing (`frame-ancestors 'none'`, `object-src 'none'`, HSTS preload, dev-only `unsafe-eval`); the geocode route validates inputs and hardcodes the upstream host (no SSRF). RLS is the real backstop for the client-only auth gate.

**Other verified controls:** coordinate fuzzing to ~2 decimals (~1.1 km) applied to the stored value; availability gated behind an opt-in `SECURITY DEFINER` RPC; account deletion cascades completely and purges storage; legal-consent gating fails closed and is idempotent; PKCE/recovery-client isolation; self-referral blocked; `send-push` requires a shared booking and sanitizes payloads; server-side content moderation `guard_prohibited_content` genuinely raises (blocks) for its listed terms.

> **All DB-layer assurances above are live-conditional** on the full ordered tracked migration set being applied and the Stripe webhook being live-registered. See §5 and the launch decision.

---

## 4. Findings overview

42 verified findings. Full technical detail with `file:line` evidence and adversarial verdicts is distributed across the three topical reports; this table is the index. **"Blocks?"** = must be resolved before *any* external user, for a *genuinely closed* beta.

### 4.1 High severity

| # | ID | Finding | Blocks? | Report |
|---|---|---|---|---|
| H1 | `beta-not-actually-closed` | **No server-side invite/allowlist gate exists** — signup is open Supabase email/password with the embedded anon key; the "closed beta" is a policy intention, not a control. gohustlr.com has open public signup. This is the load-bearing assumption under which most other findings are non-blocking. | **YES** | Security |
| H2 | `block-not-server-enforced` | **Block is UI-only and the UI lies about it** — no RLS/trigger consults `blocks` on message/booking insert; a blocked user keeps messaging and can book the blocker's gigs, while the dialog says *"they can't reach you here."* | **YES** | Abuse |
| H3 | `poster-ghosting-hold-expiry` | **A student can do the work and never get paid** — no auto-capture/cron; if the poster never marks done or never verifies, the ~7-day authorization hold auto-expires and the earner cannot be paid. | **YES** | Abuse |
| H4 | `profile-pii-cross-user` | Student directory (name, school, major, class year, city) is granted to **`anon`** — bulk-scrapable without login; no privacy opt-out. Compounds with H5. | **YES** (anon revoke) | Security |
| H5 | `jobs-anon-scrapable` | `jobs_select_all USING(true)` is anon-readable — job titles, free-text location, coarse coords, and slot times scrapable without login. Composite with H4 = "who is where, when." | **YES** (anon revoke) | Security |
| H6 | `safety-reports-no-alerting-sla` | Safety reports are a bare insert into a poll-only queue — no trigger/email/push, analytics stubbed. A harassment/assault report pages no one. | **YES** | Abuse |
| H7 | `no-age-verification` | Only a self-attested "I'm 18" checkbox; no DOB collected; the backend never learns the user's age; a minor can transact. | **YES** (min DOB gate) | Security |
| H8 | `prohibited-activity-policy-gap` | Moderation is an ~18-term wordlist; academic cheating, alcohol-to-minors, most drugs, weapons, and off-platform-payment solicitation all pass; the assistant will compose such gigs. | **YES** (terms + gig review) | Abuse |
| H9 | `grooming-funnel-instant-free-chat` | Private chat opens on a free, instant, unaccepted, unverified `pending` booking; contact-exchange ("add me on snap") passes the filter. | Fast-follow¹ | Abuse |
| H10 | `no-id-verification-post-or-book` | ID verification is optional/badge-only; nothing requires the poster (who controls the meeting location) or the booker to verify identity. | Before OPEN¹ | Abuse |
| H11 | `stolen-card-no-payout-friction` | Connect accounts get daily auto-payouts, no `delay_days`/reserve/velocity/first-payout review; destination charges make the platform merchant of record. | **YES** (config)² | Abuse |
| H12 | `no-chargeback-dispute-webhook` | The webhook has no `charge.dispute.created`/refund/transfer-reversal handler; a stolen-card chargeback debits the platform 100% while the earner is already paid out. | Before OPEN² | Abuse |

¹ Bounded once H2/H6/H7 and the invite gate (H1) are fixed. ² Beta mitigation is a Stripe-dashboard config + a manual runbook, not code.

#### 4.1.1 Remediation status — High-severity code blockers

Tracking the in-code fixes for the Phase-1 High blockers (per FABLE_FIX_PLAN.md §1). "Fixed (code)" = the source change has landed on this branch with tests; items whose *enforcement* depends on live deploy/config are flagged. Purely dashboard/config High items (H11) and later-phase items (H9/H10/H12) are out of this pass's scope and left as-is.

| ID | Status | What shipped |
|---|---|---|
| H1 | ✅ Fixed (code), enforcement live-conditional | Added a server-side closed-beta gate: new `beta_allowlist` table (RLS-locked, no client read) + re-created `handle_new_user` (migration `20260710000000_beta_invite_gate.sql`) to RAISE (rolling back the `auth.users` insert) for any non-allowlisted signup — covers email/password **and** OAuth. A `'*'` row opens the beta with no redeploy; founder email seeded. Client maps the rejection to beta copy (`src/lib/authErrors.js`, wired into `AuthContext.signUp`). Tests: `__tests__/authErrors.test.js`. **Deploy note:** the gate is only live once the migration is applied AND public signups on gohustlr.com/web route through this same Supabase project (they do — one backend). |
| H2 | ✅ Fixed (code) | Block is now server-enforced (migration `20260710030000_block_enforcement.sql`): `messages_insert` RLS rejects a message when either booking party has blocked the other (bidirectional), and a dedicated `guard_booking_not_blocked` BEFORE INSERT trigger rejects a new booking between a blocked pair. **Adversarial review caught a real hole and it was fixed:** an inline `blocks` subquery inside the RLS policy is filtered by `blocks`' own owner-scoped RLS, so it only saw the *sender's* rows and silently failed to stop the *blocked* party — the block check now goes through a `SECURITY DEFINER` `private.is_blocked_pair()` helper (housed in a non-exposed `private` schema so it isn't a PostgREST RPC oracle over the block graph) that sees both directions. Client: the Messages hub filters blocked conversations (`notBlocked`), copy no longer over-promises. Tests: `__tests__/block.test.js`. |
| H3 | ✅ Fixed (code) — earner-initiated (owner-chosen) | Guarantees a ghosted earner gets paid **without auto-moving money on a timer** (owner chose earner-initiated over cron auto-capture). New `earner-claim-payment` edge function lets the booking's earner settle their **own** completed work once the poster ghosts: authorizes the earner, requires `earner_done`, enforces a 3-day grace past the scheduled time, **skips open disputes and unresolved reports**, checks the payout account, then captures the FULL hold + credits exactly once (reusing `credit_earnings`). Client: `EarnScreen` shows a "Claim your payment" escalation CTA when eligible; pure predicate `canClaimEarnerPayment` (grace = `EARNER_CLAIM_GRACE_DAYS = 3`) in `shared/lifecycle.js`. Tests: `__tests__/earnerClaim.test.js` (predicate boundaries + server-guard presence). **Adversarial review caught + fixed an over-credit race:** if a poster ran a partial (dispute) capture concurrently, the earner-claim path could clobber `earner_amount_cents` to the full split and over-credit vs. what Stripe actually collected — it now treats Stripe's `amount_received` as the source of truth (captures only when Stripe still shows the hold uncaptured, then reconciles the row to the actual captured amount before crediting). **Note:** timer-based hold-expiry push alerts would need a scheduler (deferred); the in-app CTA is the escalation. Money movement stays human-initiated, so this does **not** depend on the H11 payout delay to be safe — though setting it is still recommended. |
| H4 | ✅ Fixed (code) | `revoke select on public.profiles from anon` (migration `20260710020000_revoke_anon_public_read.sql`) — kills the unauthenticated student-directory scrape. `authenticated` keeps its column-scoped grant, so signed-in flows are unchanged. Prereq: backfilled the missing `skill_rates`/`stripe_identity_session_id` DDL (`20260624220500_...`, timestamped before the column-lockdown) so a fresh rebuild applies the lockdown instead of aborting. Verified the web `(app)` layout never fetches as `anon` (auth-gated, static landing). Regression guard: `__tests__/anonRevoke.test.js`. Column-set trimming for authenticated users is a separate Medium (left as-is). |
| H5 | ✅ Fixed (code) | `revoke select on public.jobs from anon` (same migration) — the job feed (title, free-text location, coarse coords, slot times) is no longer anonymously scrapable, breaking the profiles×jobs "who is where, when" composite for anon callers. |
| H6 | ✅ Fixed (code), config-conditional | Safety reports now page a human: AFTER INSERT trigger on `reports` → `pg_net` → new `safety-alert` edge function → Resend email to the on-call owner (migration `20260710050000_safety_report_alerting.sql` + `supabase/functions/safety-alert/index.ts`). The trigger is a **no-op until configured** (guarded on the `app.safety_alert_url` GUC) and swallows dispatch errors, so a failed alert never rolls back a safety report. Tests: `__tests__/safetyAlert.test.js`. **Deploy note:** set the `app.safety_alert_url`/`app.safety_alert_secret` GUCs, deploy the function `--no-verify-jwt` with `SAFETY_ALERT_SECRET`/`SAFETY_ONCALL_EMAIL`/`RESEND_API_KEY`. Admin inbox badge is a smaller follow-up. |
| H7 | ✅ Fixed (code), backfill pending | Minimum age floor of 18. DB: nullable `date_of_birth` column + `guard_min_age` BEFORE INSERT trigger on jobs/bookings/messages that hard-blocks a **known** under-18 (migration `20260710040000_age_floor.sql`). Client: DOB collected + 18+ gate at onboarding on **both** platforms (mobile `OnboardingScreen`, web `onboarding/page.tsx`), using one shared, tested helper (`shared/age.js`, re-exported to `src/lib/age.js`). Tests: `__tests__/age.test.js`. **Residual (by design, per fix-plan trap #4):** column is nullable so existing testers aren't bricked — a legacy user with no DOB isn't blocked until they set one; once the (invite-gated, small) cohort is backfilled, tighten `guard_min_age` to block NULL too. Self-attested DOB = age floor, not full IDV. |
| H8 | ✅ Fixed (code) | Expanded the prohibited-term blocklist (drugs, weapons, alcohol-to-minors/fake-ID, academic/contract cheating, off-platform-payment) across all three synced copies — `shared/contentFilter.js`, `supabase/functions/assistant/index.ts`, and new migration `20260710060000_moderation_expand_terms.sql` (re-creates `contains_prohibited`). Added an `ASSISTANT_ENABLED=false` beta kill-switch to the assistant function (default = enabled, no behavior change). Tests: extended `__tests__/contentFilter.test.js` (new categories + evasion + no-over-block) and re-pointed `__tests__/moderationSync.test.js` at the new migration so the 3-way lockstep still holds. |
| H9/H10/H12 | ▫️ Out of scope (later phase) | Fast-follow / Before-OPEN per fix plan. |
| H11 | ▫️ Out of scope (config) | Stripe-dashboard payout config, not code. |

### 4.2 Medium severity

| ID | Finding | Report |
|---|---|---|
| `completion-photos-writable-array-read` | Private completion-photos read is authorized via an earner-writable `before_photos`/`completion_photos` array with no path guard (the `chat_photos` guard was never replicated) → cross-user photo read if the object path is known. | Security |
| `certificates-bucket-public-pii` | The `certificates` bucket is `public=true`, read policy grants **anon**, objects are enumerable — credential documents (names, license numbers) harvestable at scale. | Security |
| `public-bucket-mime-allowlist-missing` | The MIME/size allowlist for `avatars`/`job-photos`/`receipts` lives only in a `SUPERSEDED — DO NOT RUN` file → a rebuild from tracked migrations leaves public buckets accepting SVG/HTML (stored-XSS on the storage origin). | Security |
| `skill-rates-no-ddl-rebuild-abort` | `profiles.skill_rates` has no `ADD COLUMN` DDL in the repo, yet the column-lockdown migration grants it unguarded → a fresh rebuild **aborts** at that grant, potentially leaving `profiles_select_all` with full-column visibility. Pairs with H4. | Security |
| `deploy-drift-rls-migration-order` | `schema.sql` ships permissive `USING(true)` policies neutralized only by later migrations; a partial apply or a re-run of a superseded loose file reopens real holes (profile columns, slot writes, review forgery, client-writable Stripe rows). | Security |
| `location-exposure-freetext` | `jobs.location` is unfiltered free text shown to all users pre-booking; a street/dorm address can be broadcast, defeating the coordinate fuzzing. | Security/Abuse |
| `job-price-repricing-pending-window` | A poster can re-price `pay`/`estimated_hours` while a booking is `pending` (guard pins only when `confirmed`+); escrow is computed at accept with no earner re-consent. | Abuse |
| `collusion-self-dealing-undetected` | Only same-account self-booking is blocked; two colluding accounts launder card funds and farm earnings/reviews. | Abuse |
| `sybil-multiaccount-cheap` | Any email, email-verify only, no phone/device binding; `.edu` is an optional badge, not a gate. | Abuse |
| `assistant-cost-cap-fail-open` | The per-user Anthropic cost cap fails **open** if `assistant_rate` is unavailable; amplified by Opus routing + a 9-call tool loop. | Abuse |
| `geocode-open-proxy` | `/api/geocode` is unauthenticated and unthrottled (cost/DoS abuse; SSRF is soundly prevented). | Security |
| `send-push-notification-abuse` | A declined/cancelled counterparty can inject official-looking `payment`/`system` push + persistent inbox alerts (phishing primitive); rate limit fails open. *(elevated from Low.)* | Abuse |
| `onboarding-legal-acceptance-ordering` | Mobile marks the account onboarded **before** a best-effort `recordAcceptances`; a silent failure leaves a transacting user with no legal-acceptance row (web blocks-on-fail). | Security |
| `cancel-hold-failopen-7day` | Best-effort hold release; on failure the authorization hold lingers on the payer's (often a student's) card up to ~7 days with no in-app indication. | Abuse |
| `review-retaliation-no-protection` | Mutual reviews with no double-blind/shield let a poster retaliate against a student who declines unsafe work or reports a problem. | Abuse |
| `no-safety-interstitial-runbook` | No pre-booking safety guidance, no in-gig "get help," no incident-response runbook. | Abuse |
| `realtime-authz-unverified` | Realtime channel authorization (`msgs-${bookingId}`) is dashboard/publication state, not in the repo — a guessed `bookingId` subscription is a live verify item. | Security |
| `no-payout-freeze-refund-tooling` | The admin console can suspend/ban/delete/takedown but has no payout-freeze/transfer-reversal/refund tooling — remediation is manual via the Stripe dashboard (needs a runbook). | Abuse |
| `money-path-arithmetic-untested` | Escrow split, partial-capture math, the fee constant, and cancellation/lifecycle helpers have zero tests and the core math is trapped in un-importable Deno edge functions. | Security |
| `db-invariants-untested` | The booking guard's transition matrix, credit/tip idempotency, RLS boundaries, and `deleteUserCascade` have no automated tests. | Security |

### 4.3 Low severity

`cancellation-fee-false-money-copy` (poster-only misleading copy; no money moves — recalibrated from Medium), `stripe-pk-test-fallback` (silent test-mode if prod env unset), `moderation-normalization-parity` (DB backstop weaker than client filter), `moderation-field-coverage` (skips requirements/slots/location/city/skills), `tip-idempotency-key-design` (duplicate same-amount tip dropped as false success; no cumulative cap), `capture-prepersist-error-ignored` (bookkeeping-only over-credit, no real fund impact), `jobs-status-unguarded` (poster can flip own gig status; booking insert not gated on it), `amendment-unscoped-core-unlock` (earner-self-settable, persistent core-edit unlock), `decline-hold-before-write` (releases hold before DB write, reverse of cancel's safe ordering), `admin-peer-check-fail-open` (peer-admin check ignores query error), `signup-account-enumeration` (confirmed-account existence leak), `csp-unsafe-inline` (no active sink today), `assistant-prompt-injection-no-code-gate` (bounded, self-scoped), `ccpa-no-self-serve-export` (deletion exists, access/export does not), `hourly-topup-missing` (no path to pay for extra hours on an over-run gig).

---

## 5. The epistemic gate: code-on-master ≠ live-in-production

This is the single most important framing for the launch decision. The prior audit hardened dozens of policies, guards, and edge functions, but many are marked "code-complete, needs push/deploy." From the repository alone it is **impossible to verify**:

- whether every tracked migration is applied to the live DB, in order (no `supabase_migrations` snapshot in-repo);
- whether the Stripe webhook is registered in the target mode with the correct signing secret and all required events (payment + identity + — recommended — dispute);
- whether Stripe is in live vs test mode on the deployed edge functions;
- Supabase Auth settings (`mailer_autoconfirm`, HIBP, OTP expiry, redirect allowlist, user MFA);
- realtime authorization; Vercel env (`NEXT_PUBLIC_*`, live Stripe keys); backups/PITR.

Every "sound" claim in §3 that touches the DB is therefore **conditional**. The good news: this gate is *checkable*. The launch decision converts "unverifiable from repo" into "verified on date X" via an evidence-backed checklist and a repeatable introspection script.

**Highest-leverage single item:** confirm the Stripe webhook is live-registered with the correct signing secret. If it is stale/missing, *payments still charge but earnings never credit and the Verified badge never appears* — a silent, money-losing failure.

---

## 6. Deliverables map

| Report | Contents |
|---|---|
| **FABLE_BETA_AUDIT_REPORT.md** (this doc) | Scope, method, what's sound, full findings index, epistemic gate. |
| [FABLE_SECURITY_PRIVACY_REVIEW.md](FABLE_SECURITY_PRIVACY_REVIEW.md) | Authorization/IDOR, RLS & column-grant matrix, storage & receipts, PII exposure of a minor-inclusive population, auth surface, admin, deploy-drift/reproducibility, missing tests. |
| [FABLE_MARKETPLACE_ABUSE_REVIEW.md](FABLE_MARKETPLACE_ABUSE_REVIEW.md) | Fraud economics (stolen-card cashout, chargebacks, collusion, Sybil), lifecycle abuse (poster ghosting, re-pricing, duplicate acceptance), and physical-world trust & safety (blocking, reports, grooming funnel, verification asymmetry, review retaliation). |
| [FABLE_BETA_LAUNCH_DECISION.md](FABLE_BETA_LAUNCH_DECISION.md) | The go/no-go verdict, the blocking set, and the evidence-backed verification checklist that flips NO-GO → GO. |
| [FABLE_FIX_PLAN.md](FABLE_FIX_PLAN.md) | Prioritized, sequenced remediation — code vs config, order-of-operations traps, effort, and owners. |

---

## 7. Bottom line

The engineering that is hard to get right — escrow correctness, exactly-once crediting, the booking state machine, admin authorization, tenant isolation — **is right**, subject to being deployed as written. What is missing is the softer, cheaper layer that this specific product needs most: a closed beta that is actually closed, a guarantee that completed work gets paid, a block that blocks, safety reports that reach a human, an age floor, and a student directory that isn't anonymously scrapable. None of these is architecturally hard. All of them would be indefensible to have shipped knowingly. Close the blocking set, prove the hardening is live, and this is ready for a small, vetted, invite-only beta.
