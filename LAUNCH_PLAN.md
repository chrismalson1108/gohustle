# GoHustlr — Launch Plan

_Last updated: 2026-06-15_

The product is **feature-complete** for a first release (all 38 backlog items shipped:
two-sided marketplace, escrow payments, Connect payouts, Stripe Identity, messaging,
reviews, tax center, push, referrals, recurring gigs, etc.).

What's left to "get it out there" is **not features** — it's going live on real
infrastructure, clearing legal/business gates, and the App Store / Play Store
mechanics. This plan is ordered by the **critical path to a public launch**.

Legend: 🤖 = I can do it in-repo · 👤 = needs you (account, money, legal, device) · 🤝 = we pair

---

## Phase 1 — Production hardening (engineering) 🤖

These are code/config tasks I can complete now. None require new accounts.

1. **Switch Stripe to live keys (code side).** Move the publishable key to an env/config
   so test vs live is a one-line switch; confirm **no secret keys** are in the bundle
   (they aren't — secrets live in edge-function env). Blocked on you activating the live
   account (Phase 3). 🤖→👤
2. **Wire real monitoring.** `src/lib/analytics.js` has null `SENTRY_DSN` / `ANALYTICS_KEY`
   placeholders. Install `@sentry/react-native` + PostHog, paste keys, forward in the
   marked spots. Needs a dev-client rebuild. 🤖 (keys from you)
3. **Harden storage privacy.** `chat-photos` and `completion-photos` are public-read
   (unguessable paths). Move to private buckets + signed URLs before launch (we already
   did this for `receipts`). 🤖
4. **Server-side abuse controls.** Rate-limit sign-ups and gig posts; add a lightweight
   server-side moderation pass (the current content filter is client-side only). 🤖
5. **Empty-states / skeleton loaders / optimistic-UI audit** for a smooth first run. 🤖
6. **E2E smoke test** (Maestro or Detox) for the core loop: post → book → accept →
   complete → verify → rate. Unit tests exist; there's no end-to-end coverage. 🤖
7. **Final QA sweep on a real device** (not just simulator), all happy + error paths. 🤝

## Phase 2 — Trust, safety & legal content 👤🤖

8. **Real legal review.** The Terms / Privacy / Independent-Contractor Agreement are
   DB-driven and versioned, but the *content* needs a lawyer's sign-off — marketplace
   liability, 1099 classification, payments/escrow disclosures, dispute policy,
   arbitration. **This is the single biggest non-engineering blocker.** 👤
9. **Business entity + insurance.** LLC/Inc, general-liability / platform insurance,
   and a registered support address. Required by Apple/Stripe and for liability. 👤
10. **Privacy policy + support URLs** hosted on a public domain (App Store requires a
    reachable privacy-policy URL). 🤝
11. **Phone (SMS OTP) verification** — higher-trust identity than email. Needs an SMS
    provider (Supabase phone auth or Twilio). 🤖 (provider/account from you)

## Phase 3 — Payments go-live 👤🤝

12. **Activate the Stripe account for live mode** — complete the platform profile,
    accept **Connect platform terms**, and **enable Stripe Identity** in live mode
    (the two dashboard steps from the Identity work). 👤
13. **Register live webhooks** — point the live `stripe-webhook` events (payment,
    account.updated, identity.*) at the production function URL with the live signing
    secret. 🤝
14. **Set live edge-function secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
    in Supabase. 👤 (I'll give exact commands)
15. **End-to-end payment test in live mode** with a real card + a real bank payout to a
    test Connect account. 🤝

## Phase 4 — App Store & Play Store prep 👤🤝

16. **Apple Developer Program** ($99/yr) and **Google Play Developer** ($25 one-time)
    accounts. 👤
17. **App Store Connect / Play Console listings** — name, subtitle, description,
    keywords, category, age rating, privacy "nutrition labels" / Data Safety form. 🤝
18. **Store assets** — screenshots (multiple device sizes), app preview, feature
    graphic. Icon + splash already exist. 🤝 (I can script screenshot capture)
19. **Production EAS builds** — `eas build --platform all --profile production`
    (eas.json already has a production profile). 👤 runs it; 🤖 preps config.
20. **App Review compliance** — Apple Guideline 3.1.1 (digital vs physical goods: gig
    services are physical/real-world, so external payments are allowed — document this),
    account-deletion flow (Apple requires in-app delete), and demo credentials for
    reviewers. Account-deletion may need building. 🤖🤝

## Phase 5 — Closed beta / trial 🤝

21. **TestFlight (iOS) + Play Internal Testing (Android)** with 10–50 real users. 👤
22. **Run the real customer trial** — the original goal. Watch Sentry/PostHog funnels,
    collect feedback, fix top issues. 🤝
23. **Seed liquidity** — a two-sided marketplace is dead without gigs *and* workers in
    one geography. Pick one launch city/campus; pre-seed both sides. 👤

## Phase 6 — Public launch & post-launch 🤝

24. **Submit for review → release** to both stores.
25. **Marketing landing page** + app-store links on the gohustlr domain. 🤝
26. **Support workflow** — triage inbox, response SLAs, an admin/moderation view
    (currently support is a mailto). 🤖🤝
27. **Monitoring dashboards + on-call** for payments failures and crashes. 🤝

---

## Critical path (the shortest line to a live trial)

1. **Legal review** (#8) and **business entity/insurance** (#9) — longest lead time, start now. 👤
2. **Stripe live activation** (#12–15) — gates all real money. 👤🤝
3. **Production hardening** (#1–6) — I can do most of this in parallel today. 🤖
4. **Apple/Google accounts + production builds** (#16, #19) — gates store presence. 👤
5. **TestFlight/Play beta** (#21) → **trial** (#22).

**Rough sequencing:** Legal + entity + Stripe activation can run in parallel with my
engineering hardening. Once both land, do production builds → beta → trial. The
engineering work is days; the legal/account/store-review steps are the real calendar time.

## What only you can do (gather these to unblock me)
- Sentry DSN + PostHog key (#2)
- Lawyer for legal review (#8); LLC + insurance (#9); a domain for policy/support URLs (#10)
- SMS provider account if we do phone verification (#11)
- Stripe live activation + Connect/Identity terms (#12); live secrets (#14)
- Apple Developer + Google Play accounts (#16)
