# GoHustlr — Known Risks & Beta-Readiness Register

_Verified 2026-07-07 at commit a70c9b5 (master)._

**Purpose.** This document enumerates the known risks, incomplete/stubbed areas, deploy-gated protections, deliberate fail-open designs, lifecycle/authorization gaps, data/privacy exposures, migration-hygiene issues, and live-config unknowns for the GoHustlr platform. It is a **documentation-only** register for an external auditor (Fable). **No fixes are proposed or applied here.** Every claim is grounded in source with `path:line` citations.

**System shape (context).** GoHustlr is a two-sided, TaskRabbit-style gig marketplace for college students. Three front-ends run on one Supabase backend: **mobile** (Expo/React Native, `src/` + `App.js`), **web** (Next.js, `web/`), and an **admin console** (Next.js, `admin/`). Shared pure logic lives in `shared/`. Backend = Supabase (Postgres + RLS, Auth, Realtime, Storage) + Deno edge functions. Payments = Stripe (manual-capture escrow, Connect Express payouts, Identity, tips), in **TEST mode** for beta.

**Two ground-truth facts that recur below.**
- **Roles are per-action, not per-account.** There is no DB-level distinction between a "student worker" and a "customer/client": both are the same authenticated user. `profiles.role` (`earner`/`poster`/`both`) is a display/preference field and is **never referenced in any RLS policy**. Rights are scoped by row relationship (`earner_id` on a booking vs `poster_id` on a job).
- **Admin power lives in the app runtime, not the DB.** There are **no admin RLS policies anywhere**. Admin/support authority exists solely because the `admin/` Next.js app holds the service-role key and gates every mutation behind `requireAdmin()` → authentic `getUser()` → mandatory AAL2/MFA → `admin_users` tier check. A user JWT can never reach an admin surface at the DB layer.

---

## Section 1 — Incomplete / Stubbed Areas

Ranked by beta impact.

### 1.1 Monitoring & analytics stubbed — keys are null (no crash telemetry, no funnel analytics)
- **Severity/likelihood:** High / Certain (the system is blind in production today).
- **Evidence:** `src/lib/analytics.js:12-13` — `SENTRY_DSN = null`, `ANALYTICS_KEY = null`. `track`/`captureError`/`identify` are no-ops that only `console.log`/`console.warn` in `__DEV__` and keep a 100-entry in-memory ring buffer (`src/lib/analytics.js:16-43`); provider-forwarding is left as `// TODO` at `analytics.js:25,32,41`. Web mirror `web/lib/analytics.ts:20` is dev-only `console.warn`.
- **Impact:** No crash reporting or product analytics reaches any provider. A beta runs blind to production errors and funnels. Enabling requires real keys + native SDK install + a dev-client rebuild.

### 1.2 No end-to-end / integration test harness anywhere
- **Severity/likelihood:** High / Certain.
- **Evidence:** Unit tests cover pure logic only (10 suites in `__tests__/`: analytics, availability, certified, contentFilter, filters, finance, geo, moderationSync, school, taxFormat). `jest.config.js` ignores `/web/`, `/ios/`, `/android/`. **Zero tests in `web/` and `admin/`.** No Detox / Maestro / Playwright / Cypress anywhere.
- **Impact:** The core money loop (post → book → accept → complete → verify → rate → tip/dispute) has **no automated end-to-end coverage**. Regressions in escrow/lifecycle logic would not be caught by CI.

### 1.3 SMS / phone (OTP) verification not built
- **Severity/likelihood:** Medium / Certain (feature absent).
- **Evidence:** No implementation of `sms`/`twilio`/`phone auth`/`otp`/`signInWithOtp`/`verifyOtp` (the only OTP-ish hits are admin TOTP MFA and the `.edu` email flow). Identity today = email confirmation + optional `.edu` student email + optional Stripe Identity.
- **Impact:** No phone-based identity or 2FA for end users. Wanted-but-unbuilt; needs an SMS provider account.

