# FABLE_TOMORROW_BRIEF.md — Start-here brief for the beta-readiness audit

> **✅ AUDIT COMPLETE (2026-07-11).** This start-here brief for the audit is spent — the audit ran and its High-severity blockers (**H1–H8**) shipped. Outcome + evidence: [FABLE_BETA_AUDIT_REPORT.md §4.1.1](FABLE_BETA_AUDIT_REPORT.md). Retained as historical context.

*Prepared 2026-07-07 at commit `a70c9b5` (master). This is the fast on-ramp; the eight sibling docs (FABLE_HANDOFF, ROLE_PERMISSION_MATRIX, PRODUCT_FLOW_MAP, LIFECYCLE_STATE_MACHINES, CURRENT_COMMANDS, BASELINE_STATUS, BETA_QA_PLAN, KNOWN_RISKS) hold the detail.*

Read this first, then **FABLE_HANDOFF.md**. Everything below is grounded in source; `path:line` anchors let you jump straight to code.

---

## 1. The most important context

- **One product, three apps, one backend.** Mobile (Expo/React Native, `App.js` + `src/`), public web (Next.js 16, `web/`), and an operator **admin console** (Next.js 16, `admin/`) all talk to **one Supabase project** (`nfioebqsgmmzhbksxozc`) + Stripe. Shared pure logic lives in `shared/` (`@gohustlr/shared`). Backend = Postgres+RLS, Auth, Realtime, Storage, and **23 Deno edge functions** (`AUDIT_REPORT.md`/`CLAUDE.md` say "24" — off by one vs. disk).
- **Roles are per-action, not per-account.** The same authenticated user is an **earner** (worker) on gigs they book and a **poster** (client) on gigs they own. `profiles.role` (`earner`/`poster`/`both`) is a display field and is **never referenced in any RLS policy** — rights are scoped by row relationship (`earner_id` vs `poster_id`). "Student worker" and "customer/client" are the same account.
- **Admin power is app-layer, not DB-layer.** There are **no admin RLS policies**. The admin console holds the **service-role key** and gates every action through `admin/lib/guard.ts:42-71` `requireAdmin()` → authentic `getUser()` → **mandatory AAL2/MFA** → `admin_users` membership → tier (`admin` full / `support` read-only + ticket triage). A user JWT can never reach admin surfaces at the DB layer.
- **Money model = Stripe manual-capture escrow.** Poster's card is held on accept (10% platform fee, `transfer_data.destination` = earner Connect account); captured on verify; tips are separate off-session (100% to earner). **Stripe is in TEST mode** for beta (`admin/lib/config.ts:19`).
- **The single load-bearing invariant:** a booking can only reach `confirmed` via the `accept-booking` edge fn after it **re-fetches the PaymentIntent and confirms `requires_capture`** — a poster cannot confirm without funding escrow, because `guard_bookings_write` forbids a client setting `confirmed` directly. If this breaks, the whole escrow model breaks.
- **⚠️ The biggest unknown: code-on-master ≠ live-in-production.** Many `AUDIT_REPORT.md` hardening fixes are **code-complete but marked "needs push/deploy"** (`supabase db push` + edge redeploys). Whether they are actually applied to live Supabase/Vercel/Stripe **cannot be verified from the repo** and is the #1 thing to confirm. **[Needs Fable Review]**
- **The app is feature-complete but blind and unproven-live.** No crash/analytics telemetry (`src/lib/analytics.js:12-13` null keys), **no e2e/integration tests** (only 79 pure-logic unit tests), legal text is a draft, and the real-money loop has never been exercised in Stripe live mode.
- **Trust the source over the docs.** `CLAUDE.md`, `ROADMAP.md`, `TESTFLIGHT.md`, `AI_ASSISTANT.md` are stale in places (photo buckets called "public" when now private; assistant "no rate limiting" when it has it; built features listed as unbuilt).

---

## 2. Top 20 areas Fable should inspect

