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
```

**Tunnel troubleshooting** — If ngrok errors with `Cannot read properties of undefined (reading 'body')`, kill all node and ngrok processes first, then retry.

## SDK & Backend

- **Expo SDK 54**, React Native 0.81.5, React 19.1.0. Expo Go on device must be the SDK 54 build.
- **Supabase** at `https://nfioebqsgmmzhbksxozc.supabase.co` — PostgreSQL, Auth (email/password), Realtime, RLS.
- Client is in `src/lib/supabase.js` (uses AsyncStorage for session persistence).
- Migrations live in `supabase/` and must be run manually in the Supabase SQL Editor in order: `schema.sql` → `migration_booking_lifecycle.sql` → `migration_messaging.sql` → `migration_onboarding.sql` → `migration_role_both.sql` → `migration_mutual_completion.sql` → `migration_fix_lifecycle.sql`.
- **`migration_fix_lifecycle.sql` is idempotent** — safe to re-run at any time. It consolidates all RLS fixes for the full job lifecycle (messaging, booking accept/decline, mutual completion, poster rating). Run it if messaging fails or any booking action returns a permission error.

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
                    └── Tab.Navigator (4 tabs)
                          ├── HomeTab   → HomeStack:    HomeScreen → JobDetail
                          ├── EarnTab   → EarnStack:    EarnScreen → JobDetail
                          ├── PostTab   → PostJobScreen (direct tab screen, no stack)
                          └── ProfileTab → ProfileStack: ProfileScreen → ManageBookings
                                                                       → EditJob
                                                                       → Settings
```

- Cross-tab navigation from nested stacks: `navigation.navigate('EarnTab')` — React Navigation bubbles up automatically.
- `AppNavigator` is a component rendered *inside* providers so it can call `useJobs()` for tab badge counts — this is why `NavigationContainer` is not at the root.
- `AchievementToast` renders outside `NavigationContainer` but inside `SafeAreaProvider`.
- Never use `Alert.alert` for navigation/success flows — it's unreliable on web. Use `showToast()` from `UserContext` instead.

## State Management

### AuthContext (`src/context/AuthContext.js`)
`session`, `user`, `loading`, `authError`, `onboardingDone`. Functions: `signIn`, `signUp`, `resetPassword`, `signOut`, `markOnboardingDone`. The `onboardingDone` flag is only set to `false` on a fresh `signUp()` call — not on login — so returning users skip onboarding.

### UserContext (`src/context/UserContext.js`)
XP, streak, earnings, goals, challenges, badges, toast queue. Cache-first load from Supabase (AsyncStorage TTL via `src/lib/cache.js`). Debounced 2s sync for XP/earnings to avoid flooding DB. Key exports: `addXP`, `recordApply`, `updateChallenge`, `unlockBadge`, `setRole`, `setGoals`, `showToast`, `dismissToast`, `refreshProfile`. Call `refreshProfile()` after any external Supabase profile update to keep the UI in sync.

### JobsContext (`src/context/JobsContext.js`)
Jobs, bookings (earner view), posterBookings (poster view), myPostedIds. Cache-first job loading. Key exports:
- `bookJob(jobId, slotId, slotLabel, counterOffer)` — earner books a slot
- `addJob(jobData)` — poster creates a listing
- `updateJob(jobId, patch)` — poster edits a listing; re-inserts slots/requirements
- `deleteJob(jobId)` — soft-delete (sets `status: 'cancelled'`)
- `acceptBooking / declineBooking / markJobComplete / verifyAndRate` — booking lifecycle
- `isBooked(jobId)`, `bookedJobs`, `postedJobs`, `earnBadgeCount`, `profileBadgeCount`

`transformJob(dbJob)` includes `posterId: dbJob.poster_id` — used in `JobDetailScreen` to block self-booking (`job.posterId === user.id`).

Realtime: two Supabase channels per session — earner channel (filters by `earner_id`) and poster channel (broad subscription that calls `loadPosterBookings()` on any change).

## Key Screens

| Screen | Purpose |
|---|---|
| `HomeScreen` | Browse jobs with category chips, search, and full filter sheet (pay, days, location/state, pay type, urgency, sort) |
| `JobDetailScreen` | Job info, slot picker, counter-offer input, book button. Shows "This is your gig" banner if `job.posterId === user.id`. |
| `EarnScreen` | Booked gigs list with status, mark-complete button, message-poster button, earnings dashboard |
| `PostJobScreen` | Post a new gig — LocationPicker + DateTimePicker + custom "Other" category chip |
| `EditJobScreen` | Edit/delete an existing gig (navigate with `{ jobId }` params) |
| `ManageBookingsScreen` | Poster view — grouped by status, accept/decline/verify-and-rate, message-earner button |
| `ProfileScreen` | Stats, badges, posted gigs list with Edit buttons, Settings button, sign out |
| `SettingsScreen` | Edit name, username, bio, role, location, radius, skills — saves to Supabase and calls `refreshProfile()` |
| `OnboardingScreen` | Multi-step: Welcome → Username → Role → Location → Skills/Radius → Done. Saves all fields + `onboarding_done: true`. |
| `AuthScreen` | Sign-in / Sign-up (with confirm password) / Forgot password tabs |

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

## Caching

`src/lib/cache.js` wraps AsyncStorage with a timestamp TTL. Pattern used everywhere:
1. Show cached data instantly on mount.
2. Fetch fresh from Supabase in the background.
3. Update state and re-cache on fresh data arrival.

Invalidate a cache entry with `cacheSet(key, null)` after a write.

## Theming

`src/theme.js` — primary `#6D28D9`, secondary `#4F46E5`, accent `#10B981`. `gradients.primary/earn/gold/profile` for `LinearGradient`. `shadows.sm/md/card`.

`CATEGORY_COLORS` (category label → hex) lives in `src/data/mockData.js` — single source of truth for job card colors.

## Haptics

Always use `src/hooks/useHaptic.js` — guards against web (`Platform.OS === 'web'` returns no-ops). Never call `expo-haptics` directly.

## Booking Lifecycle

```
pending → confirmed → completed → verified
        ↘ declined
```
- Earner books → `pending`
- Poster accepts → `confirmed`; poster declines → `declined`
- Earner marks done → `completed`
- Poster verifies + rates → `verified` (inserts review, updates earner rolling rating)

## Supabase Schema Notes

Profiles table has: `name`, `avatar_initial`, `username` (unique), `bio`, `role`, `city`, `skills` (text[]), `radius_miles`, `rating`, `review_count`, `xp`, `earnings_total`, `onboarding_done`, etc.

Jobs have `poster_id` FK to profiles. Bookings have `earner_id` and `job_id`. RLS ensures earners see their own bookings and posters see bookings on their jobs.
