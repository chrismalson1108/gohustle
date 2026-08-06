# BETA_QA_PLAN.md — GoHustlr Beta QA Plan

_Verified 2026-07-07 at commit a70c9b5 (master)._

An executable, manual-first QA plan for the GoHustlr beta. GoHustlr is a TaskRabbit-style two-sided gig marketplace aimed at college students, running as three apps on one Supabase backend: **MOBILE** (Expo/React Native, `src/` + `App.js`), **WEB** (Next.js 16, `web/`), **ADMIN CONSOLE** (Next.js 16, `admin/`). Shared pure-ESM logic lives in `shared/` (`@gohustlr/shared`). Backend = Supabase (Postgres + RLS, Auth, Realtime, Storage) + **23** Deno edge functions (each `supabase/functions/<name>/index.ts`; no `_shared` dir — AUDIT_REPORT.md/CLAUDE.md say 24, off by one vs. disk). Payments = Stripe in **TEST mode for beta** (`admin/lib/config.ts:19` default `/test`) **[Needs Fable Review — live cutover mode unverifiable from code]**, manual-capture escrow, Connect Express payouts, Identity, tips.

This document stands alone: enforcement points, expected results, and severity are inlined. Companion docs (do not need to be read to execute this plan): `ROLE_PERMISSION_MATRIX.md`, `PRODUCT_FLOW_MAP.md`, `LIFECYCLE_STATE_MACHINES.md`, `KNOWN_RISKS.md`. (`BASELINE_STATUS.md` and `CURRENT_COMMANDS.md` were retired on 2026-08-06; `CLAUDE.md` now carries the verified command list.)

---

## 1. Current automated coverage & testing philosophy for beta

### 1.1 What automation exists today

- **79 passing unit tests, pure logic only.** 10 Jest suites in `__tests__/` (`analytics, availability, certified, contentFilter, filters, finance, geo, moderationSync, school, taxFormat`). Runner: Jest 29.7.0, `testEnvironment: 'node'`, `testMatch: ['**/__tests__/**/*.test.js']` (`jest.config.js:1-9`). No coverage flags, no CI-visible thresholds, no coverage gate.
- Every test imports a leaf module and asserts on return values. **No test touches money movement, no state transition, no permission boundary, no auth flow, no rendering, no network, no Supabase, no Stripe, no RLS, no navigation.**
- **`web/` is explicitly excluded from Jest** (`testPathIgnorePatterns: ['/node_modules/', '/ios/', '/android/', '/web/']`, `jest.config.js:7`). `admin/` is not excluded but has **zero** test files. Confirmed by `find` across the repo: there are **no** `*.test.*` / `*.spec.*` files under `web/`, `admin/`, `shared/`, `src/`, or `supabase/`.
- **No e2e / integration harness anywhere** — no Detox, Maestro, Playwright, or Cypress. No seeded-Supabase / Stripe-test-mode integration project in-repo. The core money loop (post → book → accept → complete → verify → rate) has **zero** automated end-to-end coverage.

**Genuinely well-covered (pure logic, cross-platform via `shared/`):** content-moderation string normalization incl. leetspeak/homoglyph/punctuation evasion (`contentFilter.test.js` against `shared/contentFilter.js`); the moderation blocklist drift guard (`moderationSync.test.js` asserts the RN client, the Deno `assistant` edge fn, and the Postgres `contains_prohibited` blocklists are identical); CSV/tax-export formula-injection neutralization (`taxFormat.test.js:23-39`); finance-coach math; discovery/matching (`matchesForYou`, `skillFitScore`); insights and the 50-job certification threshold; availability, geo distance, and `.edu` parsing.

### 1.2 Testing philosophy for beta

1. **Manual matrix now.** This document is the source of truth for beta. Every test below is executable by a human tester across mobile, web, and admin with a small set of seeded accounts. Run the full matrix before external users, and re-run the Smoke + Auth + money-loop subset before every deploy.
2. **Automate the money loop before external users.** The highest-value automation gap is the escrow money loop. Before external users, stand up a minimal happy-path e2e (Maestro or Detox for mobile; a seeded Supabase + Stripe test-mode integration for the edge/DB layer) that proves: post → book → accept (escrow authorized) → mark-done ×2 → verify (escrow captured, earnings credited exactly once) → tip credited once. This is called out as a remaining P0 item in `LAUNCH_PLAN` and `ROADMAP`.
3. **Extract-and-unit-test the arithmetic that moves real dollars.** Payment-intent amount/fee/bounds (`stripe-create-payment-intent/index.ts:94-101`), capture split (`stripe-capture-payment/index.ts:99-130`), tip bounds (`stripe-tip/index.ts:27`), and the cancellation-fee formula (`src/context/JobsContext.js:118-128`) are all untested pure math. Extract each into `shared/` and unit-test before beta — cheap, high value.
4. **Two-client RLS integration tests are the single biggest untested security surface.** The 48 tracked migrations under `supabase/migrations/` encode every permission boundary; no automated test proves any policy actually denies a cross-user read/write. Where automation is not yet in place, the Permission / Data-privacy sections below cover these boundaries manually.

**Deploy caveat that shapes QA:** the 2026-07 hardening fixes — certificates MIME allowlist, private `chat-photos`/`completion-photos` buckets, server-side DB moderation, `send-push` rate limit, redirect-URL pinning — were once code-complete on `master` but unverified in production. **That is now resolved:** `supabase db push --linked` is the canonical path and the tracked migration set matches live (re-verified 2026-08-05). The discipline it implied still holds, though, and for a stronger reason than the original doubt: source cannot prove deployment. Every security/privacy test below must be run **against the live target environment**, not just against source, and the tester must record which environment was used.

---

## 2. Test categories

Severity key: **Critical** = money wrong/lost or cross-user data leak or app unusable; **High** = core flow broken or lifecycle corruption; **Medium** = degraded flow or wrong non-money data; **Low** = cosmetic/edge. Automate-before-beta names the harness: **unit** (Jest/Vitest), **integration** (seeded Supabase + Stripe test mode), **e2e** (Maestro/Detox/Playwright).