Ranked by audit value. (P) = payments, (L) = lifecycle, (S) = security/privacy, (A) = abuse, (O) = ops.

1. **(P/L) The end-to-end escrow money path.** `stripe-create-payment-intent` (amount derived server-side, bounded 50¢–$10k, 10% fee) → `accept-booking` (`requires_capture` gate) → `stripe-capture-payment` (full/partial) → `credit_earnings`. Confirm no over/under-pay.
2. **(P) Atomicity/idempotency of `credit_earnings` and `claim_and_credit_tip` RPCs** (in `supabase/migrations/*`). Both are called from **two racing paths** — the capture fn AND the `payment_intent.succeeded` webhook (`stripe-webhook/index.ts:71`). All money correctness rests on these being exactly-once.
3. **(L) `guard_bookings_write` trigger** — the authoritative booking state-machine enforcer (final def `supabase/migrations/20260702030000_guard_pins_and_slot_delete_policies.sql:15-116`). It **silently reverts** illegal writes (HTTP 200, row unchanged). Read the poster/earner allowed-transition branches.
4. **(O) Is the live infra actually hardened?** Diff live `pg_policies`/migrations against the tracked set; confirm the Stripe **webhook is registered in the right mode with a matching signing secret** and Connect+Identity are live. **[Needs Fable Review]**
5. **(S) `profiles` column lockdown.** `profiles_select_all USING(true)` still exists; cross-user privacy relies **entirely on the column GRANT** (`supabase/migrations/20260624221000_profile_column_lockdown.sql`), with owner reads via the `my_profile()` RPC. A re-broadened grant would leak earnings/PII.
6. **(S) Storage bucket privacy.** `receipts`, `chat-photos`, `completion-photos` are **private/party-scoped signed URLs** (later migrations). Verify the party-scope read policies and that `receipts` lacking a MIME allowlist is intentional.
7. **(P) Partial-capture / dispute math.** `stripe-capture-payment/index.ts:99-130` — floor 50%, reason required, `earner_amount_cents` written **before** capture to beat the webhook. Unit-untested arithmetic.
8. **(P) Tip flow idempotency.** `stripe-tip` (`tip_ledger` unique + `claim_and_credit_tip` + Stripe idempotency key). Prove a replay can't double-credit.
9. **(P) Fee-constant consistency.** Backend hardcodes 10% (`stripe-create-payment-intent:100`, `stripe-capture-payment`); web UI uses `SERVICE_FEE_PCT`. Confirm they agree so earners see what they're charged.
10. **(S) Admin authz chain + `proxy.ts` wiring.** `admin/lib/guard.ts`; and confirm whether Next 16.2.9 auto-registers `admin/proxy.ts` (there is **no `middleware.ts`**). **[Needs Fable Review]**
11. **(S) Admin support edge fns** (`support-reply`, `support-ai-draft`) check `admin_users` membership **but not AAL2 or tier** — a leaked support-tier token bypasses the console's MFA/tier gate.
12. **(L/A) `jobs.status` has no transition guard** — client-trusted; a poster can set any status. Confirm blast radius (feed/UI integrity; no money attached).
13. **(A) Dispute has no adjudication/refund path.** Partial-capture rows and report resolutions are terminal; no user-facing appeal (`admin/app/(console)/payments/page.tsx` is read-only).
14. **(S) RLS on `bookings`/`messages`/`reviews`/`disputes`/`reports`** — party-scoping, self-booking block, review one-per-direction, reporter can't read `resolved_by`/`resolution`. None are automated-tested.
15. **(S) Content moderation** — triple-copy blocklist (`shared/contentFilter.js`, `assistant/index.ts`, DB `contains_prohibited`), evasion normalization, DB trigger backstop. Advisory only; residual evasions accepted.
16. **(A) `counter_offer` (earner-controlled) and `estimated_hours` (poster-set) feed the escrow amount.** Under/over-funding and no top-up path for over-worked hourly gigs.
17. **(S) `assistant` edge fn** — 14 tools on a **user-JWT-scoped** client (good), rate limit **fails open** if `assistant_rate` missing, prompt-injection defenses, cost cap. Confirm the rate table exists live.
18. **(O) Migration reproducibility.** Dual legacy+tracked migration sets; base `schema.sql` ships permissive `USING(true)` policies neutralized only by tracked migrations; `skill_rates`, `stripe_identity_session_id`, `rls_auto_enable()` were added **out-of-band with no DDL in the repo**. **[Needs Fable Review]**
19. **(S) Auth surface** — PKCE + isolated implicit-flow recovery client, OAuth consent capture, email-confirmation gating; onboarding **records legal acceptance in a different order on web vs mobile** (web blocks-on-fail; mobile best-effort — a mobile acceptance that fails leaves the audit trail incomplete).
20. **(O) Dashboard-only config.** `supabase/config.toml` has **no `[auth]` block** — providers, redirect allowlist, `mailer_autoconfirm`, HIBP/OTP/MFA/SSL toggles all live in the hosted Dashboard, invisible to source. **[Needs Fable Review]**

