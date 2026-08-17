# Android → Google Play launch runbook

Companion to `TESTFLIGHT.md` (iOS). Everything here is Android-specific and current as of
**2026-08-17**, verified against the SDK 55 tree in this repo rather than from memory.

---

## Where the code stands

| Piece | State | Evidence |
|---|---|---|
| `targetSdkVersion` / `compileSdk` | **36** (Android 16) | Expo SDK 55 default, `expo-modules-core/android/ExpoModulesCorePlugin.gradle:65,69` |
| `minSdkVersion` | 24 (Android 7.0) | same file |
| Play's Aug 31 2026 API-36 mandate | **already met** — no work needed | see above |
| Package name | `com.gohustlr.app` | `app.json` |
| Adaptive icon (fg/bg/monochrome) | present | `assets/android-icon-*.png` |
| New Architecture (Fabric) | on | `android/gradle.properties: newArchEnabled=true` |
| Edge-to-edge (required by Android 15+) | on | `android/gradle.properties: edgeToEdgeEnabled=true` |
| `POST_NOTIFICATIONS` (Android 13+) | declared, merges from the library manifest | `node_modules/expo-notifications/android/src/main/AndroidManifest.xml` |
| `RECORD_AUDIO` | **removed** — the app only ever picks images | `blockedPermissions` in `app.json`; manifest now shows `tools:node="remove"` |
| Google Maps Android key | **placeholder — blocks the map** | `app.json → android.config.googleMaps.apiKey` |
| FCM (Android push) | **not configured** | no `android.googleServicesFile` |
| `eas submit` Android profile | added | `eas.json → submit.production.android` |
| AAB output for Play | pinned | `eas.json → build.production.android.buildType: "app-bundle"` |

**Two things block a working Android release: the Maps API key and FCM.** Everything else
is either done or a console/account step below.

---

## Decide this first — it sets your whole timeline

Google gates production access differently by account type, and this is the long pole:

| | **Personal account** | **Organization account** (Go Hustlr LLC) |
|---|---|---|
| D-U-N-S number | not required | **required** — free, but can take up to 30 days |
| Closed-test gate | **12 testers, opted in 14 continuous days**, before you may apply for production | **exempt** |
| Best when | you want to start testing today | you want the shortest path to public launch |

You already have **Go Hustlr LLC** (the Stripe account is on it). Because the 12-tester/
14-day clock and the D-U-N-S wait can run *in parallel*, the fastest sequence is:

1. **Request the D-U-N-S number today** (free, dnb.com) — it is the only step with a
   multi-week floor and nothing else depends on it.
2. Register the Play account as an **Organization** using the LLC.
3. The legal business name in Play Console must match the incorporation documents
   *exactly* — a mismatch is the single most common verification rejection.

If you would rather not wait on D-U-N-S, register personal and start the 12-tester clock
immediately — but note that closed beta testers must stay opted in for 14 *continuous*
days; someone who opts out resets their own contribution to zero.

---

## Accounts and services to sign up for

