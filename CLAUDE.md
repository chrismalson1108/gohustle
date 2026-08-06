# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                       # Start Expo dev server (LAN mode, requires same WiFi as phone)
npx expo start --tunnel         # Start with ngrok tunnel (cross-network); kill all node/ngrok processes first
npm run ios                     # expo run:ios — build & launch the dev client on a simulator/device
npm run android                 # expo run:android — build & launch the dev client
npm run web                     # expo start --web
npm install --legacy-peer-deps  # Always use this flag when installing packages
npx expo install <package>      # Use instead of npm install for Expo packages (auto-picks SDK 54 version)
npm test                        # Jest — 33 suites / 421 tests of pure logic in __tests__/
npm run brand:sync              # Distribute shared/assets/brand → the paths web + app.json expect
supabase db push --linked       # Apply supabase/migrations/ to production (the canonical path)
```

The app runs in the **custom GoHustlr dev client, not Expo Go** — `expo-dev-client` is
installed and the app's native modules (Stripe, maps, notifications, Google sign-in)
do not exist in the Expo Go runtime.

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
- Base schema + feature migrations live in `supabase/` (run `schema.sql` first, then the `migration_*.sql` files) and were applied manually in the Supabase SQL Editor. **Incremental security/bug fixes now live in `supabase/migrations/` and are applied with `supabase db push --linked`** (the CLI is linked; this is the canonical path going forward — the timestamped files there are the source of truth for every guard, policy, trigger, and RPC fix from review rounds 2–6).
- **`migration_fix_lifecycle.sql` is idempotent and now ships the HARDENED policies** (party-scoped `messages_insert`, owner-only `profiles_update_own`) — re-running it no longer reverts later hardening. Run it (or, preferably, `supabase db push`) if a booking action returns a permission error. The guard triggers/functions, slot integrity, atomic earnings/tip credit, and column lockdown are all in the tracked `supabase/migrations/` files — applying those reproduces the hardened state.

## App Flow

On launch `App.js` renders:
1. **Loading spinner** while session is checked.
2. **`AuthScreen`** if no session (sign-in / sign-up / forgot password).
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
                          ├── EarnTab   ("My Jobs")  → EarnStack:  EarnScreen → JobDetail → UserProfile → Reviews → Chat
                          ├── GigsTab   ("Hire")     → GigsStack:  GigsScreen → PostJob → JobDetail → EditJob → UserProfile → Reviews → Chat
                          ├── MessagesTab ("Messages") → MessagesStack: MessagesScreen → Chat (ChatScreen) → UserProfile/JobDetail/FindPeople/Reviews
                          └── ProfileTab ("You")     → ProfileStack: ProfileScreen → Settings/ProfileSettings/Availability/Notifications/
                                                                    NotificationSettings/PayoutSetup/Expenses/TrophyCase/Reviews/Legal/
                                                                    UserProfile/Favorites/SavedGigs/JobDetail/EditJob/ManageBookings/FindPeople/Chat
```