---

## 3. Top 10 suspected beta blockers

1. **Legal review + business entity/insurance.** ToS/Privacy/Contractor are **self-labeled DRAFT, not attorney-reviewed**, with a `[DRAFT PLACEHOLDER]` arbitration clause (`supabase/migrations/20260702020000_legal_docs_v2026_07_02.sql:51`). Biggest non-engineering blocker.
2. **Stripe live cutover.** Live keys, **live webhook re-registration with the new signing secret**, live Connect + Identity KYC, and a real-money smoke test. Until done, live earnings/badge crediting is unproven.
3. **Apply the hardening deploys.** `supabase db push` + edge redeploys — otherwise cert-MIME allowlist, private photo buckets, server-side moderation, Stripe redirect pinning, and the push throttle are **absent in production**.
4. **No monitoring.** Sentry DSN + PostHog key + native SDKs + dev-client rebuild — currently a **blind beta** (no crash telemetry, no funnel).
5. **No e2e coverage of the money loop.** Zero integration/e2e tests; the core post→book→accept→complete→verify→capture→rate path is manually-tested only.
6. **Push requires a real native build.** `expo-notifications` is native; Expo Go can't receive remote push; needs APNs (iOS) / FCM (Android) + a production/dev build.
7. **App Store / Play prerequisites.** Developer accounts, listings, and **privacy "nutrition labels" that reflect the now-private photo buckets**; production EAS builds.
8. **Operational config gaps.** Resend verified domain + `STUDENT_VERIFY_FROM` (else student emails only reach the owner); `gohustlr.com` DNS → Vercel (else mobile Stripe-return pages dead-end); Connect branding.
9. **No dispute adjudication/refund path** for a product handling real money — disputes are terminal audit rows.
10. **Live-DB reproducibility unconfirmed.** Out-of-band columns/functions have no DDL in-repo; confirm the audited state (`schema.sql` + all tracked migrations, in order) is what's actually live. **[Needs Fable Review]**

---

## 4. Top 10 suspected security / privacy concerns

