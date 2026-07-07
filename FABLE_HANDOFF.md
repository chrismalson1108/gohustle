# GoHustlr — Auditor Orientation (FABLE_HANDOFF.md)

*Verified 2026-07-07 at commit a70c9b5 (master).*

This is the top-level orientation document for the external beta-readiness audit. It stands alone: the facts below are inlined from a set of file:line-verified dossiers. Seven sibling docs go deeper — **ROLE_PERMISSION_MATRIX.md**, **PRODUCT_FLOW_MAP.md**, **LIFECYCLE_STATE_MACHINES.md**, **CURRENT_COMMANDS.md**, **BASELINE_STATUS.md**, **BETA_QA_PLAN.md**, and **KNOWN_RISKS.md** — and are referenced by name where relevant. Every claim here is grounded in real source; `path:line` citations are preserved so you can jump straight to the code.

---

## 1. What this product does

GoHustlr is a two-sided gig marketplace aimed at college students, structured like TaskRabbit. One authenticated user can act in **either role, per action**: as an **earner** (does the work) or a **poster** (hires and pays). There is **no account-level distinction between "student worker" and "customer/client"** — both are the same Supabase user. `profiles.role` (`earner` / `poster` / `both`) is a display field only and is **never used in any RLS policy**; access rights are scoped entirely by row relationship (`earner_id` on a booking vs `poster_id` on a job). A "student worker" is simply a signed-in user acting as earner; a "customer/client" is the same user acting as poster.

**Student verification** is a trust signal layered on top, not an account type: a `.edu` email OTP flow sets `profiles.student_verified` (a signal, not proof of current enrollment). Separately, **Stripe Identity** (government ID + selfie) drives the `verified` badge and `id_verification_status`.

**Money flow (one paragraph):** Payments use a Stripe **manual-capture escrow** model. When a poster accepts a booking, the `stripe-create-payment-intent` edge function places a manual-capture PaymentIntent (a hold) on the poster's card, with a **10% platform fee** (`application_fee_amount`) and `transfer_data.destination` set to the earner's Stripe Connect Express account. A booking can only move to `confirmed` after `accept-booking` re-fetches the PaymentIntent and confirms it is `requires_capture` — a poster cannot confirm without funding escrow. After both parties mark the job done and the poster verifies, `stripe-capture-payment` captures the hold (full, or partial for disputes), transfers the net to the earner's Connect account, and atomically credits earnings via the `credit_earnings` RPC. Tips are a separate off-session charge (100% to earner, no platform fee); payouts to earners are automatic daily via Connect. **Stripe is in TEST mode for beta** (`admin/lib/config.ts:19` default `/test`).

---

## 2. Tech stack

| Layer | Tech | Location |
|---|---|---|
| Mobile app | Expo / React Native (SDK 54, RN 0.81.5, React 19.1.0) | `App.js`, `src/`, `index.js` |
| Web app | Next.js 16.2.9 App Router, React 19.2.4, Tailwind v4, Leaflet | `web/` |
| Admin console | Next.js 16.2.9 App Router (separate Vercel project) | `admin/` |
| Shared logic | Pure-ESM package `@gohustlr/shared` (no deps) | `shared/` (consumed by web via `file:../shared`) |
| Backend | Supabase — PostgreSQL + RLS, Auth, Realtime, Storage | `supabase/` (schema, migrations, config) |
| Edge functions | 23 self-contained Deno functions (AUDIT_REPORT.md/CLAUDE.md say 24 — off by one vs. disk) | `supabase/functions/*/index.ts` |
| Payments | Stripe — manual-capture escrow, Connect Express payouts, Identity, tips | `supabase/functions/stripe-*` |
| AI | Anthropic Claude (tool-use assistant + support-draft) | `supabase/functions/assistant`, `supabase/functions/support-ai-draft` |

---

## 3. App architecture

**Three client apps share one Supabase backend.**