### 1.4 Rate-limiting infra gaps at the edge/IP level
- **Severity/likelihood:** Medium / Likely under load.
- **Evidence:** Public geocode proxy `web/app/api/geocode/route.ts:14-18` validates + caps input but has **no per-IP rate limit** (comment defers it to "edge middleware / Upstash before high-traffic launch"). Support intake has DB counters but **no CAPTCHA/Turnstile** — `supabase/functions/support-submit/index.ts:51` notes "(Add a CAPTCHA/Turnstile for more.)"; only per-email/IP DB counters exist (`support-submit/index.ts:60-62`).
- **Impact:** The public geocode proxy and public support form are abusable by volume/bots. Note: several **application-level** limiters do exist (assistant `assistant_rate`, `push_send_rate`, student-verify) — this gap is specifically edge/IP/bot-challenge.

### 1.5 Legal content is draft, not attorney-reviewed
- **Severity/likelihood:** High (business-blocking) / Certain.
- **Evidence:** `supabase/migrations/20260702020000_legal_docs_v2026_07_02.sql:4` — "plain-language drafts for beta, NOT attorney-reviewed final text." Line `:51` — the governing-law/arbitration clause is an explicit `[DRAFT PLACEHOLDER … this will be set with counsel.]`.
- **Impact:** Users at beta would be accepting draft terms with a placeholder arbitration clause. Legal review + business entity + insurance are outstanding non-engineering blockers.

### 1.6 Cancellation fee recorded but no money moves
- **Severity/likelihood:** Medium (product gap) / Certain.
- **Evidence:** `bookings.cancellation_fee` is display/policy only; migrations state "recorded (display/policy only)" (`supabase/migrations/20260629190000_job_start_cancel.sql:9`) and pin the column against tampering (`20260630000000_review14…:76-78,116`; `20260702030000…:65,101`). Client computes a fee `max(5, round(effectivePay*0.15))` for display only (`src/context/JobsContext.js:126-128`); no Stripe capture/charge is wired.
- **Impact:** If beta expects TaskRabbit-style enforced cancellation fees, the money side does not exist. Wiring it later touches the security-reviewed escrow functions.

### 1.7 AI assistant feature caps not yet lifted
- **Severity/likelihood:** Low / N/A (enhancement, not a defect).
- **Evidence:** `supabase/AI_ASSISTANT.md:87-94` lists unbuilt enhancements: streaming replies, a messaging tool, richer toolset (amendments/disputes/tips). The assistant is capped at 8 tool rounds + per-request write caps in `assistant/index.ts`.
- **Impact:** Assistant is functionally limited but not a beta blocker.

### 1.8 Student verification is `.edu`-email only (not proof of current enrollment)
- **Severity/likelihood:** Medium / Certain.
- **Evidence:** `supabase/STUDENT_VERIFICATION.md:41-53` — authoritative "currently-enrolled" verification (SheerID/VerifyPass) is an unbuilt upgrade path; today it is a self-serve `.edu` OTP code (a signal, not proof). Delivery requires a verified Resend domain + `STUDENT_VERIFY_FROM` (DEPLOYMENT.md §4); the default sender only delivers to the account owner.
- **Impact:** "Student verified" is a weak trust signal, and student-verification emails will not reach real users until Resend domain config is done.

### 1.9 Documentation drift — several docs describe features as missing that ARE built (or as public that are now private)
- **Severity/likelihood:** Medium / Certain (a beta risk because operators/auditors may act on wrong facts, e.g. App Store data-safety labels).
- **Evidence:**
  - Assistant cross-request rate limiting **IS implemented** (`supabase/functions/assistant/index.ts:99-119`; `migration_assistant_rate_limit.sql`: 12/min + 300/day per user), yet `AI_ASSISTANT.md:81-86` and `TESTFLIGHT.md:59-61` still say "Not yet added — cross-request rate limiting." **Stale.**
  - `chat-photos` and `completion-photos` are now **private** buckets (`20260701000000_private_chat_photos.sql:16`; `20260707010000_private_completion_photos.sql:17`), yet ROADMAP, LAUNCH_PLAN #3, and CLAUDE.md still describe them as public-read. **Stale.**
  - Favorites/saved is built (`src/screens/FavoritesScreen.js`, `src/lib/favorites.js`, `web/app/(app)/profile/saved/page.tsx`), yet ROADMAP #12 says "not started." **Stale.**
  - Pre-gig reminders are built (mobile local push, `src/lib/push.js:91-108`, wired at `JobsContext.js:400-409`), yet ROADMAP #10 lists them as "still optional." (Calendar sync genuinely not built.)
- **Impact:** An operator relying on docs may re-do finished work or mis-state the privacy posture in store listings. **Trust source over docs.**

---

