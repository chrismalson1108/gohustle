# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                       # Start Expo dev server (LAN mode, requires same WiFi as phone)
npx expo start --tunnel         # Start with ngrok tunnel (cross-network); kill all node/ngrok processes first
npm run web                     # Launch in browser at localhost:8081
npm run android                 # Launch on Android emulator
npm install --legacy-peer-deps  # Always use this flag when installing packages
npx expo install <package>      # Use instead of npm install for Expo packages (auto-picks SDK 54 version)
npm test                        # Jest unit tests (pure logic: contentFilter, geo, taxFormat) in __tests__/
```

## Legal docs (DB-driven, `src/lib/legal.js`)
Documents live in the **`legal_documents`** table (latest row per `slug` = current; slugs `terms`/`privacy`/`contractor`, public read). Acceptances are appended to **`legal_acceptances`** (one row per `slug`+`version`, owner RLS) — an audit trail. `AuthContext` gates the app (`ConsentScreen`) when `checkNeedsAcceptance()` finds a required doc whose current version the user hasn't accepted; onboarding records acceptance for new users. **To publish new terms + force re-acceptance: insert a new `(slug, version)` row** — no app release needed. Helpers: `fetchCurrentDocs`, `recordAcceptances`, `checkNeedsAcceptance`. `SUPPORT_EMAIL` lives here too.

## Location, tips & disputes
- **Location/maps**: jobs carry `lat`/`lng` (from the LocationPicker geocoder; `onChange(label, coords)`). HomeScreen computes distance via `src/lib/geo.js`, offers a **Nearest** sort + per-card distance, and a **Map view** (`JobsMap` / react-native-maps — native, needs the dev build).
- **Tips**: `CompletionModal` → `verifyAndRate(..., { tipCents })` → `stripe-tip` edge function (off-session charge → earner). `bookings.tip_amount`.
- **Disputes / partial refund**: `CompletionModal` "report a problem" sets a pay `pct` → `stripe-capture-payment` partial capture; a `disputes` row is recorded. `verifyAndRate(..., { pct, disputeReason })`.
- **Scheduling**: slots carry machine-readable `starts_at` (job_slots + bookings); `SlotPicker` hides past slots.

**Tunnel troubleshooting** — If ngrok errors with `Cannot read properties of undefined (reading 'body')`, kill all node and ngrok processes first, then retry.

## SDK & Backend

- **Expo SDK 54**, React Native 0.81.5, React 19.1.0. Expo Go on device must be the SDK 54 build.
- **Supabase** at `https://nfioebqsgmmzhbksxozc.supabase.co` — PostgreSQL, Auth (email/password), Realtime, RLS.
- Client is in `src/lib/supabase.js` (uses AsyncStorage for session persistence).
- Migrations live in `supabase/` and must be run manually in the Supabase SQL Editor: `schema.sql` first, then `migration_fix_lifecycle.sql`.
- **`migration_fix_lifecycle.sql` is idempotent** — safe to re-run at any time. It consolidates all RLS fixes for the full job lifecycle (messaging, booking accept/decline, mutual completion, amendment flow, poster rating). Run it if any booking action returns a permission error.

## App Flow

On launch `App.js` renders:
1. **Loading spinner** while session is checked.
2. **`AuthScreen`** if no session (sign-in / sign-up / forgot password).
3. **`OnboardingScreen`** if session exists but `onboarding_done = false` on the profile — only triggered for fresh sign-ups, not returning logins.
4. **`MainApp`** otherwise — wraps `UserProvider → JobsProvider → AppNavigator + AchievementToast`.

## Navigation