### 2.1 Smoke

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| App boots (mobile) | Any | Fresh install, SDK 54 Expo Go / dev build | Launch app | Loading spinner → AuthScreen (no session) or MainApp (session); no crash; `ErrorBoundary` not triggered | Critical | Yes — e2e |
| App boots (web) | Any | Prod web URL | Load `/` | Renders; app-shell gate `web/app/(app)/layout.tsx:16-45` routes to login or browse; no console errors | Critical | Yes — e2e |
| Admin console boots | admin | MFA-enrolled admin account | Load admin URL, sign in + TOTP | Dashboard renders after `requireAdmin` AAL2 check (`admin/lib/guard.ts:52-71`) | High | No |
| Session persistence | Any | Signed in on mobile | Kill and relaunch app | Returns to MainApp without re-login (AsyncStorage session) | High | Yes — e2e |
| Tab navigation | Authenticated | Onboarded user | Tap each of Browse / My Jobs / Hiring / Messages / Profile | Each tab renders its stack; tab badge counts load | Medium | Yes — e2e |
| Pull-to-refresh | Authenticated | Any list screen | Pull down on Browse / My Jobs / Hiring / Profile | Full reload bypassing cache; spinner resolves | Low | No |
| Core money loop end-to-end | Poster + earner | Onboarded poster + Connect-onboarded earner, Stripe test mode | Post → book → accept → mark-done ×2 → verify | Booking reaches `verified`, escrow captured, earner earnings credited once | Critical | Yes — e2e + integration |

### 2.2 Auth

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Email sign-up + verify gate | New user | Email verification ON (`mailer_autoconfirm=false`) | Sign up (password ≥8, match, 18+/terms checkbox) | `signUp` returns no session; "Verify your email" panel shown; `pendingEmail` set (`AuthContext.js:264-290`) | Critical | Yes — e2e |
| Sign-up rejects weak/mismatched password | New user | — | Password <8 or mismatch | Blocked client-side (`AuthScreen.js:109-110`); no request sent | Medium | Yes — unit (`friendlyAuthError`) |
| Sign-in unverified email | New user | Signed up, email not confirmed | Sign in | `email_not_confirmed` mapped to friendly message + `pendingEmail` set (`AuthContext.js:147-151`) | High | Yes — unit + e2e |
| Sign-in valid | Existing user | Confirmed account | Enter creds | Session set; mobile routes to MainApp; web `router.replace('/browse')` | Critical | Yes — e2e |
| Resend confirmation | New user | Pending verification | Tap Resend | `resendConfirmation` fires; rate-limit codes handled (`AuthContext.js:292-299`) | Medium | No |
| Google OAuth (web + mobile build) | New/existing | Not Expo Go (blocked `AuthContext.js:169-172`) | Tap Google | PKCE flow; `?code` exchanged; routes to browse/onboarding | High | No |
| Apple Sign In (mobile only) | New/existing | iOS 13+, `isAvailableAsync` true | Tap Apple | ID-token sign-in; first-time `fullName` persisted (`AuthContext.js:249-253`); no web Apple path | Medium | No |
| Forgot → reset password | Existing user | — | Request reset → open email link | Mobile sends to web `gohustlr.com/reset-password`; recovery client never promoted to main session; `→ /login?reset=1` | High | No |
| `friendlyAuthError` mapping | — | — | Feed known error codes | Each maps to correct user text (`web/lib/authErrors.ts:12`) | Low | Yes — unit |
| Sign-out clears session | Authenticated | Signed in | Sign out | Session cleared, `unregisterPushToken`, cache cleared (`AuthContext.js:321-344`) | High | Yes — e2e |
| Suspended user cannot use app | Suspended user | Admin suspended account (ban 100y + sessions revoked) | Attempt sign-in / use existing session | Access denied; sessions revoked (`admin_revoke_sessions`) | Critical | Yes — integration |

### 2.3 Onboarding

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Full onboarding flow | Freshly-confirmed user | `onboarding_done=false` | Welcome → Username → Role → Location → Skills+Radius/Bio → Done | `profiles.update({...,onboarding_done:true})`; routes to MainApp (`OnboardingScreen.js:104-142`) | Critical | Yes — e2e |
| Username uniqueness | New user | Existing username taken | Enter taken username | Live check fails; on `23505` bounces to step 1 (`OnboardingScreen.js:79-97,121-125`) | High | Yes — integration |
| Username regex | New user | — | Enter `AB` / `bad name!` | Rejected (`^[a-z0-9_]{3,30}$`) | Medium | Yes — unit |
| Returning user skips onboarding | Existing user | `onboarding_done=true` | Sign in | Straight to MainApp; onboarding not shown | High | Yes — e2e |
| OAuth consent capture | Google/Apple user | `provider !== 'email'` | Reach Done step | Terms checkbox shown for OAuth users who never saw signup checkbox (`OnboardingScreen.js:57`) | High | No |
| Legal acceptance recorded | New user | — | Finish onboarding | `recordAcceptances` writes `legal_acceptances`; **web blocks on failure first, mobile updates profile first then best-effort** (drift — see open questions) | High | Yes — integration |
| Referral recorded | New user | Signed up with referral code | Finish | `recordReferral` writes referral from signup metadata | Low | No |

### 2.4 Job posting

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Post a gig (happy path) | Poster | Onboarded | Fill title/category/pay/location/desc/slots → Post | `jobs` row inserted with `poster_id`, `status='open'`; slots + requirements inserted; toast; navigate to Hiring (`JobsContext.js:961-1035`) | Critical | Yes — e2e |
| Required-field validation | Poster | — | Submit with missing title/pay | Blocked with message (`PostJobScreen.js:84-87`); form preserved | Medium | Yes — e2e |
| Content filter on post | Poster | — | Put a prohibited term in title/desc/tags/hazards | `findProhibited` blocks client-side; DB `trg_guard_content_jobs` rejects if it reaches the server | High | Yes — unit + integration |
| Location coords snapped | Poster | Location chosen | Post an in-person gig | Coords rounded to ~1km for privacy (`Math.round(lat*100)/100`, `JobsContext.js:989-990`) | Medium | Yes — unit |
| Photos upload to job-photos | Poster | 1–6 photos selected | Post with photos | Uploaded to public `job-photos` bucket; URLs on job | Medium | No |
| Insert error preserves form | Poster | Induce DB reject | Post | Throws so form is preserved, not silently dropped (`JobsContext.js:998-1004`) | Medium | No |
| Hourly gig sets estimated hours | Poster | payType=hourly | Post with hours | `estimated_hours` stored; drives escrow hold amount later | High | Yes — unit |
| Duplicate gig prefill | Poster | Existing gig | Tap Duplicate | `PostJob` opens prefilled (`{prefill: job}`) | Low | No |

