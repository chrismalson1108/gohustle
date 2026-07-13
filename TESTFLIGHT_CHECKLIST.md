# GoHustlr — TestFlight Submission Checklist

Practical, copy-paste-ready steps to get GoHustlr onto TestFlight via EAS.
Companion to `LAUNCH_PLAN.md` (this is the click-by-click for steps #16–21).

Legend: 👤 = only you can do it · 🤖 = Claude can do it in-repo · ✅ = already done

---

## 0. Prerequisites

- [ ] 👤 **Apple Developer Program enrollment complete** ($99/yr, Individual recommended).
      Verify at [developer.apple.com/account](https://developer.apple.com/account) —
      you should see a **10-character Team ID**. No Team ID = not enrolled.
- [x] ✅ `usesAppleSignIn`, `ITSAppUsesNonExemptEncryption: false`, bundle id
      `com.gohustlr.app`, privacy manifest — all set in `app.json`.
- [x] ✅ In-app account deletion (Apple 5.1.1(v)) — `SettingsScreen` → `delete-account`
      edge function (hard delete via `auth.admin.deleteUser`).
- [x] ✅ Sign in with Apple + Google both offered (Guideline 4.8 satisfied).

## 1. Create the App Store Connect app record 👤

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps → + → New App**.
2. Platform **iOS**, Bundle ID **`com.gohustlr.app`**, SKU e.g. `gohustlr-ios`, primary language English.
3. Open the app → **App Information** → copy the numeric **Apple ID** (e.g. `6740123456`).

## 2. Create an App Store Connect API key 👤

- App Store Connect → **Users and Access → Integrations → App Store Connect API** →
  generate a key (role **App Manager**), download the `.p8` **once** → save as
  `credentials/asc_api_key.p8` (git-ignored). Note the **Key ID** and **Issuer ID**.
- Details in `credentials/README.md`.

## 3. Fill in `eas.json` 🤖→👤

`submit.production.ios` is scaffolded; replace the 3 placeholders with your real values:

```json
"ascAppId": "REPLACE_WITH_NUMERIC_ASC_APP_ID",        // from step 1
"ascApiKeyPath": "./credentials/asc_api_key.p8",       // already correct
"ascApiKeyId": "REPLACE_WITH_ASC_API_KEY_ID",          // from step 2
"ascApiKeyIssuerId": "REPLACE_WITH_ASC_API_KEY_ISSUER_ID" // from step 2
```

## 4. Build + submit 🤖 (needs your Apple login once)

```bash
npx eas-cli login
npx eas-cli build   --platform ios --profile production   # ~15–25 min in the cloud
npx eas-cli submit  --platform ios --profile production --latest
```

- First build: approve EAS creating the distribution cert + provisioning profile + App ID.
- No Xcode/Mac build needed — EAS builds in the cloud.

## 5. In App Store Connect after upload 👤

- Build shows **Processing** (~5–15 min), then appears under the **TestFlight** tab.
- **Export compliance:** nothing to answer (already declared in `app.json`).
- **Internal testing** (fastest, no review): Users and Access → add yourself → add build
  to an internal group. Installable immediately.
- **External testing** (up to 10,000, needs Beta App Review): create an external group,
  fill **Test Information**, submit for beta review with the notes below.

---

## App Review notes (paste into ASC → App Review Information / Beta App Review)

> GoHustlr is a two-sided marketplace for **real-world, in-person gig services**
> (moving help, cleaning, tutoring, etc.). Payments are handled by **Stripe** because
> the transactions are for physical/real-world services performed off-app, which are
> outside the scope of In-App Purchase (Guideline 3.1.3(e) / 3.1.5(a)). The app sells
> **no digital goods, subscriptions, or in-app unlocks**.
>
> The app requires an account. Demo credentials are provided below. Two accounts are
> included so you can review both sides of the marketplace (a "poster" who hires and an
> "earner" who works). Both are pre-verified.
>
> Sign in with Apple and Google are both offered on the login screen. In-app account
> deletion is available in Profile → Settings → "Delete account".

**Demo accounts** (create these in advance, confirm their emails, ensure they pass the
beta gate — see below):

```
Poster (hires):   reviewer-poster@gohustlr.com  /  <password>
Earner (works):   reviewer-earner@gohustlr.com  /  <password>
```

**Reviewer access gotchas — do these before submitting:**
- Email verification is ON, so reviewers can't self-signup. **Pre-create + confirm** the
  two demo accounts above (confirm them in Supabase → Auth, or via a magic link).
- The beta signup gate currently has the `'*'` open-signups row, so new signups aren't
  blocked. If you **re-close** the beta before review, allowlist the reviewer emails:
  `insert into public.beta_allowlist(email) values ('reviewer-poster@gohustlr.com'), ('reviewer-earner@gohustlr.com');`
- Complete onboarding on both demo accounts so the reviewer lands in the main app.

## TestFlight "What to Test" blurb

> Thanks for testing GoHustlr! Please try: browsing gigs near you, posting a gig,
> booking a gig, messaging the other party, marking a job complete, and rating.
> Payments run in Stripe **test mode** during beta — use card `4242 4242 4242 4242`,
> any future expiry, any CVC. Report anything confusing or broken. 🙏

## App Privacy "nutrition labels" (ASC → App Privacy) 👤

Declare data collected: **Location** (gig proximity), **Contact Info** (name/email),
**User Content** (photos), **Identifiers**, **Purchases/Financial Info** (via Stripe),
**Usage Data / Diagnostics**. Link a working privacy-policy URL on gohustlr.com.

---

## Remaining engineering nits before external review 🤖 (optional, low-risk)

- Confirm the Apple sign-in button is visible on the login screen on a real iOS device
  (`AppleAuthentication.isAvailableAsync()` gate).
- Verify `delete-account` cascades all user rows (bookings, messages, reviews) not just
  the profile — Apple checks that deletion is real.