- **Mobile** (`App.js` + `src/`) and **Web** (`web/`) are the user-facing apps. They are near-mirrors: same tables, same edge functions, same realtime channel names, same `@gohustlr/shared` logic. Both talk to Supabase directly with the anon key and Row-Level Security; the bearer token is attached automatically by `supabase-js`.
- **Admin console** (`admin/`) is operator-facing and architecturally different: it never queries Supabase from the browser for console data. All console data access is **server-side with the service-role key**, gated by `requireAdmin()`. It is deployed as a separate Vercel project (`admin.gohustlr.com`, dev port 3100) and has **no `@gohustlr/shared` dependency**.

**Shared surfaces:**
- **Supabase project** `nfioebqsgmmzhbksxozc` at `https://nfioebqsgmmzhbksxozc.supabase.co` — identical URL/anon key across mobile and web.
- **Edge functions** at `<SUPABASE_URL>/functions/v1/<name>`. Mobile invokes them via `src/lib/stripeClient.js`/`push.js`/`student.js`/`assistantClient.js`; web via `web/lib/edge.ts` (which explicitly notes it mirrors the mobile client). Admin invokes `support-reply`/`support-ai-draft` with the admin's own JWT.
- **`@gohustlr/shared`** (`type:module`, no dependencies) re-exports `theme, constants, geo, taxFormat, contentFilter, leveling, transforms, filters, lifecycle, school, finance, availability, analytics`. Both mobile (`src/lib/*` are thin `export * from '../../shared/…'` shims) and web consume it. This is where the transforms (`transformJob`/`transformBooking`), content filter (`findProhibited`), and pure business logic live once.

**Data flow:** clients read/write Supabase tables directly under RLS and subscribe to Realtime channels; money-moving and privileged operations are funneled through edge functions (which hold the service-role and Stripe secret keys); the Stripe webhook syncs the DB back from Stripe events.

---

## 4. Mobile app structure

**Boot sequence** (`index.js` → `App.js`):
1. `index.js` registers `App` as the RN root (`index.js:3,8`).
2. `App()` provider skeleton, outermost first: `StripeProvider` → `SafeAreaProvider` → `ErrorBoundary` → `AuthProvider` → `RootNavigator` (`App.js:221-233`).
3. `RootNavigator()` gates on `useAuth()` (`App.js:202-219`): loading spinner while resolving → `AuthScreen` (no session) → `OnboardingScreen` (`!onboardingDone`) → `ConsentScreen` (`needsTermsAcceptance`) → `MainApp`.
4. `MainApp()` mounts `UserProvider` → `JobsProvider` → `AppNavigator` + `AssistantButton` + `AchievementToast` + `PushManager` (`App.js:187-200`).
5. `AppNavigator()` is rendered **inside** `JobsProvider` so it can read tab-badge counts, and owns the single `NavigationContainer` (`App.js:148-185`) — which is why `NavigationContainer` is not at the root.

**Navigation** — one bottom `Tab.Navigator` + one reused stack factory. **Route names are stable; display labels differ** (many `navigation.navigate('EarnTab'|'GigsTab'|'ProfileTab', …)` calls depend on the route names):

| Tab route | Label | Stack screens |
|---|---|---|
| `HomeTab` | Browse | HomeScreen → JobDetail → MarketInsights → UserProfile |
| `EarnTab` | My Jobs | EarnScreen → JobDetail → UserProfile |
| `GigsTab` | Hiring | GigsScreen → PostJob → JobDetail → EditJob → UserProfile |
| `MessagesTab` | Messages | MessagesScreen → UserProfile |
| `ProfileTab` | Profile | ProfileScreen → ManageBookings / Settings / Availability / Notifications / PayoutSetup / Expenses / Legal / Favorites / SavedGigs / UserProfile / JobDetail |

`PublicProfileScreen` is registered as `UserProfile` in **every** stack (the cross-tab profile viewer). Tab badges come from `JobsContext` (`earnBadgeCount`, `profileBadgeCount`, `unreadMessages`).

