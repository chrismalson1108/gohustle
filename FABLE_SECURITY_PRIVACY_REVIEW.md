# FABLE_SECURITY_PRIVACY_REVIEW.md

> **✅ RESOLVED (2026-07-11).** The High-severity blockers from this review — **H1** (invite gate), **H4/H5** (anon-read revoke), **H7** (age floor) — are implemented and **deployed to production**, verified with an anon-key `curl` (`profiles`/`jobs` → 401) and a live signup test. Full per-item status + evidence: [FABLE_BETA_AUDIT_REPORT.md §4.1.1](FABLE_BETA_AUDIT_REPORT.md). Medium/Low items below remain as recorded and are retained as the audit record.

*Independent defensive security & privacy review of GoHustlr at commit `a70c9b5`. Companion to [FABLE_BETA_AUDIT_REPORT.md](FABLE_BETA_AUDIT_REPORT.md). Read-only; every claim grounded in source read during the audit.*

This report covers: broken authorization / IDOR, cross-user data access, missing server-side validation, client-only trust, receipt/storage security, privacy risks for a minor-inclusive college population, admin abuse surface, deploy-drift/reproducibility, and missing tests. Marketplace-abuse and physical-safety findings are in [FABLE_MARKETPLACE_ABUSE_REVIEW.md](FABLE_MARKETPLACE_ABUSE_REVIEW.md).

**Confidence legend:** CONFIRMED (source) · CONFIRMED, live-conditional · DEPLOY/DASHBOARD STATE (unverifiable from repo).

---

## 1. Authorization & IDOR — verified largely sound

I read all 23 edge functions and the admin authorization chain. **20 of 23 edge functions authenticate the bearer token via `supabase.auth.getUser`; the 3 that don't are the signature-verified Stripe webhook and two static 302 redirectors.** Every money-moving function enforces resource ownership (poster-of-booking or party-of-booking) *before* any service-role write, and account/Connect/Identity functions key their resource to the token's own `user.id` with no client-supplied target id.

**Refuted IDOR attempts (CONFIRMED sound):**
- **Tip IDOR** — `stripe-tip` resolves the charged customer from the *caller's own* `user_id` and requires `booking.job.poster_id === user.id` (403 otherwise); `tipCents` bounded [50, 100000]; replay blocked by both a Stripe idempotency key and the unique `tip_ledger` row. A random authed user cannot charge another poster's card. (`stripe-tip/index.ts:22-52,78`.)
- **Capture / accept / cancel** — each re-selects booking status server-side and enforces poster-of-booking (capture/accept) or party-of-booking (cancel). (`stripe-capture-payment/index.ts:49-58`; `accept-booking/index.ts:35-45`; `stripe-cancel-payment/index.ts:36-40`.)

**Admin console (CONFIRMED sound).** `requireAdmin()` (`admin/lib/guard.ts:42-71`): `getUser()` proves token authenticity → `aalFromToken` requires AAL2/MFA → `admin_users` membership (fail-closed on lookup error) → tier check. Every mutating server action, route handler, and console page calls it; support tier is read-only + ticket triage; `/audit` and all destructive actions are admin-tier. The audit log has `UPDATE/DELETE` revoked even from `service_role` (append-only); `audit()` is awaited before irreversible actions; `assertActionableTarget` blocks acting on self or another admin; the PII export rejects cross-site requests (`Sec-Fetch-Site`) and UUID-validates its input; job-photo purge is prefix-scoped with `..` rejection.

**One admin foot-gun (Low, `admin-peer-check-fail-open`):** `assertActionableTarget` destructures only `{ data: peer }` and ignores the query `error`, so a transient lookup failure lets an admin action against a fellow-admin target pass. Not a trust boundary (any admin already holds service-role power) and not attacker-triggerable, but it should fail closed like `requireAdmin` itself. (`admin/app/(console)/users/[id]/actions.ts:28-35`.)

---

## 2. The load-bearing gap: the "closed beta" is not a technical control

**`beta-not-actually-closed` — High, CONFIRMED (source), BLOCKING.** A repo-wide search for `invite|allowlist|waitlist|access_code|beta_code` across the signup path found **nothing** (the only "allowlist" hits are the unrelated Stripe origin guard). Signup is open Supabase email/password using the embedded anon key (`src/context/AuthContext.js:264-290`), and the public web app at gohustlr.com exposes it to anyone who finds the URL.