### 2.5 Job browsing

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Browse loads jobs | Any authenticated | Jobs exist | Open Browse | Cache-first then fresh; cancelled jobs excluded (`.neq('status','cancelled')`, `JobsContext.js:299`) | High | Yes — e2e |
| Category chips + search | Any | — | Pick a category / type query | List filters correctly | Medium | Yes — unit (`applyJobFilters`) |
| "For You" matching | Earner w/ skills | Skills set | Select "For You" | Matches viewer skills; empty-skills → none (`matchesForYou`) | Medium | Yes — unit |
| Distance + radius filter | Any | Profile city or chosen location | Apply radius / "Nearest" sort | `haversineMiles` distance per card; remote always shown; in-person needs coords (`HomeScreen.js:104-208`) | Medium | Yes — unit |
| Blocked posters filtered | Any | Blocked a poster | Open Browse | Blocked poster's gigs hidden (`blockedIds`, `HomeScreen.js:238`) | High | Yes — integration |
| Full filter sheet | Any | — | Set pay/days/state/payType/urgency | `countActiveFilters` reflects; results honor filters (`FilterSheet.js:12-43`) | Low | Yes — unit |
| Map view | Any | Native dev build | Open Map | `JobsMap` renders pins; no crash on web (guarded) | Low | No |
| Poster's own status flip hides feed integrity | Poster | Own live gig | (Adversarial) flip own `jobs.status='completed'` via API | **Known gap: `jobs.status` has no server transition guard (client-trusted).** Job leaves the open feed. No money impact. Confirm intended | Medium | Yes — integration |

### 2.6 Job acceptance

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Earner books a slot | Earner | Open gig, not own | Select slot → Book | `bookings` row `status='pending'`; slot `taken=true`; no payment at book time; poster notified (`JobsContext.js:452-494`) | Critical | Yes — e2e |
| Self-booking blocked | Poster | Own gig | Attempt to book own gig | UI blocks (`job.posterId===user.id`); DB guard raises "You cannot book your own gig" (`guard_bookings_write` INSERT branch) | Critical | Yes — integration |
| Past slots hidden | Earner | Gig with past slot | Open detail | Past slots hidden/blocked (`JobDetailScreen.js:88-95`) | Medium | Yes — unit |
| Application note content-filtered | Earner | — | Book with prohibited note | Blocked client-side; DB `trg_guard_content_bookings` backstop; note capped ≤500 | Medium | Yes — unit |
| Poster accepts → escrow authorized | Poster | Pending booking; earner Connect-onboarded; Stripe test | Accept + enter card | `stripe-create-payment-intent` manual-capture PI (escrow), 10% fee, transfer to earner acct; `accept-booking` requires PI `requires_capture` then flips `confirmed` guarded `.eq('status','pending')` | Critical | Yes — integration |
| Accept blocked without escrow | Poster | Pending booking, no PI | Force accept via API (no capture PI) | `guard_bookings_write` forbids client `pending→confirmed`; edge fn is the sole path and returns `NO_ESCROW` if no PI | Critical | Yes — integration |
| Accept blocked if earner not onboarded | Poster | Earner has no Connect payout account | Accept | `EARNER_NO_PAYOUT`; no confirm; self-heals cached flag by live account retrieval (`stripe-create-payment-intent:87-106`) | High | Yes — integration |
| Amount bounds enforced | Poster | Earner-controlled counter-offer | Book with counter-offer forcing amount <50¢ or >$10k | PI creation rejects out-of-bounds (`stripe-create-payment-intent:97`) | Critical | Yes — unit + integration |
| Idempotent PI reuse | Poster | Retry accept, same amount | Re-trigger PI creation | Existing live hold reused, no orphaned second auth (`:144,:159-197`) | High | Yes — integration |
| Poster declines | Poster | Pending booking with hold | Decline | Hold released; `status='declined'`; slot freed; earner notified (`JobsContext.js:694-721`) | High | Yes — integration |
| Concurrent accept vs earner-withdraw | Poster + earner | Pending booking | Earner cancels while poster accepts | Exactly one wins; `.eq('status','pending')` → `BOOKING_CHANGED`; no confirmed-with-released-hold | High | Yes — integration |
| Double-accept idempotent | Poster | Already confirmed | Accept again | Returns `alreadyConfirmed`; no second charge (`accept-booking:42`) | High | Yes — integration |

### 2.7 Job cancellation

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Earner withdraws pending | Earner | Pending booking | Cancel | `pending→cancelled`; slot freed; no fee (`cancelBooking`) | High | Yes — integration |
| Poster cancels confirmed → records fee | Poster | Confirmed booking | Cancel | Fee = `max(5, round(effectivePay*0.15))` recorded to `bookings.cancellation_fee`; **display/policy only, no money moves** (`JobsContext.js:118-128,741-750`) | High | Yes — unit (fee math) + integration |
| Cannot cancel a started booking | Either party | `started_at` set (worker on site) | Cancel | Hard error "Cannot cancel a job that has already started" (`trg_guard_started_booking_cancel` RAISES; `stripe-cancel-payment:49-51`) | Critical | Yes — integration |
| Cannot cancel completed/verified | Either party | Completed or verified booking | Cancel | Guard reverts; `stripe-cancel-payment` rejects 409 (`:43-45`) | High | Yes — integration |
| Cancel releases hold exactly once | Poster | Confirmed booking w/ hold | Cancel | Guarded booking write FIRST, then hold release with one retry; `payments.status='cancelled'` (`JobsContext.js:762-780`) | Critical | Yes — integration |
| Cancellation-fee IDOR guard | Non-party | Someone else's booking | Attempt cancel via API | `stripe-cancel-payment` allows poster or earner only (`:36-40`) | Critical | Yes — integration |
| Race: cancel vs start | Poster + earner | Confirmed booking | Earner sets `started_at` while poster cancels | If guard raises, client rolls back optimistic state; started booking never has hold voided | High | Yes — integration |
| Earner cannot forge a fee | Earner | Confirmed booking | Cancel as earner | Earner branch pins `cancellation_fee` to old (`:101`); no fee authored | Medium | Yes — integration |

