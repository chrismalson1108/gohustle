# PRODUCT_FLOW_MAP.md — GoHustlr End-to-End Product Flows

> Verified 2026-07-07 at commit a70c9b5 (master).

**Purpose.** A standalone flow map for an external auditor (Fable). Each subsection traces one product flow from its entry point (screen/route) → user action → client function → backend (edge function / RLS write / trigger / RPC) → outcome / state change → notification fired, with `path:line` anchors. Both **mobile** (Expo/React Native — `App.js`, `src/`) and **web** (Next.js 16 — `web/app/`, `web/lib/`) entry points are noted where they differ. Backend = Supabase (Postgres + RLS, Auth, Realtime, Storage) + Deno edge functions in `supabase/functions/`. Admin console = `admin/` (Next.js). Repo root: `/Users/chrismalson/Documents/gohustle`.

### Ground-truth notes that shape these flows
- **Roles are per-action, not per-account.** There is no DB-level "student worker" vs "customer/client" distinction — both are the same authenticated user. `profiles.role` (`earner`/`poster`/`both`) is a **display field only** and is never used in any RLS policy. Rights are scoped by the row relationship: `earner_id` on a booking vs `poster_id` on a job. Throughout this doc, "student worker" = a signed-in user acting as **earner**; "customer/client" = the same user acting as **poster**.
- **Admin power is app-layer, not DB-layer.** There are no admin RLS policies; the admin app holds the service-role key. A user JWT can never reach admin surfaces at the DB layer. Two tiers exist in one console: `admin` (full mutations) and `support` (read-only + support-ticket reply/status), enforced only in `admin/` runtime via `requireAdmin()` → authentic `getUser()` → AAL2/MFA (mandatory) → `admin_users` membership → tier.
- **Expenses have no approval/rejection/reviewer** (see §10c). The `expenses` table is owner-only RLS on all four verbs; there is no status/approved/reviewed column and no admin expenses page. It is a private personal tax tracker.
- **Amendment direction (code, authoritative):** poster proposes → earner responds. *CLAUDE.md states the opposite and is WRONG* — flagged in Open Questions.
- ⚠️ **Risk: Stripe is in TEST mode for beta** (`admin/lib/config.ts:19` default `/test`; web `config.ts:12-14` `pk_test_…`; mobile `src/lib/stripeClient.js:3-4` `pk_test_…`). No build-time assertion enforces prod keys, so an unset `*_STRIPE_PUBLISHABLE_KEY` silently falls back to test mode. **[Needs Fable Review]** — confirm the prod deploy overrides these before real money moves.
- **Private vs public Storage buckets.** `receipts`, `chat-photos`, `completion-photos` are **private** (owner/party-scoped, signed URLs — later migrations override the original public creation). `avatars`, `job-photos`, `certificates` are public.
- ⚠️ **Risk: `jobs.status` has no server-side transition guard** (client-trusted; `booked` is a dead enum value). A malicious client can set arbitrary `jobs.status` values via RLS update. By contrast `bookings.status` IS heavily guarded (`guard_bookings_write`). **[Needs Fable Review]** — confirm `guard_jobs_write` scope does not cover status transitions.
- ⚠️ **Risk: many `AUDIT_REPORT` fixes are code-complete on master but need deploy** (`supabase db push` / edge redeploy) — **the live system may lag master**; every RLS/trigger/RPC claim below is source-verified, not deploy-verified. **[Needs Fable Review]**
- **Edge functions: 23 on disk** (each `supabase/functions/<name>/index.ts`; no `_shared` dir). (AUDIT_REPORT.md/CLAUDE.md say 24 — off by one vs. disk.)

### Cross-cutting session gate (both clients)
A session must clear `loading → onboardingResolved → onboardingDone → needsTermsAcceptance` before the app shell renders.
- Mobile: `RootNavigator` in `App.js:202-219` — spinner while `gateResolving`; then `AuthScreen` (`:215`) → `OnboardingScreen` (`:216`) → `ConsentScreen` (`:217`) → `MainApp` (`:218`).
- Web: `web/app/(app)/layout.tsx:16-45` — `gateResolving` spinner (`:23`,`:32-34`); redirect ladder `:25-30`: no session → `/login`; `!onboardingDone` → `/onboarding`; `needsTermsAcceptance` → `/consent`. **Client-side gating only — no `middleware.ts`/`proxy.ts`; RLS is the real backstop.**

---

## 1) Signup / Login (email verify, Google, Apple, forgot/reset)

**Entry points.** Mobile: `src/screens/auth/AuthScreen.js` (tabs `signin`/`signup`/`forgot`, `:54`). Web: `web/app/login/page.tsx` (`mode` via `?mode=signup`/`?reset=1`, `:33`; authed users redirect → `/browse`, `:48-50`).

### Email sign-up
1. Mobile submit `AuthScreen.js:108-123` → validates password ≥8 (`:109`), match (`:110`), 18+/Terms checkbox (`:111`) → `signUp()`.
2. `signUp` `AuthContext.js:264-290` → `supabase.auth.signUp` with `options.data = { name, referral_code }` (`:267-271`); detects an already-registered account via empty `identities` and force-`resend` (`:278-285`); sets `pendingEmail` → the "Verify your email" panel (`AuthScreen.js:168-202`); fires `track('sign_up')` (`:288`).
3. Web parity `web/lib/auth.tsx:311-392`: also sets `emailRedirectTo = <origin>/login` (`:321-322`); account-enumeration hardening neutralizes `user_already_exists`/`email_exists` + rate-limit codes and force-resends confirmation (`:326-357`); if `data.session` exists (autoconfirm) signs in immediately (`:361-364`). Pending panel `web/app/login/page.tsx:117-150`.
4. **Email verification is ON.** `signUp` returns no session. Resend via `resendConfirmation` (`AuthContext.js:292-299`; web `:394-407`).
- **Notification fired:** none (auth `track` only).

