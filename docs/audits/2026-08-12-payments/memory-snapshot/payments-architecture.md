---
name: payments-architecture
description: "How GoHustlr payments/payouts work, the TaskRabbit-style goal, and the Phase 2 embedded-onboarding dependency"
metadata: 
  node_type: memory
  type: project
  originSessionId: c3924a8b-2a2a-4b53-bca9-b793aa112212
---

GoHustlr uses **Stripe Connect destination charges with manual capture (escrow)**: poster pays at accept → funds held → captured + transferred to earner (minus 10% fee) on poster verify. Edge Functions live in `supabase/functions/stripe-*`; client wrappers in `src/lib/stripeClient.js`; readiness helpers (`getPaymentReadiness`, `getPaymentMethodStatus`, `getPayoutStatus`) in `src/context/JobsContext.js`.

**Product goal (owner, college-student market):** feel like TaskRabbit/eBay — neither party should feel they're "creating a Stripe account." Stripe must be the invisible processor. Both parties set up before accepting; payouts deferred-to-cashout was explicitly rejected.

**Done (Phase 1):** poster card-on-file via SetupIntent (`stripe-create-setup-intent`), payment-method status (`stripe-payment-method-status`), unified role-aware "GoHustlr Payments" hub (`PayoutSetupScreen.js`), payment-setup alerts on Profile/Gigs/Earn, earnings now credited to earner on verify, nav-trap fix (`initial: false` on cross-tab navigate).

**Phase 2 (NOT done — needs external unblocks):** remove the stripe.com **redirect** for earner bank onboarding by switching to the native `ConnectAccountOnboarding` embedded component. Blocked on: (1) `@stripe/stripe-react-native@0.50.3` does NOT export `StripeConnectProvider`/`ConnectAccountOnboarding` → needs SDK upgrade + native rebuild; (2) Stripe "embedded components" access is private-preview → owner must request it in the Stripe dashboard. Plan file: `~/.claude/plans/quizzical-brewing-pebble.md`.

**Infra:** Stripe TEST keys; `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` set in Supabase (project ref `nfioebqsgmmzhbksxozc`); webhook registered with `account.updated` + `payment_intent.*` — the `account.updated` webhook is the ONLY thing that flips `stripe_accounts.onboarded=true` (the connect-return page is static HTML).