### 2.8 Job completion

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Mutual completion required | Earner + poster | Confirmed booking | Earner marks done only | Stays `confirmed`; advances to `completed` only when the OTHER side already done (`nextStatusOnDone`, `shared/lifecycle.js:30-33`) | Critical | Yes — unit + integration |
| Neither party alone advances | Either | Confirmed booking | Force single-sided `completed` via API | Guard reverts: poster branch needs both flags; earner branch needs `old.poster_done` (`guard_bookings_write`) | Critical | Yes — integration |
| Party cannot forge other's done flag | Poster | Confirmed booking | Poster sets `earner_done` via API | Poster branch pins `earner_done` to old; symmetric for earner's `poster_done` | High | Yes — integration |
| Completion photos private | Earner | Marks done with photos | Upload before/completion photos | Uploaded to **private** `completion-photos` via `uploadPrivateImages`; shown to poster via signed URLs (`CompletionModal.js:135-156`) | High | Yes — integration |
| Poster verify captures escrow | Poster | `completed` booking, captured-nothing yet | Verify + rate | `stripe-capture-payment` captures; `credit_earnings` RPC credits earner atomically-once; `status='verified'` (`JobsContext.js:790-836`) | Critical | Yes — integration |
| Verify blocked without captured payment | Poster | `completed` booking, no capture | Force `completed→verified` via API | Guard allows only if a `payments` row `status='captured'` exists — poster cannot verify without earner paid | Critical | Yes — integration |
| Verify IDOR guard | Non-poster | Someone's booking | Call capture via API | `stripe-capture-payment` requires caller = poster (`:61-63`) | Critical | Yes — integration |
| Capture + webhook credit once | Poster | Verify triggers capture; webhook also fires | Verify | `credit_earnings` idempotent (flips `earnings_credited` false→true only if `captured`) — exactly once under concurrency | Critical | Yes — integration |
| Partial capture (dispute) | Poster | `completed` booking | "Report a problem" → pick pct + reason | Partial capture floored at 50%; reason required; `disputes` row recorded idempotently; earner credited reduced net; earner notified of adjustment | High | Yes — integration |
| Tip credited exactly once | Poster | Verified/completed booking, earner saved card | Add tip ≥50¢ | `stripe-tip` off-session; full tip to earner (no platform fee); `claim_and_credit_tip` + `tip_ledger` unique + Stripe idempotency key ⇒ no double-credit | Critical | Yes — integration |
| Tip bounds | Poster | — | Attempt tip <50¢ or >$1000 | Rejected (`stripe-tip:27` bounds `[50,100000]`) | Medium | Yes — unit |
| Review inserted once | Poster | Verify | Rate | One `reviews` row `role='earner'`; unique `(job_id,reviewer_id,reviewed_user_id,role)`; `recompute_user_rating` runs | Medium | Yes — integration |
| Earner rates poster | Earner | Verified booking | Rate poster | `reviews` row `role='poster'`; poster rating recomputed; poster notified (`ratePoster`, `JobsContext.js:594-641`) | Medium | Yes — integration |
| Job closes only if no other active booking | Poster | Multi-slot gig | Verify one booking | Job → `completed` only if no other active booking remains (`:867-878`) | Medium | Yes — integration |
| Capture split arithmetic | — | — | Feed amounts/pct to extracted split fn | `captureCents=round(amount*pct)`, `feeCents=min(captureCents,round(fee*pct))`, `earnerAmountCents=captureCents-feeCents` correct across rounding | Critical | Yes — unit |

### 2.9 Expense creation

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Add expense | Any authenticated | Tax Center open | Enter amount/category/date/desc → save | `expenses` row inserted owner-scoped (`addExpense`, `src/lib/expenses.js:19-36`) | Medium | Yes — integration |
| Add cash income | Any | Income segment | Enter cash income | `income_entries` row inserted (`addIncome`) | Medium | Yes — integration |
| Delete expense/income | Owner | Existing entry | Delete | Optimistic remove + `deleteExpense`/`deleteIncome`; owner-only RLS | Low | No |
| **No approval/rejection exists** | Any | — | Look for approve/reject/reviewer UI | **Confirm it does NOT exist.** `expenses` is owner-only RLS on all four verbs; no `status`/`approved`/`reviewed`/`rejected` column; no admin expenses page. It is a private personal tax tracker | Low (doc-correctness) | No |
| Year net-profit summary | Owner | Expenses + income + Stripe earnings | View summary | Net = Stripe earnings + logged cash income − expenses; ~27% set-aside hint | Low | Yes — unit |
| Tax summary CSV export | Owner | Entries exist | Export | `buildTaxSummaryCSV` → Share; **formula-injection neutralized** (`=`/`+`/`-`/`@` prefixes) | Medium | Yes — unit |
| Booking-tied expense | Owner | Expense with `booking_id` | Save tied to a guessed booking id | Cosmetic only — display lookup is client-side over the user's own bookings; no server ownership check on `booking_id` (low risk, private) | Low | No |

### 2.10 Receipt upload

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Upload receipt (private) | Owner | Adding expense | Pick receipt image | `uploadPrivateImage` to **private** `receipts` bucket; bare path stored in `expenses.receipt_url`; displayed via signed URL (`getSignedUrl('receipts', …)`) | High | Yes — integration |
| Owner-only read | Owner | Receipt exists | View own receipt | Signed URL resolves for owner (`receipts_owner_read`, folder[1]=uid) | High | Yes — integration |
| Cross-user receipt read blocked | User B | User A has a receipt | Request signed URL for A's receipt path | Denied — owner-only bucket policy; **the key privacy test for financial docs** | Critical | Yes — integration |
| Upload to another user's folder blocked | User B | — | Upload under A's uid folder | Rejected — INSERT policy `folder[1]=auth.uid()` | High | Yes — integration |
| No MIME/size allowlist (flag) | Owner | — | Direct-Storage upload of non-image under own folder | **Known gap: receipts and completion-photos have no MIME/size allowlist** (only `certificates` does). Verify Storage config; document | Medium | No |