### Sign-in
1. Mobile `signIn` `AuthContext.js:141-158` → `signInWithPassword`; maps `email_not_confirmed` → friendly message + `pendingEmail` (`:147-151`); `track('sign_in')`.
2. Web `signIn` `web/lib/auth.tsx:258-286` sets session synchronously (`:280-282`) then `router.replace('/browse')` (`web/app/login/page.tsx:92`).

### Google OAuth
1. Mobile `signInWithGoogle` `AuthContext.js:160-218` — PKCE via `expo-web-browser`: builds `gohustlr://auth-callback` redirect (`:165`); **blocks Expo Go** (redirect not `gohustlr://`, `:169-172`); `signInWithOAuth({ provider:'google', skipBrowserRedirect:true })` (`:173-180`); opens `WebBrowser.openAuthSessionAsync` (`:188`); parses `?code` and `exchangeCodeForSession` (`:200-209`).
2. Web `signInWithGoogle` `web/lib/auth.tsx:288-309` — redirect to `<origin>/auth/callback` with `queryParams:{prompt:'select_account'}`. `detectSessionInUrl` exchanges the code on `web/app/auth/callback/page.tsx:25-56` (classifies cancel/identity/other errors `:35-49`; routes → `/browse` or `/onboarding` `:51-56`; 20s timeout).
- **Google is web + mobile dev/app build only — not plain Expo Go.**

### Apple Sign In (mobile only)
1. `signInWithApple` `AuthContext.js:220-262` — nonce via `expo-crypto` (`:226-228`); `AppleAuthentication.signInAsync` (`:229-235`); `signInWithIdToken({ provider:'apple' })` (`:240-244`); persists Apple's first-time `fullName` to `profiles` (`:249-253`). Button gated by `isAvailableAsync` (`AuthScreen.js:59`, iOS 13+). **No web Apple path.**

### Forgot / reset password
1. Mobile request `resetPassword` `AuthContext.js:303-319` — uses the **implicit-flow `recoveryAuthClient`** (`:314`, separate GoTrue client, isolated storage) with `redirectTo: https://gohustlr.com/reset-password`. **Mobile sends users to the WEB reset page — no native reset screen.**
2. Web request `web/lib/auth.tsx:411-424` via `getRecoveryClient()` → `<origin>/reset-password`.
3. Web reset page `web/app/reset-password/page.tsx` consumes the hash `#access_token/refresh_token` with the isolated recovery client (`:51-61`), never promotes it to the main session, `updateUser({ password })` (`:84-87`), then `signOut({ scope:'local' })` → `/login?reset=1` (`:96-98`).

### Sign-out
- Mobile `signOut` `AuthContext.js:321-344` (optimistic: flip UI, background `unregisterPushToken` + `signOut({scope:'local'})` + `cacheClear`, 2s failsafe `purgePersistedSession`). Web `web/lib/auth.tsx:426-450` (parity, `cacheClearAll`).

---

## 2) Onboarding

**Entry.** Mobile `src/screens/onboarding/OnboardingScreen.js` (rendered by `App.js:216` when `!onboardingDone`). Web `web/app/onboarding/page.tsx` (routed by the gate, `web/app/(app)/layout.tsx:28`).

**Steps** (`OnboardingScreen.js:38`; web `:30-40`): 0 Welcome → 1 Username → 2 Role → 3 Location → 4 Skills+Radius (earner/both) OR Bio (poster) → 5 Done.
- Username uniqueness checked live: regex `^[a-z0-9_]{3,30}$` + `profiles` lookup (`OnboardingScreen.js:79-97`; web `:61-74`).
- Roles `earner`/`poster`/`both` (`:18-22`); skills from a fixed list (`:24-29`); radius options `[5,10,15,25,50]` (`:31`); location via `LocationPicker` (`:224-228`).

**Finish** `handleFinish` `OnboardingScreen.js:104-142`:
1. `profiles.update({ username, role, city, skills, radius_miles, bio, onboarding_done:true })` (`:108-116`); on `23505` (dup username) bounces back to step 1 (`:121-125`).
2. `recordAcceptances(user.id, fetchCurrentDocs())` records legal acceptance (`:133`).
3. `getReferralCode(user.id)` + `recordReferral(user.id, code)` from signup metadata (`:135-139`).
4. `onComplete()` → `markOnboardingDone()` (`App.js:216`; `AuthContext.js:134-137`).

**OAuth consent capture:** `needsConsent = provider !== 'email'` shows a Terms checkbox on the Done step for Google/Apple users who never saw the signup checkbox (`OnboardingScreen.js:57`; web `:45-46`).

**Web ordering divergence (audit-relevant):** web records legal acceptance **FIRST and blocks on failure** before the profile update (`web/app/onboarding/page.tsx:84-102`); mobile updates the profile first, then records acceptance best-effort (`OnboardingScreen.js:108-133`). See Open Question #1.

- **Notification fired:** none.

---