**Messages hub**: `MessagesScreen` lists conversations (one per booking with messages) built from `bookings`+`posterBookings`, with last-message preview, unread dots, and an Inbox/Archived split. Per-user `conversation_state` table (`last_read_at`, `archived`); helpers in `src/lib/messages.js`. Opening a chat pushes the full-screen `ChatScreen` (route `Chat`, registered in every stack); `MessageSheet` is the shared chat body, also hosted as a modal from JobDetail/Earn/Gigs. Opening marks the conversation read; `JobsContext.unreadMessages` drives the tab badge (`refreshUnread`). Conversations link out: the row avatar and the sheet's header person open `UserProfile`; the sheet's "re: job" line opens `JobDetail` (works for past/soft-deleted listings via `JobsContext.fetchJobById`, the fallback JobDetail uses when the job isn't in the browse list). **Messaging is booking-scoped** (party-scoped RLS) — `PublicProfileScreen` shows a "Message" button only when a booking connects the two users. `FindPeopleScreen` (`FindPeople` route in Messages+Profile stacks; entry points: Messages header search icon, Profile → Grow → Find People) searches profiles by name/username (`ilike`, respects `blockedIds`).

- **Tab route names (`HomeTab`/`EarnTab`/`GigsTab`/`MessagesTab`/`ProfileTab`) are intentionally kept even though display labels are Browse / My Jobs / Hire / Messages / You** — the route names are a wire protocol, not just internal: `send-push`'s `KNOWN_TABS` and the `data.tab` field of every push notification depend on them, so renaming a route silently breaks notification deep-links. Many `navigation.navigate('EarnTab'|'GigsTab'|'ProfileTab', …)` calls depend on them too.
- Cross-tab navigation from nested stacks: `navigation.navigate('EarnTab')` — React Navigation bubbles up automatically.
- `AppNavigator` is a component rendered *inside* providers so it can call `useJobs()` for tab badge counts — this is why `NavigationContainer` is not at the root.
- `AchievementToast` renders outside `NavigationContainer` but inside `SafeAreaProvider`.
- Never use `Alert.alert` for navigation/success flows — it's unreliable on web. Use `showToast()` from `UserContext` instead.

## State Management

### AuthContext (`src/context/AuthContext.js`)
`session`, `user`, `loading`, `onboardingResolved`, `authError`, `onboardingDone`, `pendingEmail`, `needsTermsAcceptance`. Functions: `signIn`, `signInWithGoogle`, `signInWithApple`, `signUp`, `resetPassword`, `resendConfirmation`, `clearPending`, `clearError`, `signOut`, `markOnboardingDone`, `markTermsAccepted`.

**Email verification is ON** (Supabase `mailer_autoconfirm=false`; `gohustlr://**` is whitelisted in the auth redirect allow-list). `signUp()` returns no session — it sets `pendingEmail`, and `AuthScreen` shows a "Verify your email" panel with a Resend button. `signIn()` maps the `email_not_confirmed` error to a friendly message + sets `pendingEmail`. `onboardingDone` is derived from the profile's `onboarding_done` column **on every session establishment** (`loadOnboarding`), so a freshly-confirmed user's first sign-in still routes through onboarding while returning users skip it.

**Google sign-in is native-first**: `signInWithGoogle` uses `@react-native-google-signin/google-signin` + `supabase.auth.signInWithIdToken` (like the Apple flow — no browser session, so iOS never shows the "wants to use …supabase.co" prompt). It requires (1) the native module in the binary (dev-client rebuild), (2) real client IDs in `app.json` → `extra.googleAuth` (`webClientId` = a Google Cloud **web** OAuth client that must also be listed under Supabase Auth → Providers → Google → "Client IDs"; `iosClientId` = the iOS OAuth client for `com.gohustlr.app`, whose **reversed** ID goes in the plugin's `iosUrlScheme`; Android needs an Android OAuth client with the release SHA-1 registered in the same Google Cloud project — nothing extra in the app config). The module is lazy-`require`d (its import throws when the native side is missing), so **older binaries / Expo Go / web automatically fall back to the browser PKCE OAuth flow** (`signInWithGoogleBrowser`). `REPLACE`-placeholder IDs count as unconfigured → fallback.

### UserContext (`src/context/UserContext.js`)
XP, streak, earnings, goals, challenges, badges, toast queue. Cache-first load from Supabase (AsyncStorage TTL via `src/lib/cache.js`). Debounced 2s sync for XP/earnings to avoid flooding DB. Key exports: `addXP`, `updateChallenge`, `unlockBadge`, `setRole`, `setGoals`, `showToast`, `dismissToast`, `refreshProfile`. Call `refreshProfile()` after any external Supabase profile update to keep the UI in sync. **"Jobs Done" is derived from bookings (`completed`/`verified` statuses), never a counter bumped at apply time** — the old `recordApply`/`weekly_jobs_done` increment-on-booking was removed because it showed unconfirmed applications as done work.

### JobsContext (`src/context/JobsContext.js`)
Jobs, bookings (earner view), posterBookings (poster view), myPostedIds. Cache-first job loading. Key exports:
- `bookJob(jobId, slotId, slotLabel, counterOffer, applicationNote)` — earner books a slot
- `addJob(jobData)` — poster creates a listing
- `updateJob(jobId, patch)` — poster edits a listing; re-inserts slots/requirements
- `deleteJob(jobId)` — soft-delete (sets `status: 'cancelled'`)
- `acceptBooking / declineBooking / cancelBooking / markJobComplete / verifyAndRate` — booking lifecycle (`cancelBooking` releases the escrow hold + notifies)
- `blockUser(id)` / `blockedIds` (Set) — block a user; blocked posters' gigs are filtered out of Browse. Reports/blocks via `src/lib/moderation.js`
- `proposeAmendment(bookingId, note)` / `respondToAmendment(bookingId, accept)` / `clearAmendment(bookingId)` — amendment flow
- `ratePoster(bookingId, rating, reviewText)` — earner rates a poster after completion
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
| `LegalScreen` | Renders Terms / Privacy / Independent Contractor Agreement (route param `doc`) fetched from the `legal_documents` table. See **Legal docs** below. |
| `PublicProfileScreen` | Anyone's profile (route param `userId`): combined rating + **worker/client breakdown**, bio, skills, their open gigs (→ JobDetail), recent completed work, and all reviews. Registered as `UserProfile` in every stack; reached by tapping a poster (JobDetail) or an earner (Hiring rows). |
| `SettingsScreen` | Settings **hub** — a searchable list of rows grouped Account / Money / Notifications / Saved / Legal & support / Account actions. It only navigates; it edits nothing. **Sign out lives here**, deliberately not on ProfileScreen. |
| `ProfileSettingsScreen` (route `ProfileSettings`) | The actual profile editor — avatar, name, username, bio, role, location, radius, skills. Saves to Supabase and calls `refreshProfile()`. |
| `OnboardingScreen` | Multi-step: Welcome → Username+DOB → Role → Location → Skills/Radius → Done. DOB uses `DobPicker` (Month/Day/Year dropdowns, `composeDob` → `parseDob`). Saves all fields + `onboarding_done: true`. |
| `FindPeopleScreen` | Search people by name/@username → tap through to `UserProfile`. Registered as `FindPeople` in Messages + Profile stacks. |
| `AuthScreen` | Sign-in / Sign-up (with confirm password) / Forgot password tabs. |

## Key Components

- **`FilterSheet`** — bottom-sheet modal with sort, pay range, pay type, available days (parsed from slot labels), location/state chips, urgency toggle. Import `DEFAULT_FILTERS` and `countActiveFilters` from it.
- **`MessageSheet`** — realtime chat modal between earner and poster. Props: `bookingId`, `jobTitle`, `otherPerson: { name, avatarInitial }`, `onClose`. Reads/writes `messages` table, Supabase realtime channel per `bookingId`.
- **`CompletionModal`** — poster "Verify & Rate" bottom sheet. Props: `booking`, `onConfirm({ rating, reviewText, paymentMethod })`.
- **`LocationPicker`** — live city autocomplete backed by the photon.komoot.io geocoder (worldwide, not a fixed list), plus a "use my location" reverse-geocode via `expo-location` and the remote presets `Remote` / `Zoom / Remote` / `Work from Home`. Controlled: `value` + **`onChange(label, coords)`** — the second argument carries `{ lat, lng }` and is what populates `jobs.lat`/`lng` for distance sort and the map.
- **`DateTimePicker`** — day chips + time grid producing `slots[]`. Use for posting and editing.
- **`SlotPicker`** — single-select chip row from existing `slots[]` (used in JobDetail).
- **`ScreenHeader`** — flat screen header, the replacement for the deleted gradient hero. Props: `children`, `style`, `topInset` (default `true`; pass `false` on pushed screens where the opaque native bar already cleared the status bar), `surface` (white instead of canvas). **There is no `GradientHeader` and no LinearGradient anywhere in the app.**
- **`AchievementToast`** — driven by `pendingToast` in UserContext.
- **`BookingStatusBadge`** — status pill: pending/confirmed/completed/verified/declined/cancelled. Props: `status`, `compact` (icon-only).
- **`PosterTrustCard`** — displays poster profile info and rating in JobDetailScreen.
- **`RatingStars`** — reusable star rating display/input component.
- **`JobCard`** — job listing card used in HomeScreen and search results.
- **`Avatar`** — renders a user's photo (`url`) or the initial-letter circle fallback. Props `{ url, initial, size, bg, fontSize, borderColor, borderWidth, style }`. Used everywhere an avatar appears. Profile photos live in the public `avatars` storage bucket (`profiles.avatar_url`); upload via `src/lib/uploadImage.js` (`pickImage`/`pickImages` + `uploadImage`/`uploadImages`, which compress with expo-image-manipulator and upload an ArrayBuffer to Supabase Storage under `<userId>/…`).

### Images (Supabase Storage buckets)
**Two are public, three are private — do not assume `getPublicUrl` works.**
- `avatars` → `profiles.avatar_url` — **public**, rendered with `getPublicUrl`. SELECT is owner-scoped so anon cannot LIST the bucket (`20260725000000_storage_enumeration_lockdown.sql`).
- `job-photos` → `jobs.photos text[]` — **public**, same enumeration lockdown.
- `completion-photos` → `bookings.completion_photos text[]` — **PRIVATE** (`20260707010000`). Render with `<SignedImage bucket="completion-photos" …>`; `getPublicUrl` returns a URL that 400s.
- `chat-photos` → `messages.image_url` — **PRIVATE** (`20260701000000`). Same signed-URL rule.
- `receipts` → expense receipts (Tax Center) — **PRIVATE**.

All writes are owner-scoped under `<userId>/…` and go through `src/lib/uploadImage.js`.

⚠️ **`web/public/brand/wordmark-cream.png` looks unused and is not.** 15 Supabase auth email templates and `student-verify-start` hotlink it as `https://gohustlr.com/brand/wordmark-cream.png`. An import grep cannot see it; deleting it 404s the logo in every transactional email.
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

## Booking Lifecycle

```
pending → confirmed → completed → verified
        ↘ declined    (poster refuses a pending booking)
        ↘ cancelled   (either party, from pending or confirmed, only before the earner
                       marks started — releases the escrow hold)
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

Profiles table has: `name`, `avatar_initial`, `username` (unique), `bio`, `role` (enum: `earner`/`poster`/`both`), `city`, `skills` (text[] of canonical category labels — see **Categories & skills**), `skill_rates` (jsonb: skill label → hourly rate; the keys must stay in step with `skills`), `recent_category_slugs` (text[], trigger-maintained, owner-private), `radius_miles`, `rating`, `review_count`, `poster_rating`, `poster_review_count`, `xp`, `earnings_total`, `onboarding_done`, `referral_code`, `verified` (bool — drives the Verified badge), `id_verification_status` (`none`/`pending`/`verified`/`rejected`), etc.

**ID verification** (`src/lib/verification.js`): `fetchVerificationStatus(userId)` / `requestVerification()`. Backed by **Stripe Identity**: `requestVerification()` calls the `stripe-create-identity-session` edge function (creates a document+selfie `VerificationSession` with `metadata.supabase_uid`, marks the profile `pending`, returns the hosted URL), which ProfileScreen opens via `Linking`. The `stripe-webhook` function handles `identity.verification_session.verified` → sets `verified = true` + `id_verification_status = 'verified'`; `requires_input` → `rejected`; `canceled` → resets to `none`. `stripe-identity-return` is the post-flow landing page. `profiles.stripe_identity_session_id` enables resume. ProfileScreen surfaces the status row + header badge. **Dashboard setup required**: enable Stripe Identity on the account and register the three `identity.verification_session.*` webhook events.

Jobs have `poster_id` FK to profiles, `category` (display label) + `category_slug` (the indexed identity everything filters and groups on — both maintained by `trg_y_normalize_job_category`), `tags` (text[], free-form, max 6), and a `recurrence` column (`none`/`weekly`/`biweekly`/`monthly`) — set in PostJob/EditJob, shown as a badge on JobCard/JobDetail, and duplicated via the "Duplicate" button in GigsScreen (`navigation.navigate('PostJob', { prefill: job })`). Bookings have `earner_id`, `job_id`, `earner_done` (bool), `poster_done` (bool), `amendment_status`, `amendment_note`, `earner_rating`, `poster_rating`, `poster_review`. RLS ensures earners see their own bookings and posters see bookings on their jobs.