1. **Live ≠ code drift on hardening** (see §2.4) — the single largest unknown; the protections may not be live. **[Needs Fable Review]**
2. **`profiles_select_all USING(true)` guarded only by the column GRANT** — a future migration re-broadening the grant, or a `SELECT *` via PostgREST, leaks earnings/PII. Recommend a live `has_column_privilege` audit for anon/authenticated.
3. **`receipts` bucket has no MIME allowlist** (all other buckets do) — an SVG/HTML upload vector if reads are ever made public again.
4. **Service-role key is in every edge function's env.** RLS-bypassing writes are **code-discipline, not DB-enforced** (each fn does its own `getUser` and constrains writes). One fn bug = full-DB privilege. Exception: `assistant` downgrades to a JWT-scoped client (the strongest pattern).
5. **Admin support edge fns require only `admin_users` membership, not AAL2/tier** — a stolen support-tier access token bypasses the console's own MFA/tier gate.
6. **Stripe return-URL open-redirect fix (F-2)** must be deployed; a caller-supplied `origin` was accepted for any `*.vercel.app`.
7. **Content moderation is advisory + hand-maintained in 3 copies**; a sync test guards drift but the list is small and residual evasions (spacing, cross-script homoglyphs) are accepted risk.
8. **Supabase Auth dashboard hardening is unverifiable from code** — leaked-password (HIBP), OTP expiry, user MFA, SSL enforcement, and the redirect allowlist are all Dashboard state. **[Needs Fable Review]**
9. **Previously-exposed Anthropic API key** (`TESTFLIGHT.md:66`) gates `assistant` + `support-ai-draft` — confirm it was rotated; and confirm the production web CSP posture (report-only vs enforcing, and whether `'unsafe-inline'`/dev `'unsafe-eval'` remain). **[Needs Fable Review]**
10. **Legacy-vs-tracked policy drift.** `schema.sql` ships permissive `slots_update_any USING(true)` and `stripe_* FOR ALL` policies that only tracked migrations neutralize — diff live `pg_policies` (public + storage schemas) against the tracked set.

---

## 5. Top 10 suspected marketplace-abuse concerns