## 3) Consent / legal re-acceptance gate

**Model** (`src/lib/legal.js`): docs in `legal_documents` (latest row per slug via `fetchCurrentDocs` `:10-19`); acceptances appended to `legal_acceptances` (`recordAcceptances` idempotent upsert `:49-61`); `REQUIRED_SLUGS = ['terms','privacy','contractor']` (`:7`); `checkNeedsAcceptance` **fails closed** (`:66-73`). Web mirror `web/lib/legal.ts` (`checkNeedsAcceptance` fails closed `:82-89`).

**Gate wiring** — `needsTermsAcceptance = !!session && onboardingDone && needsTerms` (mobile `AuthContext.js:357`; web `web/lib/auth.tsx:464`). Loaded in `loadOnboarding` only for already-onboarded users (mobile `AuthContext.js:131`; web `:248`).

**Screen** — Mobile `src/screens/ConsentScreen.js` (rendered `App.js:217`): lists required docs (`:61-67`); `recordAcceptances` → `markTermsAccepted` (`:30-42`); a failed docs fetch cannot pass the gate (`:32`,`:75-79`); Sign-out option (`:80`). Web `web/app/consent/page.tsx:34-47` (redirect-on-not-needed `:20-24`).

**To force re-acceptance:** insert a new `(slug, version)` row in `legal_documents` (no app release). **Notification fired:** none.

---

## 4) Student verification (.edu email OTP)

**Entry.** Mobile: `StudentVerifyModal` opened from `ProfileScreen.js:569` (row `:358-363`). Web: `web/app/(app)/verify-student/page.tsx`, linked from profile.

**Client wrappers** (`src/lib/student.js`; web `web/lib/student.ts`): `startStudentVerification(email)` / `confirmStudentVerification(email, code)` POST to edge functions with the user's JWT (`student.js:7-35`).

**Two-step UI** `StudentVerifyModal.js`: step `email` → `isEduEmail` guard (`:26`) → `startStudentVerification` (`:29`); step `code` → 6-digit → `confirmStudentVerification` (`:43`) → `refreshProfile()` + Verified-Student toast (`:44-46`). `email_not_configured` surfaced distinctly (`:32-34`). Web parity `verify-student/page.tsx:22-55`.

**Backend — start** `supabase/functions/student-verify-start/index.ts`: JWT auth (`:52-54`); `isEduEmail` incl. `.ac.uk`/`.edu.xx` (`:26-30`); `normalizeEduEmail` strips `+tag` (`:36-41`); per-user 5/15min + per-target-email 3/15min rate limits (`:70-88`); silent no-op if the inbox already verified another account (anti-enumeration, `:93-99`); CSPRNG 6-digit code, `SHA-256(code:userId)` hash stored in `student_email_verifications` with 15-min expiry (`:102-113`); Resend email requires `RESEND_API_KEY` + `STUDENT_VERIFY_FROM` else `email_not_configured` 503 (`:115-127`).

**Backend — confirm** `student-verify-confirm/index.ts`: fetches newest un-consumed row (`:44-53`); expiry / attempts (≥5) checks (`:55-57`); hash compare, increments attempts on miss (`:59-63`); one-inbox-one-account guard (`:66-75`); on success sets `consumed`, then service-role updates `profiles` `{ student_verified:true, student_verified_at, student_verify_method:'edu_email', school_domain }` and derives `student_status`/`school` (`:78-100`). **Client cannot self-set `student_verified`** (DB trigger blocks it, file header `:1-4`).

**Shared logic** `shared/school.js` (`isEduEmail :103-114`, `studentTrustLabel :132-138`, `collegeLine :141-152`). **Admin override:** `grantStudent`/`revokeStudent` `admin/app/(console)/users/[id]/actions.ts:206-238` (`student_verify_method:'manual'`).

- **Notification fired:** in-app toast only.

---

## 5) Job posting

**Entry.** Mobile `src/screens/PostJobScreen.js` (`GigsStack`; also reached with `{ prefill }` for Duplicate). Web `web/app/(app)/hiring/new/page.tsx` (+ `GigForm.tsx`, `SlotBuilder.tsx`; duplicate `?from=<jobId>`).

**Fields** (`PostJobScreen.js:28-32`): title, category (+ custom "Other" `:190-210`), tags & hazards (`TagInput` `:213-219`), pay + payType flat/hourly (`:221-246`), estimated hours for hourly (`:248-262`), location (`LocationPicker → onChange(v, coords)` `:264-269`), description, up to 6 photos (`:284-301`), requirements (one per line), available times (`DateTimePicker → slots[]` `:316-321`), recurrence none/weekly/biweekly/monthly (`:323-338`), urgent toggle (`:340-347`).

**Submit** `handlePost` `PostJobScreen.js:82-146`:
1. Required-field check (`:84-87`); content filter on title+desc+tags+hazards via `findProhibited` (`:88-92`).
2. Photos uploaded to the public `job-photos` bucket via `uploadImages` (`:96-98`).
3. `addJob(...)` `JobsContext.js:961-1035` → inserts into `jobs` with `poster_id`; **coords snapped to ~1km** for privacy (`Math.round(lat*100)/100`, `:989-990`); inserts `job_slots` (`:1007-1011`) and `job_requirements` (`:1012-1016`); `track('gig_posted')` (`:1005`); optimistic `ADD_JOB` then background `fetchJobs()` (`:1018-1034`); on insert error **throws** so the form is preserved (`:998-1004`).
4. Success toast → `navigation.navigate('GigsMain')` (`:144-145`).