## Section 2 — Deploy-Gated Risks (code-complete on `master`, "needs push/deploy")

The audit fixes are committed to `master` but marked _"needs push/deploy — did not touch live infra"_ (`AUDIT_REPORT.md:130`). ⚠️ **Risk:** if these have not been applied to the live Supabase / Vercel / Stripe environment, the production system does not have these protections. Whether they are live is **unverifiable from the repo** **[Needs Fable Review]** — each row must be verified against production.

| Ref | Severity | Area | Item | Deploy action | Evidence |
|---|---|---|---|---|---|
| **F-1** | **Medium** | Storage/validation | `certificates` bucket MIME allowlist (blocks stored SVG/HTML XSS served from `*.supabase.co`) | `supabase db push` | `20260707020000_certificates_mime_allowlist.sql`; `AUDIT_REPORT.md:64,91-94` |
| F-2 | Low | Open redirect | Stripe return-URL pinned to exact hosts (was `*.vercel.app`) | redeploy `stripe-connect-onboard`, `stripe-create-identity-session` | `AUDIT_REPORT.md:65,96-98` |
| F-3 | Low | DoS | `send-push` per-caller rate limit (30/min) | `db push` + redeploy `send-push` | `20260707030000_send_push_rate_limit.sql`; `send-push/index.ts:51` |
| F-4 | Low | Moderation | Leetspeak/homoglyph normalization added to DB/edge filter copies | `db push` + redeploy `assistant` | `20260707040000_moderation_normalize_evasions.sql`; `AUDIT_REPORT.md:67,104-106` |
| H-1 | Info | Payments | Drop dead non-idempotent `credit_tip()` (double-credit foot-gun) | `db push` | `20260707050000_drop_dead_credit_tip.sql`; `AUDIT_REPORT.md:71` |
| H-2 | Info | Prompt injection | `support-ai-draft` hardened prompt/delimiter | redeploy `support-ai-draft` | `AUDIT_REPORT.md:72` |
| H-3 | Info | CSRF | Admin PII-export `Sec-Fetch-Site` cross-site block | admin deploy | `AUDIT_REPORT.md:73` |
| — | (deploy) | Storage privacy | `chat-photos` + `completion-photos` → private + signed reads | `db push` | `20260701000000_private_chat_photos.sql`, `20260707010000_private_completion_photos.sql` |
| — | (deploy) | Moderation | Server-side DB moderation backstop (`contains_prohibited` + guards) | `db push` | `20260707000000_server_side_moderation.sql` |

> **Single highest-leverage live-verification item** (DEPLOYMENT.md §1): the **Stripe webhook** must be registered with the correct signing secret in **each mode**. If stale/missing, "payments still charge but earnings never credit and the Verified badge never appears." Test-mode registration does **not** carry to live (`DEPLOYMENT.md:44-46,77`).

**Impact of the section as a whole:** until `supabase db push` + edge/admin redeploys run against production, the highest item (F-1, Medium — stored-XSS vector on the Supabase origin), the private photo buckets, the server-side moderation backstop, redirect pinning, and the push throttle are **absent in production** even though they exist on `master`.

---

## Section 3 — Accepted Risk / Needs Human Review (survived the audit deliberately)

| Ref | Severity | Item | Rationale on record | Evidence |
|---|---|---|---|---|
| D-2 | Low (real) / High (advisory) | Mobile `undici` (high) + Expo tooling advisories | Build-time deps only, **not in the shipped RN bundle**; fix = Expo SDK major bump, deferred | `AUDIT_REPORT.md:70,115-116`; `TESTFLIGHT.md:62-65` |
| H-4 | Info | Wildcard CORS (`ACAO:*`) on Stripe/edge functions | Not exploitable under Bearer-token (non-ambient) auth; no `Allow-Credentials`. Revisit only if auth moves to cookies | `AUDIT_REPORT.md:74,83` |
| Q-1 | Low | 26 pre-existing `react-hooks/*` lint findings across 18 web files | Not security; build/typecheck/tests pass; full-green needs a multi-file effect refactor | `AUDIT_REPORT.md:75,124-125` |
| F-5 | Low | Geocode proxy rate limiter | Needs infra (edge middleware / Upstash); marked Needs Human Review | `AUDIT_REPORT.md:68,108-110` |