### 2.11 Admin review

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Admin requires MFA (AAL2) | admin | admin_users membership | Sign in without TOTP | Denied — `requireAdmin` reads AAL2 claim from JWT; MFA mandatory (`admin/lib/guard.ts:26-66`) | Critical | Yes — unit (`aalFromToken`) + integration |
| Non-admin JWT cannot reach admin surfaces | authenticated | Regular user | Attempt admin API/DB access | Denied — there are NO admin RLS policies; admin power = the admin app holding the service key; a user JWT can never reach admin surfaces at the DB layer | Critical | Yes — integration |
| Moderation queue reads reports | admin/support | Open + resolved reports exist | Open Moderation | Reports list with name/title resolution + recent blocks (`moderation/page.tsx:18-43`) | Medium | No |
| Resolve/reopen report (admin only) | admin | Open report | Resolve | Writes `reports.resolved_*` + audit; `requireAdmin('admin')` (`moderation/actions.ts`) | High | Yes — integration |
| Support tier CANNOT resolve reports | support | Open report | Attempt resolve | Denied — resolve/reopen is `requireAdmin('admin')`, not support | High | Yes — integration |
| Support tier CANNOT mutate users | support | Any user | Attempt suspend/verify/delete | Denied — all user mutations are `requireAdmin('admin')` (`users/[id]/actions.ts`) | Critical | Yes — integration |
| Support tier CAN reply/close tickets | support | Open ticket | Reply + set status | Allowed — `requireAdmin('support')`; ticket `open→pending`/`closed` (`support/actions.ts`) | Medium | Yes — integration |
| Audit log page admin-only | support | — | Open Audit page | Denied for support — `requireAdminPage('admin')` (`audit/page.tsx:14`) | High | Yes — integration |
| Admin cannot act on self/other admin | admin | Target = self or another admin | Suspend/delete | Blocked by `assertActionableTarget` (`users/[id]/actions.ts:25-38`) | High | Yes — integration |
| Job takedown | admin | Reported gig | Take down | `status='cancelled'`; purges `job-photos` under poster's folder only, `..`-guarded; audited (`jobs/actions.ts`) | High | Yes — integration |
| Suspend user | admin | Active user | Suspend | Ban ~100y + `suspended_at` + `admin_revoke_sessions`; audited | High | Yes — integration |
| Delete account (destructive) | admin | Test user | Type "DELETE" → delete | Audits BEFORE irreversible `deleteUserCascade`; escrow released best-effort, storage purged | Critical | Yes — integration |
| Audit log is append-only | admin | Any audited action | Attempt to edit/delete an audit row | Denied even to service_role (`revoke update,delete`); `audit()` fail-closed for mutations | High | Yes — integration |
| Reporter cannot read internal columns | reporter (regular user) | Own resolved report | Read own report | Sees resolved-status but NOT `resolved_by`/`resolution` (revoked from column grant, `v2_hardening`) | High | Yes — integration |

### 2.12 Notifications

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Booking-request push | Poster | Earner books | Earner books gig | Poster gets `notify(posterId,'New booking request',…,{tab:'GigsTab'})` + in-app `notifications` row + realtime toast | Medium | No |
| Booking-accepted push | Earner | Poster accepts | Accept | Earner gets "Booking accepted!"; 1-hour gig reminder scheduled | Medium | No |
| Verify/paid push | Earner | Poster verifies | Verify | "Job verified — you got paid!" (or partial-adjustment variant) | Medium | No |
| Anti-spoof: caller must share a booking | Any | — | Call `send-push` targeting a stranger | Rejected — `send-push` requires caller shares a booking with the target (`:35-46`); no self-notify | High | Yes — integration |
| Payload sanitized | Any | — | Send push with unlisted tab/type/foreign jobId | Whitelisted tabs/types only; jobId honored only on a shared job (`send-push:70-88`) | Medium | Yes — integration |
| Rate limit | Any | — | Fire >30 push/min | Throttled via `push_send_rate` (fails open if table missing — flag) | Low | Yes — integration |
| In-app inbox | Authenticated | Notifications exist | Open Notifications | Inbox/Archived; auto-archive on view; deep-link via `notificationRoute` | Low | No |
| Tab-badge unread count | Authenticated | Unread messages | Receive message | `unreadMessages` badge updates live via realtime | Low | No |
| Push requires native build | Any | Expo Go SDK 54 | Expect remote push | **Known: `expo-notifications` is native; Expo Go can't receive remote push.** Needs dev/prod build + APNs/FCM. Document | Medium | No |

### 2.13 Messaging

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Send message (party) | Party to booking | Booking exists | Open chat, send text | Optimistic insert to `messages` `{booking_id,sender_id,text}`; realtime delivery on `msgs-${bookingId}` | High | Yes — integration |
| Non-party cannot read messages | User C | Booking between A and B | Attempt read via API | Denied — `messages_read` scoped to both parties (`migration_fix_lifecycle.sql:95-105`) | Critical | Yes — integration |
| Non-party cannot insert message | User C | Learns a booking_id | Insert message via API | Denied — `messages_insert` requires `sender_id=auth.uid()` AND caller is a party | Critical | Yes — integration |
| Messages immutable | Party | Sent message | Attempt edit/delete via API | Denied — no UPDATE/DELETE policy on `messages` | Medium | Yes — integration |
| Image message | Party | — | Send photo | Uploads path to private `chat-photos`, inserts `image_url`; party-scoped signed read | Medium | Yes — integration |
| Message content filtered | Party | — | Send prohibited text | DB `trg_guard_content_messages` rejects | Medium | Yes — integration |
| Read state / unread dots | Party | Unread convo | Open chat | `markConversationRead` upserts `conversation_state.last_read_at`; unread dot clears; `refreshUnread` | Low | No |
| Archive conversation | Party | — | Archive | `setConversationArchived`; moves to Archived split | Low | No |