```
SafeAreaProvider → AuthProvider → RootNavigator
  └── MainApp
        ├── UserProvider
        └── JobsProvider
              └── AppNavigator (NavigationContainer inside providers to access context for tab badge counts)
                    └── Tab.Navigator (5 tabs — display labels in parens, route names unchanged)
                          ├── HomeTab   ("Browse")  → HomeStack:    HomeScreen → JobDetail → UserProfile
                          ├── EarnTab   ("My Jobs") → EarnStack:    EarnScreen → JobDetail → UserProfile
                          ├── GigsTab   ("Hiring")  → GigsStack:    GigsScreen → PostJob → JobDetail → EditJob → UserProfile
                          ├── MessagesTab ("Messages") → MessagesStack: MessagesScreen (chat via MessageSheet) → UserProfile
                          └── ProfileTab ("Profile") → ProfileStack: ProfileScreen → Settings/Expenses/Legal/Favorites/UserProfile/…
```

**Messages hub**: `MessagesScreen` lists conversations (one per booking with messages) built from `bookings`+`posterBookings`, with last-message preview, unread dots, and an Inbox/Archived split. Per-user `conversation_state` table (`last_read_at`, `archived`); helpers in `src/lib/messages.js`. Opening a chat (`MessageSheet`, reused) marks it read; `JobsContext.unreadMessages` drives the tab badge (`refreshUnread`).

- **Tab route names (`HomeTab`/`EarnTab`/`GigsTab`/`ProfileTab`) are intentionally kept even though display labels are Browse/My Jobs/Hiring/Profile** — many `navigation.navigate('EarnTab'|'GigsTab'|'ProfileTab', …)` calls depend on them.
- Cross-tab navigation from nested stacks: `navigation.navigate('EarnTab')` — React Navigation bubbles up automatically.
- `AppNavigator` is a component rendered *inside* providers so it can call `useJobs()` for tab badge counts — this is why `NavigationContainer` is not at the root.
- `AchievementToast` renders outside `NavigationContainer` but inside `SafeAreaProvider`.
- Never use `Alert.alert` for navigation/success flows — it's unreliable on web. Use `showToast()` from `UserContext` instead.

## State Management

### AuthContext (`src/context/AuthContext.js`)
`session`, `user`, `loading`, `authError`, `onboardingDone`, `pendingEmail`. Functions: `signIn`, `signUp`, `resetPassword`, `resendConfirmation`, `clearPending`, `signOut`, `markOnboardingDone`.

**Email verification is ON** (Supabase `mailer_autoconfirm=false`; `gohustlr://**` is whitelisted in the auth redirect allow-list). `signUp()` returns no session — it sets `pendingEmail`, and `AuthScreen` shows a "Verify your email" panel with a Resend button. `signIn()` maps the `email_not_confirmed` error to a friendly message + sets `pendingEmail`. `onboardingDone` is derived from the profile's `onboarding_done` column **on every session establishment** (`loadOnboarding`), so a freshly-confirmed user's first sign-in still routes through onboarding while returning users skip it.

### UserContext (`src/context/UserContext.js`)
XP, streak, earnings, goals, challenges, badges, toast queue. Cache-first load from Supabase (AsyncStorage TTL via `src/lib/cache.js`). Debounced 2s sync for XP/earnings to avoid flooding DB. Key exports: `addXP`, `recordApply`, `updateChallenge`, `unlockBadge`, `setRole`, `setGoals`, `showToast`, `dismissToast`, `refreshProfile`. Call `refreshProfile()` after any external Supabase profile update to keep the UI in sync.

### JobsContext (`src/context/JobsContext.js`)
Jobs, bookings (earner view), posterBookings (poster view), myPostedIds. Cache-first job loading. Key exports:
- `bookJob(jobId, slotId, slotLabel, counterOffer)` — earner books a slot
- `addJob(jobData)` — poster creates a listing
- `updateJob(jobId, patch)` — poster edits a listing; re-inserts slots/requirements
- `deleteJob(jobId)` — soft-delete (sets `status: 'cancelled'`)
- `acceptBooking / declineBooking / cancelBooking / markJobComplete / verifyAndRate` — booking lifecycle (`cancelBooking` releases the escrow hold + notifies)
- `blockUser(id)` / `blockedIds` (Set) — block a user; blocked posters' gigs are filtered out of Browse. Reports/blocks via `src/lib/moderation.js`
- `proposeAmendment(bookingId, note)` / `respondToAmendment(bookingId, accept)` / `clearAmendment(bookingId)` — amendment flow
- `ratePoster(bookingId, rating, reviewText)` — earner rates a poster after completion
- `isBooked(jobId)`, `bookedJobs`, `postedJobs`, `earnBadgeCount`, `profileBadgeCount`

