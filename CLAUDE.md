# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                       # Start Expo dev server (LAN mode, requires same WiFi as phone)
npx expo start --tunnel         # Start with ngrok tunnel (cross-network); kill all node/ngrok processes first
npm run ios                     # expo run:ios — build & launch the dev client on a simulator/device
# ⚠️ A native iOS build needs BOTH of these or it fails in ways that name the wrong thing:
#   LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   — CocoaPods aborts on ASCII-8BIT
#   ios/build + ios/build-release removed — see the note below
npm run android                 # expo run:android — build & launch the dev client
npm run web                     # expo start --web
npm install --legacy-peer-deps  # Always use this flag when installing packages
deno check --node-modules-dir=none supabase/functions/<fn>/index.ts   # type-check an edge fn (see below)
npx expo install <package>      # Use instead of npm install for Expo packages (auto-picks SDK 54 version)
npm test                        # Jest — the pure-logic + drift-guard suite in __tests__/ (~1s)
npm run brand:sync              # Distribute shared/assets/brand → the paths web + app.json expect
supabase db push --linked       # Apply supabase/migrations/ to production (the canonical path)
cd admin && npx vercel --prod   # REQUIRED: the admin console does NOT auto-deploy (see below)
```

⚠️ **Native iOS builds on this Mac: use `xcodebuild`, and never a custom `-derivedDataPath`.**
Two traps, both of which cost real time on 2026-08-13:
- `expo run:ios` misroutes a BOOTED simulator to the physical-device path ("No code signing
  certificates are available"), with or without `--device`, by name or UDID. SDK 57's CLI
  fixed the underlying `devicectl` parse warning but not this. Use `xcodebuild -workspace
  ios/GoHustlr.xcworkspace -scheme GoHustlr -destination "platform=iOS Simulator,id=<udid>"`.
- `ios/build/generated/` is NOT disposable. `pod install` runs React Native's codegen and
  writes `ReactCodegen` sources there, and the Pods project references that exact path. So
  `rm -rf ios/build` — the fix for the stale-plist problem below — DESTROYS them, and the next
  build fails with "Build input file cannot be found: …/ReactCodegen/…-generated.mm". After
  removing `ios/build`, re-run `pod install` (or `npx expo prebuild -p ios`) before building.
  A custom `-derivedDataPath` is fine; that was my first, wrong diagnosis of this error.

⚠️ **A failed pod build can leave `.DerivedData` INSIDE `node_modules`, and it poisons the
next build.** `expo-modules-jsi` left 173 MB at `node_modules/expo-modules-jsi/apple/.DerivedData`
containing a `.swiftinterface` that re-declares symbols from its own source — the compiler then
reports `type of expression is ambiguous without a type annotation` in Expo's own code, which
reads exactly like an SDK/Xcode incompatibility and is not one. `rm -rf` it and rebuild.

⚠️ **Stale `ios/build*` artifacts break `pod install`, and the error blames CocoaPods.**
React Native's post-install hook (`new_architecture.rb`) scans every Info.plist in the tree
for git conflict markers. Compiled BINARY plists inside `ios/build/` and `ios/build-release/`
are not valid UTF-8, so the regex dies with `invalid byte sequence in UTF-8` and the visible
message is only "Command `pod install` failed". Both dirs are gitignored build output —
`rm -rf ios/build ios/build-release` and rebuild. This had been broken for some time; nobody
noticed because OTA updates do not run `pod install`. Also export `LANG`/`LC_ALL` as UTF-8
first, or CocoaPods aborts before it gets that far.

⚠️ **`expo run:ios --device <name-or-udid>` may misread a SIMULATOR as a physical device**
("No code signing certificates are available"), because `devicectl` returns JSON Expo cannot
parse. Build with xcodebuild against the simulator udid instead.

⚠️ **Never let Deno manage `node_modules`.** The edge functions are Deno and the app is
Expo/npm in the same tree. `deno check --node-modules-dir=auto` writes `node_modules/.deno/`
and REPLACES real package directories with symlinks into it — on 2026-08-13 it swapped
`expo-updates` for a symlink and Metro died with `Unable to resolve module
@react-navigation/native`, naming a completely innocent package. Plain `deno check` is safe.
Use `--node-modules-dir=none`: it resolves npm through Deno's GLOBAL cache and cannot write
here. Plain `deno check` is safe but fails to resolve npm specifiers at all, so it is not the
answer either. `__tests__/workspaceIntegrity.test.js` fails on the residue so the next person
is not debugging a phantom import error. All 32 functions type-check clean as of 2026-08-13.

⚠️ **The two Vercel projects behave differently, and it will bite you.**
`gohustle` (the **web** app) has git integration — every push to `master` ships it
within a minute. `gohustlr-admin` has **no** git integration: pushing does nothing, and
the console keeps serving whatever was last deployed by hand. Verified 2026-08-06 —
four consecutive pushes each triggered a web deploy and none touched admin, which was
7 days stale at the time. After any `admin/` change:

```bash
cd admin && npx vercel --prod
```

The app runs in the **custom GoHustlr dev client, not Expo Go** — `expo-dev-client` is
installed and the app's native modules (Stripe, maps, notifications, Google sign-in)
do not exist in the Expo Go runtime.

## Legal docs (DB-driven, `src/lib/legal.js`)
Documents live in the **`legal_documents`** table (latest row per `slug` = current; slugs `terms`/`privacy`/`contractor`, public read). Acceptances are appended to **`legal_acceptances`** (one row per `slug`+`version`, owner RLS) — an audit trail. `AuthContext` gates the app (`ConsentScreen`) when `checkNeedsAcceptance()` finds a required doc whose current version the user hasn't accepted; onboarding records acceptance for new users. **To publish new terms + force re-acceptance: insert a new `(slug, version)` row** — no app release needed. Helpers: `fetchCurrentDocs`, `recordAcceptances`, `checkNeedsAcceptance`. `SUPPORT_EMAIL` lives here too.

## In-person safety (undocumented until 2026-08-13 — read before touching `jobs.location`)

⚠️ **`jobs.location` is MASKED. The exact address is in `job_locations`, behind RLS.**
`trg_mask_job_location` → `capture_job_location()` moves the precise label into
`job_locations` on write and stores a masked one on `jobs`. `mask_location()` drops any
segment containing a digit or ending in a street/unit keyword, so "742 Evergreen Terrace,
Springfield, IL" is published as "Springfield, IL".

A session that does not know this will either think the address feature is broken, or
"fix" the masking and publish every street address on the platform. `job_locations`'s
only policy (`job_locations_party_read`) exposes the exact label to the **poster**, and to
an earner **only once their booking is `confirmed`/`completed`/`verified`** — never on an
open application.

- **`gig_shares`** — a tokenised, expiring, revocable link an earner sends to a friend
  ("here's where I'll be"). `view_gig_share(token)` is SECURITY DEFINER and returns first
  names only, and it re-applies the same accepted-booking condition before revealing the
  exact label — a definer function that skipped that would be a way to read addresses off
  unaccepted applications.
- **`safety_checkins`** — `due_at` / `nudged_at` / `escalated_at` / `resolved_at` per
  booking: the "are you OK?" timer, its nudge, and escalation when it goes unanswered.
- `trg_notify_safety_report` dispatch config lives in `app_flags`, **not a GUC** — that is
  why it sat dead from 2026-07-10 to 2026-08-06 without firing once.

Read `RUNBOOK_SAFETY.md` before changing any of it.

## Location, tips & disputes
- **Location/maps**: jobs carry `lat`/`lng` (from the LocationPicker geocoder; `onChange(label, coords)`). HomeScreen computes distance via `src/lib/geo.js`, offers a **Nearest** sort + per-card distance, and a **Map view** (`JobsMap` / react-native-maps — native, needs the dev build).
- **Tips**: `CompletionModal` → `verifyAndRate(..., { tipCents })` → `stripe-tip` edge function (off-session charge → earner). `bookings.tip_amount`.
- **Disputes / partial refund**: `CompletionModal` "report a problem" sets a pay `pct` → `stripe-capture-payment` partial capture; a `disputes` row is recorded. `verifyAndRate(..., { pct, disputeReason })`.
- **Scheduling**: slots carry machine-readable `starts_at` (job_slots + bookings); `SlotPicker` hides past slots.

**Tunnel troubleshooting** — If ngrok errors with `Cannot read properties of undefined (reading 'body')`, kill all node and ngrok processes first, then retry.

## SDK & Backend

- **Expo SDK 54**, React Native 0.81.5, React 19.1.0. **The app cannot run in Expo Go at all** — Stripe, maps, notifications and Google sign-in are native modules Expo Go does not contain. Use the custom dev client (`npm run ios` / `npm run android`, or an EAS `development` build).
- **Supabase** at `https://nfioebqsgmmzhbksxozc.supabase.co` — PostgreSQL, Auth (email/password), Realtime, RLS.
- Client is in `src/lib/supabase.js` (uses AsyncStorage for session persistence).
- Base schema + feature migrations live in `supabase/` (run `schema.sql` first, then the `migration_*.sql` files) and were applied manually in the Supabase SQL Editor. **`supabase/migrations/` is the source of truth for the ENTIRE live schema** — every guard, policy, trigger and RPC, including the fee pinning, controls, promotions, support, payouts and MFA systems — applied with `supabase db push --linked`. 166 files as of 2026-08-13, and production's `supabase_migrations.schema_migrations` matches them file-for-file. Never hand-apply SQL in the dashboard; that is how the two drift.
- ⚠️ **`migration_fix_lifecycle.sql` is a LEGACY file — do NOT re-run it against production.** This line used to recommend exactly that, and following it would silently weaken two live controls. Verified 2026-08-13: production's `messages_insert` carries `NOT private.is_suspended(auth.uid())` (added by `20260730150000_suspension_blocks_messages.sql`); the legacy file recreates the policy with only the block check, so re-running it **re-opens messaging for suspended accounts** — and because messaging is party-scoped, the people a suspended account can then reach are its existing booking counterparties, i.e. whoever most likely just reported them. It also does `DROP PUBLICATION supabase_realtime; CREATE PUBLICATION … FOR TABLE bookings, jobs, messages`, which **drops `payments` from realtime** (added by `migration_stripe.sql`). Neither failure errors; the policy just gets weaker.
  **If a booking action returns a permission error, run `supabase db push --linked`.** The tracked `supabase/migrations/` files are the only reproducible hardened state.