### 2.14 Permission tests

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Cross-user profile update blocked | User B | User A profile | Update A's profile via API | Denied — `profiles_update_own USING(auth.uid()=id)`; owner-only | Critical | Yes — integration |
| Private profile columns not readable cross-user | User B | User A profile | Select `earnings_total`/`availability`/`suspended_at`/`weekly_earning_goal` on A | Denied — column-lockdown revokes these; only owner via `my_profile()`/`profile_availability()` RPC | Critical | Yes — integration |
| Owner cannot self-set protected columns | Owner | Own profile | Set `verified`/`rating`/`earnings_total`/`id_verification_status` via API | Reverted — `guard_profiles_write` pins them to old | Critical | Yes — integration |
| Student-verified fields locked | Owner | Own profile | Set `student_verified=true` via API | Reverted — `guard_student_verified` pins student fields; only service-role edge sets them | High | Yes — integration |
| Booking parties only | User C | A/B booking | Read/update booking via API | Denied — `bookings_select/update_parties` (earner_id or job.poster_id) | Critical | Yes — integration |
| Bookings not deletable by clients | Party | Own booking | Delete row via API | Denied — no DELETE policy on `bookings`; cancel via status only | High | Yes — integration |
| Payments not writable by clients | Party | Own booking's payment | Insert/update `payments` via API | Denied — SELECT-only party policies; all writes are service-role | Critical | Yes — integration |
| Money-credit RPCs not client-callable | authenticated | — | Call `credit_earnings`/`claim_and_credit_tip` via API | Denied — EXECUTE revoked from anon/authenticated; service-role only | Critical | Yes — integration |
| tip_ledger inert to clients | authenticated | — | Read/write `tip_ledger` | Denied — RLS on, no policy, grants revoked | High | Yes — integration |
| Reviews bound to verified booking + role | authenticated | No verified booking | Insert a review via API | Denied — `reviews_insert_auth` requires a verified booking on the same job_id with matching direction and `role`; unique per direction per job | High | Yes — integration |
| Slots/requirements owner-of-job scoped | User B | A's job | Insert/update/delete slots via API | Denied — `slots_*_poster` / `reqs_*_poster` owner-of-parent scoped (verify legacy permissive `slots_update_any` is dropped live) | High | Yes — integration |
| Reports own-only | reporter | Another user's report | Read/update via API | Denied — `reports_select_own`/no client UPDATE; only own visible | High | Yes — integration |
| Blocks own-only | user | Another user's block | Read via API | Denied — `blocks` own-only select/insert/delete | Medium | Yes — integration |
| Legal acceptances own-only | user | Another user's acceptance | Read via API | Denied — `legal_acc_select_own`; append-only | Medium | Yes — integration |
| Admin-internal tables inert to users | authenticated | — | Query `admin_users`/`admin_audit_log`/`support_tickets`/`student_email_verifications` | Denied — RLS on, no policies, grants revoked; invisible to user apps | Critical | Yes — integration |

### 2.15 Mobile-specific

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Haptics guarded on web | Any | Web build | Trigger a haptic action | No-op on web (`useHaptic.js`); no crash | Low | Yes — unit |
| Expo Go blocks Google/Apple/push | New user | Expo Go SDK 54 | Try Google / expect push | Google blocked with message; remote push unavailable (native module) | Medium | No |
| Realtime channels | Authenticated | Booking + messages | Trigger booking/message events | `bookings-user-${id}`, `poster-bookings-${id}`, `msgs-${bookingId}` fire; toasts appear | Medium | No |
| Cache-first load + refresh | Authenticated | Cached data | Open screen then pull-to-refresh | Cached shows instantly; fresh replaces; re-cache | Low | No |
| Mobile Safari web layout | Any | iOS Safari (web app) | Load key screens | Layout intact (recent mobile-Safari fixes); no horizontal scroll | Medium | No |
| Local gig reminder | Earner | Confirmed booking | Wait ~1h before start | Local notification fires (`scheduleGigReminder`) | Low | No |
| Mobile reset-password dead-end risk | User | — | Request reset on mobile | Sends to hardcoded `gohustlr.com/reset-password`; **verify domain/allow-list live** or reset dead-ends | High | No |
| Dead screens not reachable | — | — | Navigation audit | `BrowseScreen.js` / `MyJobsScreen.js` are orphaned/dead (not registered; `MyJobsScreen` references non-existent `appliedIds`). Confirm unreachable; do not remove | Low | No |

### 2.16 Web-specific

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| App-shell gate | Any | Web prod | Load `/browse` unauthenticated | Gate routes through loading → onboarding → consent before shell (`web/app/(app)/layout.tsx:16-45`) | High | Yes — e2e |
| Money formatting parity | Any | Booking with amounts | View pay label on web | `web/lib/format.ts` `money`/`effectivePay`/`payLabel` match mobile interpretation of the same booking (`shared/transforms.js`) | High | Yes — unit (parity) |
| Accept-payment modal (Elements) | Poster | Pending booking | Accept via web | Stripe Elements; saved-card one-tap or new card; `confirmCardPayment` then `acceptBooking` | Critical | Yes — e2e |
| Auth callback classification | OAuth user | — | Complete Google on web | Cancel/identity/other errors classified; routes to browse/onboarding (`auth/callback/page.tsx:35-56`) | Medium | No |
| Reset-password isolation | User | Reset link | Open web reset page | Recovery client consumes hash, never promoted to main session; `signOut({scope:'local'})` → `/login?reset=1` | High | No |
| Consent gate | Authenticated | New terms version published | Load app | `ConsentScreen` blocks until acceptance (`checkNeedsAcceptance` fails closed) | High | Yes — e2e |
| Web has no Apple Sign In | — | — | Look for Apple button on web | Confirm absent (intentional platform difference) | Low | No |
| Geocode proxy no per-IP limit | Any | — | Hammer `/api/geocode` | **Known gap: no per-IP rate limit** (deferred to edge/Upstash). Input capped/validated. Document | Low | No |
| CSP posture | Any | Web prod | Inspect response headers | `next.config.ts:4` says ENFORCING; TESTFLIGHT said report-only. **Verify live** which is enforced and whether `unsafe-inline`/`unsafe-eval` remain | Medium | No |
| Support contact form | Any (unauth ok) | — | Submit Contact form | `support-submit` (verify_jwt=false) creates ticket; rate-limited per-email 5/hr, per-IP 8/hr, global 60/hr; no CAPTCHA | Medium | Yes — integration |

### 2.17 Negative / edge-case

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Book a cancelled/deleted gig | Earner | Gig soft-cancelled after browse | Book stale gig | Rejected; cancelled jobs excluded from feed; server rejects | Medium | Yes — integration |
| Book an already-taken slot | Earner | Slot `taken=true` | Book | Rejected; slot-belongs-to-job validated in guard | Medium | Yes — integration |
| Verify an already-verified booking | Poster | `verified` booking | Verify again | Rejected (status ∈ {verified,declined,cancelled} bail, `JobsContext.js:808-811`); no double-capture | High | Yes — integration |
| Double-verify no double review/credit | Poster | Verify twice | Retry | Review insert idempotency-guarded; earnings idempotent; no dupes | Critical | Yes — integration |
| Capture-then-status-write crash recovery | Poster | Client dies after capture, before status write | Retry verify | Capture idempotent (already `captured`); status write succeeds; earner paid once | High | Yes — integration |
| Under-estimated hourly hold | Poster | Hourly gig, low estimated hours | Complete over-worked gig | Capture bounded by authorized amount; **no top-up path** — product gap to flag | Medium | No |
| Amendment on any booking status | Poster | Verified booking | Propose amendment | Guard constrains value not timing; unlocks core edit only if earner accepts + booking active — low impact | Low | Yes — integration |
| Amendment `accepted` sticky | Poster | Earner accepted, edit done | Skip `clearAmendment` | Core terms stay editable until cleared (client-driven). Flag: no server auto-clear | Medium | No |
| Empty / null inputs | Any | — | Submit empty forms, null coords | Graceful validation; geo returns null on missing coords; no crash | Low | Yes — unit |
| CSV injection in expense description | Owner | — | Add expense desc starting `=cmd` | Neutralized on export (`taxFormat`) | Medium | Yes — unit |
| Content-filter evasion | Any | — | Post `c0caine`/`0nlyfans`/`c.o.c.a.i.n.e` | Blocked — leetspeak/homoglyph/punctuation normalization (`contentFilter`) | High | Yes — unit |
| Multi-earner gig verify race | Poster | Multi-slot gig, two verifies | Verify both concurrently | Job-close write idempotent; both bookings credited once each | Medium | Yes — integration |