**Impact:** these are conscious deferrals. D-2's "High" is advisory only (not in the runtime bundle); H-4 becomes real only if the app ever adopts cookie/ambient auth; Q-1 is code-quality; F-5 recurs from §1.4.

---

## Section 4 — Fail-Open Designs (availability over strictness; degrade silently if backing infra is missing)

These are intentional and logged, but an auditor should know the control **is not enforced** if its backing table/env is absent.

### 4.1 Assistant per-user cost cap fails open
- **Severity/likelihood:** Medium / Only if the table is missing.
- **Evidence:** `supabase/functions/assistant/index.ts:116-119` logs `console.error('… cost cap NOT enforced …')` and proceeds if `assistant_rate` is unavailable.
- **Impact:** A missing/failed `assistant_rate` table silently removes the Anthropic-spend ceiling (12/min + 300/day per user) — unbounded model spend.

### 4.2 `send-push` rate limit fails open
- **Severity/likelihood:** Low / Only if the table is missing.
- **Evidence:** `send-push/index.ts:51` — the 30/min per-caller limit is skipped if `push_send_rate` is missing.
- **Impact:** Push-spam throttle disappears if the ledger table is absent.

### 4.3 Escrow-hold release on cancel/delete is best-effort
- **Severity/likelihood:** Low / Occasional.
- **Evidence:** best-effort with one retry; on persistent failure the Stripe hold auto-expires (~7 days) rather than releasing immediately (`src/context/JobsContext.js:773`; `web/lib/jobs.tsx:773`; `delete-account/index.ts:46`; `admin/lib/deleteUser.ts:29`).
- **Impact:** No money is lost, but an authorization hold can linger on a payer's card up to ~7 days.

### 4.4 Account-deletion escrow release skipped if Stripe key blank
- **Severity/likelihood:** Low / Config-dependent.
- **Evidence:** `admin/README.md:25-27`, `delete-account/index.ts:46` — release is skipped best-effort if `STRIPE_SECRET_KEY` is blank in an environment.
- **Impact:** In a mis-configured env, a deleted account's in-flight hold is not proactively released (auto-expires later).

---

## Section 5 — Lifecycle / Authorization Gaps Found in Review

Ranked by severity. The bookings state machine is strongly guarded (`guard_bookings_write`, a `SECURITY DEFINER BEFORE UPDATE` trigger; authoritative definition `supabase/migrations/20260702030000_guard_pins_and_slot_delete_policies.sql:15-116`). The gaps below sit outside that core.

### 5.1 `jobs.status` has NO server-side transition guard (client-trusted)
- **Severity/likelihood:** Medium / Exploitable trivially by any poster on their own job.
- **Evidence:** `guard_jobs_write` (`20260702030000…:122-173`) pins core terms but **never references `new.status`**. RLS `jobs_update_own` only checks ownership (`schema.sql:135`). The DB CHECK constrains the value set (`'open'|'booked'|'completed'|'cancelled'`, `schema.sql:40`) but not the transition graph. `'booked'` is a **dead enum value** — never written by any code path.
- **Impact:** A poster can set their own job to any status at will regardless of bookings (e.g. flip a live gig to `completed`). No money is tied to `jobs.status`, so blast radius is feed/UI integrity, not funds. Confirm whether a transition guard is intended.

### 5.2 No dispute adjudication or refund path — disputes are a terminal audit row
- **Severity/likelihood:** Medium (marketplace-handling-money gap) / Certain.
- **Evidence:** `disputes` is an append-only record (`booking_id, raised_by, reason, pct_paid`, `migration_location_tips_disputes.sql:10-17`), created server-side inside `stripe-capture-payment` only when `pct < 1` (`:154-165`), partial capture floored at 50% (`:44`). The admin `payments` page **reads** disputes but has **no write/resolve/refund action** (`admin/app/(console)/payments/page.tsx:26-52`; grep for update/resolve/refund/form → empty).
- **Impact:** Once recorded, a dispute is terminal from the system's perspective; any remedy is manual/out-of-band. No user-facing appeal path exists in the schema.

### 5.3 Amendment `accepted` is sticky (core-edit stays unlocked until client clears it)
- **Severity/likelihood:** Low / Depends on client discipline.
- **Evidence:** Core job fields unlock when `exists(booking with amendment_status='accepted')` (`guard_jobs_write`, `20260702030000…:145-163`). Reset to `none` is client-driven via `clearAmendment` (`src/context/JobsContext.js:1138-1141`); there is no server auto-clear after edit.
- **Impact:** If a poster proposes → earner accepts → poster edits but forgets to clear, the job's core terms stay editable longer than intended.