Why this is first: **almost every "acceptable for a closed beta" judgment in this audit is priced on the cohort being small and vetted.** If anyone can sign up, the age gap, the prohibited-activity gap, the grooming funnel, and the Sybil/collusion economics all silently re-escalate. A "closed beta" enforced only by not advertising the URL is not closed.

The only acceptable evidence is a **server-side gate** (an allowlist/invite-code checked in a signup trigger or edge function, or Supabase public-signups disabled + admin-provisioned users). App-distribution restriction (TestFlight/internal) does **not** gate the web app. This is DEPLOY/DASHBOARD STATE today and must become a code control.

---

## 3. Cross-user data access & PII — the privacy core

### 3.1 The student directory is anonymously scrapable

**`profile-pii-cross-user` — High, CONFIRMED (source), BLOCKING (anon revoke).** The only SELECT policy on `profiles` is `profiles_select_all USING(true)` (`supabase/schema.sql:128`), which never scopes columns — cross-user privacy rests **entirely** on the column GRANT. That grant is `to anon, authenticated` (`supabase/migrations/20260624221000_profile_column_lockdown.sql:18-25`) and includes: `name, username, city, bio, skills, avatar_url, school, major, degree_type, class_standing, grad_year, student_status, referral_code`.

Because it is granted to **anon**, an unauthenticated caller holding the embedded anon key can query
`/rest/v1/profiles?select=name,city,school,major,class_standing,grad_year` and enumerate the entire user base — full name + specific campus + class year + city + photo, no login required, bulk-scrapable, with **no per-user privacy opt-out**. `class_standing` values like "Freshman" strongly correlate with age 17–19. `PublicProfileScreen` renders the college line and city for an arbitrary `userId` (`src/screens/PublicProfileScreen.js:85-87,157-158`); the same columns are joined onto every job (`src/context/JobsContext.js:294`).

*Sensitive columns are correctly protected:* `earnings_*`, goals, `suspended_at/suspension_reason`, `assistant_memory`, `school_domain`, `stripe_identity_session_id`, and `availability` are excluded from the grant and served owner-only via `my_profile()` / the availability RPC. There is **no email/phone/DOB column on `profiles`** (email lives in `auth.users`, unexposed). The exposure is identity + campus + schedule, not credentials.

### 3.2 Jobs are anonymously readable too — the composite is worse

**`jobs-anon-scrapable` — High, CONFIRMED (source), BLOCKING (anon revoke).** `jobs_select_all ON public.jobs FOR SELECT USING (true)` (`supabase/schema.sql:133`) with no role restriction is anon-readable. Combined with §3.1, an unauthenticated anon-key holder can join **the student directory to the job feed**: name + school + class year + city, next to job title, free-text location, ~1 km coordinates, and machine-readable slot times. That composes into "which identifiable young person will be at which place at which time" — the exact exposure that matters most for this population.

### 3.3 Free-text location defeats the coordinate fuzzing

**`location-exposure-freetext` — Medium, CONFIRMED (source).** `lat/lng` are correctly snapped to ~2 decimals (~1.1 km) on the stored value, but the human-readable `jobs.location` string is stored and displayed exactly as typed. `LocationPicker` fires `onChange(text, null)` on every keystroke (`src/components/LocationPicker.js:59`), so a user who types a street address and taps Post without selecting a city submits raw text; `PostJob` runs the content filter on title/description/tags/hazards but **not** on location (`src/screens/PostJobScreen.js:88`). The string renders to every viewer on `JobCard`/`JobDetail`. A code comment claiming "precise location is shared with the earner after booking" is misleading — no such post-confirmation mechanism exists. **Recommendation:** restrict location to a selected coarse area or scrub/coarsen to city+state before storing; if a precise address is meant to be exchanged post-confirmation, build that as a separate booked-party-only field.

### 3.4 Order-of-operations for the privacy fix (important)