### 2.18 Abuse / fraud

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| Self-booking to farm earnings | User | Own gig | Book own gig | Blocked at UI + DB ("You cannot book your own gig") | Critical | Yes — integration |
| Poster verifies without paying earner | Poster | `completed` booking | Force verify without capture | Blocked — guard requires `payments.status='captured'` | Critical | Yes — integration |
| Fee bypass via counter-offer | Earner | Counter-offer controls amount | Book with amount forcing zero/negative fee | Bounds + 10% fee enforced server-side at PI creation | Critical | Yes — unit + integration |
| Tip double-credit via replay | Poster | Saved card | Replay tip with same idempotency key | Credited once — `tip_ledger` unique + `claim_and_credit_tip` claim flag + Stripe idempotency | Critical | Yes — integration |
| Earnings double-credit via capture+webhook | Poster | Verify | Capture and webhook both credit | Once — `credit_earnings` conditional flip | Critical | Yes — integration |
| Forge the rating you received | Poster | Confirmed booking | Poster sets `poster_rating`/`poster_review` (the earner's rating of them) via API | Reverted — poster branch pins these; earner authors them | High | Yes — integration |
| Review-spam / arbitrary-job review | User | One verified booking | Insert reviews on unrelated jobs | Blocked — review must be bound to a verified booking on the same job with matching role; unique per direction | High | Yes — integration |
| Report spam | User | — | Mass-submit reports | Owned rows only; admin resolves; moderation queue triage (no per-user report throttle noted — watch) | Medium | No |
| Push spoofing a stranger | User | — | `send-push` to non-shared user | Blocked — must share a booking; rate-limited | High | Yes — integration |
| Support intake flood | Anyone | — | Flood Contact form | Rate limits (email 5/hr, IP 8/hr, global 60/hr) fail-closed; no CAPTCHA yet | Medium | Yes — integration |
| Assistant cost-cap bypass | User | — | Spam assistant requests | 12/min + 300/day per-user via `assistant_rate`; **fails open if table missing** — verify table exists live | Medium | Yes — integration |
| Cancel-after-start to dodge fee/work | Earner/poster | `started_at` set | Cancel | Hard-blocked; must dispute | High | Yes — integration |
| Job status tampering | Poster | Own live gig | Flip `jobs.status` freely | **Known gap: no server transition guard; client-trusted.** No money tied to `jobs.status`; blast radius is feed/UI integrity. Flag | Medium | Yes — integration |

### 2.19 Data privacy

| Test name | User role | Preconditions | Steps | Expected result | Severity if broken | Automate before beta? |
|---|---|---|---|---|---|---|
| User B cannot read User A's receipt via signed URL | User B | A has a receipt | Attempt signed URL on A's receipt path | Denied — `receipts` owner-only private bucket | Critical | Yes — integration |
| Third party cannot read completion photos | User C | A/B booking with photos | Attempt read | Denied — `completion-photos` party-scoped (uploader or booking party); verify live-private (deploy-gated) | Critical | Yes — integration |
| Third party cannot read chat photos | User C | A/B chat images | Attempt read | Denied — `chat-photos` party-scoped private; verify live-private | High | Yes — integration |
| Private profile financials hidden | User B | A profile | Query A's `earnings_*`/goals | Denied — revoked from clients; owner via RPC only | Critical | Yes — integration |
| Availability respects visibility flag | User B | A has `show_availability=false` | Query A's availability | Denied — `profile_availability` RPC enforces `show_availability OR self` | Medium | Yes — integration |
| Reporter cannot read `resolved_by` | reporter | Own resolved report | Read report row | `resolved_by`/`resolution` revoked from column grant | High | Yes — integration |
| Location coarsened on jobs | Any | In-person gig | Read job coords | Coords snapped to ~1km (poster privacy) | Medium | Yes — unit |
| Legacy public URL to now-private bucket dead | Any | Old completion/chat photo full URL | Open old public URL | Public link is dead (bucket private); UI must use signed URL. Verify no orphaned public leak | Medium | No |
| Account deletion cascades + purges storage | Owner | Own account | Delete account | Escrow released, storage purged (receipts etc.), `auth.admin.deleteUser` cascade scoped to `user.id` | High | Yes — integration |
| Admin PII export gated | admin | — | Trigger user data export | `requireAdmin('admin')` + `Sec-Fetch-Site` CSRF block; support tier cannot; audited | High | Yes — integration |
| Anthropic key not exposed | — | — | Inspect client bundles | Only anon/publishable (`pk_test_…`) keys in client; confirm previously-pasted Anthropic key rotated (`TESTFLIGHT.md:66`) | High | No |

---

## 3. First 72-hour beta monitoring checklist

Analytics/crash telemetry is currently **null** (`src/lib/analytics.js:12-13` — `SENTRY_DSN`/`ANALYTICS_KEY` null; no-op `track`/`captureError`/`identify`). Until Sentry + PostHog + native SDKs are wired, **watch external dashboards manually**: Supabase logs, Stripe dashboard, and edge-function logs are the primary signal. Check the following on a tight cadence (hourly for the first day, then every few hours):

**Payments (highest priority — Stripe dashboard + edge-fn logs):**
- **Payment capture success + earnings credit.** For each verified booking, confirm the Stripe capture succeeded AND `profiles.earnings_total` incremented once via `credit_earnings`. A captured-but-not-credited case = the webhook or RPC failed.
- **Stripe webhook deliveries.** Confirm the webhook is registered in the **live target mode** with the matching signing secret (test-mode registration does NOT carry over). Watch for failed/retried deliveries — if stale/missing, "payments still charge but earnings never credit and the Verified badge never appears."
- **Escrow holds not lingering.** Watch authorized-but-uncaptured PIs. Cancels/declines should release holds promptly; a failed release lets a hold auto-expire only after ~7 days. Investigate any hold older than expected on a resolved booking.
- **Fee correctness.** Spot-check that captured amount, 10% platform fee, and earner net match the authorization. Confirm the web-displayed `SERVICE_FEE_PCT` equals the backend 10% (potential display/charge mismatch).
- **Tips + partial captures.** Confirm each tip credited exactly once and each dispute wrote exactly one `disputes` row with a reason. Note: **no dispute adjudication/refund path exists** — any remedy is manual/out-of-band.

**Errors & crashes (Supabase logs + edge-fn logs, since analytics is null):**
- Watch edge-function error rates for `accept-booking`, `stripe-*`, `send-push`, `support-submit`, `student-verify-*`. Fail-open designs (assistant cost cap, `send-push` limit) log loudly if their backing table is missing — grep for "cost cap NOT enforced" and rate-limit fail-open lines.
- Watch Postgres logs for guard-trigger reverts and RLS denials that indicate someone probing boundaries, and for any 5xx from PostgREST.
- On mobile, the root `ErrorBoundary` catches render crashes but reports only to the null analytics buffer — so crash signal must come from user reports and any store crash dashboards once on a real build.

**Sign-up & onboarding funnel:**
- Sign-up → email-verify → first-login-through-onboarding completion rate. Watch for users stuck at email verification (Resend/domain config) or bouncing on username uniqueness.
- Confirm `legal_acceptances` rows are being written (mobile records best-effort AFTER the profile update — a silent failure leaves a user marked onboarded but re-hitting the consent gate).
- Student `.edu` verification: confirm Resend verified domain + `STUDENT_VERIFY_FROM` are set live, else student emails only reach the account owner.

**Moderation & support:**
- **Moderation queue** — triage new `reports` daily; confirm resolve/reopen works and audit rows land.
- **Support inbox** — watch the Resend support inbox and `support_tickets`; confirm the intake rate limits aren't blocking legitimate users and no CAPTCHA-less flood is occurring.
- Content-filter drift — the blocklist lives in three hand-maintained copies; the `moderationSync.test.js` guard should stay green in CI.

**Deploy-state verification (do this before opening the beta, then confirm holds):**
- Confirm the audit/hardening migrations + edge redeploys are actually applied to LIVE Supabase/Vercel/Stripe: certificates MIME allowlist, private `chat-photos`/`completion-photos` buckets, server-side DB moderation, `send-push` rate limit, redirect-URL pinning. If not applied, those protections are absent in production.

---

## 4. Open questions / for Fable to verify

1. **Live deploy state is the largest unknown.** Many `AUDIT_REPORT.md` fixes are code-complete on `master` but marked "needs push/deploy." Every security/privacy/permission test above must be run against the **live** target. Confirm: private photo buckets, certificates MIME allowlist, server-side moderation, `send-push` throttle, redirect pinning are all live.
2. **Stripe live cutover + webhook** — is the webhook registered in the target mode with a matching signing secret, and are Connect + Identity enabled live? This is the linchpin for earnings crediting and the Verified badge; unverifiable from code.
3. **Amendment direction contradicts CLAUDE.md.** The code is **poster-proposes / earner-responds** (guard confirms: poster may only set `pending`/`none`, earner reaches `accepted`/`declined`). CLAUDE.md says the opposite — flag and reconcile.
4. **`jobs.status` has no server-side transition guard** — client-trusted; `'booked'` is a dead enum value never written. Confirm whether a transition guard is needed. `bookings.status` IS heavily guarded (`guard_bookings_write`).
5. **Fee constant mismatch risk** — backend hardcodes 10% (`stripe-create-payment-intent:100`, `stripe-capture-payment:129`); web UI uses `SERVICE_FEE_PCT` from `@/lib/config` for display. Verify they agree, or the earner sees a fee different from what's charged.
6. ~~**No dispute adjudication/refund path**~~ **RESOLVED 2026-08-04** — disputes carry `status`/`assigned_to`/`resolved_at`/`resolved_by`/`resolution_note` and are triaged at `/disputes`; refunds and hold releases run from `/bookings/[id]` through the `admin-payment-action` edge function. Test that path rather than assuming out-of-band remedy.
7. **No MIME/size allowlist on `receipts` and `completion-photos`** (only `certificates` has one). A direct-Storage upload under the uid folder could store non-image content. Verify Storage config.
8. **Amendment `accepted` is sticky** — cleared only by client `clearAmendment`; a skipped clear leaves core terms editable. No server auto-clear. Also, the earner branch of the guard does not pin `amendment_status`, so an earner could write `pending`/`none` — confirm acceptable.
9. **CSP posture** — `next.config.ts:4` says ENFORCING; TESTFLIGHT said report-only. Verify which is live and whether `unsafe-inline`/`unsafe-eval` remain in prod.
10. **Mobile reset-password** hardcodes `https://gohustlr.com/reset-password` with no native reset screen. If that domain/allow-list breaks, mobile reset dead-ends. Not verified live.
11. **No CI gate confirmed in scope** — verify `npm test` runs in CI and blocks merges; otherwise even the 79 passing unit tests provide no regression gate. No coverage numbers exist (Jest runs without `--coverage`).
12. **`web/` is Jest-ignored and `admin/` has zero tests** — acceptable for beta, or a gap to weight? A destructive `deleteUserCascade` (`admin/lib/deleteUser.ts`) has no test.
13. **Fresh-DB reproducibility** — the audited state = `schema.sql` + all `supabase/migrations/` applied in timestamp order. `schema.sql` alone (or the legacy `migration_*.sql` set only) is more permissive. Confirm the live DB matches the tracked-migration state (diff live `pg_policies`), and that no `tmp_audit_diag` debug function remains EXECUTE-able live.
14. **Anthropic API key rotation** — confirm the previously-exposed key was rotated (`TESTFLIGHT.md:66`); it gates `assistant` + `support-ai-draft`.
15. **Push requires a real build** — `expo-notifications` is native; Expo Go on SDK 54 can't receive remote push. Needs APNs (iOS) / FCM (Android) + a production/dev build before push tests are meaningful.
16. **Two dead mobile screens** (`BrowseScreen.js`, `MyJobsScreen.js` — unregistered; `MyJobsScreen` references non-existent `appliedIds`). Confirm unreachable; noted as dead code, not to be removed.
