# GoHustlr

A mobile gig marketplace app built for college students. Earners browse and book gigs posted by anyone — neighbors, parents, local businesses — and get paid through the app. Posters can find motivated students quickly and book a time that works for both parties.

Built with Expo (React Native) targeting iOS and Android, with a web preview available in Chrome.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Expo SDK 54 / React Native 0.81.5 |
| Language | JavaScript (React 19.1.0) |
| Navigation | React Navigation v7 (bottom-tabs + native-stack) |
| State | React Context + useReducer |
| Backend | Supabase (PostgreSQL, Auth, Realtime, RLS) |
| Styling | StyleSheet + expo-linear-gradient |
| Haptics | expo-haptics (no-op on web) |

---

## Local Environment Setup

### Prerequisites

- **Node.js** v18 or higher — [nodejs.org](https://nodejs.org)
- **npm** v9 or higher (comes with Node)
- **Expo Go** app on your phone — install from the [App Store](https://apps.apple.com/app/expo-go/id982107779) or [Google Play](https://play.google.com/store/apps/details?id=host.exp.exponent)
  - Must be the **SDK 54** build. If you have an older version, update it from the store.

### 1. Clone the repo

```bash
git clone https://github.com/ChrisMalson/gohustle.git
cd gohustle
```

### 2. Install dependencies

Always use `--legacy-peer-deps` — React 19 has peer conflicts with some Navigation packages:

```bash
npm install --legacy-peer-deps
```

### 3. Set up the database

The app requires a Supabase project. Run the migrations in order in the Supabase SQL Editor:

1. `supabase/schema.sql` — creates all tables and base RLS policies
2. `supabase/migration_fix_lifecycle.sql` — consolidates all lifecycle, messaging, and booking RLS fixes (idempotent, safe to re-run)

The Supabase URL and anon key are in `src/lib/supabase.js`.

### 4. Start the dev server

**Same WiFi as your phone (fastest):**
```bash
npm start
```

**Different network (uses ngrok tunnel):**
```bash
npx expo start --tunnel
```

> If tunnel fails with a `Cannot read properties of undefined (reading 'body')` error, kill any existing node/ngrok processes and retry.

**Browser (Chrome):**
```bash
npm run web
```

### 5. Open on your phone

Once the server is running, scan the QR code in the terminal with:
- **iPhone** — use the Camera app (iOS 16+) or the Expo Go app
- **Android** — open Expo Go and tap "Scan QR code"

The app will bundle and open in Expo Go.

### Adding new packages

Use `npx expo install` instead of `npm install` so Expo picks the SDK-54-compatible version automatically:

```bash
npx expo install <package-name>
```

If you must use `npm install`, always add `--legacy-peer-deps`.

---

## Project Structure

```
supabase/
├── schema.sql                # Full database schema + RLS policies
└── migration_fix_lifecycle.sql  # Lifecycle/RLS fixes (idempotent)
src/
├── context/
│   ├── AuthContext.js        # Session, sign-in/up/out, onboarding flag
│   ├── JobsContext.js        # Jobs, bookings, booking lifecycle, amendments
│   └── UserContext.js        # XP, earnings, streak, challenges, badges, toasts
├── screens/
│   ├── AuthScreen.js         # Sign-in / sign-up / forgot password
│   ├── OnboardingScreen.js   # Multi-step new-user setup
│   ├── HomeScreen.js         # Browse + search + filter gigs
│   ├── EarnScreen.js         # Earnings dashboard + booked gigs
│   ├── GigsScreen.js         # Poster hub — posted jobs + booking management
│   ├── PostJobScreen.js      # Create a new gig
│   ├── EditJobScreen.js      # Edit / delete a posted gig
│   ├── ProfileScreen.js      # Stats, badges, role toggle
│   ├── SettingsScreen.js     # Edit profile fields
│   ├── ManageBookingsScreen.js  # Poster booking management (profile tab)
│   └── JobDetailScreen.js    # Job info, slot picker, book / counter-offer
├── components/               # Shared UI (FilterSheet, MessageSheet, DateTimePicker, etc.)
├── lib/
│   ├── supabase.js           # Supabase client (URL + anon key)
│   └── cache.js              # AsyncStorage cache with TTL
├── hooks/
│   └── useHaptic.js          # Web-safe haptic feedback hook
├── data/
│   └── mockData.js           # CATEGORIES, BADGE_DEFS, LEVELS, CATEGORY_COLORS
└── theme.js                  # Colors, gradients, shadows
```

> See `CLAUDE.md` for a detailed architecture reference including navigation tree, context APIs, booking lifecycle, and amendment workflow.

---

## Key Features

- **Browse & book gigs** — filter by category, pay range, days, location, and urgency; search by keyword; pick a time slot
- **Counter-offer** — propose a different rate before confirming a booking
- **Post gigs** — location autocomplete, visual date/time slot picker, custom categories
- **Real-time messaging** — in-app chat between earner and poster per booking
- **Booking lifecycle** — pending → confirmed → completed → verified, with mutual completion (both parties mark done)
- **Gig amendments** — earner proposes changes to active booking terms; poster accepts or declines
- **Earn dashboard** — today/week/all-time earnings, weekly goals, streak tracker
- **Dual ratings** — posters rate earners; earners rate posters
- **Gamification** — XP system with 5 levels, daily/weekly challenges, 5 achievement badges
- **Achievement toasts** — animated notifications on XP gain and badge unlock
- **Dual role** — toggle between Earner and Poster mode in Profile

---

## Contributing

1. Branch off `master` for your feature
2. Keep components in `src/components/`, screens in `src/screens/`
3. All colors/shadows go through `src/theme.js`
4. Run `npm run web` to do a quick sanity check in Chrome before pushing
