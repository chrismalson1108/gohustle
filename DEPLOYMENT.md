# GoHustlr — Launch Runbook

**Status snapshot — updated 2026-06-30.**
Legend: ✅ done/verified · ⚙️ in progress · 👤 needs your account/credentials (cannot be automated) · ⚠️ must confirm before go-live.

The app is feature-complete and security-hardened (15 adversarial review rounds, converged). What remains is **operational**: confirm the live money + ID flows end-to-end in **test mode**, then do a careful **test→live key cutover**. Read §1 first — one webhook drives most of "does it actually work."

---

## 0. What changed since 2026-06-25 (so this doc is trustworthy)

- ✅ **Stripe account reconciled** to **Go Hustlr LLC** (publishable `pk_test_51ThvnME0UZF…`, in `web/lib/config.ts` + `src/lib/stripeClient.js`). Test **secret key set** in Supabase; **Connect (Express, Marketplace model) enabled**.
- ✅ **Add-a-card** (poster `SetupIntent`) and **payout onboarding** (earner Connect Express) verified returning real results on the LLC account.
- ✅ **Stripe return pages moved onto the web app** (`web/app/stripe/connect-return`, `…/identity-return`). The old Supabase-function landing pages rendered as raw text because the Edge Functions gateway forces `text/plain`+`nosniff` on browser responses. The session-creating fns (`stripe-connect-onboard`, `stripe-create-identity-session`) now build `return_url` from a **caller-supplied origin**, allowlisted to `*.vercel.app` / `gohustlr.com` / `localhost`; web passes `window.location.origin`, mobile passes a constant. **Default base = `https://gohustlr.com`.** The old `stripe-{connect,identity}-return` fns are now 302 backstops.
- ✅ **Web is public and git auto-deploys.** Push `master` → **production** at **`https://gohustle-git-master-go-hustlr.vercel.app`** (feature branches → `…-git-<branch>-…` previews). Vercel **deployment protection (login wall) is now OFF**. Vercel project = `go-hustlr/gohustle`, linked at the **repo root** `.vercel/`, Root Directory = `web`.
  - ⚠️ **`gohustle-chi.vercel.app` in any older note was WRONG** — it's a different (Flutter) project. Use the `gohustle-git-master…` URL until `gohustlr.com` is connected.
- ✅ All edge functions deployed + reachable (probed 2026-06-30: Stripe fns return `401` auth-gated, webhook returns `400` signature-gated).

---

## 1. The webhook — the linchpin ⚠️ (confirm this first)

One Stripe webhook keeps the database in sync. **If it's not registered, or its signing secret is stale, payments still charge but earnings never credit and the Verified badge never appears.** It drives:
- `payment_intent.succeeded` → credits the earner (escrow settlement; idempotent via `credit_earnings` RPC)
- `payment_intent.payment_failed` → reverts/holds the booking appropriately
- `account.updated` → keeps earner payout eligibility correct
- `identity.verification_session.{verified,requires_input,canceled}` → flips the **Verified badge** / status