### 5.4 Review-response feature has no RLS UPDATE policy backing it
- **Severity/likelihood:** Low / Feature likely non-functional as written.
- **Evidence:** `reviews.response_text`/`responded_at` columns exist (`migration_competitive_features.sql`), but the `reviews` table has **no UPDATE policy at all** — SELECT `USING(true)`, hardened INSERT, no UPDATE/DELETE (`schema.sql:157`; `20260624220000_review5…:187-199`).
- **Impact:** The advertised "reviewed person may reply once" cannot be written by a client through RLS. The feature is either unwired, done via a service path not found in review, or dead. Confirm against the client review-response code path.

### 5.5 No MIME/size allowlist on `receipts` or `completion-photos`
- **Severity/likelihood:** Low (buckets are private) / Uploadable.
- **Evidence:** A MIME allowlist exists for `certificates` (`20260707020000_certificates_mime_allowlist.sql`) and the four image buckets (`migration_security_hardening_2.sql`), but **not** for `receipts` or `completion-photos`. Clients compress to JPEG, but a direct PostgREST/Storage upload could store arbitrary content types under the uid folder.
- **Impact:** Non-image content could be stored. Both buckets are now **private** (owner/party-scoped signed URLs), so the stored-XSS vector is mitigated unless a bucket is ever re-made public. The `receipts` omission may be intentional (PDF receipts) — confirm.

### 5.6 Amendment direction — CLAUDE.md contradicts the code
- **Severity/likelihood:** Documentation defect / Certain.
- **Evidence:** The **code** is **poster-proposes / earner-responds**: `proposeAmendment` reads `state.posterBookings` and notifies the earner (poster is caller); `respondToAmendment` notifies the poster (earner is caller) (`src/context/JobsContext.js:1118-1136`). The guard enforces this: poster branch may only set `pending`/`none` (cannot self-accept, `20260702030000…:67-70`); only the earner branch can reach `accepted`/`declined`. **CLAUDE.md states the opposite** ("Earner proposes … Poster responds").
- **Impact:** Anyone acting on CLAUDE.md's amendment description will be wrong about who does what. The guard/code is authoritative. Also note: the earner branch does **not** pin `amendment_status`, so an earner could technically write `pending`/`none` too — likely harmless but not clearly intended.

---

## Section 6 — Data / Privacy Risks

### 6.1 `profiles_select_all USING(true)` still present — cross-user privacy relies entirely on the column GRANT
- **Severity/likelihood:** Medium / Latent (safe today; fragile).
- **Evidence:** The permissive SELECT policy remains (`schema.sql:128`). Cross-user visibility is scoped **only** by the column lockdown: `revoke select on public.profiles from anon, authenticated` then a column allowlist grant (`20260624221000_profile_column_lockdown.sql:17-24`). Private columns (`earnings_*`, `availability`, `suspended_at`/`suspension_reason`, goals, `assistant_memory`, `school_domain`, `stripe_identity_session_id`, `monthly_*`) are served to the owner only via the `my_profile()` / `profile_availability()` RPCs.
- **Impact:** If any future migration re-broadens the column grant, or a `SELECT *` slips through PostgREST, private columns leak — because the row policy would not stop it. Recommend a live `has_column_privilege` audit for anon/authenticated on `profiles`.

### 6.2 Legacy-vs-tracked policy drift may leave the live DB more permissive than the audited state **[Needs Fable Review]**
- **Severity/likelihood:** Medium / Unverifiable from repo.
- **Evidence:** Base `schema.sql` ships permissive `USING(true)` policies (`profiles_select_all` `:128`, `slots_update_any` `:143`, `reviews_select_all` `:157`) that are later restricted/neutralized by tracked migrations (`slots_update_any` → `slots_update_poster`, `20260624220000_review5…:176`, re-asserted `20260624230000_review6…:126`; `profiles_select_all` neutralized by the column-lockdown revoke). Correctness depends on applying the tracked migrations **in order** on top of `schema.sql`.
- **Impact:** A DB set up from `schema.sql` alone, or from the legacy set only, would be more permissive than the audited state. The live `pg_policies` set was not dumped; recommend Fable diff live policies against the tracked set. Similarly, `storage.objects` policies are additive across many buckets — a live `pg_policies WHERE schemaname='storage'` diff is advised to catch any leftover public-read on a now-private bucket.