**The three contexts:**
- **AuthContext** (`src/context/AuthContext.js`) — session lifecycle, onboarding + legal-acceptance gating, all sign-in methods. Email/password, Google OAuth (PKCE, disabled in Expo Go), Apple Sign-In (nonce + id-token), password reset via a **separate implicit-flow `recoveryAuthClient`**. Init is time-boxed (8s) so a corrupt AsyncStorage session can't freeze launch; the `onAuthStateChange` callback is deliberately synchronous to avoid auth/network deadlock. No realtime channels.
- **UserContext** (`src/context/UserContext.js`) — profile/gamification state (XP, streak, earnings, goals, challenges, badges, work status, availability, student fields), toast queue. Cache-first, reads the owner's full row via the **`my_profile` RPC**, debounced 2s merge-sync for XP/goals. `profileStatus` (`loading`/`ready`/`error`) prevents rendering `DEFAULT_STATE` as real data.
- **JobsContext** (`src/context/JobsContext.js`) — jobs feed, earner + poster bookings, blocking, saved gigs, unread count, the entire booking lifecycle, amendments, and the payment edge-function wrappers. Runs **three realtime channels**: `bookings-user-${id}` (earner), `poster-bookings-${id}` (broad poster subscription), `messages-unread-${id}`. Money-critical paths: `acceptBooking` (via `accept-booking` with a retry ladder), `verifyAndRate` (captures escrow before writing status, idempotent, handles partial/dispute + tip), `cancelBooking` (guarded DB write first, then hold release).

**Inventory (summary level):**
- **Screens** (`src/screens/`): HomeScreen (Browse), EarnScreen (My Jobs), GigsScreen (Hiring), PostJob, EditJob, JobDetail, MarketInsights, Profile, PublicProfile (`UserProfile`), Settings, Availability, Messages, Notifications, Expenses (Tax Center), PayoutSetup, Favorites, SavedGigs, Legal, Consent, ManageBookings (legacy poster view), plus `auth/AuthScreen` and `onboarding/OnboardingScreen`. **Two dead screens** — `BrowseScreen.js` and `MyJobsScreen.js` — are not registered anywhere; `MyJobsScreen` even reads a non-existent `appliedIds` from `useJobs()` (`MyJobsScreen.js:8`). Note as dead code; do not remove.
- **lib** (`src/lib/`): `supabase.js` (PKCE client + recovery client), `stripeClient.js` (pk_test key, 12 Stripe/Connect/Identity edge wrappers), `push.js` (Expo push + local reminders + `send-push`), `moderation.js`, `verification.js` (Stripe Identity), `student.js` (.edu OTP), `expenses.js`, `notifications.js` (in-app DB notifications, distinct from push), `analytics.js` (no-op, null keys), `assistantClient.js`/`assistantThreads.js`, `cache.js`, `certifications.js`, `favorites.js`, `legal.js`, `messages.js`, `referrals.js`, `savedJobs.js`, `schedule.js`, `uploadImage.js`, plus thin shared re-export shims (`geo`, `finance`, `filters`, `contentFilter`, `taxFormat`, `availability`, `school`, `insights`).
- **components** (brief): `AchievementToast`, `AssistantButton`, `Avatar`, `BadgeGrid`/`ChallengeCard`/`XPBar`, `BookingStatusBadge`, `CompletionModal` (verify+rate+dispute+tip), `DateTimePicker`/`SlotPicker`, `ErrorBoundary`, `FilterSheet`, `GradientHeader`, `JobCard`, `JobsMap` (native-only), `LocationPicker`, `MessageSheet` (realtime chat), `MoneyGoalCard`, `PosterTrustCard`, `RatingStars`, `SignedImage` (private-bucket signed URL), `StudentBadge`/`StudentVerifyModal`, `TagInput`, `WorkStatusBar`.

**Native-only features** (require a dev-client rebuild — not plain Expo Go): Stripe (`@stripe/stripe-react-native`), push (`expo-notifications` + `expo-device`), maps (`react-native-maps`), Apple Sign-In, Google OAuth (PKCE), haptics, image capture/upload (`expo-image-picker`/`-manipulator`), location (`expo-location`), crypto (`expo-crypto`). EAS profiles: `development`, `development-device`, `preview`, `production`.

---

## 5. Web app structure

Next.js 16 App Router. **⚠️ Version caveat:** `web/AGENTS.md` warns this is "NOT the Next.js you know" — APIs and conventions differ from training data; Next 16 also renames `middleware` → `proxy`. Treat static-vs-dynamic rendering, CSP/nonce, and `proxy` behavior as non-standard.

