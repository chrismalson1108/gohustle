# Shipping GoHustlr — TestFlight & security checklist

## ✅ Fixed in-repo (this pass)

- **iOS location permission** — added `NSLocationWhenInUseUsageDescription` + the
  `expo-location` config plugin. Without this Apple rejects the build *and* the app
  crashes when it requests location (`src/components/LocationPicker.js`,
  `src/screens/HomeScreen.js` use `expo-location`).
- **iOS privacy manifest** — `ios.privacyManifests` in `app.json` declares the
  required-reason APIs (UserDefaults/AsyncStorage, file timestamp, boot time, disk
  space). Apple requires a privacy manifest for App Store submissions.
- **Web security headers** — `web/next.config.ts` now sends HSTS, `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  and an **ENFORCING** CSP (`Content-Security-Policy`, not Report-Only — verify against production before adding any third-party script; the old note said report-only and was wrong
  after the browser console shows no violations).

## ⚠️ SDK 55 upgrade — READ BEFORE THE NEXT RELEASE (2026-08-13)

The app moved Expo 54 → 55 (RN 0.81 → 0.83, `@stripe/stripe-react-native` 0.50 → 0.63).
That is a NATIVE change, and it has one consequence that is easy to get wrong:

**The runtimeVersion fingerprint changed** — `d75c3ab4…` (SDK 54) → `32a5c684…` (SDK 55).
The policy is `fingerprint`, so this is it working as designed: it stops incompatible JS
reaching an old binary. But it means:

- **An OTA cannot carry this upgrade.** `eas update` from master now publishes against the
  NEW fingerprint and reaches nobody still on the 54 binary.
- **Ship a build first, then resume OTAs.** Until testers install the new build, any urgent
  JS fix must ALSO be published against the old fingerprint or it reaches no one.

**Three native surfaces were never verified**, because a simulator cannot exercise them.
Walk each on the first TestFlight build:

1. **Stripe payment sheet** — the biggest single jump in the upgrade (13 minors). Add a
   card, pay for a gig, and confirm a saved card still appears. Server-side ephemeral keys
   are pinned to apiVersion `2024-06-20`; a mismatch here breaks SAVED CARDS specifically.
2. **Remote push** — `push.js` returns null on simulators via `Device.isDevice`, so the
   whole registration path is untested. Confirm a token registers and a notification lands.
3. **Google sign-in** — needs real client IDs and a device.

Everything else was verified: 773 tests, native build, app launch, real data, maps
rendering, and the two confirmed upgrade breaks fixed (full-screen swipe-back on every
pushed screen; tab-bar label clipping on OS font-size change).

## 📱 iOS → TestFlight (you — needs your Apple Developer account)

```bash
# 1. Bump the build (marketing version is 1.4.2; build number auto-increments
#    via eas.json's production profile: autoIncrement + appVersionSource local)
eas build --platform ios --profile production

# 2. Submit to App Store Connect → TestFlight
eas submit --platform ios --profile production
```
- `eas submit` will ask for an **App Store Connect API key** (recommended) or your
  Apple ID — create the key at App Store Connect → Users and Access → Integrations.
- First submit also needs the app record created in App Store Connect (bundle id
  `com.gohustlr.app`).
- **Push notifications:** the current binary can't receive remote push until you
  build a dev client / production build with `expo-notifications` (it's native). This
  build includes it, so push will work once installed — but you must enable the
  **APNs key** in your Apple account and in EAS (`eas credentials`).

## 🤖 Android → Play Console (you — same codebase)

The app is already Android-config-ready: package `com.gohustlr.app`, adaptive icon,
and the `expo-location` plugin auto-adds `ACCESS_FINE_LOCATION` to the manifest.
`eas.json` already has the build profiles.

```bash
eas build --platform android --profile production   # produces an .aab
eas submit --platform android --profile production   # needs a Google Play service-account JSON
```
- Create the app in the **Google Play Console** (one-time), and a **service account**
  key for `eas submit`.
- **Push on Android** needs an **FCM** setup (Firebase project + `google-services`
  credentials in EAS) — `eas credentials` walks you through it.

## 🌐 Web (Vercel) — when you're ready

Root directory `web`, framework Next.js. Env vars are already public-safe
(`NEXT_PUBLIC_*`). See `DEPLOY.md`. The security headers ship automatically.

## 🔒 Security follow-ups (not blockers)

- **Promote the CSP** from `Content-Security-Policy-Report-Only` to
  `Content-Security-Policy` once you've confirmed no violations in the console.
- **Assistant rate limiting** — the bot has per-request write caps but no
  cross-request quota; add a per-user token-bucket (small Supabase table or
  Upstash) before heavy traffic to bound Anthropic spend.
- **Dependency audit** — `npm audit` shows ~37 mobile (1 high) / 2 web findings,
  almost all transitive. **Don't** `npm audit fix --force` (it breaks the Expo SDK
  pin); review the high one and bump individually with `npx expo install` where
  Expo provides a compatible version.
- **Rotate the Anthropic API key** that was pasted in chat earlier.

## ✅ Already solid (spot-checked)

- RLS is owner-scoped across every table (profiles public-read carries no PII —
  email lives in `auth.users`); edge functions validate the JWT; the Stripe webhook
  verifies its signature; storage buckets are owner-scoped writes (`receipts`
  private). The AI assistant got an adversarial review (IDOR + races fixed).
