# GoHustlr — Launch Runbook

Status snapshot (2026-06-25). Legend: ✅ done · ⚙️ in progress · 👤 needs your account/credentials (cannot be automated).

The app is **feature-complete and security-hardened** (15 adversarial review rounds, converged). What remains is almost entirely **operational** — store submissions, dashboard toggles, and credentials only you can enter.

---

## 0. Blockers (do these first)

| # | Item | Owner | Notes |
|---|---|---|---|
| 0.1 | **Rotate `STRIPE_SECRET_KEY`** (the live one is expired) | 👤 | `supabase secrets set STRIPE_SECRET_KEY=... --project-ref nfioebqsgmmzhbksxozc` (or Supabase Dashboard → Edge Functions → Secrets). Use a **restricted key** (least-privilege). No redeploy needed. |
| 0.2 | **Enable Stripe Connect + Express** | 👤 | Stripe Dashboard → Connect → enable; complete the platform profile. Required for earner payouts. |

After 0.1 + 0.2: tell me and I'll re-probe the full payment path.

---

## 1. Backend — Supabase (mostly ✅)

- ✅ All migrations applied via `supabase db push` (source of truth in `supabase/migrations/`).
- ✅ All edge functions deployed; both escrow sides server-enforced (`accept-booking`; captured-payment-gated verify).
- ✅ `config.toml` sets `verify_jwt=false` for `stripe-webhook` + return pages (confirmed live: webhook returns 400, not 401).
- ⚙️ Secrets: `STRIPE_SECRET_KEY` (rotate — 0.1). `ANTHROPIC_API_KEY` rotated ✅. `STRIPE_WEBHOOK_SECRET` set ✅.
- 👤 **Auth → Providers / Security**: enable **leaked-password protection** (HaveIBeenPwned), set **OTP expiry** to 1h, consider **MFA/TOTP**, enforce SSL. Run **Security Advisor** and clear any warnings.
- 👤 **Auth → URL Configuration**: set **Site URL** = `https://gohustlr.com`; add **Redirect URLs**: `https://gohustlr.com/**`, the Vercel URL `https://gohustle-chi.vercel.app/**`, and `gohustlr://**` (mobile).

## 2. Payments — Stripe

- 👤 Rotate secret key (0.1) + enable Connect/Express (0.2).
- 👤 **Register the webhook**: endpoint `https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-webhook`, events:
  `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.amount_capturable_updated`,
  `account.updated`, `identity.verification_session.verified`, `identity.verification_session.requires_input`,
  `identity.verification_session.canceled`. Confirm it returns **200**s in the Stripe webhook logs.
- 👤 **Enable Stripe Identity** (ID verification feature).
- 👤 **Live smoke test** (test mode): post gig → book → accept (card `4242 4242 4242 4242`) → both mark done → verify (captures) → earner paid. See §7.
- 👤 **Go-live**: swap test→live keys (publishable on the client/Vercel **and** `STRIPE_SECRET_KEY` in Supabase), re-register the webhook in live mode (new signing secret → update `STRIPE_WEBHOOK_SECRET`).
- **Key hygiene**: restricted least-privilege key; rotate ~quarterly with a 24h overlap (roll → set old key to expire in 24h → update secret → verify → let old lapse).

## 3. Web — Vercel (✅ live)

- ✅ Deployed (`gohustle-chi.vercel.app`), production build clean, all 24 routes 200, CSP enforcing, auth gates work.
- 👤 **Custom domain** `gohustlr.com` (Vercel → Domains → add + DNS). `SITE_URL` and the mobile password-reset redirect already point there.
- 👤 **Env vars** (Vercel → Settings → Environment Variables): set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`. (Safe fallbacks are baked in for test mode; set these explicitly before switching Stripe to **live**.)

## 4. Mobile — Expo / EAS (config ✅)

- ✅ `app.json` production-ready: bundle IDs `com.gohustlr.app`, all permission strings, iOS privacy manifests, `scheme: gohustlr`, build numbers, EAS projectId.
- ✅ `eas.json` has development / preview / production profiles + submit.
- 👤 **Build + submit** (needs your Apple Developer + Google Play accounts):
  - iOS: `eas build -p ios --profile production` → `eas submit -p ios`
  - Android: `eas build -p android --profile production` → `eas submit -p android`
- ⚠️ A real build is required for **push notifications, native Stripe, and maps** (native — not in Expo Go).
- 👤 **Smoke test the build**, especially the rewired **accept** flow (review #11).

## 5. App Store / Play metadata (👤)

- App Store Connect: app record, screenshots (6.7" + 5.5" + iPad if "supportsTablet"), description, keywords, **privacy labels** (location, financial info, contact, identifiers), **age rating** (likely 17+), support URL, **privacy policy URL** = `https://gohustlr.com/legal/privacy`.
- Play Console: store listing, content rating questionnaire, **Data safety** form, screenshots.

## 6. Legal / compliance (✅)

- ✅ Terms / Privacy / Independent-Contractor docs in the DB (`legal_documents`), consent-gated, versioned (publish a new `(slug, version)` row to force re-acceptance — no app release needed).
- ✅ Privacy Policy (v2026-06-24) discloses location/GPS, payments/Stripe, data retention, and deletion.
- ✅ In-app **account deletion** (Apple 5.1.1(v) / Play / GDPR-CCPA) implemented + escrow-hold release on delete.

## 7. End-to-end smoke test (after 0.1 + 0.2)

Two accounts (a buyer can't book their own gig). Stripe test cards: success `4242 4242 4242 4242` (exp `12/34`, CVC `123`, ZIP `42424`); declined `4000 0000 0000 0002`; 3DS `4000 0025 0000 3155`.

1. **Earner** → Profile → Payouts → Set up payouts → Stripe Connect onboarding (test values) → status "active".
2. **Poster** → post a $20 gig with a slot.
3. **Earner** → Browse → book the slot.
4. **Poster** → Hiring → Accept → enter test card → escrow **hold** authorized → booking **Confirmed**.
5. Both → Mark done → **Completed**.
6. **Poster** → Verify & Rate → **captures** → earner paid (−10% fee). Optionally add a tip.
7. Confirm in Stripe: PI `requires_capture → succeeded`, Connect transfer, 10% application fee.

## 8. Verification baseline (✅)

- Mobile `npm test` = 41 passing (6 suites). Web `next build` = 22/22 routes, pages static.
- Security: 15 adversarial review rounds, converged (two consecutive clean). Both escrow sides server-enforced.