**Backend:** direct RLS insert (poster = `poster_id`); `guard_jobs_write` trigger constrains poster writes (referenced `admin/app/(console)/jobs/actions.ts:14`). Note: `jobs.status` transitions are client-trusted (no transition guard).

- **Notification fired:** none at post time.

---

## 6) Job browsing (Browse / Home)

**Entry.** Mobile `src/screens/HomeScreen.js` (`HomeTab`). Web `web/app/(app)/browse/page.tsx`.
- Category chips incl. pseudo-category "For You" matching viewer skills (`HomeScreen.js:18-20`; filter `:158`); search; full `FilterSheet` (sort, pay range, days, location/state, payType, urgency, radius) — `DEFAULT_FILTERS`/`countActiveFilters` `src/components/FilterSheet.js:12-43`.
- Distance: `haversineMiles` from `src/lib/geo.js` (`HomeScreen.js:15`); radius center = chosen location else geocoded profile city (`:104-125`); remote gigs always shown, in-person need coords stored or geocoded (`:188-193`); "Nearest" sort adds `_distanceMi` (`:208`). Geocode via free Photon (`geocodeOne :61-66`).
- Map view: `JobsMap` (react-native-maps, native dev build) `HomeScreen.js:343`.
- Blocked posters filtered out (`blockedIds`, `:238`); soft-cancelled jobs excluded by `fetchJobs` `.neq('status','cancelled')` (`JobsContext.js:299`).
- Web parity `browse/page.tsx` (`FilterSheet :18`, dynamic `JobsMap` `ssr:false` `:25`/`:248`, geocode + radius `:60-78`, `milesLabel :294`; server geocode proxy `web/app/api/geocode/route.ts`).

- **Notification fired:** none.

---

## 7) Job acceptance / booking (pending → poster accept → escrow authorize)

### Book (earner)
**Entry.** Mobile `JobDetailScreen.js`; web `web/app/(app)/jobs/[id]/page.tsx`.
1. `handleBook` `JobDetailScreen.js:83-131`: hides/blocks past slots (`:88-95`); requires slot selection (`:96-100`); content-filters the note (`:104-108`); calls `bookJob(jobId, slotId, slotLabel, counter, note)`. **Self-booking blocked** (`job.posterId === user.id`, `JobsContext.js:455`; UI `JobDetailScreen.js:55`). On success awards XP/challenges (`:117-120`) → navigate `EarnTab`.
2. `bookJob` `JobsContext.js:452-494`: optimistic `BOOK_JOB` + temp booking; inserts `bookings` row `{ status:'pending', slot_id, starts_at, counter_offer, application_note }` (`:461-470`); marks `job_slots.taken=true` (`:481-483`); rolls back on error (`:472-479`); `track('booking_created')`. **No payment at book time.**
- **Notification fired:** `notify(posterId, 'New booking request', …, { tab:'GigsTab' })` (`JobsContext.js:490`). Realtime poster toast "New Booking Request!" (`:426-428`). Web parity `web/lib/jobs.tsx:493`+`:531`.

### Accept (poster) — funds escrow here
**Entry.** Mobile `GigsScreen.js` `handleAccept:146-192`; web `hiring/page.tsx` via `AcceptPaymentModal` (`:409-417`).
1. Mobile: `createPaymentIntent(bookingId)` → `initPaymentSheet` → `presentPaymentSheet` (card entry) → on auth `acceptBooking(bookingId)` (`GigsScreen.js:151-180`). Web: `AcceptPaymentModal.tsx` uses Stripe Elements (`:88-90`), saved-card one-tap (`:68-83`) or new card, `confirmCardPayment`/`confirmPayment` (`:138`,`:196`), then `acceptBooking`.
2. **Edge `stripe-create-payment-intent`** `supabase/functions/stripe-create-payment-intent/index.ts`: poster-owns-job check (`:64`); **manual-capture PI (escrow)** with `application_fee_amount = 10%`, `transfer_data.destination = earner Connect acct` (`:161-180`); amount = `counter_offer ?? pay` × hours (hourly), bounded 50¢–$10k (`:143-150`); **earner must be Connect-onboarded** — self-heals the cached flag by retrieving the account live (`:87-104`), else `EARNER_NO_PAYOUT` (`:106`); reconciles/reuses an existing live hold to avoid orphaned auths (`:159-197`); records a `payments` row `status:'authorized'` (`:199-206`). Fee constant mirrored `stripeClient.js:7` (`SERVICE_FEE_PCT=0.10`).
3. **Edge `accept-booking`** `supabase/functions/accept-booking/index.ts`: re-fetches the PI from Stripe and **requires `status==='requires_capture'`** before flipping the booking (`:57-64`); guarded update `.eq('status','pending')` (`:74-82`). This is the sole confirm path — `guard_bookings_write` blocks a client setting `confirmed` directly (file header `:1-13`). `acceptBooking` has a transient-retry ladder for `HOLD_NOT_AUTHORIZED`/5xx (`JobsContext.js:646-692`; web `acceptWithRetry` `web/lib/jobs.tsx:42`).
- **Outcome:** `bookings.status: pending → confirmed`; escrow authorized (not captured).
- **Notification fired:** `notify(earner, 'Booking accepted!', …, { tab:'EarnTab' })` (`JobsContext.js:688-690`); earner realtime toast "Booking Confirmed!" + a 1-hour local gig reminder scheduled (`:398-401`; `push.js:93-106`); `track('booking_accepted')`.