### 6.3 Private-bucket reads depend on signed URLs + sender-controlled paths
- **Severity/likelihood:** Low / Mitigated.
- **Evidence:** `chat-photos`, `completion-photos`, `receipts` are private and read via short-lived `createSignedUrl` (`src/lib/uploadImage.js:111-117`). The chat-photos read policy trusts `messages.image_url` (sender-controlled), mitigated by the `guard_message_image_path` write trigger forcing the path under the sender's own uid folder (`20260702010000_chat_photo_path_guard.sql`). Legacy rows may still hold full public URLs to now-private buckets (`objectPath` normalizes them for signing).
- **Impact:** Low residual risk. Verify no orphaned legacy public URLs are still surfaced in any UI (they would now 400 against a private bucket).

---

## Section 7 — Migration Hygiene

### 7.1 Dual migration sources with no single idempotent bootstrap
- **Severity/likelihood:** Medium / Reproducibility risk.
- **Evidence:** Two parallel sets exist — legacy `supabase/migration_*.sql` (31 files, applied by hand in the SQL Editor; some banner-marked "SUPERSEDED — DO NOT RUN") and tracked `supabase/migrations/*.sql` (48 timestamped, `supabase db push`, "source of truth"). The audited live state = `schema.sql` + all tracked migrations in timestamp order. There is **no single idempotent bootstrap** in-repo. CLAUDE.md warns `migration_fix_lifecycle.sql` must ship the hardened policies so a re-run doesn't revert later hardening — implying ordering/re-run fragility.
- **Impact:** Fresh-DB reproducibility is not guaranteed; the live DB may have drifted via manually-applied legacy migrations. No `supabase_migrations.schema_migrations` snapshot is present to confirm every tracked file was pushed in order.

### 7.2 Out-of-band columns/functions with no DDL in the repo **[Needs Fable Review]**
- **Severity/likelihood:** Medium / Reproducibility risk.
- **Evidence:** `profiles.skill_rates` (jsonb) and `profiles.stripe_identity_session_id` (text) are **granted** in the column lockdown (`20260624221000…:34`) but have **no `ALTER TABLE … ADD COLUMN` anywhere in `supabase/`** (grep empty) — added manually. `rls_auto_enable()` is revoked in `20260702000000_revoke_definer_function_execute.sql:34` but its **definition appears nowhere** in the repo.
- **Impact:** A DB rebuilt purely from tracked files would be missing these columns/functions; the source is not reproducible. Confirm they exist on the live DB (app code and `verification.js` reference them).

### 7.3 Temporary diagnostic migration trio (cosmetic clutter, net-neutral)
- **Severity/likelihood:** Info / None (self-cleaning).
- **Evidence:** `20260705041000_tmp_audit_diag.sql` and `…042000_tmp_audit_diag2.sql` create a `SECURITY DEFINER` diagnostic `admin_debug_audit()` (EXECUTE revoked from public/anon/authenticated, granted only to `service_role`); `…043000_drop_audit_diag.sql` **drops it**. Net effect after all three: the function is gone. The related `admin_user_login_history()` is intentionally retained (returns nothing because hosted Supabase does not populate `auth.audit_log_entries` here).
- **Impact:** Cosmetic only — three tracked migrations for a throwaway probe. Confirm no `admin_debug_*` function is left EXECUTE-able on the live DB.

---

## Section 8 — Operational / Live-Config Unknowns

These cannot be verified from source; they are live/dashboard state and must be confirmed against production.

### 8.1 Stripe webhook registration + live cutover (the linchpin) **[Needs Fable Review]**
- **Severity/likelihood:** High / Unverified.
- **Evidence:** DEPLOYMENT.md §1, §3 — live keys, live webhook re-registration with a new signing secret, live Connect + Identity KYC, and a real-money smoke test are all outstanding. Stripe defaults to **test** mode for beta (`admin/lib/config.ts:19` default `/test`). Test-mode webhook registration does not carry to live (`DEPLOYMENT.md:44-46,77`). The `identity.verification_session.*` events must be registered for the Verified badge to work.
- **Impact:** If the webhook is stale/missing in the target mode, payments still charge but **earnings never credit and the Verified badge never appears**. Earnings/badge crediting is unproven live until this is confirmed.