1. **`jobs.status` is client-trusted** — a poster can flip their own gig's status arbitrarily (hide from feed / mark completed). No money attached, but feed/UI integrity.
2. **Cancellation fee is cosmetic** (`bookings.cancellation_fee` records but **no money moves**, `src/context/JobsContext.js:126-128`) — a serial-canceler poster or a no-show earner faces no financial consequence.
3. **Dispute = poster-driven partial capture with no appeal.** A poster can partial-capture (floored at 50%) with any reason; the earner has no adjudication path.
4. **Escrow amount is influenced by earner `counter_offer` and poster `estimated_hours`** (bounded 50¢–$10k). Under/over-funding; no top-up for over-worked hourly gigs.
5. **Content filter is evadable** (advisory) — prohibited content can slip via spacing/cross-script homoglyphs despite normalization.
6. **`support-submit` is public with no CAPTCHA** (only DB rate counters: 5/hr email, 8/hr IP, 60/hr global) — ticket-spam/flooding surface.
7. **Review farming via collusive booking rings.** Reviews require a verified booking + role + one-per-direction (good), but two colluding accounts can book each other to mint mutual 5-star reviews and inflate ratings.
8. **Student verification is `.edu`-email-only** — a trust signal, not enrollment proof; alumni addresses / forwarders pass.
9. **Multi-account farming.** Identity is email + optional `.edu` + optional Stripe Identity; no phone/device binding — referral abuse (self-referral is blocked, but multi-account isn't) and ban evasion.
10. **In-booking harassment.** `send-push`/messages are anti-spoofed (must share a booking) and content-moderated, but a counterparty can still send abusive (unfiltered-by-intent) messages within a legitimate booking; blocking is client-side-filtered on Browse only.

---

## 6. The exact order to review the app

1. **Orient:** read `FABLE_HANDOFF.md`, then this brief. Skim `KNOWN_RISKS.md` §Top-10.
2. **Money path (highest value):** `supabase/functions/stripe-create-payment-intent` → `accept-booking` → `stripe-capture-payment` → `stripe-tip` → `stripe-webhook`; then the money RPCs `credit_earnings` / `claim_and_credit_tip` in `supabase/migrations/*`. Cross-read `LIFECYCLE_STATE_MACHINES.md` §Completion.
3. **Booking state machine:** `guard_bookings_write` (`supabase/migrations/20260702030000_...:15-116`) + `src/context/JobsContext.js` / `web/lib/jobs.tsx`. Confirm every illegal transition is reverted.
4. **Permissions & RLS:** `ROLE_PERMISSION_MATRIX.md`, then the profile column-lockdown migration and the storage-bucket policies. Ideally diff **live** `pg_policies` vs. the tracked migration set.
5. **Admin console:** `admin/lib/guard.ts` → `admin/app/(console)/**/actions.ts` → `admin/lib/serviceClient.ts` / `audit.ts` / `deleteUser.ts`.
6. **Auth:** `src/context/AuthContext.js` + `web/lib/auth.tsx`; clients `src/lib/supabase.js` + `web/lib/supabaseClient.ts`; note the Dashboard-only config gap.
7. **Trust & safety edge fns:** `assistant`, `send-push`, `support-*`, `student-verify-*`, moderation (`contains_prohibited` + `shared/contentFilter.js`).
8. **Risk reconciliation:** `KNOWN_RISKS.md` + `BASELINE_STATUS.md`; confirm which deploy-gated items are actually live.
9. **Flows & manual QA:** `PRODUCT_FLOW_MAP.md` for end-to-end traces, then execute `BETA_QA_PLAN.md` against a **test/staging** environment.

---

## 7. Commands Fable should rerun (safe, read-only / local)

Run from the repo root unless noted. All are non-destructive and touch no live infra.

```bash
npm install --legacy-peer-deps            # root (mobile) deps
npm --prefix web install                  # web deps (already present)
npm --prefix admin install --legacy-peer-deps  # admin deps (NOT committed; must install)

npm test                                  # 79 unit tests (pure logic)
npx tsc --noEmit                          # root typecheck — clean after the tsconfig fix
npm --prefix web run typecheck            # clean
npm --prefix admin run typecheck          # clean
npm --prefix web run lint                 # 26 React-Compiler findings (non-blocking)
npm --prefix admin run lint               # clean
npm --prefix web run build                # passes
npm --prefix admin run build              # passes
npm audit ; npm --prefix web audit ; npm --prefix admin audit   # mobile 20 (Expo build-time); web/admin 0

# Local secret scan (no network):
git grep -nIE '(sk_live_|sk_test_|rk_live_|whsec_|sb_secret_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'

# Read-only DB drift check (does NOT mutate — recommended to catch live drift):
supabase migration list --linked          # applied vs local migrations
supabase db diff --linked --schema public,storage   # read-only: shows drift, writes nothing
```

Expected results are recorded in `BASELINE_STATUS.md` — compare against them.

---

## 8. Commands Fable should AVOID (mutate live infra, cost money, or are destructive)

- **`supabase db push` / `supabase db push --linked`** — applies migrations to the **live** DB. Do not run during the audit.
- **`supabase functions deploy <name>`** — redeploys **live** edge functions.
- **Anything against production Stripe** in live mode (captures, refunds, transfers) — the project is on test keys; keep it that way for the audit.
- **`eas build` / `eas submit`** — EAS cloud builds cost time/credits and hit external infra; not needed to audit code.
- **`npm audit fix` / `npm audit fix --force`** — npm suggests a nonsensical `next@9` downgrade; the `postcss` override is the correct forward fix. Do not "fix."
- **Admin destructive actions against real accounts** — `deleteAccount`/`deleteUserCascade`, `suspendUser`, `changeEmail`, takedowns. Exercise these only against seeded test users on a non-production project.
- **`delete-account` edge fn** against a real user — it cancels escrow holds and cascades an irreversible delete.
- **`git push` / commits to `master`** by the auditor — leave the tree as handed over unless a change is intended.
- **Bulk/automated calls to public edge fns** (`support-submit`, `api/geocode`) that could trip rate limits or generate spam tickets/emails.

---

*Companion docs: `FABLE_HANDOFF.md` (architecture) · `ROLE_PERMISSION_MATRIX.md` (RLS/authz) · `LIFECYCLE_STATE_MACHINES.md` (state machines) · `PRODUCT_FLOW_MAP.md` (flows) · `BETA_QA_PLAN.md` (tests) · `KNOWN_RISKS.md` (risk register) · `CURRENT_COMMANDS.md` + `BASELINE_STATUS.md` (tooling & baseline).*