### Decline (poster)
- `declineBooking` `JobsContext.js:694-721` — `stripeEdge.cancelPayment` releases the hold, sets `status:'declined'`, frees the slot, notifies earner "Booking declined" (`:718-720`). Web `web/lib/jobs.tsx:699`.

---

## 8) Job cancellation

**Entry.** Earner `EarnScreen.js` `handleCancel:313-332` (withdraw pending / cancel confirmed). Poster `GigsScreen.js` `handleCancel:201-224` (shows the cancellation-fee dialog).

**`cancelBooking`** `JobsContext.js:725-788`:
1. Only `pending`/`confirmed` cancellable (`:730-733`); **blocked once `started_at` set** ("worker on site" → must dispute instead, `:736-739`; mirrors DB `trg_guard_started_booking_cancel`).
2. **Cancellation-fee policy is record/display only — NO money moves.** A poster cancelling a `confirmed` booking owes 15% of effective pay, floored $5 (`computeEffectivePay`/`computeCancellationFeeAmount` `:118-128`; applied `:747-750`; dialog via `cancellationFeeFor` `:1040-1046`).
3. **Order matters:** the guarded `bookings.update({ status:'cancelled', cancellation_fee })` runs **FIRST** (`:762-770`); only then `stripeEdge.cancelPayment` (one retry) releases the hold + frees the slot (`:775-780`). Rolls back optimistic state if the guarded write fails (`:766-769`). Web `web/lib/jobs.tsx:728`.
4. **Edge `stripe-cancel-payment`** `supabase/functions/stripe-cancel-payment/index.ts`: IDOR guard — poster or earner only (`:36-40`); rejects completed/verified (`:44-46`) and started (`:49-51`); cancels the PI, sets `payments.status:'cancelled'` (`:73-79`); no-payment / already-cancelled / captured handled (`:65-71`).
- **Notification fired:** `notify(otherParty, 'Booking cancelled', …)` (`JobsContext.js:783-787`).

---

## 9) Job completion (mutual done + completion photos + verify + capture + rate + tip)

Both `earner_done` and `poster_done` must be `true` to reach `completed`. Neither party alone advances the status.

### Mutual "done"
1. Earner `markEarnerDone` `JobsContext.js:531-558` (Finish sheet `EarnScreen.js:255-311`): optional **before/completion photos** uploaded **privately** to `completion-photos` via `uploadPrivateImages` (`EarnScreen.js:287-291`); saves `completion_photos`/`before_photos`; advances to `completed` only if `posterDone` already (`:534-537`). **Notify:** `notify(poster, 'Job marked done', …)` (`:554-557`). Web `web/lib/jobs.tsx:562`.
2. Poster `markPosterDone` `JobsContext.js:561-579` (`GigsScreen.js:226-236`): advances if `earnerDone`; **notify** earner (`:576-578`). Web `web/lib/jobs.tsx:593`.
3. Photos shown to the poster in `CompletionModal` via `SignedImage` (private-bucket signed URLs, `CompletionModal.js:135-156`).

### Verify + rate + capture (poster)
`CompletionModal` (`GigsScreen.js` `verifyTarget`) → `verifyAndRate(bookingId, { rating, reviewText, paymentMethod, pct, tipCents, disputeReason })` `JobsContext.js:790-907` (web `web/lib/jobs.tsx:798`):
1. Content-filters the review (`:795-798`); rejects already-finalized bookings (`:808-811`).
2. **Capture:** `stripeEdge.capturePayment(bookingId, pct?, disputeReason?)` (`:816`). **Edge `stripe-capture-payment`**: poster-owns-job IDOR guard (`:61-63`), requires `completed`/`verified` (`:64-66`); partial capture **floored at 50%** and **requires a `disputeReason`** (`:40-52`); persists the reduced net BEFORE capture to avoid webhook over-credit (`:96-116`); credits the earner atomically-once via `credit_earnings` RPC (`:147-151`); records a `disputes` row idempotently for partial captures (`:154-166`).
3. Sets `bookings.status:'verified'`, `earner_rating`, `review_text`, `payment_method` (`:823-836`).
4. **Tip** (optional, ≥50¢): `stripeEdge.tip` off-session (`:851-863`). **Edge `stripe-tip`**: poster check, `completed`/`verified` gate, off-session charge on the saved default card, **full tip to earner (no platform fee)**, `claim_and_credit_tip` RPC atomic-once (`stripe-tip:35-99`); `card_requires_authentication` surfaced (`:104-108`).
5. Inserts a `reviews` row `role='earner'` once (dedup `:883-899`) → `recompute_user_rating` RPC (`:901`). Marks the job `completed` only if no other active booking remains (`:867-878`).
- **Outcome:** `bookings.status → verified`; escrow captured; earner credited; review written.
- **Notifications fired:** earner "Job verified — you got paid!" or the partial-adjustment variant (`:841-847`); tip → "You got a tip!" (`:855-857`); `track('job_verified')`, `track('tip_sent')`.

### Earner rates poster
- `ratePoster` `JobsContext.js:594-641` (`EarnScreen.js:334-343`): content-filter; updates `bookings.poster_rating/poster_review`; inserts a `reviews` row `role='poster'` once (`:626-637`); `recompute_user_rating`; **notify** poster "You were rated" (`:639`). Web `web/lib/jobs.tsx:623`. Reviews are two-sided; the combined rating is cached on the profile.

