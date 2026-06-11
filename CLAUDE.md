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

## SDK Version

**Expo SDK 54**, React Native 0.81.5, React 19.1.0. Expo Go on device must be the SDK 54 build. Docs: https://docs.expo.dev/versions/v54.0.0/

## Architecture

### Navigation (4 tabs)

```
SafeAreaProvider
└── Tab.Navigator
    ├── HomeTab   → HomeStack:  HomeScreen → JobDetail
    ├── EarnTab   → EarnStack:  EarnScreen → JobDetail
    ├── PostTab   → PostJobScreen  (direct tab screen, no stack)
    └── ProfileTab → ProfileScreen
```

- `JobDetail` is in both `HomeStack` and `EarnStack` — pass `{ jobId: string }` as params; the screen looks up the live job from context so state stays reactive.
- To navigate from a nested stack screen to a sibling tab use `navigation.navigate('EarnTab')` — React Navigation bubbles the action up to the tab navigator automatically.
- `PostJobScreen` is a direct `Tab.Screen` child, so `navigation.navigate('HomeTab')` works directly from it.
- `AchievementToast` renders **outside** `NavigationContainer` in `App.js`. It requires `SafeAreaProvider` to wrap the entire app (not just the navigator) — this is already in place.

### State Management

Two React Context + `useReducer` stores:

**`JobsContext`** (`src/context/JobsContext.js`) — job list, bookings, posted job IDs.
- `bookJob(jobId, slotId, slotLabel, counterOffer)` — marks slot taken, stores booking with slot label and counter-offer
- `addJob(jobData)` — prepends job to list, adds ID to `myPostedIds`
- Derived: `bookedJobs`, `postedJobs`, `isBooked(jobId)`, `bookings[]`

**`UserContext`** (`src/context/UserContext.js`) — XP, streak, earnings, goals, challenges, badges, toast queue.
- `addXP(n)`, `updateChallenge(id, delta)`, `unlockBadge(key)`, `recordApply(amount)`
- `showToast({ icon, title, message })` / `dismissToast()` — drives `AchievementToast`
- `getLevelInfo(xp)` computes current level, label, and progress ratio from `LEVELS` in mockData

No backend — all state is in-memory and resets on reload.

### Key Data (`src/data/mockData.js`)

- `CATEGORIES` — array with `{ id, label, icon }`. `id: 'all'` is filter-only; actual job categories use string labels like `'Tutoring'`, `'Tech Help'`.
- `CATEGORY_COLORS` — map from category label → hex color used in `JobCard` and `JobDetailScreen`.
- `BADGE_DEFS`, `LEVELS` — static config consumed by UserContext and UI components.
- `MOCK_JOBS` — seed data. Each job has `poster: { name, avatarInitial, rating, reviewCount, verified }`, `slots[]`, `requirements[]`, `reviews[]`.

### Theming

All colors and shadows in `src/theme.js` (primary `#6D28D9`, secondary `#4F46E5`, accent `#10B981`). `gradients` object has `primary / earn / gold / profile` arrays for `LinearGradient`.

`CATEGORY_COLORS` is defined in `mockData.js` and imported where needed — only one source of truth.

### Components to know

- **`LocationPicker`** — autocomplete dropdown over ~60 US cities + Remote options. Controlled: `value` + `onChange`.
- **`DateTimePicker`** — visual day chips (next 14 days) + time grid (8am–8pm). Manages a `slots[]` array via `onChange`. Use for both posting available times and anywhere else slot selection is needed.
- **`SlotPicker`** — horizontal chip row for selecting a single slot from an existing `slots[]` array (used on JobDetail).
- **`GradientHeader`** — wraps screen headers with `LinearGradient` and safe-area top inset.
- **`AchievementToast`** — animated slide-in toast, driven by `pendingToast` in UserContext.

### Haptics

`src/hooks/useHaptic.js` guards against web — returns no-op functions when `Platform.OS === 'web'`. Always import from this hook rather than calling `expo-haptics` directly.

### Posting a job

`PostJobScreen` uses `LocationPicker` for location and `DateTimePicker` for slots. Category "Other" chip reveals a free-text input; the effective category is `customCategory` when `category === 'other'`. On submit: calls `addJob()`, fires `showToast()`, then `navigation.navigate('HomeTab')` — no `Alert`.

### Booking a gig

`JobDetailScreen` calls `bookJob(jobId, slotId, slotLabel, counterOffer)`, then `addXP(25)`, `recordApply()`, `showToast()`, and navigates to `EarnTab`. Counter-offer is optional — `null` if the user leaves the field blank.