## App Flow

On launch `App.js` renders:
1. **Loading spinner** while session is checked.
2. **`AuthScreen`** if no session (sign-in / sign-up / forgot password).
2b. **`MfaChallengeScreen`** if `needsMfaChallenge` — a password sign-in on an account with a verified TOTP factor returns a REAL session at aal1, which every gate below would let through, so the challenge is held FIRST. It fails open on a network error (the server still refuses anything needing aal2).
3. **`OnboardingScreen`** if session exists but `onboarding_done = false` on the profile — only triggered for fresh sign-ups, not returning logins.
4. **`ConsentScreen`** if `needsTermsAcceptance` — a required legal doc has a newer version than the user has accepted (see **Legal docs**).
5. **`MainApp`** otherwise — `UserProvider → JobsProvider → (AppNavigator + AssistantButton + AchievementToast + PushManager)`.

## Navigation

```
StripeProvider → SafeAreaProvider → ErrorBoundary → AuthProvider → RootNavigator
  └── MainApp
        ├── UserProvider
        └── JobsProvider
              └── AppNavigator (NavigationContainer inside providers to access context for tab badge counts)
                    └── Tab.Navigator (5 tabs — display labels in parens, route names unchanged)
                          ├── HomeTab   ("Browse")   → HomeStack:  HomeScreen → JobDetail → MarketInsights → UserProfile → Reviews → Chat
                          ├── EarnTab   ("My Jobs")  → EarnStack:  EarnScreen → JobDetail → UserProfile → Reviews → Chat → Payments
                          ├── GigsTab   ("Hire")     → GigsStack:  GigsScreen → PostJob → JobDetail → EditJob → UserProfile → Reviews → Chat → Payments
                          ├── MessagesTab ("Messages") → MessagesStack: MessagesScreen → Chat (ChatScreen) → UserProfile/JobDetail/FindPeople/Reviews/Support
                          └── ProfileTab ("You")     → ProfileStack: ProfileScreen → Settings/ProfileSettings/Availability/Notifications/
                                                                    NotificationSettings/PayoutSetup/Expenses/TrophyCase/Reviews/Legal/
                                                                    UserProfile/Favorites/SavedGigs/JobDetail/EditJob/ManageBookings/FindPeople/Chat/
                                                                    Payments/Security/Support
```