**Route groups & the `(app)` auth gate:**
- One route group `(app)/` — the authenticated shell. Everything else (`login`, `onboarding`, `consent`, `contact`, `reset-password`, `auth/callback`, `legal/[doc]`, `stripe/*` return pages, `api/geocode`, and the root marketing `page.tsx`) is ungated.
- **Providers:** root `providers.tsx` mounts **only** `AuthProvider` globally; the `(app)/layout.tsx` mounts `UserProvider → JobsProvider → AppShell` **inside the gate**.
- The gate (`app/(app)/layout.tsx`) reads `useAuth()` and runs a client-side redirect ladder: no session → `/login`; `!onboardingDone` → `/onboarding`; `needsTermsAcceptance` → `/consent`; else render children. **This is client-side gating only — there is no `middleware.ts`/`proxy.ts` in web** (verified absent). A signed-out user still receives the page JS; the real backstop is Supabase RLS on every table/RPC. Flag for the audit.

**`web/lib` (key modules):** `auth.tsx` (`AuthProvider`/`useAuth`, mirrors mobile), `jobs.tsx` (`JobsProvider`, 1197 lines — the largest lib, same three realtime channels and lifecycle as mobile), `user.tsx` (`UserProvider`, `my_profile` RPC), `edge.ts` (edge client mirroring mobile `stripeClient.js`), `supabaseClient.ts` (PKCE client with `processLock` + isolated implicit-flow recovery client), `config.ts` (public config + hardcoded anon/publishable fallbacks, **`pk_test` default**), `legal.ts` (fails closed), `analytics.ts` (no-op), plus `moderation/favorites/savedJobs/messages/expenses/schedule/certifications/referrals/verification/notifications/push/stripe/assistant/student`.

**Key routes:** `/browse`, `/jobs/[id]`, `/my-jobs` (mirrors mobile EarnScreen), `/hiring` + `/hiring/new` + `/hiring/[id]/edit` (mirrors GigsScreen), `/messages`, `/notifications`, `/insights`, `/u/[id]` (public profile), `/verify-student`, `/profile` (+ `/settings`, `/payouts`, `/taxes`, `/saved`, `/saved-gigs`, `/availability`). **Server components** are only `layout.tsx`, the marketing `page.tsx`, and the two `stripe/*` return pages; everything else is `"use client"`. The only true server code paths are `app/api/geocode/route.ts` (Node runtime Photon proxy — **self-flagged as unauthenticated with no rate limit**, `route.ts:17-18`) and the enforcing CSP in `next.config.ts`.

---

## 6. Backend / API structure

**Supabase** (Postgres + RLS + Auth + Realtime + Storage) plus **23 Deno edge functions** in `supabase/functions/` (AUDIT_REPORT.md/CLAUDE.md say 24 — off by one vs. disk). There is **no `_shared` directory** — every function is fully self-contained (CORS, `json()`, and the content filter are duplicated per function). Default `verify_jwt = true`; a handful opt out (`config.toml`): `stripe-webhook` (Stripe signature), the two 302 redirectors, `support-submit` (public form), and `support-reply`/`support-ai-draft` (admin JWT + `admin_users` membership).