### Earnings crediting
- Credited server-side only (in `stripe-capture-payment` / `credit_earnings`), never double-credited client-side (`JobsContext.js:904-906`). Webhook `payment_intent.succeeded` also calls `credit_earnings` idempotently (`stripe-webhook:61-73`).

---

## 10) Expense & income (Tax Center) — creation, receipt upload, and the absence of approval

**Entry.** Mobile `src/screens/ExpensesScreen.js` (`ProfileStack → Expenses`). Web `web/app/(app)/profile/taxes/page.tsx` (+ `TrackExpensesModal.tsx`).

### 10a) Expense creation
- Segments Expenses / Income; year net-profit summary (Stripe earnings + logged cash income − expenses) with a ~27% set-aside hint.
- **Add expense** `ExpensesScreen.js:119-138`: `pickImage` (`:119`) → **receipt uploaded privately** to the `receipts` bucket via `uploadPrivateImage` (`:132`) → `addExpense(userId, { amount, category, description, date, receiptUrl, bookingId, miles })` (`:134`) → inserts into `expenses` (`src/lib/expenses.js:19-36`).
- **Add cash income** → `addIncome` into `income_entries` (`expenses.js:71-79`).
- Delete: optimistic + `deleteExpense`/`deleteIncome` (`ExpensesScreen.js:156`; lib `:56-59`,`:81-84`). Grouping `expensesByJob` (`expenses.js:41-54`).
- **Export:** year-end tax-summary CSV `buildTaxSummaryCSV` → `Share.share` (`ExpensesScreen.js:168-171`; pure helpers in `src/lib/taxFormat.js`). Web CSV export mirrors this in `web/app/(app)/profile/taxes/page.tsx`.

### 10b) Receipt upload
- Receipts go to the **private `receipts` bucket** (owner-scoped) and are displayed via `getSignedUrl('receipts', …)` (`expenses.js:82`; `ExpensesScreen.js:137`). Deleted on account deletion (`delete-account/index.ts:12`).

### 10c) Expense "approval / rejection" — DOES NOT EXIST
- **There is no approval, rejection, reviewer, or status workflow for expenses.** The `expenses` table has owner-only RLS on all four verbs and **no** status/approved/reviewed/reviewer column. There is **no admin expenses page** in `admin/`. Expenses are a **private personal tax tracker** — a user logs their own deductions for their own 1099 tax accounting; nobody else (poster, admin, support) can see or act on them. Any audit question about "expense approval/rejection" should be answered: this concept is not implemented and is out of scope by design.
- **Notification fired:** none.

---

## 11) Messaging

**Entry.** Mobile `MessagesTab → MessagesScreen`; chat via `MessageSheet` (reused from JobDetail `:430-436`, EarnScreen `:800`, GigsScreen). Web `web/app/(app)/messages/page.tsx`.
- Conversations built one-per-booking from `bookings`+`posterBookings` with last-message preview + unread dots; Inbox/Archived split.
1. **Send** `MessageSheet.js:140-210`: optimistic insert into `messages` `{ booking_id, sender_id, text }` (`:167`); image messages upload a path to the private `chat-photos` bucket then insert `image_url` (`:201`); realtime channel `msgs-${bookingId}` (`:119-137`).
- **Notification fired** per message: `notify(otherPerson.id, senderName, text|'📷 Photo', { tab:'MessagesTab' })` (`MessageSheet.js:183`,`:210`).
2. **Read state** `src/lib/messages.js`: `markConversationRead` upserts `conversation_state.last_read_at` (`:29-32`); `setConversationArchived` (`:34-37`); `isUnread` = newest msg from other + newer than last read (`:40-44`). Opening a chat marks read + `refreshUnread` (`MessageSheet.js:74`).
3. **Tab badge** `unreadMessages` computed in `JobsContext.refreshUnread` (`:257-267`); live-recomputed on incoming `messages` INSERT from another sender (realtime `messages-unread-${user.id}` `:436-441`). Web parity `web/app/(app)/messages/page.tsx`, `web/lib/messages.ts`.

---

## 12) Disputes / support

### Dispute (partial refund)
- **Entry:** poster's `CompletionModal` "report a problem" toggle (`CompletionModal.js:196-229`) — pick a pay % (tiers 90/75/50, `:91`), state a required reason (`:67`,`:217-226`).
- Flows into `verifyAndRate({ pct, disputeReason })` → **edge `stripe-capture-payment`** partial capture, which records the `disputes` row server-side (audit trail; capture floored at 50%, reason required) (`stripe-capture-payment/index.ts:40-52`,`:154-166`).
- **Notification fired:** earner notified of the pay adjustment (`JobsContext.js:842-844`).

### Gig / user reports
- `src/lib/moderation.js`: `submitReport` inserts into `reports` (`:11-21`); `blockUserDb`/`unblockUserDb`/`fetchBlockedIds` (`:23-38`). Mobile entry: JobDetail "Report this gig" (`JobDetailScreen.js:69-81`; reasons `moderation.js:3-9`). Web mirror `web/lib/moderation.ts` (report/block from `/u/[id]` and `/messages`). Blocked posters' gigs are filtered from Browse (`blockedIds`).

