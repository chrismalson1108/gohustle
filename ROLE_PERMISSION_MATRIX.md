# GoHustlr — Role × Object Permission Matrix

*Handoff for the Fable beta-readiness audit. Verified 2026-07-07 at commit a70c9b5 (master).*

This document maps **who can do what to each object**, backed by the enforcing RLS policy, guard trigger, column grant, or edge function with `path:line` citations. It is self-contained — every fact needed to reason about authorization is inlined here.

**Method note.** RLS is the primary control. `SECURITY DEFINER` guard-trigger functions (`guard_*`) further constrain *which columns/transitions* a party may write even when an RLS `UPDATE` policy passes. The `service_role` key (edge functions + the admin console's `getServiceClient()`) bypasses all RLS and column grants; the guard triggers explicitly early-return for `auth.role() = 'service_role'`. Where the base `supabase/schema.sql` and the tracked `supabase/migrations/*.sql` disagree, **the tracked migration wins** (per CLAUDE.md and the file banners); each cell cites the currently-authoritative definition.

**Cell vocabulary:** `Yes` · `No` · `Own-only` (row where `auth.uid()` = the owner column) · `Party-only` (either party of a booking) · `Server-only(edge)` (writable only via a service-role edge function) · `Tier-gated` (admin/support tier check in the `admin/` app) · `Column-scoped` (readable but only an allowlisted subset of columns).

---

## 1. Roles as they actually exist

There is **no DB-level distinction between "student worker" and "customer/client."** Both are the same authenticated Postgres role. `profiles.role` (enum `earner`/`poster`/`both`, `migration_fix_lifecycle.sql:44-46`) is a **display/preference field and is never referenced in any RLS policy.** Rights are **per-action, scoped by row relationship** — `earner_id` on a booking vs `poster_id` on the job. The same user is an "earner" on gigs they book and a "poster" on gigs they own.

| Role | What it is | Where enforced |
|---|---|---|
| **anon** | Unauthenticated Postgres role (public web/legal pages, pre-login). | RLS policies with `USING(true)` + column grants. |
| **student worker** = **earner capacity** | A signed-in user acting on a booking where `auth.uid() = earner_id`. Not a separate account type. | Row-relationship checks in booking/message/dispute policies. |
| **customer/client** = **poster capacity** | The same signed-in user acting on a job where `auth.uid() = poster_id`. Not a separate account type. | Row-relationship checks in job/booking policies. |
| **admin (tier `admin`)** | Row in `public.admin_users` with `role='admin'`. Full console mutations. | `admin/` Next.js runtime only — `requireAdmin('admin')` (`admin/lib/guard.ts:42-71`), acting through `service_role`. |
| **internal / support (tier `support`)** | Row in `admin_users` with `role='support'`. Read-only console access **plus** support-ticket reply/status/AI-draft. | `requireAdmin('support')` (default `minRole`, `admin/lib/guard.ts:42`); page wrapper `requireAdminPage` at `guard.ts:74`. |
| **service_role** | Backend key used by the 23 edge functions (on disk under `supabase/functions/<name>/index.ts`; AUDIT_REPORT.md/CLAUDE.md say 24 — off by one vs. disk) and the admin console's `getServiceClient()` (`admin/lib/serviceClient.ts:10-19`). | Bypasses all RLS; guard triggers early-return for it. |

**Admin authorization is app-layer, not RLS.** There are **no admin RLS policies anywhere in the DB.** `admin_users`, `admin_audit_log`, `admin_user_notes`, `support_tickets`, `support_ticket_messages`, `student_email_verifications`, `assistant_rate`, `push_send_rate`, and `tip_ledger` all have **RLS enabled with NO policies and all grants revoked from anon/authenticated** — they are invisible and inert to the user apps. Admin power exists *solely* because the `admin/` app's server runtime holds the service-role key. A user JWT can never reach an admin surface at the DB layer.

**Admin authz chain** (`requireAdmin`, `admin/lib/guard.ts:42-71`): `supa.auth.getUser()` (hits the auth server, proving the token authentic) → **AAL2/MFA is mandatory** (the `aal` claim is decoded from the JWT, `aalFromToken`, `guard.ts:26-35`) → `admin_users` membership lookup via the service client → tier check. `admin/proxy.ts` performs **UX redirects only** and is explicitly *not* an enforcement point (`proxy.ts:5-9`).

---

## 2. users / profiles (`public.profiles`)

RLS enabled `schema.sql:118`. The row-level `SELECT` policy `profiles_select_all USING(true)` is still present (`schema.sql:128`), so **cross-user visibility is scoped by column GRANTs, not by the row policy.**

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No (trigger-created on signup) | Column-scoped Yes | No | No |
| earner/poster (self) | trigger-created | **Own: full row via `my_profile()` RPC** | **Own-only, column-restricted by guard** | Server-only(edge) — `delete-account` |
| earner/poster (other user) | — | Column-scoped Yes (public columns) | No | No |
| admin | No | Yes (service) | **Tier-gated** (suspend/verify/student/reset/email) | Tier-gated (cascade) |
| support | — | Yes (read-only) | No | No |

**Column lockdown (the key control).** `20260624221000_profile_column_lockdown.sql:17` runs `revoke select on public.profiles from anon, authenticated;` then re-grants SELECT on a **column allowlist** (~43 public columns: `id, name, avatar_initial, role, rating, review_count, verified, member_since, xp, streak_days, weekly_jobs_done, created_at, updated_at, username, bio, skills, radius_miles, city, onboarding_done, poster_rating, poster_review_count, avatar_url, terms_accepted_at, terms_version, skill_rates, referral_code, id_verification_status, id_verification_requested_at, school, major, degree_type, class_standing, grad_year, student_status, student_verified, student_verified_at, student_verify_method, work_status`, lines 18-24) to anon/authenticated.

**Columns revoked from clients** (owner reads them only via the `my_profile()` SECURITY DEFINER RPC): `earnings_today/week/total` (`20260624193000_review2_db_fixes.sql:120`); `availability` (`20260630000000_review14_post_feature_hardening.sql:222`, served instead by the `profile_availability(uid)` RPC that enforces `show_availability OR self`, lines 200-219); `suspended_at`, `suspension_reason` (never granted — admin-internal, `20260705010000_admin_console.sql:60-61`); `weekly_earning_goal`, `weekly_jobs_goal`, `assistant_memory`, `school_domain`, `work_status_note`, `stripe_identity_session_id`, `monthly_*` (never in the allowlist).

**How clients read profiles:** own full row via `supabase.rpc('my_profile')` (mobile `src/context/UserContext.js:195`; web `web/lib/user.tsx:283`); other users via a direct `from('profiles').select(<public columns>)` (mobile `src/screens/PublicProfileScreen.js:85-86`). A query selecting a revoked column errors, so clients request only granted columns.

**UPDATE policy:** `profiles_update_own FOR UPDATE USING (auth.uid() = id)` — owner-only (`migration_fix_lifecycle.sql:100-105`; re-asserted `20260624230000_review6_db_fixes.sql:174-176`). Cross-user profile writes are impossible.

**Column-write guard** `guard_profiles_write` (current form `20260705030000_admin_console_hardening.sql:29-57`): the owner branch pins (reverts to `old`) `verified, id_verification_status, rating, review_count, poster_rating, poster_review_count, earnings_today/week/total, suspended_at, suspension_reason`. Any non-owner direct write returns `old` (fully reverted). A transaction-local `current_setting('app.recompute')='on'` flag lets the `recompute_user_rating` RPC bypass. Student-verified fields (`student_verified/at/verify_method`) are additionally pinned for non-service-role by `guard_student_verified`. `bio`/`work_status_note` writes are rejected on prohibited terms (`trg_guard_content_profiles`, `20260707000000_server_side_moderation.sql`). Only `show_availability` has a narrow `GRANT UPDATE` (`20260629180000_show_availability.sql:22`).

**INSERT:** `profiles_insert_own WITH CHECK (auth.uid() = id)` (`schema.sql:129`), but rows are in practice created by the `handle_new_user` SECURITY DEFINER trigger on `auth.users` insert (`schema.sql:169-186`).

**Self-delete:** `delete-account` edge fn (`supabase/functions/delete-account/index.ts`) authenticates the caller, releases in-flight escrow, purges storage, then cascades `admin.auth.admin.deleteUser(user.id)` — strictly scoped to `user.id`.

**Admin mutations** (all `requireAdmin('admin')`, `admin/app/(console)/users/[id]/actions.ts`): suspend (GoTrue ban ~100y + `suspended_at` + session revoke), unsuspend, force-signout, set_verified, grant/revoke student, reset username/bio, password reset, confirm/change email, notify, add note, delete. `assertActionableTarget` (lines 24-36) blocks acting on self or on another admin.

---

## 3. jobs (`public.jobs`)

RLS enabled `schema.sql:119`.

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No | **Yes** (all jobs) | No | No |
| poster (owner) | **Yes** (self as poster) | Yes | **Own-only, guard-pinned while booked** | **Own-only, blocked while a booking is active** |
| earner / other user | — | Yes | No | No |
| admin | — | Yes | **Tier-gated** (takedown → `status='cancelled'` / restore) | via user cascade |
| support | — | Yes | No | No |

- `jobs_select_all USING(true)` (`schema.sql:133`) — world-readable, including anon.
- `jobs_insert_auth WITH CHECK (auth.uid() = poster_id)` (`:134`); `jobs_update_own USING (auth.uid() = poster_id)` (`:135`); `jobs_delete_own USING (auth.uid() = poster_id)` (`:136`).
- **`guard_jobs_write`** (current `20260702030000_guard_pins_and_slot_delete_policies.sql:122-172`; the `guard_bookings_write` def in the same file is a *separate* function at `:14-119`): if any booking is `confirmed/completed/verified`, pins `pay, pay_type, estimated_hours` unconditionally; pins `title, category, location, lat, lng, description` and blocks *removing* `hazards` unless an accepted amendment exists (`amendment_status='accepted'`). No live booking → the poster edits freely.
- **`guard_jobs_delete`** (`20260625020000_review10_db_fixes.sql`): blocks a poster hard-deleting a job with a `confirmed/completed/verified` booking; bypasses for service_role and for the GoTrue account-deletion cascade (no-JWT connection). The app "delete" is actually a soft-delete `status='cancelled'` (an UPDATE), so this DELETE guard is a backstop against a raw hard-delete.
- **Content guard:** `title`/`description` rejected on prohibited terms (`trg_guard_content_jobs`, `20260707000000`).
- **Admin takedown** (`admin/app/(console)/jobs/actions.ts:15-67`, `requireAdmin('admin')`): sets status, purges `job-photos` under the poster's folder only (path-traversal guarded), audited (`job.takedown` / `job.restore`).

⚠️ **Risk — `jobs.status` has NO server-side transition guard.** It is client-trusted (owner UPDATE policy only, no guard trigger validates the value), and `'booked'` is a **dead enum value** in the CHECK (`schema.sql:40`) — the lifecycle runs through `bookings.status`, and `jobs.status='booked'` is never set. Contrast this with `bookings.status`, which is heavily guarded (§5).

---

## 4. job_slots & job_requirements (sub-rows of a gig)

RLS enabled `schema.sql:120-121`.

| Role | job_slots C / R / U / D | job_requirements C / R / U / D |
|---|---|---|
| anon | No / Yes / No / No | No / Yes / No / No |
| poster (of parent job) | Own-job / Yes / **Own-job** / Own-job | Own-job / Yes / — (no UPDATE policy) / Own-job |
| other user | No / Yes / No / No | No / Yes / No / No |

- ⚠️ **Slots:** `slots_select_all USING(true)` (`schema.sql:139`), `slots_insert_poster` (owner-of-job, `:140`), `slots_update_poster` (created `20260624220000_review5_db_fixes.sql:176`, re-asserted `20260624230000_review6_db_fixes.sql:123`), and `slots_delete_poster` (`20260702030000_guard_pins_and_slot_delete_policies.sql:177`). The original permissive `slots_update_any USING(true)` (`schema.sql:143`) was **replaced** by the owner-scoped `slots_update_poster`. **Risk:** historically world-writable — verify the permissive `slots_update_any` is dropped on the **live** DB **[Needs Fable Review]** (see Open Questions #2).
- **Requirements:** `reqs_select_all USING(true)` (`schema.sql:146`), `reqs_insert_poster` (`:147`), `reqs_delete_poster` (`20260702030000_guard_pins_and_slot_delete_policies.sql:180-181`). **No UPDATE policy** → requirements are immutable in place; the edit flow is delete-then-reinsert.
- `job_slots.taken` is maintained authoritatively by the `sync_slot_taken` trigger (`20260624220000_review5_db_fixes.sql`), not by clients.

---

## 5. bookings (= applications / acceptances) (`public.bookings`)

RLS enabled `schema.sql:122`. This is the most heavily guarded object. `UNIQUE(job_id, earner_id)`; a partial unique index `bookings_one_active_per_slot` prevents two active bookings on one slot.

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No | No | No | No |
| earner | **Yes** (self as earner) | **Party-only** | **Party-only, side-scoped by guard** | No (no DELETE policy) |
| poster (of the job) | No (self-booking blocked) | **Party-only** | **Party-only, side-scoped by guard** | No (no DELETE policy) |
| admin / support | — | Yes (read; `bookings/[id]` page) | via service (rare) | via user cascade |

- `bookings_insert_own WITH CHECK (auth.uid() = earner_id)` (`schema.sql:153`) — **only the earner creates a booking.**
- `bookings_select_parties` / `bookings_update_parties`: `auth.uid()=earner_id OR EXISTS(job WHERE poster_id=auth.uid())` (`migration_fix_lifecycle.sql:69-83`).
- **No DELETE policy on bookings** → neither party can delete a booking row; it is only "cancelled" via status. Rows vanish only through the account-delete cascade.
- **`guard_bookings_write`** (current `20260702030000_guard_pins_and_slot_delete_policies.sql:15-116`), the transition/column arbiter:
  - **INSERT:** forces `status='pending'`, `earner_done=false`, `poster_done=false`, rating cleared; **raises "You cannot book your own gig" if `earner_id = job.poster_id`**; validates the slot belongs to the job.
  - **Poster branch:** pins `earner_id, job_id, slot_id, earner_done, completion_photos, before_photos, started_at, application_note, counter_offer, tip_amount, poster_rating, poster_review` (a poster cannot forge the rating the earner gave them). Allowed transitions: `pending→declined|cancelled`, `confirmed→cancelled`, `confirmed→completed` (only if both done-flags set), `completed→verified` **only if a `payments` row with `status='captured'` exists**. The poster **cannot set `confirmed` directly** — the escrow-attested confirm is edge-only.
  - **Earner branch:** pins `job_id, earner_id, poster_done, earner_rating, review_text, payment_method, counter_offer, amendment_note, tip_amount, application_note, cancellation_fee`; allows the single `started_at` null→non-null while confirmed; allows `confirmed→completed` (if poster already done) and `→cancelled` from `pending/confirmed`; cannot regress a `verified` booking.
- **`advance_mutual_completion`** trigger auto-advances `confirmed→completed` when both done-flags are set (`20260624210000_review4_db_fixes.sql`).
- **`guard_started_booking_cancel`** blocks cancelling once `started_at` is set (`20260629190000_...`).
- **The confirm path is server-only.** The `accept-booking` edge fn (`supabase/functions/accept-booking/index.ts:39,56-73`) authenticates, checks `booking.job.poster_id === user.id` (IDOR guard), re-fetches the Stripe PaymentIntent, and requires `status === 'requires_capture'` before flipping to `confirmed` via service role. The guard blocks any client-set confirm.
- `application_note` is capped ≤500 chars (CHECK) and content-moderated (`trg_guard_content_bookings`).

### 5a. Booking status transitions — who can drive which

| Transition | Driven by | Enforcement |
|---|---|---|
| (none) → `pending` | earner (on book) | INSERT forces `pending` (guard) |
| `pending` → `confirmed` | **poster, via `accept-booking` edge fn only** | Guard blocks client-set `confirmed`; edge fn requires PI `requires_capture` |
| `pending`/`confirmed` → `declined` \| `cancelled` | poster (decline/cancel) or earner (cancel) | Guard branch rules; blocked once `started_at` set |
| `confirmed` → `completed` | **either party, but only once BOTH `earner_done` and `poster_done` are true** | `advance_mutual_completion` + guard |
| `completed` → `verified` | poster, only if a captured `payments` row exists | Guard requires `payments.status='captured'` |

Neither party alone can advance to `completed`. `jobs.status` is **not** part of this machine and is unguarded (§3).

---

## 6. payments / escrow / payouts / tips / invoices

Tables: `payments`, `stripe_customers`, `stripe_accounts`, `tip_ledger`. ⚠️ **Risk:** Stripe is in **TEST mode** for beta (`admin/lib/config.ts:19` default `/test`) — this is the source default; the **live key mode + webhook-secret wiring are environment/dashboard state not verifiable from source [Needs Fable Review]** (no real money moves under test keys).

| Object / Role | anon | earner | poster | admin | support |
|---|---|---|---|---|---|
| **payments** Create | No | **Server-only(edge)** | Server-only(edge) | Server (rare) | — |
| **payments** Read | No | Own booking (SELECT) | Own job's booking (SELECT) | Yes | Yes (payments page) |
| **payments** Update/Delete | No | **No** | **No** | via cascade | — |
| **stripe_customers** | No | — | Own-only Read | Yes | Yes |
| **stripe_accounts** | No | Own-only Read | — | Yes | Yes |
| **tip_ledger** | No | **No** (no policy) | No | Yes | Yes |

- `payments_earner_select` / `payments_poster_select` are **SELECT-only** party policies (`migration_stripe.sql:52-73`). There is **no INSERT/UPDATE/DELETE policy on `payments`** → all writes are service_role (edge functions) only.
- `stripe_accounts_select_own` / `stripe_customers_select_own` are **SELECT-only** (`20260624230000_review6_db_fixes.sql:180-186`) — the earlier `FOR ALL` policies (`migration_stripe.sql:43-49`) were replaced so clients can't write their own Stripe linkage.
- `tip_ledger` has RLS on with **no policy** → clients can't touch it; only the service-role edge writes (idempotency ledger).
- **Money-credit RPCs are service-role-only:** `credit_earnings(payment_id)` (revoked from public/anon/authenticated `20260624220000_review5_db_fixes.sql`; re-granted to service_role `20260702040000_...:22`) — atomic exactly-once earner credit; `claim_and_credit_tip(pi, booking, earner, cents)` (revoked `20260624240000_review7_db_fixes.sql`; granted service_role `20260702040000_...:13`) — recoverable exactly-once tip credit via `tip_ledger`. The old non-idempotent `credit_tip()` was **dropped** (`20260707050000_drop_dead_credit_tip.sql`).
- **Edge functions with IDOR guards:** `stripe-capture-payment` (poster-only; supports partial capture ≥50% for disputes, then calls `credit_earnings`), `stripe-tip` (poster-only; off-session 50¢–$1000, no platform fee, then `claim_and_credit_tip`), `stripe-cancel-payment` (either party). `stripe-create-payment-intent` writes a manual-capture PI with a 10% fee (`feeCents = round(amountCents*0.10)`, `:100-101`), status `authorized`. `stripe-webhook` verifies the Stripe signature (`constructEventAsync`) and on PI capture calls `credit_earnings`; on `identity.verification_session.verified` sets `profiles.verified=true`.
- Earnings dashboard columns (`earnings_*`) are revoked from clients and only writable by the service-role capture path (§2).
- **There is no separate `invoices` table.** The year-end tax summary is computed client-side in the Tax Center from Stripe earnings + logged cash income − expenses (`src/lib/expenses.js`); the `payments` row is the authoritative escrow record.

---

## 7. disputes (`public.disputes`)

RLS enabled `migration_location_tips_disputes.sql:18`. Cols include `booking_id, raised_by, reason, pct_paid (CHECK 0-100)`.

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No | No | No | No |
| earner/poster (party) | **Party-only** (`raised_by=self`) | **Party-only** | No | No |
| admin / support | — | Yes (dashboard counts, bookings view) | — | via cascade |

`disputes_insert_party` requires `auth.uid()=raised_by` AND the caller is a party (`:31-38`); `disputes_select_parties` similarly (`:22-29`). **No UPDATE/DELETE policy.** Created in practice from `CompletionModal`'s partial-capture flow. There is **no user-facing appeal path** in the schema.

---

## 8. reports / moderation + blocks (`public.reports`, `public.blocks`)

RLS enabled `migration_trial_p0.sql`.

| Object / Role | anon | reporter / blocker | admin | support |
|---|---|---|---|---|
| **reports** Create | No | **Own** (`reporter_id=self`) | via service | — |
| **reports** Read | No | **Own** (Column-scoped) | Yes | Yes (moderation page) |
| **reports** Update | No | **No** | **Tier-gated** (resolve/reopen) | No |
| **reports** Delete | No | No | via cascade | — |
| **blocks** C / R / U / D | No | **Own-only** / Own-only / — (no update) / Own-only | — | — |

- `reports_insert_own WITH CHECK (auth.uid()=reporter_id)`; `reports_select_own USING (auth.uid()=reporter_id)`. **No client UPDATE/DELETE policy.**
- **Internal columns hidden from the reporter:** `resolved_by`, `resolution` are **excluded from the column grant** — `20260705060000_v2_hardening.sql:22-27` re-grants SELECT only on `(id, reporter_id, reported_user_id, job_id, booking_id, reason, details, created_at, resolved_at)`. A reporter can see *that* their report resolved, but not the moderator note or staff id.
- Admin resolve/reopen writes those internal columns via service role (`admin/app/(console)/moderation/actions.ts:12-60`, `requireAdmin('admin')`, audited `report.resolve` / `report.reopen`). App-layer reporting is INSERT-only (`src/lib/moderation.js` / `web/lib/moderation.ts`).
- `blocks`: own-only select/insert/delete (`migration_trial_p0.sql`). The client-side filter uses `blockedIds` (JobsContext).
- **Content moderation is server-enforced.** `contains_prohibited()` + `guard_prohibited_content()` triggers run on `jobs.title/description`, `messages.text`, `reviews.text`, `profiles.bio/work_status_note`, `bookings.application_note` (`20260707000000_server_side_moderation.sql`, evasion-normalized in `20260707040000`), a DB backstop to the client filter `shared/contentFilter.js`.

---

## 9. reviews (`public.reviews`)

RLS enabled `schema.sql:123`. Cols include `job_id, reviewer_id, reviewed_user_id, rating(1-5), text, role('earner'|'poster'), response_text, responded_at`.

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No | **Yes** | No | No |
| earner/poster | **Own, verified-booking-bound, role-bound** | Yes | No policy* | No |
| admin / support | — | Yes | via service | via cascade |

- `reviews_select_all USING(true)` (`schema.sql:157`) — world-readable.
- `reviews_insert_auth` (current `20260624220000_review5_db_fixes.sql`): requires `auth.uid()=reviewer_id` **AND** a `verified` booking **on the same `job_id`** where the reviewer/reviewed pair matches the direction, **and `role` matches** (`poster→earner ⇒ role='earner'`; `earner→poster ⇒ role='poster'`). This closed the earlier "one verified booking authorizes unlimited/arbitrary-job reviews" flaw (`20260624210000_review4_db_fixes.sql`).
- **Unique index** `reviews_one_per_party_per_job (job_id, reviewer_id, reviewed_user_id, role)` (`20260624203000_review3_db_fixes.sql`) — one review per direction per job.
- **No UPDATE/DELETE policy** → once inserted, a review can't be edited or deleted by clients. *The `response_text`/`responded_at` columns exist for a "reviewed person may reply once" feature, but there is **no RLS UPDATE policy backing it** — so it is not writable by clients through RLS as written.* (Flagged — see Open Questions.)
- Content-moderated (`trg_guard_content_reviews`). `reviews.job_id` FK is `ON DELETE SET NULL` so a poster deleting their account doesn't wipe earners' earned reviews (`20260624193000_review2_db_fixes.sql:29-33`).

---

## 10. messages (DMs) (`public.messages`)

RLS enabled `migration_fix_lifecycle.sql`. Cols `booking_id, sender_id, text, image_url, created_at`.

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No | No | No | No |
| party to booking | **Party-only, `sender_id`=self** | **Party-only** | No | No (cascade only) |
| non-party authenticated | No | No | No | No |
| admin / support | — | Yes (bookings/support view, signed image URLs) | — | via cascade |

- `messages_read`: both parties of the booking (`migration_fix_lifecycle.sql:...`).
- `messages_insert WITH CHECK (sender_id = auth.uid() AND <party to booking>)` (`:150-159`; re-asserted `20260624230000_review6_db_fixes.sql`) — the sender must be a party, not just any authenticated user who learns a `booking_id`.
- **No UPDATE/DELETE policy** → messages are immutable and undeletable by clients.
- Content-moderated (`trg_guard_content_messages`). `image_url` is forced under the sender's own storage folder by `guard_message_image_path` (`20260702010000_chat_photo_path_guard.sql`).

---

## 11. notifications / alerts (`public.notifications`)

RLS enabled `migration_competitive_features.sql`. Cols `type, title, body, job_id, read, archived, data jsonb`.

| Role | Create | Read | Update | Delete |
|---|---|---|---|---|
| anon | No | No | No | No |
| owner | **No client INSERT policy** | **Own-only** | **Own-only** (mark read/archive) | No |
| system (definer trigger) | Yes (`notify_saved_searches`) | — | — | — |
| admin | Yes (service; `notifyUser`) | — | — | via cascade |

`notifications_owner_select` / `notifications_owner_update`. **No INSERT policy** → users can't insert notifications; rows are written by the `notify_saved_searches` SECURITY DEFINER trigger (`AFTER INSERT on jobs`), by booking/message events, by admin `notifyUser` (`admin/app/(console)/users/[id]/actions.ts`, service), and by the `send-push` edge fn (rate-limited via `push_send_rate`, `20260707030000_send_push_rate_limit.sql`).

---

## 12. legal docs / acceptances (`legal_documents`, `legal_acceptances`)

RLS enabled `migration_legal_db.sql:14,26`.

| Object / Role | anon | authenticated | admin |
|---|---|---|---|
| **legal_documents** Read | **Yes** (public read) | Yes | Yes |
| **legal_documents** C/U/D | No | No | SQL editor / migration only |
| **legal_acceptances** Create | No | **Own** (`user_id=self`) | — |
| **legal_acceptances** Read | No | **Own-only** | — |
| **legal_acceptances** U/D | No | No | — |

`legal_docs_public_read USING(true)` (`:16`); publishing new terms = inserting a new `(slug,version)` row via SQL editor / migration (`20260702020000_legal_docs_v2026_07_02.sql`), no client policy. `legal_acc_insert_own` / `legal_acc_select_own` (`:28-30`). Unique `(user_id, slug, version)` (`20260706000000_legal_acceptances_unique.sql`). Append-only audit trail — no UPDATE/DELETE.

---

## 13. expenses / income (Tax Center) — NO approval/rejection exists

RLS enabled `migration_expenses.sql:18` / `migration_trial_p0.sql`.

| Object / Role | anon | owner | admin |
|---|---|---|---|
| **expenses** C / R / U / D | No | **Own-only** (all four) | — (no admin page) |
| **income_entries** C / R / U / D | No | **Own-only** (all four) | — |

**Expenses are a private personal tax tracker. There is NO approval, rejection, reviewer, or moderator flow — because none exists.** The `expenses` table is owner-only RLS on all four verbs (`expenses_select/insert/update/delete_own`, `migration_expenses.sql:21-27`); there is **no `status`/`approved`/`reviewed`/`resolved` column**, and **no admin expenses page** in the console. `income_entries` (cash/off-platform income) is likewise owner-only on all four verbs (`income_select/insert/update/delete_own`, `migration_trial_p0.sql`). Any audit question phrased as "who approves/rejects an expense" has the answer: **nobody — the concept does not exist in this system.**

---

## 14. receipts / uploads — the 6 storage buckets

All buckets live under `storage.buckets`; write scope is enforced via `(storage.foldername(name))[1] = auth.uid()::text` (files live under `<userId>/…`). A MIME allowlist (raster image types only — deliberately **excludes `image/svg+xml` and `text/html`**) + 10 MB cap is applied by `migration_security_hardening_2.sql`. **`receipts`, `chat-photos`, and `completion-photos` are now PRIVATE** (owner/party-scoped, signed-URL reads) — later migrations override the original public creation. `avatars`, `job-photos`, and `certificates` are public.

| Bucket | Public? | Read | Insert | Update | Delete | Migration |
|---|---|---|---|---|---|---|
| `avatars` | **Public** | anyone | own folder | own folder | own folder | `migration_profile_photos.sql:12-30` |
| `job-photos` | **Public** | anyone | own folder | — | own folder | `migration_job_chat_photos.sql:13-27` |
| `certificates` | **Public** | anyone | own folder | own folder | own folder | `20260629160000_certifications.sql:30-48`; `image_url` CHECK `^https://`; MIME allowlist `20260707020000` |
| `chat-photos` | **PRIVATE** | **party-of-booking or owner** (signed URLs) | own folder | — | own folder | `20260701000000_private_chat_photos.sql`; path guard `20260702010000` |
| `completion-photos` | **PRIVATE** | **party-of-booking or owner** (signed URLs) | own folder | — | own folder | `20260707010000_private_completion_photos.sql` (also holds `before_photos`, `20260629150000`) |
| `receipts` | **PRIVATE** | **owner only** (signed URLs) | own folder | — | own folder | created public `migration_expenses.sql`; made private `migration_receipts_private.sql` |

- `before-photos` is **not a separate bucket** — before photos share the `completion-photos` bucket.
- The chat-photos SELECT policy joins through `messages.image_url` (sender-controlled) — mitigated by the `guard_message_image_path` write trigger.
- **`receipts` appears to have no explicit MIME allowlist** (unlike the other five) — possibly intentional (PDF receipts); flagged in Open Questions.
- Admin takedown deletes `job-photos` under the poster's folder only, `..`-guarded (`admin/app/(console)/jobs/actions.ts:33-52`).

---

## 15. Other user-owned objects (own-only, for completeness)

| Object | Policy | Role rights |
|---|---|---|
| `badges` | `badges_own FOR ALL (auth.uid()=user_id)` `schema.sql:161` | own-only CRUD |
| `user_challenges` | `challenges_own FOR ALL` `schema.sql:164` | own-only CRUD |
| `saved_jobs` | `saved_jobs_owner FOR ALL` `migration_competitive_features.sql:16` | own-only CRUD |
| `saved_searches` | `saved_searches_owner FOR ALL` `:45` | own-only CRUD |
| `favorites` | select/insert/delete own `migration_favorites.sql:10-14` | own-only (no update) |
| `conversation_state` | select/insert/update own `migration_conversations.sql:12-16` | own-only (no delete) |
| `push_tokens` | select/insert/update/delete own `migration_push.sql:15-27` | own-only CRUD |
| `referrals` | insert-self, select-mine (`migration_referrals.sql`; self-referral blocked `migration_security_hardening_4.sql`) | referrer/referred scoped |
| `certifications` | public read; insert/delete own `20260629160000:18-22` | own-write, world-read |
| `class_schedule` | owner `FOR ALL` `migration_hustler_suite.sql:40` | own-only CRUD |
| `assistant_threads` / `assistant_messages` | owner `FOR ALL` `:57,72` | own-only CRUD |

---

## 16. Admin / support tier matrix (console-only; DB has no admin RLS)

Two tiers in one console (`type AdminRole = "admin" | "support"`, `admin/lib/guard.ts:7`). Enforcement is app-layer only; every mutating server action re-checks `requireAdmin(...)` server-side, so support-only UI hiding is cosmetic.

| Capability | admin | support | Evidence |
|---|---|---|---|
| View all pages (dashboard, users, jobs, bookings, payments, moderation, support) | Yes | **Yes (read-only)** | pages call `requireAdminPage('support')` |
| View **audit log** page | **Yes** | **No** | `admin/app/(console)/audit/page.tsx:14` `requireAdminPage('admin')` |
| User mutations (suspend/verify/student/reset/email/delete/notify/note) | **Yes** | No | `users/[id]/actions.ts` all `requireAdmin('admin')` |
| GDPR user data export | **Yes** | No | `users/[id]/export/route.ts:53` `requireAdmin('admin')` (+ CSRF & UUID guards) |
| Job takedown / restore | **Yes** | No | `jobs/actions.ts:15` `requireAdmin('admin')` |
| Report resolve / reopen | **Yes** | No | `moderation/actions.ts:12,38` `requireAdmin('admin')` |
| Support ticket reply / status / AI draft | **Yes** | **Yes** | `support/actions.ts:16-18` `requireAdmin('support')` |

- **MFA/AAL2 is mandatory** for all admin/support access (`guard.ts:53-56`).
- **The audit log is append-only even to service_role**: `revoke update, delete … from … service_role` (`20260705010000_admin_console.sql:41`). `audit()` is awaited and fail-closed for mutations (`admin/lib/audit.ts:20-28`); `auditRead()` is best-effort for view pages. `deleteAccount` audits *before* the irreversible cascade.
- Admin **cannot act on self or on another admin** for user mutations (`assertActionableTarget`, `users/[id]/actions.ts:24-36`). Job/moderation/support actions have no equivalent target guard (they act on jobs/reports/tickets).
- **Admins cannot** manage `admin_users` from the console (DB-only), rewrite/delete audit history, refund/capture payments from the console (Stripe-side only), or instantly kill an already-issued access JWT (refresh sessions are revoked; existing access tokens live up to ~1h — Supabase-inherent).
- Service-role-only DB primitives (all `revoke execute from public/anon/authenticated; grant to service_role`): `admin_find_users`, `admin_dashboard_metrics`, `admin_user_login_history`, `admin_revoke_sessions` (all SECURITY DEFINER).

---

## Open questions / for Fable to verify

1. **Review responses have no RLS UPDATE policy.** `reviews.response_text/responded_at` exist and the `reviews` table has **no UPDATE policy at all** — so the advertised "reviewed person may reply once" cannot be written by a client through RLS. Either the feature is unwired, done via a service path not found, or dead. Confirm against the client review-response code path.
2. **Legacy vs tracked policy drift.** `schema.sql`'s permissive `slots_update_any USING(true)` and the original `stripe_*` `FOR ALL` policies were superseded by tracked migrations (`drop policy if exists` + recreate). The migration *source* replaces them, but the **live remote DB** was not confirmed to have only the hardened versions (some legacy files were "applied manually"). Fable should diff live `pg_policies` against the tracked set.
3. **`profiles_select_all USING(true)` still exists** alongside the column lockdown. Cross-user column scoping relies **entirely on the column GRANT**, not the row policy. If a future migration re-broadens the column grant, or a `SELECT *` slips through PostgREST, private columns leak. Worth a live-DB `has_column_privilege` audit for anon/authenticated on `profiles`.
4. **`jobs.status` is unguarded and client-trusted**, and `'booked'` is a dead enum value. Confirm no client path writes an unexpected `jobs.status` that other logic trusts (the lifecycle uses `bookings.status`, which *is* guarded).
5. **`handle_new_user` default role.** The trigger inserts profiles without setting `role`; the base default is `'earner'` (`schema.sql`) though the enum now allows `both`. Onboarding sets it later. Not a permission issue (role isn't used in RLS) but noting the DB default.
6. **`storage.objects` policies are additive across buckets.** Each bucket's policies were read, but the live `storage.objects` policy set wasn't enumerated for a stray permissive/overlapping policy (e.g., a leftover public-read on a now-private bucket). Recommend a live `pg_policies WHERE schemaname='storage'` diff.
7. **`receipts` bucket has no MIME allowlist** applied (unlike the five other buckets). Possibly intentional (PDF receipts) but unconfirmed — a potential SVG/HTML-upload vector if reads were ever re-made public.
8. **`support-submit` accepts unauthenticated posts** (JWT optional, `support-submit/index.ts:39-44`) by design (public contact form, rate-limited). Anon can create `support_tickets` rows *via the edge function* (service role), though not via PostgREST. Correct, but worth flagging as an anon write-path.
9. **Edge-fn trust boundary** (from the admin dossier): `support-reply` / `support-ai-draft` require only `admin_users` membership, **not AAL2 or the `admin` tier**. A leaked support-tier (or aal1) access token would pass these edge fns directly, bypassing the console's own MFA/tier gate. Assess whether these edge fns should also assert AAL2.
10. **`proxy.ts` wiring.** There is no `middleware.ts` in `admin/`; the interceptor is named `proxy.ts`. Whether Next.js 16.2.9 auto-registers it as request middleware was not confirmed empirically (node_modules absent). Security impact is low (data layer still gated by `requireAdmin`), but if unrecognized the cookie-refresh + login-redirect UX layer is dead code.
11. **Out-of-band schema columns.** `skill_rates` (jsonb) and `stripe_identity_session_id` (text) are granted/referenced but have **no `ADD COLUMN` DDL anywhere in `supabase/`** — added manually. A rebuild from tracked migrations would lack them. Confirm they exist on the live DB. Likewise `rls_auto_enable()` is revoked but never defined in the repo.
12. **Deploy gap.** Many AUDIT_REPORT fixes are code-complete on master but "need deploy" (`supabase db push` / edge redeploy) — the **live** system may not yet reflect every guard/policy cited here. **There is no e2e/integration test harness; the only automated coverage is the pure-logic unit suite (`npm test`, `__tests__/` — `contentFilter`/`geo`/`taxFormat`). No RLS policy, guard trigger, or edge-fn IDOR guard cited in this matrix is covered by an automated test** — every authorization claim here is verified by source-reading only. Fable should verify the live DB against the tracked migration set before relying on any single citation.
13. **Stripe live-mode & webhook wiring [Needs Fable Review].** §6 cites the source default of TEST mode (`admin/lib/config.ts:19`), but the actual key mode on the deployed edge functions, the `stripe-webhook` signing secret, and whether Stripe Identity/Connect are enabled on the account are all environment/dashboard state not present in the repo. Confirm the intended beta mode and that no live-key path is inadvertently active.

---

**Key source files.** RLS/guards — `supabase/schema.sql`, `supabase/migration_fix_lifecycle.sql`, `supabase/migrations/20260624221000_profile_column_lockdown.sql`, `.../20260630000000_review14_post_feature_hardening.sql`, `.../20260702030000_guard_pins_and_slot_delete_policies.sql`, `.../20260705030000_admin_console_hardening.sql`, `.../20260707000000_server_side_moderation.sql`, `.../20260702000000_revoke_definer_function_execute.sql`. Admin authz — `admin/lib/guard.ts`, `admin/lib/serviceClient.ts`, `admin/lib/audit.ts`, `admin/proxy.ts`, `admin/app/(console)/**/actions.ts`, `supabase/migrations/20260705010000_admin_console.sql`. Edge authz — `supabase/functions/{accept-booking,stripe-capture-payment,stripe-tip,stripe-cancel-payment,stripe-webhook,support-submit,delete-account}/index.ts`.