Items 3.1/3.2 and the invite gate (§2) are one unit and must ship **in order**: **(1) invite gate** (stops new scraper signups) → **(2) revoke `anon` SELECT** on `profiles` and `jobs` (kills the unauthenticated path) → **(3) reduce the cross-user column set** (drop `city/major/degree_type/class_standing/grad_year/referral_code` from the authenticated grant or gate behind an opt-in). Anon-revoke alone just adds a free signup step for a scraper; the gate alone leaves the anon feed open. **Before revoking, check whether gohustlr.com renders jobs/profiles pre-auth** (marketing/SEO/OG-preview pages) — if it does, those need a service-role server route with a reduced-column view, or they go blank.

---

## 4. Storage & receipts

**Receipts are handled correctly (CONFIRMED sound).** The `receipts` bucket is private (`migration_receipts_private.sql`), owner-scoped read (`folder[1] = auth.uid()`), served via short-lived signed URLs; write policies force the uid folder. Cross-user receipt read is denied. The absence of a MIME allowlist on `receipts` is low-risk while the bucket stays private (self-XSS only).

**`certificates-bucket-public-pii` — Medium, CONFIRMED (source).** The `certificates` bucket is `public=true` with a read policy `FOR SELECT USING (bucket_id='certificates')` and **no role restriction**, so it applies to `anon` (`supabase/migrations/20260629160000_certifications.sql:24-31`). Any unauthenticated anon-key holder can fetch and **enumerate** the bucket. Certificate images routinely embed the holder's legal name and license/certification number — higher-sensitivity PII than an avatar, sitting in an anonymously-listable bucket. **Fix (minutes):** make the bucket private + serve via `createSignedUrl`, or at minimum restrict the read policy `to authenticated` with owner/party scoping.

**`completion-photos-writable-array-read` — Medium, CONFIRMED (source).** The private `completion-photos` read policy authorizes a signed URL by matching the object against `bookings.completion_photos || before_photos` for a booking the caller is party to — but the earner branch of `guard_bookings_write` **never pins those two columns** (contrast the poster branch, which does), and no path-guard trigger exists. So an attacker who books any gig (becoming earner on booking B) can `UPDATE B.before_photos = ['<victimUid>/<file>.jpg']` and then obtain a signed URL for a victim's completion photo. This is the exact "trust a writable column" flaw the `chat_photo_path_guard` was created to close for chat images (`20260702010000_chat_photo_path_guard.sql`); the analogous guard was never added here even though the private-read migration postdates it. Gated by knowing the object path (bounds it to Medium). **Fix:** add a BEFORE INSERT/UPDATE trigger rejecting any `completion_photos`/`before_photos` element not prefixed with the writer's own `<auth.uid()>/` folder, mirroring `guard_message_image_path`.

**`public-bucket-mime-allowlist-missing` — Medium, CONFIRMED (source), live-conditional.** The only migration that sets `allowed_mime_types`/`file_size_limit` for `avatars`/`job-photos`/`chat-photos`/`completion-photos` is `migration_security_hardening_2.sql`, banner-marked **`SUPERSEDED — DO NOT RUN`** and not applied by `supabase db push`. A rebuild from `schema.sql` + tracked migrations creates `avatars`/`job-photos` **public with no MIME restriction**; the `certificates` hardening was re-added but these were left behind. A direct Storage REST upload sets its own Content-Type, bypassing the client JPEG re-encode, so an `image/svg+xml` or `text/html` object in a public bucket executes active content on the `*.supabase.co` origin when a victim opens its URL. **Fix:** add a tracked idempotent migration setting a raster allowlist + size cap on all image buckets; verify on prod.

---

## 5. Missing server-side validation & client-trust

**`no-age-verification` — High, CONFIRMED (source), BLOCKING (minimum DOB form).** GoHustlr targets a population that includes minors yet performs **zero age verification**. The only control is a self-attestation checkbox (`src/screens/auth/AuthScreen.js:111,313-329`; OAuth users get the same lone checkbox at onboarding). A repo-wide grep for `date_of_birth|dob|birthdate|age` found no DOB collection in any signup/onboarding/profile flow and no age column in any migration — **the backend never learns the user's age**, so server-side enforcement is not even possible today. Stripe Connect KYC de-facto 18-gates *Stripe-paid earners*, but browsing, posting gigs (a poster only saves a card — no KYC), messaging adults, booking, and disclosing location all happen before any payout setup, and posters never onboard to Connect at all. The Terms represent all users as 18+.