### 8.2 Anthropic API key rotation **[Needs Fable Review]**
- **Severity/likelihood:** High / Unverified.
- **Evidence:** `TESTFLIGHT.md:66` — "Rotate the Anthropic API key that was pasted in chat earlier." The key gates `assistant` + `support-ai-draft`.
- **Impact:** A previously-exposed key, if not rotated, is a live credential-exposure risk. Confirm rotation happened.

### 8.3 Supabase Auth dashboard hardening (not in repo) **[Needs Fable Review]**
- **Severity/likelihood:** Medium / Unverified. Note: **all** auth-provider config — Google/Apple OAuth client IDs, `mailer_autoconfirm`, `site_url`, and the `gohustlr://**` redirect allowlist — is Dashboard-managed and absent from `config.toml` (which carries only edge-function `verify_jwt` toggles); none of it is source-verifiable.
- **Evidence:** `config.toml` (`supabase/config.toml`) contains **only** edge-function `verify_jwt` toggles — no `[auth]` block, no `site_url`, no external-provider config, no redirect allowlist, no `enable_confirmations`. DEPLOYMENT.md §4 lists outstanding toggles: leaked-password protection (HIBP), OTP expiry, user MFA/TOTP, SSL enforcement, Security-Advisor clear, correct Site/Redirect URLs. Provider config (Google/Apple client IDs, `mailer_autoconfirm`) and the `gohustlr://**` redirect allowlist are all Dashboard-managed.
- **Impact:** All auth-provider/redirect/autoconfirm posture is invisible to source review and must be confirmed via a live Dashboard export.

### 8.4 Content Security Policy — report-only vs enforcing contradiction **[Needs Fable Review]**
- **Severity/likelihood:** Low / Contradiction to resolve.
- **Evidence:** `TESTFLIGHT.md:57` says CSP is report-only ("promote … to enforcing after console shows no violations"), but `web/next.config.ts:4` now says "ENFORCING" with dev-only `'unsafe-eval'`.
- **Impact:** Verify the live deploy's actual CSP posture and whether `'unsafe-inline'`/`'unsafe-eval'` remain in production.

### 8.5 Other operational config (Resend, DNS, Connect branding) **[Needs Fable Review]**
- **Severity/likelihood:** Medium / Unverified.
- **Evidence:** DEPLOYMENT.md §4 — Resend verified domain + `STUDENT_VERIFY_FROM` (else student emails only reach the owner); `gohustlr.com` DNS → Vercel (else mobile Stripe-return pages land on a not-yet-live domain); Stripe Connect branding.
- **Impact:** Student verification and Stripe-return landing pages will not function correctly for real users until these are set.

---

## Top 10 Things for Fable to Review First (prioritized)

1. **Have the audit/hardening migrations + edge/admin redeploys actually been applied to LIVE Supabase / Vercel / Stripe?** Every §2 item is code-complete on `master` but marked "needs push/deploy." This single unknown separates "code-complete" from "protected in production," and includes the only Medium finding (F-1 cert-MIME stored-XSS) plus the private photo buckets and server-side moderation. (`AUDIT_REPORT.md:130`)
2. **Stripe live cutover + webhook registration** (§8.1). Confirm the webhook is registered in the target mode with a matching signing secret and that Connect + Identity are enabled live. Until then, earnings crediting and the Verified badge are unproven. (`DEPLOYMENT.md:44-46,77`)
3. **Legal review + business entity/insurance** (§1.5). Draft ToS with a `[DRAFT PLACEHOLDER]` arbitration clause is the biggest non-engineering blocker. (`20260702020000_legal_docs_v2026_07_02.sql:4,51`)
4. **Was the previously-exposed Anthropic API key rotated?** (§8.2, `TESTFLIGHT.md:66`)
5. **Monitoring is stubbed** (§1.1). No crash/analytics telemetry until Sentry DSN + PostHog key + native SDKs + a dev-client rebuild — a blind beta. (`src/lib/analytics.js:12-13`)
6. **`jobs.status` has no transition guard** (§5.1) and **disputes have no adjudication/refund path** (§5.2). Confirm both are acceptable for a money-handling beta. (`guard_jobs_write` never touches `new.status`; `admin/app/(console)/payments/page.tsx:26-52`)
7. **Live policy/grant drift** (§6.1, §6.2). Diff live `pg_policies` and `has_column_privilege` for anon/authenticated on `profiles` (and `storage.objects`) against the tracked set — cross-user privacy relies entirely on the column grant, not the row policy.
8. **Fresh-DB reproducibility + out-of-band DDL** (§7.1, §7.2). `skill_rates`, `stripe_identity_session_id`, and `rls_auto_enable()` have no DDL in the repo; there is no single idempotent bootstrap. Confirm the live DB matches the tracked set.
9. **Documentation drift** (§1.9). CLAUDE.md/ROADMAP/LAUNCH_PLAN contradict the code on assistant rate limiting, private photo buckets, favorites, and reminders — and CLAUDE.md has the **amendment direction backwards** (§5.6). Ensure App Store privacy labels reflect the now-private buckets. Trust source over docs.
10. **Fail-open cost cap + no E2E coverage** (§4.1, §1.2). A missing `assistant_rate` table silently removes the Anthropic-spend ceiling, and the core money loop has zero automated end-to-end tests. (`assistant/index.ts:116-119`; `jest.config.js`)