`transformJob(dbJob)` includes `posterId: dbJob.poster_id` — used in `JobDetailScreen` to block self-booking (`job.posterId === user.id`).

Realtime: two Supabase channels per session — `bookings-user-${user.id}` (earner channel) and `poster-bookings-${user.id}` (poster channel, broad subscription that calls `loadPosterBookings()` on any change).

### Push notifications (`src/lib/push.js`)
Expo push. `registerPushToken(userId)` (called from `PushManager` in `App.js` on login) requests permission, gets the Expo token via `extra.eas.projectId`, and upserts into the `push_tokens` table (owner RLS). `unregisterPushToken` runs on sign-out. `notify(userId, title, body, data)` POSTs to the `send-push` edge function (service-role lookup of the recipient's tokens → Expo push API, prunes dead tokens). Triggers live at the booking/message events in `JobsContext` (book/accept/decline/mark-done/verify/rate/amend) and `MessageSheet.sendMessage`; `data.tab` routes the tap to a tab. **Requires a dev-client rebuild** — `expo-notifications` is native and isn't in the current binary; plain Expo Go on SDK 54 can't receive Android remote push.

## Key Screens

| Screen | Purpose |
|---|---|
| `HomeScreen` | Browse jobs with category chips, search, and full filter sheet (pay, days, location/state, pay type, urgency, sort). Pull-to-refresh. |
| `JobDetailScreen` | Job info, slot picker, counter-offer input, book button. Shows "This is your gig" banner if `job.posterId === user.id`. |
| `EarnScreen` (tab "My Jobs") | Earner hub — earnings dashboard + **Active / Awaiting / Completed** segmented control over booked gigs (Awaiting=pending, Active=confirmed+completed, Completed=verified+declined). Mark-complete, message-poster, rate-poster, amendment response, weekly goals, challenges. Pull-to-refresh. |
| `GigsScreen` (tab "Hiring") | Poster hub — Post New Gig button + **Active/Past** segmented control. Active = posted listings with expandable booking sections (accept/decline/verify/delete, amendment); Past = read-only completed/declined booking history. Pull-to-refresh. |
| `PostJobScreen` | Post a new gig — LocationPicker + DateTimePicker + custom "Other" category chip. Nested in GigsStack. |
| `EditJobScreen` | Edit/delete an existing gig (navigate with `{ jobId }` params). Core terms (title, category, pay, payType, location, description) are **locked** once a booking is confirmed/completed; they unlock only if an amendment was accepted. |
| `ManageBookingsScreen` | Poster view accessible from ProfileTab — grouped booking management (legacy, some functionality overlaps GigsScreen). |
| `ProfileScreen` | Stats, badges, reviews received, "Manage My Gigs" link (→ Gigs tab), Payments, Settings, sign out. No role toggle — every user can both earn and post. Pull-to-refresh. |
| `ExpensesScreen` (Tax Center) | Full tax tracker — **Expenses / Income** segments, year net-profit summary (Stripe earnings + logged cash income − expenses) with a ~27% set-aside hint, add expense (category/receipt → `receipts` bucket) or cash income (`income_entries` table), delete, and a combined year-end **tax summary CSV** export via Share. Helpers in `src/lib/expenses.js`. Nested in ProfileStack as `Expenses`. |
| `LegalScreen` | Renders Terms / Privacy / Independent Contractor Agreement (route param `doc`) fetched from the `legal_documents` table. See **Legal docs** below. |
| `PublicProfileScreen` | Anyone's profile (route param `userId`): combined rating + **worker/client breakdown**, bio, skills, their open gigs (→ JobDetail), recent completed work, and all reviews. Registered as `UserProfile` in every stack; reached by tapping a poster (JobDetail) or an earner (Hiring rows). |
| `SettingsScreen` | Edit name, username, bio, role, location, radius, skills — saves to Supabase and calls `refreshProfile()`. |
| `OnboardingScreen` | Multi-step: Welcome → Username → Role → Location → Skills/Radius → Done. Saves all fields + `onboarding_done: true`. |
| `AuthScreen` | Sign-in / Sign-up (with confirm password) / Forgot password tabs. |

## Key Components

- **`FilterSheet`** — bottom-sheet modal with sort, pay range, pay type, available days (parsed from slot labels), location/state chips, urgency toggle. Import `DEFAULT_FILTERS` and `countActiveFilters` from it.
- **`MessageSheet`** — realtime chat modal between earner and poster. Props: `bookingId`, `jobTitle`, `otherPerson: { name, avatarInitial }`, `onClose`. Reads/writes `messages` table, Supabase realtime channel per `bookingId`.
- **`CompletionModal`** — poster "Verify & Rate" bottom sheet. Props: `booking`, `onConfirm({ rating, reviewText, paymentMethod })`.
- **`LocationPicker`** — autocomplete over 60+ US cities + Remote. Controlled: `value` + `onChange`.
- **`DateTimePicker`** — day chips + time grid producing `slots[]`. Use for posting and editing.
- **`SlotPicker`** — single-select chip row from existing `slots[]` (used in JobDetail).
- **`GradientHeader`** — screen header with `LinearGradient` + safe-area inset.
- **`AchievementToast`** — driven by `pendingToast` in UserContext.
- **`BookingStatusBadge`** — status pill: pending/confirmed/completed/verified/declined.
- **`PosterTrustCard`** — displays poster profile info and rating in JobDetailScreen.
- **`RatingStars`** — reusable star rating display/input component.
- **`JobCard`** — job listing card used in HomeScreen and search results.
- **`Avatar`** — renders a user's photo (`url`) or the initial-letter circle fallback. Props `{ url, initial, size, bg, fontSize, borderColor, borderWidth, style }`. Used everywhere an avatar appears. Profile photos live in the public `avatars` storage bucket (`profiles.avatar_url`); upload via `src/lib/uploadImage.js` (`pickImage`/`pickImages` + `uploadImage`/`uploadImages`, which compress with expo-image-manipulator and upload an ArrayBuffer to Supabase Storage under `<userId>/…`).

### Images (Supabase Storage buckets — all public read, owner-scoped writes)
- `avatars` → `profiles.avatar_url` (profile photos)
- `completion-photos` → `bookings.completion_photos text[]` (earner proof-of-work, shown in CompletionModal + history)
- `job-photos` → `jobs.photos text[]` (gallery on JobDetail, cover on JobCard; set in PostJob/EditJob)
- `chat-photos` → `messages.image_url` (image messages in MessageSheet)
All four use `src/lib/uploadImage.js`. Migrations: `supabase/migration_profile_photos.sql`, `migration_completion_photos.sql`, `migration_job_chat_photos.sql` (applied to the remote DB via the Management API).
- **`XPBar`** — XP progress bar toward next level, used in ProfileScreen.
- **`BadgeGrid`** / **`ChallengeCard`** — achievement and challenge display in ProfileScreen.

## Monitoring & analytics

`src/lib/analytics.js` — pluggable `track(event, props)`, `captureError(error, ctx)`, `identify(userId)`. Currently logs in dev + keeps a ring buffer; set `SENTRY_DSN` / `ANALYTICS_KEY` and forward in the marked spots to enable real Sentry/PostHog (native SDKs need a dev-client rebuild). A root `ErrorBoundary` (`src/components/ErrorBoundary.js`, wrapping the app in `App.js`) catches render crashes and reports via `captureError`. Funnel events fire from AuthContext (`sign_in`/`sign_up`) and JobsContext (`gig_posted`, `booking_created`, `booking_accepted`, `job_verified`); `identify` runs on login in `PushManager`.

## Caching

`src/lib/cache.js` wraps AsyncStorage with a timestamp TTL. Pattern used everywhere:
1. Show cached data instantly on mount.
2. Fetch fresh from Supabase in the background.
3. Update state and re-cache on fresh data arrival.

Invalidate a cache entry with `cacheSet(key, null)` after a write. All major screens also support **pull-to-refresh** via `RefreshControl` that triggers a full reload bypassing cache.

## Theming

`src/theme.js` — primary `#6D28D9`, secondary `#4F46E5`, accent `#10B981`. `gradients.primary/earn/gold/profile` for `LinearGradient`. `shadows.sm/md/card`.

`CATEGORY_COLORS` (category label → hex) lives in `src/data/mockData.js` — single source of truth for job card colors. Other constants there: `CATEGORIES`, `BADGE_DEFS`, `LEVELS`.

## Haptics

Always use `src/hooks/useHaptic.js` — guards against web (`Platform.OS === 'web'` returns no-ops). Never call `expo-haptics` directly.

## Booking Lifecycle

```
pending → confirmed → completed → verified
        ↘ declined
```
- Earner books → `pending`
- Poster accepts → `confirmed`; poster declines → `declined`
- Earner marks done → opens the Finish sheet (optional **completion photos** uploaded to the `completion-photos` bucket → `bookings.completion_photos text[]`), then sets `earner_done = true`; if poster already done → status advances to `completed`. Photos are shown to the poster in `CompletionModal` and in both sides' history.
- Poster marks done → sets `poster_done = true`; if earner already done → status advances to `completed`
- Poster verifies + rates → `verified` (inserts review, updates earner rolling rating)
- Earner rates poster → inserts a `reviews` row (`role='poster'`) and recomputes the poster's rating

**Reviews are two-sided.** Every rating (poster→earner in `verifyAndRate`, earner→poster in `ratePoster`) inserts a `reviews` row tagged with `role` (`earner` = reviewed for work; `poster` = reviewed as a client). `recomputeRatings(userId)` sets `profiles.rating`/`review_count` to the **combined** average across all roles (the general rating shown everywhere) and `poster_rating`/`poster_review_count` as the client cache. Profiles show a worker-vs-client breakdown.

**Mutual completion**: both `earner_done` and `poster_done` must be `true` before status becomes `completed`. Neither party alone can advance the status.

## Amendment Workflow

When a booking is `confirmed` or `completed` and the poster needs to change core job terms:

1. **Earner proposes** an amendment via `proposeAmendment(bookingId, note)` — sets `amendment_status: 'pending'` and `amendment_note` on the booking.
2. **Poster responds** via `respondToAmendment(bookingId, accept)` — accept sets `amendment_status: 'accepted'`; decline sets `amendment_status: 'declined'`.
3. **If accepted**: `EditJobScreen` unlocks core fields (`canEditCore = true`) so the poster can update the job terms.
4. **If declined** or after editing: `clearAmendment(bookingId)` resets `amendment_status` back to `'none'`.

Amendment status values: `'none'` | `'pending'` | `'accepted'` | `'declined'`.

## Supabase Schema Notes

Profiles table has: `name`, `avatar_initial`, `username` (unique), `bio`, `role` (enum: `earner`/`poster`/`both`), `city`, `skills` (text[]), `radius_miles`, `rating`, `review_count`, `poster_rating`, `poster_review_count`, `xp`, `earnings_total`, `onboarding_done`, etc.

Jobs have `poster_id` FK to profiles. Bookings have `earner_id`, `job_id`, `earner_done` (bool), `poster_done` (bool), `amendment_status`, `amendment_note`, `earner_rating`, `poster_rating`, `poster_review`. RLS ensures earners see their own bookings and posters see bookings on their jobs.