Functions grouped by domain:
- **Payments / escrow:** `stripe-create-payment-intent` (place hold, 10% fee, server-derived amount bounded 50¢–$10k, idempotency key), `stripe-capture-payment` (full or partial-capture dispute → `credit_earnings`), `stripe-cancel-payment` (release hold; blocked once work started), `stripe-tip` (off-session, 100% to earner, `claim_and_credit_tip`), `stripe-create-setup-intent`, `stripe-payment-method-status`, `stripe-detach-payment-method`.
- **Connect payouts:** `stripe-connect-onboard` (Express account + onboarding link, exact-host open-redirect guard, daily automatic payouts), `stripe-connect-status` (authoritative live-refresh of `onboarded`), `stripe-payout-login-link`, `stripe-connect-return` (legacy 302).
- **Identity:** `stripe-create-identity-session` (document + selfie, resumable), `stripe-identity-return` (legacy 302).
- **Webhook:** `stripe-webhook` — signature-verified (dual secret for Connect events); handles `payment_intent.succeeded/payment_failed/canceled`, `account.updated`, and the three `identity.verification_session.*` events. ⚠️ **Risk: no event-level dedup ledger** — safe only because each handler is idempotent (money-moving ones lean on `credit_earnings`/`claim_and_credit_tip`); a non-idempotent future handler would double-apply on Stripe redelivery.
- **Booking:** `accept-booking` — the sole trusted confirm path; re-fetches the PaymentIntent and requires `requires_capture` before `pending → confirmed`.
- **Notifications:** `send-push` — Expo push + in-app row; anti-spoof (sender must share a booking), 30/min per-caller rate limit, content hardening.
- **Student (.edu OTP):** `student-verify-start` (rate-limited, oracle-safe, CSPRNG, SHA-256-hashed codes), `student-verify-confirm` (max 5 attempts, one .edu → one account).
- **Support:** `support-submit` (public, layered rate limits, no CAPTCHA), `support-reply` (admin email send), `support-ai-draft` (Claude suggestion, never sends, prompt-injection-defended).
- **Account:** `delete-account` (self-serve; cancels in-flight escrow holds before cascade; admin-initiated deletion uses a separate service-role port in `admin/lib/deleteUser.ts`).
- **AI:** `assistant` — 14 tools run against a **user-JWT-scoped** client (strongest pattern in the set), rate-limited (12/min, 300/day, fail-open), content-moderated, prompt-injection-defended, model-routed Haiku/Sonnet/Opus.

**Cross-cutting:** every app-facing function creates a service-role client and does its own `getUser` — so RLS-bypassing writes are code-discipline, not DB-enforced (except `assistant`, which downgrades to a JWT-scoped client). The money-correctness linchpins are the `credit_earnings` and `claim_and_credit_tip` RPCs (called from both the capture function and the webhook — idempotency depends on their atomicity). **Note:** `config.toml:25-27` has a **stale comment** claiming the admin support functions authenticate via `x-admin-secret`/service-role — the code actually uses an admin JWT + `admin_users` membership; no `x-admin-secret` exists anywhere.

---

## 7. Database, storage & auth providers

**Tables (summary):**
- **Core marketplace:** `profiles` (extends `auth.users`, ~30+ columns, column-grant-scoped SELECT, owner-only UPDATE + `guard_profiles_write` trigger pinning trust/rating/earnings/suspension), `jobs`, `job_slots`, `job_requirements`, `bookings` (the most heavily guarded table — all writes pass `guard_bookings_write`), `reviews` (two-sided, one per job/reviewer/direction).
- **Gamification:** `badges`, `user_challenges`.
- **Payments:** `stripe_customers`, `stripe_accounts`, `payments`, `tip_ledger`, `disputes` (all service-role-written or party-scoped read).
- **Tax:** `expenses`, `income_entries` — **owner-only RLS on all four verbs; there is NO approval/rejection/reviewer concept and no admin expenses page.** The Tax Center is a private personal tracker; anything the brief describes as "expense approval" does not exist.
- **Messaging:** `messages` (party-scoped, image path guarded), `conversation_state`.
- **Moderation:** `reports` (internal `resolved_by`/`resolution` hidden from reporter by column grant), `blocks`.
- **Notifications:** `notifications`, `push_tokens`, `push_send_rate`, `saved_searches`.
- **Discovery/social:** `saved_jobs`, `favorites`, `referrals`, `certifications`.
- **Availability/student:** `class_schedule`, `student_email_verifications`.
- **AI:** `assistant_threads`, `assistant_messages`, `assistant_rate`.
- **Legal:** `legal_documents` (public read), `legal_acceptances` (append-only audit).
- **Admin (service-role-only, invisible to user apps):** `admin_users`, `admin_audit_log` (immutable — UPDATE/DELETE revoked even from service_role), `admin_user_notes`, `support_tickets`, `support_ticket_messages`.

**Storage buckets (6):**

| Bucket | Public? | Holds |
|---|---|---|
| `avatars` | **Public** | profile photos |
| `job-photos` | **Public** | gig gallery/cover |
| `certificates` | **Public** | credential images |
| `chat-photos` | **Private** | DM images (party-scoped, signed URLs) |
| `completion-photos` | **Private** | proof-of-work + before photos (party-scoped, signed URLs) |
| `receipts` | **Private** | expense receipts (owner-scoped, signed URLs) |