**Messages hub**: `MessagesScreen` lists conversations (one per booking with messages) built from `bookings`+`posterBookings`, with last-message preview, unread dots, and an Inbox/Archived split. Per-user `conversation_state` table (`last_read_at`, `archived`); helpers in `src/lib/messages.js`. Opening a chat pushes the full-screen `ChatScreen` (route `Chat`, registered in every stack); `MessageSheet` is the shared chat body, also hosted as a modal from JobDetail/Earn/Gigs. Opening marks the conversation read; `JobsContext.unreadMessages` drives the tab badge (`refreshUnread`). Conversations link out: the row avatar and the sheet's header person open `UserProfile`; the sheet's "re: job" line opens `JobDetail` (works for past/soft-deleted listings via `JobsContext.fetchJobById`, the fallback JobDetail uses when the job isn't in the browse list). **Messaging is booking-scoped** (party-scoped RLS) — `PublicProfileScreen` shows a "Message" button only when a booking connects the two users. `FindPeopleScreen` (`FindPeople` route in Messages+Profile stacks; entry points: Messages header search icon, Profile → Grow → Find People) searches profiles by name/username (`ilike`, respects `blockedIds`).

- **Tab route names (`HomeTab`/`EarnTab`/`GigsTab`/`MessagesTab`/`ProfileTab`) are intentionally kept even though display labels are Browse / My Jobs / Hire / Messages / You** — the route names are a wire protocol, not just internal: `send-push`'s `KNOWN_TABS` and the `data.tab` field of every push notification depend on them, so renaming a route silently breaks notification deep-links. Many `navigation.navigate('EarnTab'|'GigsTab'|'ProfileTab', …)` calls depend on them too.
- Cross-tab navigation from nested stacks: `navigation.navigate('EarnTab')` — React Navigation bubbles up automatically.
- `AppNavigator` is a component rendered *inside* providers so it can call `useJobs()` for tab badge counts — this is why `NavigationContainer` is not at the root.
- `AchievementToast` renders outside `NavigationContainer` but inside `SafeAreaProvider`.
- Never use `Alert.alert` for navigation/success flows — it's unreliable on web. Use `showToast()` from `UserContext` instead.

## State Management

### AuthContext (`src/context/AuthContext.js`)
`session`, `user`, `loading`, `onboardingResolved`, `authError`, `onboardingDone`, `pendingEmail`, `needsTermsAcceptance`, `needsMfaChallenge`, `mfaResolved`, `clearMfaPending`. Functions: `signIn`, `signInWithGoogle`, `signInWithApple`, `signUp`, `resetPassword`, `resendConfirmation`, `clearPending`, `clearError`, `signOut`, `markOnboardingDone`, `markTermsAccepted`.

**Email verification is ON** (Supabase `mailer_autoconfirm=false`; `gohustlr://**` is whitelisted in the auth redirect allow-list). `signUp()` returns no session — it sets `pendingEmail`, and `AuthScreen` shows a "Verify your email" panel with a Resend button. `signIn()` maps the `email_not_confirmed` error to a friendly message + sets `pendingEmail`. `onboardingDone` is derived from the profile's `onboarding_done` column **on every session establishment** (`loadOnboarding`), so a freshly-confirmed user's first sign-in still routes through onboarding while returning users skip it.

**Google sign-in is native-first**: `signInWithGoogle` uses `@react-native-google-signin/google-signin` + `supabase.auth.signInWithIdToken` (like the Apple flow — no browser session, so iOS never shows the "wants to use …supabase.co" prompt). It requires (1) the native module in the binary (dev-client rebuild), (2) real client IDs in `app.json` → `extra.googleAuth` (`webClientId` = a Google Cloud **web** OAuth client that must also be listed under Supabase Auth → Providers → Google → "Client IDs"; `iosClientId` = the iOS OAuth client for `com.gohustlr.app`, whose **reversed** ID goes in the plugin's `iosUrlScheme`; Android needs an Android OAuth client with the release SHA-1 registered in the same Google Cloud project — nothing extra in the app config). The module is lazy-`require`d (its import throws when the native side is missing), so **older binaries / Expo Go / web automatically fall back to the browser PKCE OAuth flow** (`signInWithGoogleBrowser`). `REPLACE`-placeholder IDs count as unconfigured → fallback.

### UserContext (`src/context/UserContext.js`)
XP, streak, earnings, goals, challenges, badges, toast queue. Cache-first load from Supabase (AsyncStorage TTL via `src/lib/cache.js`). Debounced 2s sync (`scheduleSyncProfile`) for **xp, role and weekly goals** — earnings are NOT client-writable, `guard_profiles_write` pins `earnings_today/week/total` for owner writes. Branch on `profileStatus` ('loading' | 'ready' | 'error'), never render the DEFAULT_STATE placeholder as real data. Key exports: `addXP`, `updateChallenge`, `unlockBadge`, `setRole`, `setGoals`, `showToast`, `dismissToast`, `refreshProfile`. Call `refreshProfile()` after any external Supabase profile update to keep the UI in sync. **"Jobs Done" is derived from bookings (`completed`/`verified` statuses), never a counter bumped at apply time** — the old `recordApply`/`weekly_jobs_done` increment-on-booking was removed because it showed unconfirmed applications as done work.

### JobsContext (`src/context/JobsContext.js`)
Jobs, bookings (earner view), posterBookings (poster view), myPostedIds. Cache-first job loading. Key exports:
- `bookJob(jobId, slotId, slotLabel, counterOffer, applicationNote)` — earner books a slot
- `addJob(jobData)` — poster creates a listing
- `updateJob(jobId, patch)` — poster edits a listing. Slots are **reconciled, never delete-then-reinsert**: re-inserting minted new slot ids and blanked live bookings' `slot_id` via the FK
- `deleteJob(jobId)` — soft-delete (sets `status: 'cancelled'`)
- `acceptBooking / declineBooking / cancelBooking / markJobComplete / verifyAndRate` — booking lifecycle (`cancelBooking` releases the escrow hold + notifies)
- `blockUser(id)` / `blockedIds` (Set) — block a user; blocked posters' gigs are filtered out of Browse. Reports/blocks via `src/lib/moderation.js`
- `proposeAmendment(bookingId, note)` / `respondToAmendment(bookingId, accept)` / `clearAmendment(bookingId)` — amendment flow
- `ratePoster(bookingId, { rating, reviewText })` — earner rates a poster after completion (OBJECT second arg, same on web)
- `isBooked(jobId)`, `bookedJobs`, `postedJobs`, `earnBadgeCount`, `profileBadgeCount`

`transformJob(dbJob)` includes `posterId: dbJob.poster_id` — used in `JobDetailScreen` to block self-booking (`job.posterId === user.id`).

Realtime: three Supabase channels per session — `bookings-user-${user.id}` (earner), `poster-bookings-${user.id}` (poster; broad subscription that calls `loadPosterBookings()` on any change), and `messages-unread-${user.id}` (feeds `unreadMessages` and the Messages tab badge).

### Push notifications (`src/lib/push.js`)
Expo push. `registerPushToken(userId)` (called from `PushManager` in `App.js` on login) requests permission, gets the Expo token via `extra.eas.projectId`, and upserts into the `push_tokens` table (owner RLS). `unregisterPushToken` runs on sign-out. `notify(userId, title, body, data)` POSTs to the `send-push` edge function (service-role lookup of the recipient's tokens → Expo push API, prunes dead tokens). Triggers live at the booking/message events in `JobsContext` (book/accept/decline/mark-done/verify/rate/amend) and `MessageSheet.sendMessage`; `data.tab` routes the tap to a tab (the values must match `send-push`'s `KNOWN_TABS` — see the tab-route-name note above). `expo-notifications` is a dependency **and** a registered config plugin in `app.json`, so the native module **is** compiled into the current dev-client / TestFlight binary — no rebuild is outstanding. Remote push still needs a real device: `push.js` returns `null` on simulators via `Device.isDevice`, and plain Expo Go on SDK 54 cannot receive Android remote push.

## Key Screens

| Screen | Purpose |
|---|---|
| `HomeScreen` | Browse jobs with category chips, search, and full filter sheet (pay, days, location/state, pay type, urgency, sort). Pull-to-refresh. |
| `JobDetailScreen` | Job info, slot picker, counter-offer input, book button. Shows "This is your gig" banner if `job.posterId === user.id`. |
| `EarnScreen` (tab "My Jobs") | Earner hub — earnings dashboard + **Active / Awaiting / Completed** segmented control over booked gigs (Awaiting=pending, Active=confirmed+completed, Completed=verified+declined+cancelled). Mark-complete, message-poster, rate-poster, amendment response, weekly goals, challenges. Pull-to-refresh. |
| `GigsScreen` (tab "Hire") | Poster hub — Post New Gig button + **Active/Past** segmented control. Active = posted listings with expandable booking sections (accept/decline/verify/delete, amendment); Past = read-only verified/declined/cancelled booking history. Pull-to-refresh. |
| `PostJobScreen` | Post a new gig — LocationPicker + DateTimePicker + `CategoryPicker` (search the catalog, or create your own; your recent categories appear as quick chips). Times are optional: **no slots picked → a bookable "Flexible — Contact to Schedule" slot is attached** (a hint under the picker says so; EditJob applies the same fallback on save), so a gig can never end up slot-less/un-bookable. Nested in GigsStack. |
| `EditJobScreen` | Edit/delete an existing gig (navigate with `{ jobId }` params). Core terms (title, category, pay, payType, location, description) are **locked** once a booking is confirmed/completed; they unlock only if an amendment was accepted. |
| `ManageBookingsScreen` | Legacy poster booking view. **Registered in ProfileStack but unreachable** — nothing navigates to it; the last entry point was deleted in `bc5cc0a`. `GigsScreen` superseded it. Delete it or re-link it; don't build against it. |
| `ProfileScreen` (tab "You") | Stats, badges, reviews received, "Manage my gigs" (→ Gigs tab), Payments, Tax Center, Saved gigs/people, identity + student verification, Settings link. **No sign out here — it lives only in Settings** (deliberate: it sat one mis-tap away on the most-opened tab). No role toggle — every user can both earn and post. Pull-to-refresh. |
| `ExpensesScreen` (Tax Center) | Full tax tracker — **Expenses / Income** segments, year net-profit summary (Stripe earnings + logged cash income − expenses) with a ~27% set-aside hint, add expense (category/receipt → `receipts` bucket) or cash income (`income_entries` table), delete, and a combined year-end **tax summary CSV** export via Share. Helpers in `src/lib/expenses.js`. Nested in ProfileStack as `Expenses`. |
| `PaymentsScreen` (route `Payments`, nav title **Transactions**) | The money ledger, both sides. Earnings / Spending segments, range + status filters, six-month trend, per-transaction receipt showing THAT booking's pinned fee rate, CSV export, and Bank deposits with real Stripe arrival dates. Registered in Earn/Gigs/Profile stacks. |
| `SupportScreen` (route `Support`) | In-app two-way support. **ONE implementation** registered in MessagesStack + ProfileStack — do not add a second. Thread switcher is the title; actions live in the ⋯ menu. |
| `SecurityScreen` (route `Security`) | Two-factor: enroll (deep-link first), recovery codes, disable (requires a current code). Prompted from PayoutSetup once a bank is connected. |
| `MfaChallengeScreen` | The sign-in code prompt. Rendered by `RootNavigator` BEFORE onboarding/terms — not a stack route. Carries the "I've lost my phone" recovery path. |
| `LegalScreen` | Renders Terms / Privacy / Independent Contractor Agreement (route param `doc`) fetched from the `legal_documents` table. See **Legal docs** below. |
| `PublicProfileScreen` | Anyone's profile (route param `userId`): combined rating + **worker/client breakdown**, bio, skills, their open gigs (→ JobDetail), recent completed work, and all reviews. Registered as `UserProfile` in every stack; reached by tapping a poster (JobDetail) or an earner (Hiring rows). |
| `SettingsScreen` | Settings **hub** — a searchable list of rows grouped Account / Money / Notifications / Saved / Legal & support / Account actions. It only navigates; it edits nothing. **Sign out lives here**, deliberately not on ProfileScreen. |
| `ProfileSettingsScreen` (route `ProfileSettings`) | The actual profile editor — avatar, name, username, bio, role, location, radius, skills. Saves to Supabase and calls `refreshProfile()`. |
| `OnboardingScreen` | Multi-step: Welcome → Username+DOB → Role → Location → Skills/Radius → Done. DOB uses `DobPicker` (Month/Day/Year dropdowns, `composeDob` → `parseDob`). Saves all fields + `onboarding_done: true`. |
| `FindPeopleScreen` | Search people by name/@username → tap through to `UserProfile`. Registered as `FindPeople` in Messages + Profile stacks. |
| `AuthScreen` | Sign-in / Sign-up (with confirm password) / Forgot password tabs. |

## Key Components

- **`FilterSheet`** — bottom-sheet modal with sort, pay range, pay type, available days (parsed from slot labels), location/state chips, urgency toggle. Props: `visible`, `filters`, `availableStates`, `mySchool`, `defaultCenterLabel`, `onApply`, `onClose`. Import `DEFAULT_FILTERS` and `countActiveFilters` from it.
- **`MessageSheet`** — realtime chat modal between earner and poster. Props: `visible`, `bookingId`, `jobId`, `jobTitle`, `otherPerson: { name, avatarInitial }`, `onClose`, `onViewProfile`, `onViewJob`, `embedded` (default `false`). ⚠️ `visible` is required — the docs omitted it, so anything built from them rendered a modal that never appeared. Reads/writes `messages` table, Supabase realtime channel per `bookingId`.
- **`CompletionModal`** — poster "Verify & Rate" bottom sheet. Props: `visible`, `booking`, `onClose`, `onConfirm({ rating, reviewText, paymentMethod })`. Same omission as above: `visible` and `onClose` were missing.
- **`LocationPicker`** — live city autocomplete backed by the photon.komoot.io geocoder (worldwide, not a fixed list), plus a "use my location" reverse-geocode via `expo-location` and the remote presets `Remote` / `Zoom / Remote` / `Work from Home`. Controlled: `value` + **`onChange(label, coords)`** — the second argument carries `{ lat, lng }` and is what populates `jobs.lat`/`lng` for distance sort and the map.
- **`DateTimePicker`** — day chips + time grid producing `slots[]`. Use for posting and editing.
- **`SlotPicker`** — single-select chip row from existing `slots[]` (used in JobDetail). Props: `slots`, `selected`, `onSelect`.
- **`ScreenHeader`** — flat screen header, the replacement for the deleted gradient hero. Props: `children`, `style`, `topInset` (default `true`; pass `false` on pushed screens where the opaque native bar already cleared the status bar), `surface` (white instead of canvas). **There is no `GradientHeader` and no LinearGradient anywhere in the app.**
- **`AchievementToast`** — driven by `pendingToast` in UserContext.
- **`BookingStatusBadge`** — status pill: pending/confirmed/completed/verified/declined/cancelled. Props: `status`, `compact` (icon-only).
- **`PosterTrustCard`** — displays poster profile info and rating in JobDetailScreen.
- **`RatingStars`** — star rating DISPLAY. Props: `rating`, `size` (default 13). It is not an input — nothing in it takes a press handler, despite the old wording here saying "display/input".
- **`JobCard`** — job listing card used in HomeScreen and search results.
- **`Avatar`** — renders a user's photo (`url`) or the initial-letter circle fallback. Props `{ url, initial, size, bg, fontSize, borderColor, borderWidth, style }`. Used everywhere an avatar appears. Profile photos live in the public `avatars` storage bucket (`profiles.avatar_url`); upload via `src/lib/uploadImage.js` (`pickImage`/`pickImages` + `uploadImage`/`uploadImages`, which compress with expo-image-manipulator and upload an ArrayBuffer to Supabase Storage under `<userId>/…`).

### Images (Supabase Storage buckets)
**Three are public, four are private — do not assume `getPublicUrl` works.**
- `avatars` → `profiles.avatar_url` — **public**, rendered with `getPublicUrl`. SELECT is owner-scoped so anon cannot LIST the bucket (`20260725000000_storage_enumeration_lockdown.sql`).
- `job-photos` → `jobs.photos text[]` — **public**, same enumeration lockdown.
- `completion-photos` → `bookings.completion_photos text[]` — **PRIVATE** (`20260707010000`). Render with `<SignedImage bucket="completion-photos" …>`; `getPublicUrl` returns a URL that 400s.
- `chat-photos` → `messages.image_url` — **PRIVATE** (`20260701000000`). Same signed-URL rule.
- `receipts` → expense receipts (Tax Center) — **PRIVATE**.
- `certificates` → `certifications.image_url` — **public**, same enumeration lockdown.
- `support-photos` → `support_ticket_messages.images[]` and agent attachments — **PRIVATE**. Render with `<SignedImage bucket="support-photos" …>`.

All writes are owner-scoped under `<userId>/…` and go through `src/lib/uploadImage.js`.

⚠️ **`web/public/brand/wordmark-cream.png` looks unused and is not.** 15 Supabase auth email templates and `student-verify-start` hotlink it as `https://gohustlr.com/brand/wordmark-cream.png`. An import grep cannot see it; deleting it 404s the logo in every transactional email.
- **`XPBar`** — XP progress bar toward next level, used in ProfileScreen.
- **`BadgeGrid`** / **`ChallengeCard`** — achievement and challenge display in ProfileScreen.

## Support (in-app, two-way) — `src/lib/support.js`

Tickets live in **`support_tickets`** + **`support_ticket_messages`** (owner RLS, both
guarded). `SupportScreen` is the conversation; the admin console queue is `/support`.

- **Threads are PER TOPIC, and that is forced by the schema** — `priority` and
  `booking_id` are both per-ticket and safety is urgent by definition, so one lifelong
  thread could not carry a routine question and a safety report without mis-routing one.
- `pickActiveTicket` / `groupTickets` (in `src/lib/support.js`, unit-tested) decide which
  thread is shown: **unread wins over status**, because an agent's note on a resolved
  thread deliberately leaves it `closed`.
- **A user reply REOPENS a closed ticket** and un-archives it. Archiving is the user's
  inbox preference; closing is the team's workflow state. Never conflate them.
- ⚠️ **`guard_support_ticket_write` must keep the `app.support_reopen` exemption.** The
  message trigger's rollup UPDATE re-enters it; without the exemption every user reply
  stops moving `last_author`, and the console queue and SLA control go blind. This has
  been dropped by TWO separate rewrites — `__tests__/supportGuardDrift.test.js` and
  `ctl_ticket_rollup_stale` both exist because of it.
- Agents can **open** a thread (`openThreadWithUser`, support tier): recipient resolved
  server-side, cold contact is in-app + push only (never branded email), never merges
  into a user's own safety report, rate-limited from the append-only `admin_audit_log`.

## Transactions — `src/lib/payments.js`, `PaymentsScreen` (route `Payments`, title "Transactions")

`payments` rows rendered as a statement for whichever side the reader is on.
`fetchLedger` runs TWO queries on purpose: RLS exposes a row through either the earner
or the poster policy and a single select cannot tell which side the reader is on — that
is the difference between "you earned $54" and "you paid $60".

- Amounts come from the payment row, **never re-derived from the current rate card**.
  A past transaction shown at today's rate misstates what the person received.
- **Bank deposits**: capture is a destination charge, so funds reach the earner's Connect
  account immediately and Stripe pays out on its own schedule. `stripe_payouts` stores
  `payout.*` webhook events (Connect destination) so arrival dates are real Stripe data.
  It deliberately does NOT claim which gig is in which deposit — Stripe batches transfers.
  Requires `payout.created/updated/paid/failed/canceled` enabled on the Connect webhook.

## Two-factor — `src/lib/mfa.js`, `SecurityScreen`, `MfaChallengeScreen`

Optional for users, enforced where it protects money.

- **Enrollment is deep-link-first, not QR.** A phone has one screen and cannot
  photograph itself; `otpauth://` handed to the OS is the only route that works.
- **Recovery codes are generated AT enrollment, not offered later** — 2FA without a way
  back in turns a lost phone into a lost account. Redeeming one REMOVES the factor
  (a code cannot mint aal2), dropping the account to password-only.
- **Step-up** (`_shared/stepUp.ts`): minting a Stripe payout dashboard link or starting
  Connect onboarding requires aal2 **if the account has a factor**; no factor ⇒ allowed,
  because locking someone out of their own bank details for not enrolling is the same
  "our posture, their cost" mistake. Opening payout settings emails the account holder.

## Hustlr AI — `supabase/functions/assistant`

A Claude tool-use loop behind the floating `AssistantButton`. Tools run under the
**user's own token**, so RLS bounds everything; service role is used only for auth,
rate limiting and staging.

- ⚠️ **`create_gig` and `book_gig` do NOT perform the action.** They validate, stage the
  parameters in `assistant_pending_actions`, and return a one-shot id through the
  `actions` side-channel — which the model never sees. The user taps a card rendered
  from the SERVER's summary. Injected gig text can make the model stage something; it
  cannot produce the tap. Do not "simplify" this back into a prompt instruction.
- **Its system prompt is a parity-tested artifact.** `__tests__/parity.test.js` fails if
  the prompt does not name every tab as the app names it, or cannot point at
  Transactions, bank-deposit timing, Tax Center, Support, two-factor, escrow and who
  pays the fee. **Adding a user-facing feature means adding it to `MUST_KNOW` there.**

## A feature is not finished when the mobile screen works

Everything this platform does eventually needs a **person** to see it. Before calling any
user-facing feature done, ask what the other three surfaces need — this is not a
checklist to be polite about, it is where the actual failures have come from.

| Surface | Ask |
|---|---|
| **Admin console** (`admin/`) | Can a human see and act on this? A new object usually needs a page or a column on an existing one. **It does NOT auto-deploy** — `cd admin && npx vercel --prod`. |
| **Controls** | What silent wrong state can this create? Write a `ctl_*` function AND register it in `controls` — `run_all_controls` iterates the REGISTRY, so an unregistered check never runs and the board still shows green. `__tests__/adminSurface.test.js` fails on an unregistered control and on a console page missing from `Nav.tsx`. |
| **Errors** | Client crashes reach `captureError` → `log-client-error` → `client_errors` → console **`/errors`**. New edge functions should `console.error` on failure; nothing else surfaces them. |
| **Web** (`web/`) | Does the same flow exist there? `shared/` is the single source for pricing, categories, lifecycle and transforms — put logic there, not in one client. |
| **Hustlr AI** | If users will ask about it, add the destination to `MUST_KNOW` in `__tests__/parity.test.js`; that test fails until the assistant's prompt knows it. |

**Money features carry an extra obligation.** Anything touching payments, refunds,
tips, payouts, promotions or referrals needs: the amount **pinned** at booking (never
re-derived from the current rate card), a control asserting the invariant **against
data** rather than against the formula, and a rolled-back simulation proving the fix
discriminates — broken vs fixed on the same staged row. Every money bug found this week
was a formula that looked right and a number nobody asserted.

⚠️ **After ANY fix, ask what else touched that code path.** Adding step-up to payouts
broke payout setup for every user, because the new check queried a schema PostgREST
cannot see and failed closed. The fix was correct; the blast radius was not checked. Run
the gate, then exercise the actual screen.

## Unfinished work — read `OPEN_WORK.md` FIRST, and work it

**`OPEN_WORK.md` is the backlog that outlives a session, and it is not optional reading.**

Two audits this week produced 108 confirmed findings. One set lived only inside a Claude
session transcript; the other in a file under `/tmp`. Both were invisible to the next
session — which is exactly how "we fixed x and y" becomes "z never got done", and how the
owner ends up being the only memory the project has.

**A session that finishes what it was asked does not stop. It opens `OPEN_WORK.md`, takes
the highest-severity open item, and keeps going** — verify against live `pg_proc`/production
BEFORE believing the description, fix with a migration that asserts its own effect, prove
the fix discriminates (broken vs fixed on the same staged row, rolled back), run the gate,
move the row to Closed. Ask only when a fix would change money already owed to a real
person, or needs a product decision that cannot be inferred.

`__tests__/openWork.test.js` fails if the register drifts out of shape or stops being
referenced here, so it cannot quietly rot.

⚠️ **Findings do not count until they are in that file.** An audit that ends in a
transcript, a `/tmp` file or a chat message has not been recorded — transcribe it.

## The other documents in this repo (read the relevant one BEFORE working)

Every one of these was orphaned until 2026-08-13: nothing in CLAUDE.md pointed at them,
so a new session never learned they existed and rediscovered — or re-broke — what they
already record. `__tests__/docIndex.test.js` now fails if a markdown file at the repo
root is not listed here, which is what stops that happening again.

| Read this | When |
|---|---|
| `KNOWN_RISKS.md` | **Before any beta/launch judgement.** The risk register — what is accepted, what is outstanding, and why. Cited elsewhere as e.g. "KNOWN_RISKS §5.6". |
| `LIFECYCLE_STATE_MACHINES.md` | Before changing booking, payment or dispute transitions. Every claim cited to `path:line`. |
| `PRE_LAUNCH_DATA_RESET.md` | **Before going live.** The runbook for wiping accumulated test activity from production so beta users start clean. |
| `BETA_QA_PLAN.md` | Before a TestFlight push — the manual QA passes that automated tests do not cover. |
| `ADMIN_AUDIT_2026-08-04.md` | Before touching the admin console; also records residual risks deliberately left open. |
| `DEPLOY.md` | Deploying the **website** + the gohustlr.com domain. |
| `DEPLOYMENT.md` | The broader launch runbook (its own status snapshot is older than the file's git date — trust the code). |
| `LAUNCH_PLAN.md` | Sequencing for launch. Self-reported date is stale; verify before relying on it. |
| `NOTIFICATIONS_SETUP.md` | Push/email provider steps that need a human (accounts, secrets). |
| `APP_STORE_LISTING.md` | App Store Connect copy. Apple ID `6790460957`. |
| `CLAUDE_MD_DRIFT.md` | **When editing CLAUDE.md, or wondering why a new session got something wrong.** The measured diff between this file's claims and the code: 79 undocumented surfaces, 33 assertions that are false. Every surface is mechanically enumerable, so it is the spec for a drift test, not a cleanup list. |
| `ATTACK_FINDINGS.md` | **Before trusting any money path.** 23 UNVERIFIED candidates from an adversarial attack on promotions, referrals, refunds, capture and the admin console after the stripe@22 upgrade. The refutation pass did not finish — verify before acting. One is confirmed and fixed. |
| `OPEN_WORK.md` | **Every session, first.** Confirmed-but-unfixed findings, worked highest-severity-first without being asked. |
| `AGENTS.md` | Three lines, and they matter: read the **versioned** Expo SDK 54 docs before writing Expo code. |
| `RUNBOOK_MONEY.md` | **What to do when money goes wrong.** Read before touching payments, and follow it when something has already broken. |
| `RUNBOOK_SAFETY.md` | What to do when a person is at risk, or a person *is* the risk. |
| `ROLE_PERMISSION_MATRIX.md` | Who may do what to which object — check before changing any policy, guard or admin tier. |
| `PRODUCT_FLOW_MAP.md` | End-to-end user flows, cited to `path:line`. Read before changing a flow you have not personally walked. |
| `ROADMAP.md` | Where the product is heading and what blocks a customer-ready trial. |
| `TESTFLIGHT.md` | The shipping + security checklist for a TestFlight build. |

⚠️ **Several of these carry a self-reported "Verified <date>" line that is older than
their last edit.** Where a doc and the code disagree, the code wins — and fix the doc.

⚠️ **Not every finding lives on disk.** A read-only payments security audit on
2026-08-12 produced ~72 findings clustered into 6 root causes and **nothing was fixed**;
that report exists only inside its own Claude session transcript. Other sessions can be
searched from a new session — this is worth doing before a payments change. Anything
worth keeping should be written into `KNOWN_RISKS.md` rather than left in a transcript.

## Definition of done (this is enforced, not aspirational)

**The obligations nobody remembers are tests, not prose.** This file itself carried the
amendment direction BACKWARDS for months and survived several audit rounds — a document
cannot be trusted to stay true, so anything that must stay true is asserted in
`__tests__/` and fails loudly. When one of these fails it is not the test being fussy;
it is the second half of a change that has not been done yet.

| Guard | Stops |
|---|---|
| `parity.test.js` | tab routes drifting from `send-push`'s `KNOWN_TABS` (breaks every push deep-link, silently, on device only) · **Hustlr AI's prompt going stale** — it must name every tab as the app names it and be able to point at Transactions, bank-deposit timing, Tax Center, Support, two-factor, escrow, and who pays the fee · brand colours drifting between `shared/theme.js` and `web/app/globals.css` |
| `categories.test.js` | JS `categorySlug()` ≠ SQL `category_slug()` |
| `pricing.test.js` | `shared/pricing.js` ≠ the fee migration |
| `supportGuardDrift.test.js` | a guard rewrite dropping the `app.support_reopen` exemption (has happened twice; makes customer replies invisible to the support queue) |
| `importIntegrity.test.js` | a JSX component used but never imported — Metro does not resolve free identifiers, so this passes `expo export` and crashes on open |
| `headerDuplication.test.js` | a screen printing its nav-bar title a second time in its own header |
| `assistantGate.test.js` | the assistant's confirmation gate degrading back into a prompt instruction |
| `ledger.test.js`, `mfa.test.js` | money wording/maths and the 2FA sign-in gate |

**Adding a user-facing feature? The parity suite will tell you what else it touches.**
Add the destination to `MUST_KNOW` in `parity.test.js` and it fails until Hustlr AI
knows about it — that is the cheapest reminder available, and it is why the assistant
prompt is no longer months behind the app.

### Pre-push hook (`.githooks/pre-push`, `core.hooksPath` is set)
Runs the suite and then prints the reminders that no test can produce, because they are
about deployment rather than code:
- `admin/` changed → **does not auto-deploy**, `cd admin && npx vercel --prod`
- `supabase/functions/` changed → deploy each one by hand
- `supabase/migrations/` changed → `db push` BEFORE shipping app builds that read new columns
- native config changed → an OTA will **not** carry it; it needs a new build
- otherwise → JS-only, ships over the air

A fresh clone needs `git config core.hooksPath .githooks` once.

### What is deliberately NOT automated
No agent rewrites code, prompts or migrations unattended. In a single day of supervised
work this session dropped a `WHERE` clause from a control, shipped a screen missing an
import, and broke the MFA gate so a correct code hung the app — each caught because a
person or an assertion was in the loop. Unsupervised, those land at 3am. Production
monitoring is already continuous and does not need an agent: 47 `controls` run hourly
via pg_cron with a daily digest.

## Monitoring & analytics

`src/lib/analytics.js` — pluggable `track(event, props)`, `captureError(error, ctx)`, `identify(userId)`. Currently logs in dev + keeps a ring buffer; set `SENTRY_DSN` / `ANALYTICS_KEY` and forward in the marked spots to enable real Sentry/PostHog (native SDKs need a dev-client rebuild). A root `ErrorBoundary` (`src/components/ErrorBoundary.js`, wrapping the app in `App.js`) catches render crashes and reports via `captureError`. Funnel events fire from AuthContext (`sign_in`/`sign_up`) and JobsContext (`gig_posted`, `booking_created`, `booking_accepted`, `job_verified`); `identify` runs on login in `PushManager`.

## Caching

`src/lib/cache.js` wraps AsyncStorage with a timestamp TTL. Pattern used everywhere:
1. Show cached data instantly on mount.
2. Fetch fresh from Supabase in the background.
3. Update state and re-cache on fresh data arrival.

Invalidate a cache entry with `cacheSet(key, null)` after a write. All major screens also support **pull-to-refresh** via `RefreshControl` that triggers a full reload bypassing cache.

## Theming

**`shared/theme.js` is the single source of design tokens** — `src/theme.js` is a bare `export * from '../shared/theme.js'`, so edit tokens THERE. The web app mirrors the same values by hand as Tailwind v4 `@theme` custom properties in `web/app/globals.css`; keep the two in lockstep.

Brand v3.0: primary `#5038FF`, primaryDark `#2E1BC7`, primaryLight `#EAE6FF`, secondary `#6B54FF`, urgent `#EA4637`, background `#F7F4EC`, textPrimary `#363636`, success `#15803D`. `radii.sm/md/lg/xl/pill` and `shadows.sm/md/card` unchanged.

**Hustle Orange is retired and the `colors.accent*` / `colors.gold*` keys no longer exist.** The four jobs that one amber used to do are now named separately: `warning`/`warningLight`/`warningDeep` (lifecycle "awaiting action"), `wash`/`washDeep` (money + badge surfaces), `rating` (review stars — a score is not a warning), and `primary` (gamification). Tailwind v4 emits **no utility at all** for an undefined token, so a stale `accent-*`/`gold-*` class fails silently as `currentColor` rather than erroring — grep CSS and TSX, don't trust the build.

`gradients`/`cssGradients` are still exported but nothing imports them on either platform; `expo-linear-gradient` was removed and there are zero LinearGradient usages left. Never reintroduce one in `src/`.

Category colors come from `categoryColor(value)` in `shared/categories.js` (see **Categories & skills** below), not a lookup table. `src/data/mockData.js` re-exports `shared/constants.js`, which holds `BADGE_DEFS`, `BADGE_GROUPS` and `LEVELS`.

## Categories & skills (one taxonomy, DB-backed)

Job categories, profile skills and job tags all draw from **one** vocabulary. It replaced seven hardcoded labels (Tutoring/Delivery/Moving/Tech Help/Creative/Odd Jobs/Errands) and a 20-item hardcoded `SKILL_OPTIONS` list that was duplicated in four files.

- **`shared/categories.js`** is the contract: `categorySlug`, `resolveCategorySlug`, `findCategory`, `categoryLabel`, `categoryColor`, `categoryIcon`, `categoryBaseRate`, `sameCategory`, `validateCategoryLabel`, `normalizeCategoryInput`, `searchCategories`, `categoriesByGroup`, `browseChipsFromJobs`. It seeds ~200 canonical categories across 19 groups.
- **`slug` is the identity; `label` is display only.** Filter, group, match and aggregate on the slug — never compare labels with `===`, never hand-lowercase. Use `sameCategory()`.
- **`categories` table** — `status` is `canonical` (seeded) · `community` (user-created, live immediately) · `merged` (a spelling folded into `merged_into`) · `reserved` (`all`/`foryou`, so a user category can never collide with a control value). Select+insert for authenticated; **no update/delete policy** — curation is service-role only, via the admin console's **Categories** page (promote / rename / merge).
- **The DB normalizes every write.** `trg_y_normalize_job_category` snaps `jobs.category` to the canonical label, fills `jobs.category_slug`, and mints a `community` row for a genuinely new value — so mobile, web, the assistant edge function and any older app build all land on the same value. `"lawn care"`, `"Lawn Care"` and `"LAWNCARE "` are one category.
- **`profiles.recent_category_slugs`** (last 8, most recent first) is maintained by trigger on job insert and read via `my_profile()`. It powers the "your recent categories" chips in every picker.
- `categorySlug()` in JS and `public.category_slug()` in SQL **must** stay byte-identical; `__tests__/categories.test.js` parses the migration and fails if the two drift.
- The seed is **generated**: edit `shared/categories.js`, then run `node scripts/gen-categories-migration.js`. Never hand-edit `supabase/migrations/20260805000000_dynamic_categories.sql`.
- Data layer: `src/lib/categories.js` (mobile) and `web/lib/categories.ts` (web) expose the same `fetchCategories({force}) → {list, aliases, bySlug}` and `ensureCategory(label) → {slug, label}`. Both fall back to the seed catalog on any fetch failure, so a picker is never empty offline. UI: `CategoryPicker` on both platforms (`multiple` mode is the skills picker).
- **Deploy order: push the migration before shipping app builds.** New builds select `jobs.category_slug`; without the column PostgREST fails the whole jobs query. The migration is backwards-compatible in the other direction — older builds keep working because `jobs.category` still holds the label.

## Haptics

Always use `src/hooks/useHaptic.js` — guards against web (`Platform.OS === 'web'` returns no-ops). Never call `expo-haptics` directly.

## Platform fee, promotions & incentives (2026-08-06)

**The take rate is data, not a constant, and it is PINNED per booking.** It used to be
a `0.10` literal in seven places across three deploy targets.

⚠️ **The standing rate has been 700 bps (7%) since 2026-08-12** ("expedited beta
testing"). 1000 bps is the FOUNDING rate and remains the fallback everywhere, so any
degraded path quotes 10% while live bookings pin 7% — never infer the current rate from
a code default.

⚠️ **The pinned rate is LOWEST-WINS across three sources**, not just the rate card:
`fee_bps_at()` (standing rate) · `tier_fee_bps(earner)` (`fee_tiers`, a loyalty ladder
keyed on verified-booking count) · an active `fee_override` promotion grant.

- **`platform_rates`** — effective-dated rate card in **basis points** (1000 = 10%).
  Append-only: change the rate by inserting a future-dated row. `fee_bps_at(at)` reads
  it, clamped to `[500, 3000]`, defaulting to 1000.
- **`public.platform_fee_cents(amount_cents, fee_bps)` is the ONE definition of the
  fee.** All four money paths call it by RPC rather than reimplementing it. It rounds
  **half up** (`(amount*bps + 5000)/10000`) to match `Math.round` in the JS it replaced —
  plain integer division truncates and disagrees by a cent on odd amounts — and floors
  at Stripe cost (`ceil(amount*0.029) + 30 + 25`), capped at the amount.
- **FOUR immutable inputs, pinned at booking INSERT** by `trg_z_pin_booking_amount`:
  `bookings.amount_cents_quoted`, `fee_bps_quoted`, `fee_credit_cents`,
  `poster_discount_cents`. `payments` inherits three of them — `fee_bps`,
  `fee_credit_cents`, `poster_discount_cents` — via `trg_z_pin_payment_fee_bps`; it has
  no copy of `amount_cents_quoted` because its own `amount_cents` IS the authorized hold. **This is why capture is
  idempotent** — the fee derives only from values that cannot change, which is the
  property `stripe-capture-payment` depends on (a retry after a partial capture would
  otherwise scale an already-reduced fee again, `fee * pct²`).
- **A rate change never re-prices an existing booking.** Verified: rate moved to 5%
  mid-test, the existing pin stayed at 1000.

**Display**: `shared/pricing.js` (`platformFeeCents`, `earnerNetCents`, `feeLabel`,
`bookingNetDollars`) with `__tests__/pricing.test.js` **parsing the migration off disk**
so JS/SQL cannot drift — the same guard `categories.test.js` applies to `category_slug`.
Quote screens use `getFeeBps()` (the current rate); anything showing an existing booking
uses **that booking's `feeBpsQuoted`**. Using the wrong one is a disclosure bug.
`SERVICE_FEE_PCT` still exists in both clients but has **no consumers** and resolves to
the founding rate.

⚠️ **The fee comes out of the EARNER's payout**, not added to the poster's charge
(`earnerAmountCents = amountCents - feeCents`). So a fee discount is a *supply-side*
incentive; it does nothing for posters.

### Promotions
`promotions` (campaign) → `promo_codes` (redeemable strings) → `promo_grants` (a user's
claim, with the benefit **snapshotted**) → `promo_redemptions` (which grant paid for
which booking). `kind` is `fee_override`, `bonus` or `poster_discount` (the first and last are mutually exclusive shapes, enforced by `promotions_kind_shape`). A **fee** discount is supply-side and does nothing for posters — `poster_discount` is the demand-side lever, and it reduces what the poster is charged.

- **Three ways one ends**: `ends_at` passes (**no action required** — the default and
  the one that matters), `status='paused'`, or `app_flags.promotions_enabled=false`.
  Ending one **never re-prices agreed work** — the benefit is on the grant and the pin.
- **Loss is bounded by construction**: `budget_cents` + `max_redemptions`, enforced by
  `consume_promo_grant` where **the increment IS the check** (one `UPDATE … WHERE
  spent + hit <= budget`), never read-then-decide.
- **Stacking dies at two unique indexes**: one grant per user per promotion, one
  redemption per booking.
- `redeem_promo_code(code)` takes **only a string**, returns only true/false (distinct
  errors would be an existence oracle), and is rate-limited off
  `promo_redeem_attempts` — **attempts, not successes**, or a brute-force sweep that
  only ever fails would never register.
- An exhausted budget **still lets the booking succeed** at the standing rate.

### Referral bonuses
`bonus_ledger`, **vest-on-outcome**: created when the *referred* person's gig reaches
`verified`, `payable` only after a 7-day window with no refund and no open dispute
(`vest_bonuses()`, run at the top of every control sweep). Farming requires doing real
work and paying real fees on both sides.

Delivered as a **fee credit** — `consume_fee_credit` spends only the headroom between
the fee and the floor, splitting the remainder back onto the ledger. We never pay
Stripe's processing to honour a credit. **`bonus_cash_payout_enabled` is OFF**; cash is
the classic farming target.

Console: **`/pricing`** (rate card + loyalty tiers) and **`/promotions`** (campaigns,
codes, budget burn-down) — both admin only.

## Controls (scheduled invariant checks)

**The engine is in Postgres, not the console.** A check that runs in a Next.js route
only runs when a human opens a page.

- `controls` (registry) · `ctl_*()` functions (the checks, defined in migrations) ·
  `control_findings` (one row per violating entity, open/resolved) · `run_all_controls()`.
- **`pg_cron`**: `controls_sweep_and_page` hourly at `:05` (vesting, then all controls,
  then pages **only if something newly needs a human**), `controls_digest` daily 13:05
  UTC (always emails, with Claude triage via `controls-alert`).
- Controls are **functions, never SQL text in a table** — a stored executable body would
  hand anyone with console write access arbitrary `SECURITY DEFINER` execution.
  `run_control` validates `fn_name` against `^ctl_[a-z0-9_]+$` **and** `pg_proc`.
- Findings are unique on `(control_key, entity_id) where resolved_at is null`, so a
  persisting violation stays ONE row; anything a control stops returning **auto-resolves**.
- **A control that errors or goes stale is reported as loudly as a violation** — both
  mean you are no longer being told the truth.
- Alert dispatch config lives in **`app_flags`**, not a GUC. A GUC is invisible, needs
  superuser (so `db push` cannot set it), and cannot be read back — which is exactly how
  `trg_notify_safety_report` sat dead from 2026-07-10 until 2026-08-06 without one alert
  ever firing. Config in a table can be **asserted on**.
- **Disabling a control is a MUTE, not a switch.** `enabled = false` requires a
  `disabled_until` (default 24h) and `reenable_expired_controls()` runs at the top of
  every sweep, so a control cannot be quietly switched off forever.
- One registry row is `external = true` (`stripe_reconciliation` → the `reconcile-stripe`
  edge function, dispatched by the sweep); `run_all_controls` filters it out.
- The hourly sweep also runs `expire_stale_pending_bookings(14)` — untouched,
  never-started bookings with no live Stripe authorization become `cancelled` and their
  slots are freed.
- Console: **`/controls`**.

## Admin console roles

Four **ranked** tiers (`admin/lib/guard.ts`, `roleSatisfies`): `support` (tickets, a
user's own context) · `trust` (moderation + disputes **with resolve authority**) ·
`finance` (payments, refunds, escrow) · `admin` (everything + team, flags, pricing,
promotions). **`trust` and `finance` are peers**, neither outranks the other.

`trust` exists because `resolveReport` used to need full `admin` while
`earner-claim-payment` refuses to settle a booking with an open report — one person's
availability was a money-harm control.

MFA (AAL2) is re-verified **on every request** from the JWT claim, and money- or privilege-moving actions additionally require **step-up** (`requireFreshAdmin`, factor satisfied within 5 minutes). Membership lives in `admin_users`; **`status` gates, not just membership** — a row starts `pending` and grants nothing until approved. Login throttle:
5 failures per account / 15 min, or 20 per IP. Nav hides what a role cannot open, but
**the guard is the enforcement** — if they disagree the guard wins.

⚠️ **`gohustlr-admin` does NOT auto-deploy.** See the Commands block.

## Booking Lifecycle

```
pending → confirmed → completed → verified
        ↘ declined    (poster refuses a pending booking)
        ↘ cancelled   (either party, from pending or confirmed, only before the earner
                       marks started — releases the escrow hold)
```
- Earner books → `pending`
- Poster accepts → `confirmed` — **not a client write.** `acceptBooking` calls the service-role `accept-booking` edge function, which confirms ONLY if a real Stripe escrow hold exists. Poster declines → `declined`
- Earner claims a ghosted gig → `verified`. `claimEarnerPayment` → `earner-claim-payment` settles a `completed` booking the poster never verified; it refuses while a report is open (which is why `trust` has resolve authority).
- Earner marks done → opens the Finish sheet (optional **completion photos** uploaded to the `completion-photos` bucket → `bookings.completion_photos text[]`), then sets `earner_done = true`; if poster already done → status advances to `completed`. Photos are shown to the poster in `CompletionModal` and in both sides' history.
- Poster marks done → sets `poster_done = true`; if earner already done → status advances to `completed`
- Poster verifies + rates → `verified` (inserts review, updates earner rolling rating)
- Earner rates poster → inserts a `reviews` row (`role='poster'`) and recomputes the poster's rating

**Reviews are two-sided.** Every rating (poster→earner in `verifyAndRate`, earner→poster in `ratePoster`) inserts a `reviews` row tagged with `role` (`earner` = reviewed for work; `poster` = reviewed as a client). `recomputeRatings(userId)` sets `profiles.rating`/`review_count` to the **combined** average across all roles (the general rating shown everywhere) and `poster_rating`/`poster_review_count` as the client cache. Profiles show a worker-vs-client breakdown.

**Mutual completion**: both `earner_done` and `poster_done` must be `true` before status becomes `completed`. Neither party alone can advance the status.

## Amendment Workflow

When a booking is `confirmed` or `completed` and the poster needs to change core job terms:

> ⚠️ **The direction is POSTER → EARNER.** This was documented backwards here for months
> and survived several audit rounds (KNOWN_RISKS §5.6). The code is authoritative and
> unambiguous: `proposeAmendment` is called from `GigsScreen` (the poster hub) and
> `respondToAmendment` from `EarnScreen` (the earner hub). It has to work this way — the
> poster is the one who wants to change their own listing, and the earner is the one whose
> agreed terms would change, so the earner is the one who must consent.

1. **Poster proposes** an amendment via `proposeAmendment(bookingId, note)` (`GigsScreen`) — sets `amendment_status: 'pending'` and `amendment_note` on the booking. Returns `false` if the note trips the prohibited-content filter.
2. **Earner responds** via `respondToAmendment(bookingId, accept)` (`EarnScreen`) — accept sets `amendment_status: 'accepted'`; decline sets `amendment_status: 'declined'`.
3. **If accepted**: `EditJobScreen` unlocks core fields (`canEditCore = true`) so the poster can update the job terms.
4. **If declined** or after editing: `clearAmendment(bookingId)` resets `amendment_status` back to `'none'`.

Amendment status values: `'none'` | `'pending'` | `'accepted'` | `'declined'`.

## Supabase Schema Notes

Profiles table has: `name`, `avatar_initial`, `username` (unique), `bio`, `role` (enum: `earner`/`poster`/`both`), `city`, `skills` (text[] of canonical category labels — see **Categories & skills**), `skill_rates` (jsonb: skill label → hourly rate; the keys must stay in step with `skills`), `recent_category_slugs` (text[], trigger-maintained, owner-private), `radius_miles`, `rating`, `review_count`, `poster_rating`, `poster_review_count`, `xp`, `earnings_total`, `onboarding_done`, `referral_code`, `verified` (bool — drives the Verified badge), `id_verification_status` (`none`/`pending`/`verified`/`rejected`), etc.

**ID verification** (`src/lib/verification.js`): `fetchVerificationStatus(userId)` / `requestVerification()`. Backed by **Stripe Identity**: `requestVerification()` calls the `stripe-create-identity-session` edge function (creates a document+selfie `VerificationSession` with `metadata.supabase_uid`, marks the profile `pending`, returns the hosted URL), which ProfileScreen opens via `Linking`. The `stripe-webhook` function handles `identity.verification_session.verified` → sets `verified = true` + `id_verification_status = 'verified'`; `requires_input` → `rejected`; `canceled` → resets to `none`. `stripe-identity-return` is the post-flow landing page. `profiles.stripe_identity_session_id` enables resume. ProfileScreen surfaces the status row + header badge. **Dashboard setup required**: enable Stripe Identity on the account and register the three `identity.verification_session.*` webhook events.

Jobs have `poster_id` FK to profiles, `category` (display label) + `category_slug` (the indexed identity everything filters and groups on — both maintained by `trg_y_normalize_job_category`), `tags` (text[], free-form, max 6), and a `recurrence` column (`none`/`weekly`/`biweekly`/`monthly`) — set in PostJob/EditJob, shown as a badge on JobCard/JobDetail, and duplicated via the "Duplicate" button in GigsScreen (`navigation.navigate('PostJob', { prefill: job })`). Bookings have `earner_id`, `job_id`, `earner_done` (bool), `poster_done` (bool), `amendment_status`, `amendment_note`, `earner_rating`, `poster_rating`, `poster_review`. RLS ensures earners see their own bookings and posters see bookings on their jobs.