**Confirm (Stripe Dashboard → Developers → Webhooks):**
1. Endpoint exists: `https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-webhook`
2. It listens for **exactly these events**:
   ```
   payment_intent.succeeded
   payment_intent.payment_failed
   account.updated
   identity.verification_session.verified
   identity.verification_session.requires_input
   identity.verification_session.canceled
   ```
   (`payment_intent.amount_capturable_updated` is optional — the code doesn't rely on it.)
3. Its **Signing secret** matches `STRIPE_WEBHOOK_SECRET` in Supabase (Edge Functions → Secrets).
4. After the test in §2, the webhook's **recent deliveries show `200`s**.

> Test mode and live mode are **separate webhook endpoints with different signing secrets**. Registering in test does NOT register in live — see §3.

---

## 2. Phase A — Prove it works in TEST mode (before touching live keys)

**Prereqs:** webhook confirmed (§1); **Stripe Identity enabled** (Dashboard → Identity); Connect enabled (✅).
**Two accounts** (a buyer can't book their own gig). **Test cards:** success `4242 4242 4242 4242` (exp `12/34`, CVC `123`, ZIP `42424`); declined `4000 0000 0000 0002`; 3-D Secure `4000 0025 0000 3155`.
**Where to test:** `https://gohustle-git-master-go-hustlr.vercel.app` (or local `web/`).

**2a. Payments / escrow end-to-end:**
1. **Earner** → Profile → Payouts → **Set up payouts** → complete Stripe Connect onboarding (test values) → status shows **active**.
2. **Poster** → post a **$20** gig with a time slot.
3. **Earner** → Browse → **book** the slot.
4. **Poster** → Hiring → **Accept** → enter test card → escrow **hold** authorized → booking **Confirmed**.
5. Both sides → **Mark done** → **Completed**.
6. **Poster** → **Verify & Rate** → **captures** the hold → earner's earnings increase by ~**$18** (−10% platform fee). (Optionally add a tip.)
7. In Stripe: the PaymentIntent goes `requires_capture → succeeded`, with a **Connect transfer** + 10% application fee. Webhook deliveries show `200`.

**2b. ID verification end-to-end:**
1. Profile → **request verification** → complete Stripe's test Identity flow → it returns to `…/stripe/identity-return` (styled "We're reviewing your ID").
2. Within ~1 min the **Verified badge** appears on the profile.
   → **That badge appearing is your live proof the webhook + Identity wiring work.** If it doesn't, re-check §1 (esp. the 3 `identity.*` events + signing secret).

**If 2a credits earnings and 2b shows the badge, the money + trust systems are confirmed.**

---

## 3. Phase B — Test → Live cutover (only after §2 is all green)

Do these together, then re-verify (§3.6):
1. **Publishable key** (test→live): Vercel env `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` **and** the baked fallbacks in `web/lib/config.ts` + `src/lib/stripeClient.js`.
2. **`STRIPE_SECRET_KEY`** (test→live, **restricted least-privilege** key): Supabase → Edge Functions → Secrets. No redeploy needed.
3. **Re-register the webhook in LIVE mode** → Stripe gives a **new signing secret** → update **`STRIPE_WEBHOOK_SECRET`** in Supabase. ← *the most-missed step; skipping it makes every live webhook fail signature, so earnings/badges silently stop.*
4. **Enable Connect + Identity in LIVE mode** (live KYC/platform profile may need completing separately from test).
5. **Vercel env vars** — set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL` **explicitly** (don't rely on the test-mode fallbacks once live).
6. **Re-run a *small real-money* smoke test** (real card, ~$1 gig, then refund). **Test-mode green ≠ live green** — live has real KYC, card AVS, and Connect restrictions.

**Key hygiene:** restricted key; rotate ~quarterly with 24h overlap (roll new → set old to expire in 24h → update secret → verify → let old lapse).

---

## 4. Remaining operational items (👤 your accounts)

| Item | Why it matters | Notes |
|---|---|---|
| **Connect `gohustlr.com` to Vercel** | Clean public domain; **unblocks mobile payout/ID return + the 302 backstops** (they default to `gohustlr.com`). | See `DEPLOY.md` §2 (Domain.com DNS). Until then mobile Stripe-return flows land on a not-yet-live domain. |
| **Verify a domain in Resend + set `STUDENT_VERIFY_FROM`** | Student `.edu` verification emails (`student-verify-start`) can't reach real inboxes on the test sender (`onboarding@resend.dev` only delivers to the account owner). | Supabase secret already has `RESEND_API_KEY` ✅. Add a verified domain in Resend, then set `STUDENT_VERIFY_FROM=verify@yourdomain`. |
| **Brand the Stripe Connect onboarding** | The hosted "Set up payouts" pages show a generic icon + Stripe's default purple instead of Hustlr branding. | Stripe Dashboard → **Settings → Connect → Branding** (do in **test + live**): upload icon `shared/assets/brand/app-icon.png`, brand color **#3F25FE** (Electric Blue), accent **#FFBC45** (Hustle Orange). Applies to onboarding + the earner Express dashboard. |
| **Supabase Auth hardening** | Production security. | Auth → enable leaked-password protection (HIBP), OTP expiry 1h, consider MFA/TOTP, enforce SSL. Set **Site URL** = `https://gohustlr.com`; **Redirect URLs**: `https://gohustlr.com/**`, `https://gohustle-git-master-go-hustlr.vercel.app/**`, `gohustlr://**`. Run **Security Advisor**, clear warnings. |
| **Mobile build + submit** | Push, native Stripe, and maps need a real build (not Expo Go). | iOS: `eas build -p ios --profile production` → `eas submit`. Android: same with `-p android`. Needs Apple Developer + Google Play accounts. Smoke-test the **accept** flow on the build. |
| **App Store / Play metadata** | Store approval. | Screenshots, descriptions, **privacy labels / Data safety** (location, financial info, identifiers), age rating (likely 17+), privacy policy URL = `https://gohustlr.com/legal/privacy`. |
| **Cancellation-fee CHARGE** | Currently policy/record only (`bookings.cancellation_fee`); no money moves. | Wiring a real charge touches the security-reviewed escrow fns — flag before doing it. |

---

## 5. Reference

**Edge functions (all deployed ✅):** `accept-booking`, `stripe-create-payment-intent`, `stripe-capture-payment`, `stripe-cancel-payment`, `stripe-tip`, `stripe-connect-onboard`, `stripe-payout-login-link`, `stripe-create-setup-intent`, `stripe-payment-method-status`, `stripe-detach-payment-method`, `stripe-create-identity-session`, `stripe-webhook`, `stripe-connect-return`/`stripe-identity-return` (302 backstops), `student-verify-start`/`student-verify-confirm`, `send-push`, `assistant`, `delete-account`.

**Supabase secrets:** `STRIPE_SECRET_KEY` (test ✅ → swap live), `STRIPE_WEBHOOK_SECRET` (✅ → re-issue live), `RESEND_API_KEY` (✅), `ANTHROPIC_API_KEY` (✅), `SUPABASE_SERVICE_ROLE_KEY` (auto).

**What Claude can / can't do:** ✅ probe functions, drive the §2 test on the test site, deploy web (`npx vercel --prod` **from the repo root**, not `web/`), edit code/docs. ❌ enter API keys, register/toggle Stripe or Supabase dashboard settings, or move real money — those are yours (Claude gives exact steps + verifies after).

**Already done/verified ✅:** all migrations applied (`supabase/migrations/`); both escrow sides server-enforced (`accept-booking` + capture-gated verify); `config.toml` `verify_jwt=false` for `stripe-webhook` + return pages (webhook returns 400 not 401); web build clean; legal docs DB-driven + consent-gated; in-app account deletion + escrow release; mobile `app.json`/`eas.json` production-ready.