The three private buckets were made private by **later** migrations that override the original public creation. All buckets except `receipts` carry a raster-only MIME allowlist (SVG/HTML excluded) and a 10 MB cap; `receipts` has no MIME allowlist (possibly intentional for PDFs — flag).

**Auth providers:** email/password (email confirmation ON), **Google OAuth** (PKCE), **Apple Sign-In** (native id-token), and the custom **student `.edu` email OTP** (not a Supabase provider — a trust signal via edge functions). **Critical:** `supabase/config.toml` contains **only** edge-function `verify_jwt` toggles — there is **no `[auth]` block**. All auth-provider client IDs, `mailer_autoconfirm`, `site_url`, and the redirect allowlist live in the **hosted Supabase Dashboard, not in the repo**. The audit cannot verify these from source.

---

## 8. Important commands

Full, verified list is in **CURRENT_COMMANDS.md**. The handful an auditor will actually run:

```bash
npm install --legacy-peer-deps      # mobile deps (root); --legacy-peer-deps is mandatory (React 19)
npm test                            # mobile/shared Jest unit tests (79 pass, 10 suites)
npm --prefix web run build          # web production build (Next 16)
npm --prefix admin run build        # admin console build
supabase db push --linked           # apply tracked DB migrations (CLI is linked)
```

Notes: `web`/`admin` install and run under `web/` and `admin/` (`npm run dev`, ports 3000 and 3100); `admin` also uses `--legacy-peer-deps`. `eas`/`expo` are **not** global — prefix with `npx`. Edge functions deploy via `supabase functions deploy <name>`.

---

## 9. Known incomplete areas

From the risks dossier §1 (each verified against source):
1. **Monitoring/analytics are stubbed** — `SENTRY_DSN`/`ANALYTICS_KEY` are `null` (`src/lib/analytics.js:12-13`); `track`/`captureError`/`identify` are dev-only no-ops on both mobile and web. No crash telemetry or funnel analytics reaches any provider.
2. **No e2e/integration tests** anywhere — only 10 pure-logic Jest suites (79 tests pass). `web/` and `admin/` have zero tests. No Detox/Maestro/Playwright/Cypress. The core money loop has no automated end-to-end coverage.
3. **No SMS/phone OTP** — identity is email confirmation + optional `.edu` + optional Stripe Identity; SMS is an unbuilt P1.
4. **Rate-limit infra gaps** — the public `/api/geocode` proxy has no per-IP limiter (self-flagged), and `support-submit` has no CAPTCHA (only DB counters). Application-level limiters (assistant, push, student-verify) do exist.
5. **Legal content is draft** — the v2026-07-02 docs are self-labeled "NOT attorney-reviewed," with an explicit `[DRAFT PLACEHOLDER]` in the governing-law/arbitration clause.
6. **Cancellation fee records but no money moves** — `bookings.cancellation_fee` is display/policy only; no Stripe charge is wired.
7. **Documentation drift** — several docs (CLAUDE.md, ROADMAP, TESTFLIGHT, AI_ASSISTANT) are stale vs `master`: they still call the now-private photo buckets "public," say the assistant has no cross-request rate limiting (it does), and list built features (favorites, gig reminders) as unbuilt. Trust source over docs.

---

## 10. Known risky areas