*Fix, sequenced for existing users:* add a nullable `date_of_birth` column → collect at next login → **enforce at action time** (post/book/message), not as `NOT NULL` on the row (which would brick current testers). Hard-block under-18 server-side. This is a minimum age *floor*, not full IDV.

**`onboarding-legal-acceptance-ordering` — Medium, CONFIRMED (source).** Mobile `handleFinish()` writes `onboarding_done=true` **first**, then calls `recordAcceptances` inside a `try/catch` that swallows errors (`src/screens/onboarding/OnboardingScreen.js:108-116,133`); web records acceptance first and blocks on failure (`web/app/onboarding/page.tsx:84-102`). Email sign-ups never record acceptance at signup (the checkbox is UI-only), so on mobile a transient failure leaves a fully-onboarded, transacting user with **no `legal_acceptances` row** for terms/privacy/contractor. It self-heals to `ConsentScreen` on the next session (fail-closed), but the current session transacts with no audit trail. **Fix:** mirror web ordering — `await recordAcceptances` and abort if it fails before setting `onboarding_done=true`.

**`geocode-open-proxy` — Medium, CONFIRMED (source).** `GET /api/geocode` is public with no auth and no rate limit, relaying to `photon.komoot.io` (`web/app/api/geocode/route.ts:6-42`). SSRF is **soundly prevented** (upstream host/path hardcoded, all inputs `encodeURIComponent`'d, lat/lon range-validated). The residual risk is cost/DoS abuse (Vercel quota burn, komoot IP throttling that silently breaks autocomplete for real users). **Fix:** per-IP rate limit; optionally require a Supabase session since all callers are inside authenticated screens.

**`signup-account-enumeration` — Low, CONFIRMED (source).** A sign-up targeting an already-**confirmed** email falls through to "An account with this email already exists," confirming existence to an unauthenticated caller (`src/context/AuthContext.js:278-285`). Unconfirmed/new cases correctly return a neutral state, so enumeration is limited to confirmed accounts. Accept as a UX tradeoff or return the neutral outcome uniformly.

**`csp-unsafe-inline` — Low, CONFIRMED (source).** Production `script-src` retains `'unsafe-inline'` (`web/next.config.ts:21-24`), so CSP provides no defense-in-depth against injected inline scripts. **No active sink exists** (no `dangerouslySetInnerHTML`/`innerHTML`/`eval` anywhere in `web/`; all user content renders through React auto-escaping), so this is a residual, not a live vuln. Add a CI grep that fails the build if a raw-HTML sink is introduced, so the "no sink" premise holds.

---

## 6. Realtime authorization — verify live

**`realtime-authz-unverified` — Medium, DEPLOY/DASHBOARD STATE.** No realtime configuration (`supabase_realtime` publication membership, RLS-on-realtime) is present in the repo. Clients subscribe to per-booking channels keyed by `bookingId` (`msgs-${bookingId}`). Whether a third party who guesses a `bookingId` can subscribe to `postgres_changes` events depends entirely on whether realtime authorization is enabled and RLS-gated in the hosted project — dashboard state. **Verify:** attempt a cross-user channel subscription against a staging project; confirm RLS is enforced on the realtime publication. (If you flip realtime RLS on to fix this, re-test `MessageSheet` immediately — the flip can silently kill legitimate chat channels.)

---

## 7. Deploy-drift & reproducibility

**`deploy-drift-rls-migration-order` — Medium, CONFIRMED (source), live-conditional.** `schema.sql` ships permissive `USING(true)` policies that only later migrations neutralize: `profiles_select_all` (never column-scopes — the whole cross-user model rests on the GRANT), `slots_update_any` (any authed user could UPDATE any slot until `review5`), `reviews_insert_auth` (forgeable until `review5`), and client-writable `stripe_accounts/customers` (`FOR ALL` until `review6`). A partial apply, or a re-run of a superseded loose file *after* the tracked hardening, reopens real holes. `CLAUDE.md`'s "run `schema.sql` first" as a standalone bootstrap is dangerous. **Fix:** ship the hardened policies in a squashed baseline so the base schema is safe standalone; treat loose `supabase/*.sql` as historical/never-rerunnable; verify live `pg_policies` against the tracked set.

**`skill-rates-no-ddl-rebuild-abort` — Medium, CONFIRMED (source), live-conditional.** `profiles.skill_rates` appears only in two GRANT statements and is never created by any `CREATE TABLE`/`ADD COLUMN`. The tracked column-lockdown migration runs an **unguarded** `grant select ( ... skill_rates ... )`. On a fresh DB built from `schema.sql` + tracked migrations, that statement throws "column skill_rates does not exist" and **aborts the migration** — so the accompanying `revoke` + narrowed grant may never take effect, leaving `profiles_select_all USING(true)` with default full-column visibility (earnings, goals, `work_status_note`, `assistant_memory` exposed cross-user). `stripe_identity_session_id` is similarly out-of-band. This directly pairs with the §3.1 blocker: the mechanism that *fixes* the anon exposure can silently fail to apply on rebuild. **Fix (do before any live-DB introspection):** add tracked `alter table public.profiles add column if not exists skill_rates jsonb` and `... stripe_identity_session_id text` migrations ordered *before* the lockdown.

---

## 8. Missing tests (security-relevant blast radius)

`npm test` = 79 pure-logic unit tests (10 suites); `web/` is Jest-ignored; `admin/` has zero tests; no Detox/Maestro/Playwright/Cypress. Nothing exercises money movement, a state transition, a permission boundary, auth, or RLS.

**`money-path-arithmetic-untested` — Medium.** The escrow split, partial-capture math, the 10%-fee constant (duplicated across 3+ edge-function sites), and the cancellation/lifecycle helpers have no test, and the math is entangled with `import Stripe from 'npm:stripe@15'` so it can't be imported into Node Jest. A regression that flips the fee, drops the hours multiplier, mis-rounds, or removes the 0.5 floor would ship undetected. (Currently verified *correct* by this audit — this is a regression-protection gap.) A related smell: the partial branch reads `payment.fee_cents` rather than re-deriving from immutable `amount_cents` like the full branch. **Fix (hours):** extract `computeEscrowSplit`/partial-split into `shared/finance.js` (Deno-importable), define `PLATFORM_FEE_PCT` + bounds once, unit-test the odd-cent rounding, bounds, and 0.5 floor.

**`db-invariants-untested` — Medium.** `guard_bookings_write` (the sole server-side lifecycle enforcer), `credit_earnings`/`claim_and_credit_tip` idempotency, every RLS boundary, and `deleteUserCascade` have no automated test. A one-word widening of a `using`/`with check` clause or a reordered guard would ship green. **Fix (first post-beta CI investment):** a `supabase`-local integration harness asserting each allowed transition succeeds and each disallowed one reverts, concurrent credit calls net exactly one increment, and 6–8 highest-value cross-user RLS denials.

For beta, the required subset is a **money-path smoke test** (post→book→accept→done→verify→capture→credit, plus partial-capture and cancel-release) against Stripe test mode before the live-mode flip — not a full e2e suite. See the fix plan.

---

## 9. Security & privacy verification checklist (for the launch gate)

These are the live-state items this report cannot resolve from source. Evidence (script output / screenshot / date / owner) belongs in the launch decision.

1. `pg_policies` + column grants on `profiles`, `jobs`, `storage.objects` match the tracked hardened set; **anon has no SELECT on `profiles`/`jobs`** (prove with an anon-key `curl` that fails).
2. `has_column_privilege` for `anon`/`authenticated` on `profiles` excludes every sensitive column.
3. The `skill_rates`/`stripe_identity_session_id` DDL exists live; a fresh rebuild from tracked migrations applies the lockdown without aborting.
4. All image buckets carry the raster MIME allowlist + size cap; `certificates` is private.
5. Realtime authorization is enabled and RLS-gated; a cross-user channel subscription is denied.
6. Supabase Auth: `mailer_autoconfirm=false`, HIBP leaked-password protection on, OTP expiry sane, redirect allowlist correct, admin MFA enrolled.
7. No secret in any `NEXT_PUBLIC_*`; service-role key server-only; backups/PITR enabled (ideally restore-tested).
8. `send-push` caller-auth + shared-booking anti-spoof confirmed on the deployed function.
