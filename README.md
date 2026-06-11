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
| State | React Context + useReducer (no backend) |
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

### 3. Start the dev server

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

### 4. Open on your phone

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
src/
├── context/
│   ├── JobsContext.js    # Job list, bookings, posted IDs
│   └── UserContext.js    # XP, earnings, streak, challenges, badges
├── screens/
│   ├── HomeScreen.js     # Browse + search gigs
│   ├── EarnScreen.js     # Earnings dashboard + booked gigs
│   ├── PostJobScreen.js  # Create a new gig
│   ├── ProfileScreen.js  # User profile + role toggle
│   └── JobDetailScreen.js
├── components/           # Shared UI (JobCard, SlotPicker, LocationPicker, etc.)
├── hooks/
│   └── useHaptic.js      # Web-safe haptic feedback hook
├── data/
│   └── mockData.js       # CATEGORIES, BADGE_DEFS, LEVELS, MOCK_JOBS
└── theme.js              # Colors, gradients, shadows
```

> All state is in-memory — there is no backend or database. State resets on every reload. See `CLAUDE.md` for a detailed architecture reference.

---

## Key Features

- **Browse & book gigs** — filter by category, search by keyword, pick a time slot
- **Counter-offer** — propose a different rate before confirming a booking
- **Post gigs** — location autocomplete, visual date/time slot picker, custom categories
- **Earn dashboard** — today/week/all-time earnings, weekly goals, streak tracker
- **Gamification** — XP system with 5 levels, daily/weekly challenges, 5 achievement badges
- **Poster trust signals** — ratings, review count, verified badge on every job
- **Achievement toasts** — animated notifications on XP gain and badge unlock
- **Dual role** — toggle between Earner and Poster mode in Profile

---

## Contributing

1. Branch off `master` for your feature
2. Keep components in `src/components/`, screens in `src/screens/`
3. All colors/shadows go through `src/theme.js`
4. Run `npm run web` to do a quick sanity check in Chrome before pushing