Detail is in **KNOWN_RISKS.md**. The top items:
- **Deploy-gated fixes:** many audit/hardening fixes are code-complete on `master` but marked "needs push/deploy." If not yet applied to live Supabase/Vercel/Stripe, the live system lacks the `certificates` MIME allowlist, private photo buckets, server-side moderation, Stripe return-URL pinning, and the `send-push` throttle. **The single highest-leverage live-verification item is the Stripe webhook** — if registered in the wrong mode or with a stale signing secret, payments still charge but earnings never credit and the Verified badge never appears.
- **Fail-open designs:** the assistant cost cap, `send-push` rate limit, and escrow-hold-release-on-cancel/delete all degrade silently if their backing table/secret is missing (holds then auto-expire after ~7 days rather than releasing immediately).
- **Migration hygiene:** two parallel migration sets exist (32 legacy `migration_*.sql` + 48 tracked `migrations/*.sql`). The base `schema.sql` still ships permissive `USING(true)` policies that only the tracked migrations neutralize — correctness depends on applying the tracked set, in order, on top of `schema.sql`. There is no single idempotent bootstrap, and a couple of columns (`skill_rates`, `stripe_identity_session_id`) and `rls_auto_enable()` were added out-of-band with no DDL in the repo.
- **`jobs.status` has no server-side transition guard** — it is client-trusted (unlike the heavily-guarded `bookings.status`), and `'booked'` is a dead enum value never set by the lifecycle.
- **Disputes have no adjudication path** — partial-capture/dispute rows and report resolutions are written only by edge functions/console; there is no user-facing appeal flow in the schema.
- **Content moderation is advisory + hand-maintained in three places** (`shared/contentFilter.js`, `assistant/index.ts`, the DB `contains_prohibited`); a sync test guards drift but the list is small.

**Admin authz** deserves a positive note: it has two tiers (`admin` = full mutations, `support` = read-only + support-ticket triage/reply) enforced **only in the admin Next.js runtime** via `requireAdmin()` → authentic `getUser()` → mandatory AAL2/MFA → `admin_users` membership → tier. There are **no admin RLS policies in the DB** — admin power is the admin app holding the service-role key, and a user JWT can never reach admin surfaces at the DB layer.

---

## 11. Where important logic lives (map to the code)

| Concern | Primary location(s) |
|---|---|
| Booking lifecycle (state machine) | `src/context/JobsContext.js` + `web/lib/jobs.tsx` (client) enforced by DB trigger `guard_bookings_write` (`supabase/migrations/20260702030000_guard_pins_and_slot_delete_policies.sql:15-116`) |
| Escrow / payments / tips | `supabase/functions/stripe-*` (create-payment-intent, capture-payment, cancel-payment, tip, connect-*, create-identity-session) + `accept-booking` + `stripe-webhook`; money RPCs `credit_earnings` / `claim_and_credit_tip` in `supabase/migrations/*` |
| RLS policies & write guards | `supabase/schema.sql` (base) + `supabase/migrations/*` (authoritative hardened layer): `guard_bookings_write`, `guard_profiles_write`, `guard_jobs_write`/`guard_jobs_delete`, `advance_mutual_completion`, `sync_slot_taken`, `contains_prohibited` |
| Admin authorization | `admin/lib/guard.ts` (`requireAdmin`), `admin/lib/serviceClient.ts`, `admin/lib/audit.ts`, `admin/lib/deleteUser.ts`; membership table `supabase/migrations/20260705010000_admin_console.sql` |
| Shared/pure logic | `shared/*` — `transforms.js` (`transformJob`/`transformBooking`), `contentFilter.js` (`findProhibited`), `finance.js`, `filters.js`, `geo.js`, `taxFormat.js`, `leveling.js`, `availability.js`, `constants.js` |
| Auth / session | `src/context/AuthContext.js` + `web/lib/auth.tsx`; clients `src/lib/supabase.js` + `web/lib/supabaseClient.ts` |
| AI assistant | `supabase/functions/assistant/index.ts` (server tool-use loop); clients `src/lib/assistantClient.js`, `web/lib/assistant.ts` |

---

## 12. Current beta-readiness status

Summarized from the risks dossier §3.

**Code-complete (in-repo, on `master`):** the full two-sided marketplace — escrow payments, Connect payouts, Stripe Identity, realtime messaging, two-sided reviews, tax center, push (needs native build), referrals, recurring gigs, tips, disputes/partial-capture, favorites/saved, gig reminders, maps/distance, AI assistant, `.edu` verification, in-app account deletion, and the admin console. Baseline is green: 79 unit tests pass, web + admin typecheck clean and `npm audit` = 0, both build successfully (see **BASELINE_STATUS.md**). The mobile `npm audit` shows transitive `@expo/*` build-time vulns (accepted risk), and the root `npx tsc` "failure" is a spurious config artifact (root tsconfig only excludes `supabase/functions`, so tsc crawls web/admin `.tsx` without their path aliases) — not a real mobile type error.