### Support tickets → admin
- **Entry:** web Contact form `web/app/contact/page.tsx` POSTs to **edge `support-submit`** (`:44-52`; no login required; prefills email + attaches JWT if signed in, `:29-33`).
- `support-submit/index.ts`: creates a `support_tickets` row + first `support_ticket_messages` row (`:78-95`); layered fail-closed rate limits per-email 5/hr, per-IP 8/hr, global 60/hr (`:56-71`); emails the support inbox via Resend (`:97-121`).
- Mobile support = mailto to `SUPPORT_EMAIL` (`ProfileScreen.js:554`; `legal.js:6` = `mainmail@gohustlr.com`). Tickets are then handled in the admin Support console (§13).

---

## 13) Admin review (moderation queue, reports, takedowns, user actions, MFA)

**Enforcement** — `admin/lib/guard.ts` `requireAdmin`: authentic session (`getUser`) → **AAL2 / TOTP MFA** (JWT `aal` claim `:26-56`, mandatory) → `admin_users` membership → role tier `admin`/`support` (`:42-71`). **Tier semantics:** `admin` = full mutations; `support` = **read-only + support-ticket triage only** (reply/status) — the moderation/user/job mutation actions below are gated to the `admin` tier, not `support`. `requireAdminPage` redirects deny reasons (`:74-85`). `proxy.ts` is UX-only. ⚠️ **No admin RLS at the DB layer** — admin power = the admin app holding the service-role key; a user JWT cannot reach these surfaces, but the ONLY thing standing between a compromised admin session and full DB mutation is app-layer `requireAdmin` + MFA. **[Needs Fable Review]** — AAL2/MFA enrollment enforcement, `admin_users` seeding, and service-role key custody are live-infra state, not verifiable from source.

**Moderation queue** — `admin/app/(console)/moderation/page.tsx`: reads `reports` (open vs resolved toggle) with bulk name/title resolution + recent `blocks` (`:18-43`). Actions `admin/app/(console)/moderation/actions.ts`: `resolveReport` / `reopenReport` (admin tier) → update `reports.resolved_*` + write `audit` (`:12-60`).

**Job takedown** — `admin/app/(console)/jobs/actions.ts` `setJobStatus`: soft-delete (`status:'cancelled'`) or restore (`:15-29`); on takedown purges the gig's `job-photos` **only under the poster's own folder, rejecting `..`** (`:38-52`); `audit('job.takedown'|'job.restore')` (`:54-57`).

**User actions** — `admin/app/(console)/users/[id]/actions.ts`, all via `run()` (requireAdmin → `assertActionableTarget` blocks self/other-admin `:24-36` → act → **fail-closed `audit`** → revalidate `:38-64`):
- `suspendUser` (ban ~100y + `suspended_at` + revoke sessions `:66-94`), `unsuspendUser` (`:96-110`), `forceSignOut` (`:112-131`).
- `setVerified` (`:133-148`), `resetProfileFields` (`:150-164`).
- `sendPasswordReset` (server-resolves email `:166-182`), `confirmEmail`/`changeEmail` (`:184-204`).
- `grantStudent`/`revokeStudent` (`:206-238`; `student_verify_method:'manual'`).
- `notifyUser` (in-app `notifications` insert + optional email via `support-reply` `:240-276`), `addNote` (`:278-288`).
- `deleteAccount` (requires typing "DELETE"; audits BEFORE the irreversible `deleteUserCascade` `:290-319`).

**Support console** — `admin/app/(console)/support/actions.ts`: `replyTicket` (records message + `support-reply` email; support tier `:39-88`), `setTicketStatus` (`:90-114`), `aiDraft` via `support-ai-draft` with PII-egress `auditRead` (`:116-141`).

---

## 14) Notifications (push register + notify + send-push + inbox)

**Registration** — Mobile `src/lib/push.js` `registerPushToken(userId)` (from `PushManager` in `App.js:50-55`): permission → Expo token via `extra.eas.projectId` → upsert `push_tokens` (`push.js:44-78`). `unregisterPushToken` on sign-out (`:81-89`). Guards for web/simulator/missing native module (`:10-18`). Local gig reminders `scheduleGigReminder`/`cancelGigReminder` (`:93-111`). Tap routing via `addNotificationResponseListener` → `navigationRef.navigate(tab)` (`App.js:56-62`). **Web:** `registerPushToken`/local reminders are no-ops (`web/lib/push.ts`).

**Send** — `notify(userId, title, body, data)` POSTs to **edge `send-push`** with the caller JWT (`push.js:127-144`; web `web/lib/push.ts`). `send-push/index.ts`: JWT required (`:24-26`); no self-notify (`:29`); **anti-spoof — caller must share a booking with the target** (`:35-46`); rate limit 30/min via `push_send_rate` (`:52-66`); **sanitizes** title/body/type/tab/jobId, whitelists tabs+types, only honors a jobId on a shared job (`:70-88`); **persists an in-app `notifications` row** for the inbox (`:90-104`); sends to `push_tokens` via Expo, prunes `DeviceNotRegistered` (`:106-142`).

**Event triggers** — fire from JobsContext booking events + `MessageSheet.sendMessage` (mobile `JobsContext.js` `:490`,`:523`,`:556`,`:577`,`:639`,`:688`,`:718`,`:783`,`:843`,`:856`,`:1123`,`:1134`; web `web/lib/jobs.tsx` `:531`,`:558`,`:589`,`:612`,`:666`,`:694`,`:725`,`:783`,`:851`,`:860`,`:1064`,`:1073`). Cross-platform deep-links keep mobile route-name vocabulary in `data.tab` (`GigsTab`/`EarnTab`) even on web. **[Needs Fable Review]** — `web/lib/push.ts` is a no-op for token registration/local reminders (§271); web notifications rely solely on the in-app `notifications` inbox, so a web-only user receives no OS push — confirm this is intended for beta.