| # | Service | Cost | What you get | Needed for |
|---|---|---|---|---|
| 1 | [Google Play Console](https://play.google.com/console/signup) | **$25 once** | developer account | everything |
| 2 | Dun & Bradstreet D-U-N-S | free | business identifier | organization account only |
| 3 | Google Cloud Console (project `735847623182` — the one already holding your OAuth clients) | free tier | Maps SDK key + Android OAuth client | the map, Google sign-in |
| 4 | Firebase (same Google account) | free (Spark) | `google-services.json` + FCM V1 key | Android push |

You already have everything else — EAS/Expo, Supabase, Stripe, Resend.

---

## Step 1 — Google Maps key (blocks the Map view)

`JobsMap` renders `react-native-maps` with `PROVIDER_DEFAULT`. On iOS that means Apple
Maps and needs no key; **on Android there is no Apple Maps, so it is always Google Maps
and always needs an API key.** Without it the Map tab renders a blank grey grid — it does
not error, which is why this is easy to ship by accident.

1. Google Cloud Console → **APIs & Services → Library** → enable **Maps SDK for Android**.
   Use the *same* project as your existing OAuth clients so everything stays in one place.
2. **Credentials → Create credentials → API key**.
3. **Restrict the key** (do not skip — an unrestricted key is the one real abuse risk):
   - *Application restrictions* → **Android apps**
   - Add package `com.gohustlr.app` + your SHA-1 (see Step 2 for where SHA-1s come from —
     add **both** the upload and the Play App Signing fingerprint)
   - *API restrictions* → **Maps SDK for Android** only
4. Paste it into `app.json`, replacing the placeholder:

```json
"android": { "config": { "googleMaps": { "apiKey": "AIza…" } } }
```

Mobile map loads on the Maps SDK for Android are not billed, so a restricted key here
carries no meaningful cost exposure.

---

## Step 2 — SHA-1 fingerprints (the step everyone gets wrong)

**Google Play re-signs your app.** The AAB you upload is signed with your *upload* key,
then Play strips that and re-signs with the *app signing* key it holds. Anything that
validates your app by certificate — Google Sign-In and the restricted Maps key — must
trust **both** fingerprints, or it works in your internal build and fails for every real
installer.

```bash
eas credentials --platform android
```

→ *production* → *Keystore* → shows the **upload** SHA-1. (First run offers to generate
the keystore; let EAS manage it — losing it means never updating the app again.)

Then, after your first upload: **Play Console → Test and release → App integrity → App
signing** → copy the **App signing key certificate** SHA-1.

Register **both** SHA-1s everywhere a fingerprint is asked for.

---

## Step 3 — Google Sign-In on Android

`signInWithGoogle` uses the native module with `webClientId`. On Android, Google
additionally validates the calling app by package + certificate, so without an **Android
OAuth client** you get `DEVELOPER_ERROR` at sign-in — with no useful message.

1. Google Cloud Console → **Credentials → Create credentials → OAuth client ID → Android**
2. Package name `com.gohustlr.app`, SHA-1 = the upload fingerprint from Step 2
3. Create a **second** Android client with the Play App Signing SHA-1
4. Nothing to change in `app.json` — Android clients are matched by fingerprint, not by ID

Your existing `webClientId` stays as-is and must remain listed under
**Supabase → Auth → Providers → Google → Client IDs**.

---

## Step 4 — Android push (FCM V1)

Push needs **two separate files** that are easy to confuse:

| File | Where it goes | Secret? |
|---|---|---|
| `google-services.json` | repo root, referenced from `app.json` | no — public identifiers, safe to commit |
| FCM V1 service-account key | uploaded to EAS only | **yes — never commit** |

1. [Firebase Console](https://console.firebase.google.com) → add project (or link the
   existing Google Cloud project).
2. **Add app → Android**, package `com.gohustlr.app` → download `google-services.json` →
   save at the repo root.
3. Add to `app.json` inside the `android` block:

```json
"googleServicesFile": "./google-services.json"
```

4. Firebase → **Project settings → Service accounts → Generate new private key** → a JSON
   downloads. Upload it to EAS:

```bash
eas credentials --platform android
```

→ *production* → **Google Service Account** → *FCM V1* → upload.

`.gitignore` now blocks `firebase-service-account*.json` and `credentials/*.json`, and
deliberately does **not** block `google-services.json` (ignoring it silently breaks push
on the EAS build workers).

---

## Step 5 — Play service account, so `eas submit` can upload

1. Play Console → **Setup → API access** → link your Google Cloud project
2. **Create new service account** → opens Google Cloud → grant no GCP roles
3. Back in Play Console → **Grant access** → role **Release manager** → *Invite user*
4. Google Cloud → that service account → **Keys → Add key → JSON** → save as:

```
credentials/play-service-account.json
```

`eas.json` already points at that path. The file is gitignored.

---

## Step 6 — Build and submit

```bash
eas build --platform android --profile production
```

```bash
eas submit --platform android --profile production
```

`eas.json` submits to the **internal** track as a **draft** — deliberate, so nothing can
reach the public before you press the button in the console.

`appVersionSource` is `local` and the production profile sets `autoIncrement`, so
`android.versionCode` in `app.json` bumps itself (currently **9**). Play rejects any
re-used versionCode, so let it increment and commit the change.

---

## Step 7 — Play Console listing (where reviews actually fail)

**App access — this one will reject you.** Signups are invite-gated
(`supabase/migrations/20260710000000_beta_invite_gate.sql`). A reviewer who cannot get past
the gate rejects the app as broken. Under **App content → App access**, provide a working
test account (email + password) that is already allowlisted, plus a one-line note on how
to reach a gig. Verify that login works from a device that has never run the app.

Also required before you can publish:

- **Data safety** — declare what you collect and why. Yours: name/email/username, photos,
  **precise location** (nearby gigs), payment info via Stripe, messages. Say that data is
  encrypted in transit and that users can request deletion (`delete-account` function
  exists — link it).
- **Content rating** questionnaire — a marketplace with free-text chat; answer the
  user-generated-content questions honestly. Understating UGC is a policy violation.
- **Target audience** — the app enforces an 18+ age floor (`20260710040000_age_floor.sql`).
  Declare 18+ and it stays out of Families policy entirely.
- **Privacy policy URL** — must be publicly reachable, not gated. You serve these from
  the `legal_documents` table; give Google the public web URL.
- **Financial features** — declare that you facilitate payments (Stripe).
- **Ads** — declare none.

**On Play Billing:** you do *not* owe Google 15–30%. Google Play Billing is mandatory only
for digital goods consumed in-app. GoHustlr sells **real-world services performed
off-app**, the same exemption Uber and TaskRabbit use, so Stripe is correct and permitted.
Keep it that way — adding any in-app digital purchase would drag you into Play Billing.

---

## Known gaps, stated plainly

- **The Android build is not yet verified to compile.** Local Gradle cannot run on this
  Windows machine — every invocation dies with
  `java.io.IOException: Unable to establish loopback connection`, before compiling a
  single file. It is not a project problem (it reproduces with the daemon on and off, with
  matched JVM args, and outside the tool sandbox); Java is being denied a loopback socket,
  which on Windows is almost always endpoint-security or firewall software blocking
  `java.exe`. This also blocks `npm run android` locally. **An EAS cloud build sidesteps it
  entirely** and is the real verification — nothing here has been proven to compile until
  that build goes green.
- **The maps key and FCM are placeholders.** A build made right now compiles and installs,
  but the Map view is blank and push does not arrive.
- **Untested on Android hardware:** Stripe payment sheet, Google sign-in, push delivery,
  and the map. None can be exercised by the Jest suite (1221 tests, all passing) because
  all four are native surfaces. Test them on an internal-track build before opening the
  beta.
- **Google Pay is off** (`enableGooglePay: false`). Not required; card entry works. Turning
  it on later is a Stripe-plugin flag plus a Play declaration.