---

## Open Questions / For Fable to Verify

1. Are the §2 audit/hardening migrations + edge/admin redeploys applied to **live** infra? (largest unknown; unverifiable from repo)
2. Is the Stripe webhook registered in the target mode with a matching signing secret, and are Connect + Identity enabled live?
3. Which docs are authoritative where they contradict code? (assistant rate limiting "not added"; photo buckets "public"; amendment direction) — recommend trusting source.
4. Live CSP posture: `next.config.ts:4` says ENFORCING; `TESTFLIGHT.md:57` says report-only — which is live, and does prod still allow `'unsafe-inline'`/dev-only `'unsafe-eval'`?
5. Was the previously-exposed Anthropic API key rotated? (`TESTFLIGHT.md:66`)
6. Supabase Auth dashboard hardening (HIBP, OTP expiry, SSL, user MFA, Site/Redirect URLs) — dashboard state, needs live confirmation.
7. Fresh-DB reproducibility: is there a validated path to reproduce the exact audited state (`schema.sql` + tracked migrations in order), or has the live DB drifted via manual legacy applies? No `supabase_migrations` snapshot in repo.
8. Do `profiles.skill_rates`, `profiles.stripe_identity_session_id`, and `rls_auto_enable()` exist on the live DB despite having no DDL in the repo?
9. Does the review-response feature (`reviews.response_text`) have any writable path, given there is no RLS UPDATE policy on `reviews`? (§5.4)
10. Is the missing MIME allowlist on `receipts`/`completion-photos` intentional (e.g. PDF receipts)? (§5.5)
11. Does the fee constant agree with the backend? Backend hardcodes 10% (`stripe-create-payment-intent:100`, `stripe-capture-payment:129`); the web UI uses `SERVICE_FEE_PCT` from `@/lib/config` for display — not verified equal.
12. Is `web/`/`admin/` having zero automated tests acceptable for beta, or a gap to weight?
13. Confirm no `admin_debug_*` diagnostic function remains EXECUTE-able on the live DB after the tmp_audit_diag drop (§7.3).
14. `stripe-webhook` has **no event-ID dedup ledger** — safe today only because each handler is naturally idempotent (and money handlers rely on `credit_earnings`/`claim_and_credit_tip`). Stripe can redeliver events; confirm this is acceptable and that no future non-idempotent handler double-applies (`supabase/functions/stripe-webhook/index.ts`; backend dossier Q3).
15. `support-submit` accepts **unauthenticated** posts (`verify_jwt=false`; JWT optional, only to attach `user_id` — `supabase/functions/support-submit/index.ts:37-44`), so anon can create `support_tickets` rows via the service-role edge function (not via PostgREST). By design (public contact form), gated only by per-email/IP/global rate limits and no CAPTCHA (`:51`). Confirm the rate limits are sufficient without a bot challenge.

---

**Sibling handoff docs** (do not duplicate): `BASELINE_STATUS.md` (lint/typecheck/test/build/audit/secret-scan results), `CURRENT_COMMANDS.md` (verified command list), `FABLE_HANDOFF.md`, `ROLE_PERMISSION_MATRIX.md`, `PRODUCT_FLOW_MAP.md`, `LIFECYCLE_STATE_MACHINES.md`, `BETA_QA_PLAN.md`.