**Inbox** — Mobile `src/lib/notifications.js` (`listNotifications`, `markRead`, `markAllRead`, `setArchived`, `getUnreadCount`, `notificationRoute` `:5-43`); `NotificationsScreen.js` renders Inbox/Archived, auto-archives on view, deep-links via `notificationRoute` (`:34-59`); reached from `ProfileScreen.js:455`. Web `web/app/(app)/notifications/page.tsx` + `web/lib/notifications.ts` (`useUnreadNotifications` hook drives the Alerts badge). Admin `notifyUser` writes to the same `notifications` table (`type:'admin'`).

---

## Open questions / for Fable to verify

1. **Web vs mobile onboarding ordering divergence.** Web records legal acceptance FIRST and blocks (`web/app/onboarding/page.tsx:84-90`); mobile updates the profile first, then records acceptance best-effort (`OnboardingScreen.js:108-133`). A mobile user whose `recordAcceptances` silently fails is marked onboarded but may hit the consent gate next launch — a legal-audit-trail inconsistency.
2. **CLAUDE.md amendment direction is wrong (code-verified).** The code is **poster proposes → earner responds**: `proposeAmendment` is called only from the poster hub `GigsScreen.js:251` and `respondToAmendment` only from the earner hub `EarnScreen.js:534,:542` (both defined `JobsContext.js:1118`,`:1127`). CLAUDE.md's Amendment Workflow section describes the reverse — a doc bug, not a code bug. The flows here follow the code.
3. **Mobile password reset hardcodes `https://gohustlr.com/reset-password`** (`AuthContext.js:314-315`) with no native reset screen. If that domain/allow-list entry breaks, mobile password reset dead-ends. Not verified live.
4. **`payment_method` label is cosmetic.** `CompletionModal.js:75` always sends `paymentMethod:'card'`; real settlement is Stripe escrow capture. Confirm no code path treats a "cash" method as bypassing capture (none found).
5. **`estimated_hours` drives the hourly escrow hold** (poster-set, `PostJobScreen.js:123`; used in `stripe-create-payment-intent:141-142`). A poster under-estimating hours under-funds the hold; capture is bounded by the authorized amount. No "top-up" path for over-worked hourly gigs was found — possible product gap.
6. **Web Apple Sign In absent.** Only Google on web; mobile has both Google and Apple. Intentional, but a platform-parity note.
7. **[Needs Fable Review] Stripe is in TEST mode by default** (mobile `stripeClient.js:3-4`; web `config.ts:12-14`; admin `admin/lib/config.ts:19`). If `*_STRIPE_PUBLISHABLE_KEY` is unset in prod, payments silently fall back to test mode — no build-time assertion enforces env presence.
8. **[Needs Fable Review] Client-side-only route gating on web.** No `middleware.ts`/`proxy.ts` (verified absent); page JS and initial data requests are reachable while signed out. Confirm Supabase RLS fully backstops every table/RPC. `/api/geocode` is self-flagged unauthenticated + unrated (`web/app/api/geocode/route.ts:17-18`).
9. **[Needs Fable Review] RPC/trigger existence not verified from client scope.** Flows depend on `my_profile`, `recompute_user_rating`, `credit_earnings`, `claim_and_credit_tip`, `area_market_stats`, plus triggers `guard_bookings_write`, `guard_jobs_write`, `trg_guard_started_booking_cancel`. These live in `supabase/migrations/*.sql` — verify they are present and **deployed** (many audit fixes are code-complete but "need deploy").
13. **[Needs Fable Review] `jobs.status` has no server-side transition guard** — client-trusted RLS update; confirm `guard_jobs_write` does not cover status and assess whether an attacker forcing `jobs.status` has any downstream payment/visibility impact.
14. **[Needs Fable Review] Admin enforcement is app-layer only** — AAL2/MFA enrollment, `admin_users` seeding, `support`-vs-`admin` tier gating, and service-role key custody are live-infra/dashboard state not verifiable from source (§13).
15. **[Needs Fable Review] Web has no OS push** — `web/lib/push.ts` token registration is a no-op (§14); web users get only the in-app inbox. Confirm intended for beta.
10. **Dead / legacy screens.** Mobile `BrowseScreen.js` and `MyJobsScreen.js` are orphaned (not registered; `MyJobsScreen` references a non-existent `appliedIds`). `ManageBookingsScreen` (ProfileStack) overlaps `GigsScreen` (CLAUDE.md calls it legacy) — if reachable it may present a second, divergent poster booking-management path worth auditing for consistency. Note as dead/legacy code; do not remove.
11. **Analytics/error capture are no-ops** on both clients (`src/lib/analytics.js`, `web/lib/analytics.ts`) — no production error visibility despite `captureError` being called throughout. Confirm intended for beta.
12. **`assistant` edge function (Claude tool-use loop)** is invoked from the web `AssistantWidget` and mobile `AssistantButton`; it performs state-mutating "actions" (`web/lib/assistant.ts:20-22`). A powerful surface not covered by the flows above — flag for a dedicated review.