**Blocks a beta (must clear before external users):**
1. Legal review + business entity/insurance (the biggest non-engineering blocker; draft ToS with a placeholder arbitration clause).
2. Stripe live cutover — live keys, **live webhook re-registration with the new signing secret**, live Connect + Identity KYC, and a real-money smoke test. Until done, live earnings/badge crediting is unproven.
3. Apply the audit/hardening deploys (`supabase db push` + edge redeploys) — otherwise the cert-MIME allowlist, private photo buckets, server-side moderation, redirect pinning, and push throttle are absent in production.
4. Monitoring (Sentry DSN + PostHog key + native SDKs + dev-client rebuild) — currently a blind beta.
5. E2E smoke coverage for the core money loop.
6. Push on a real build (Expo Go can't receive remote push; needs APNs/FCM + a production/dev build).
7. App Store / Play accounts, listings, and privacy labels that reflect the now-private photo buckets.
8. Operational config (Resend verified domain + `STUDENT_VERIFY_FROM`, `gohustlr.com` DNS → Vercel, Stripe Connect branding).

**Nice-to-have (not blocking):** assistant streaming/messaging tool, SheerID enrollment tier, calendar sync, SMS OTP, geocode/support CAPTCHA limiters, CSP-posture confirmation, empty-state polish.

**What to review first:** (1) the **escrow money path end-to-end** — `stripe-create-payment-intent` → `accept-booking` (the `requires_capture` invariant) → `stripe-capture-payment` → `credit_earnings`, plus the webhook's parallel credit path and whether `credit_earnings`/`claim_and_credit_tip` are truly atomic/once-only; (2) whether the **§10 hardening migrations and edge redeploys are actually live**; (3) the **`guard_bookings_write` trigger** as the load-bearing lifecycle enforcer; (4) **admin authz** (`requireAdmin` → AAL2 → `admin_users` → tier) since it is the only thing standing between an operator and the service-role key.

---

## Open questions / for Fable to verify

1. **Have the audit/hardening migrations + edge redeploys actually been applied to LIVE Supabase/Vercel/Stripe?** The code is on `master` but every deploy-gated item is marked "needs push/deploy." This is the largest unknown separating "code-complete" from "protected in production."
2. **Is the Stripe webhook registered in the target mode with a matching signing secret, and are Connect + Identity enabled live?** Test-mode registration does not carry to live.
3. **Which docs are authoritative?** CLAUDE.md / ROADMAP / TESTFLIGHT / AI_ASSISTANT contradict the current code (photo-bucket privacy, assistant rate limiting, built features). Trust source over docs.
4. **Web/admin have no request-level middleware and web has no `middleware.ts`/`proxy.ts`** — confirm Supabase RLS fully backstops every table/RPC reachable while signed out.
5. **Admin `proxy.ts` wiring** — there is no `middleware.ts` in `admin/`; whether Next 16.2.9 auto-registers `proxy.ts` as request middleware is unverified (node_modules absent at dossier time). If not recognized, the cookie-refresh/login-redirect UX layer is dead code (security impact low; data layer still gated by `requireAdmin`).
6. **Fresh-DB reproducibility** — `skill_rates` and `stripe_identity_session_id` columns and `rls_auto_enable()` were added out-of-band with no DDL in the repo; confirm the live DB has them and that the audited state = `schema.sql` + all tracked migrations in timestamp order.
7. **`receipts` bucket has no MIME allowlist** — confirm intentional (PDF receipts) vs an SVG/HTML-upload vector if reads are ever made public.
8. **Which legal doc version is currently published** per slug (is the `[DRAFT PLACEHOLDER]` v2026-07-02 what beta users are accepting)?
9. **Supabase Auth dashboard hardening** (HIBP leaked-password, OTP expiry, SSL, user MFA, correct Site/Redirect URLs) is dashboard state, not code — needs live confirmation.
10. **Was the previously-exposed Anthropic API key rotated** (it gates `assistant` + `support-ai-draft`), and does the production web CSP still allow `'unsafe-inline'`/dev-only `'unsafe-eval'`?
11. **`config.toml:25-27` stale comment** — documents an `x-admin-secret` auth model the support functions no longer implement (they use admin JWT + `admin_users`); confirm no deployment path still sends `x-admin-secret`.
