# GoHustlr — Path to a customer-ready trial

Status of the current branch (`feature/app-completion`, PR #2): two clear tabs (My Jobs / Hiring),
email verification, profile photos, completion photos, push notifications, images on job postings + chat,
Stripe escrow + Connect payouts, and a Tax Center for business expenses. This doc lists what's still
needed to run a real customer trial, prioritized, with notes from TaskRabbit/Thumbtack/Airbnb.

---

## Worker classification & taxes (decision + plan)

**Are workers employed by GoHustlr? No — they should be independent contractors (1099), not W‑2 employees.**
This is the standard marketplace model (TaskRabbit "Taskers", Uber drivers, Instacart shoppers are all
1099 contractors). GoHustlr is the *platform that connects* posters and earners; it does not employ earners,
set their hours, or control how work is done. Treating them as employees would create payroll tax,
benefits, workers'-comp, and minimum-wage obligations that don't fit a marketplace.

What this implies we should build/establish:
- **Independent Contractor Agreement** accepted at onboarding (a checkbox + versioned ToS). *(P0 legal)*
- **W‑9 collection** for earners (Stripe Connect Express already collects tax info during payout
  onboarding — we largely have this for card payouts). *(mostly done via Stripe)*
- **1099‑K**: Stripe issues 1099‑K to earners for **card** payments routed through Connect once they cross
  IRS thresholds. Nothing else to build for the card path. *(done via Stripe)*
- **Cash payments are off‑platform and unreported.** No one issues a 1099 for cash, so the earner must
  self‑report. Our **Tax Center** (already added) is exactly this: earners log cash income + deductible
  expenses and export a CSV/Schedule‑C-style summary. *Next:* add a **cash income log** in the Tax Center
  (mirror of expenses) and a **net profit summary** that combines Stripe income + logged cash income −
  expenses. *(P1)*
- **Recommend (don't require) on‑platform card payment.** TaskRabbit does **not** allow cash — all money
  flows through the platform, which is how it earns its fee and offers protection. We currently *allow* cash
  (poster picks payment method at verification). Decision to make: keep cash as a convenience (no escrow, no
  fee, "at your own risk"), or phase it out. Recommendation: keep cash for the trial but clearly label it
  unprotected, and nudge card. *(product decision)*

**"Should employers be able to contract workers on an ongoing basis?"** Yes, as a later expansion, not for
the first trial. Start with one‑off gigs (current). Then add: **"Rehire / Hire again"** for a past earner,
**recurring gigs** (weekly lawn care, etc.), and **business/employer accounts** (a company profile that can
post under a brand, multiple seats, invoicing). These are P2 — they widen the market but aren't needed to
validate the core loop.

---

## P0 — Required before any external trial

1. ✅ **Legal & policy screens** — Terms, Privacy, Independent Contractor Agreement (`src/data/legal.js`,
   `LegalScreen`), accept-on-signup checkbox (versioned via `TERMS_VERSION`, recorded as
   `profiles.terms_accepted_at`), Legal & Support section + support mailto in Profile.
2. ✅ **Cancellation handling** — `cancelBooking` releases the escrow hold, frees the slot, notifies the
   other party; earner can withdraw/cancel from My Jobs, poster can cancel a confirmed booking from Hiring;
   cancelled bookings move to the Completed/Past tabs. *(No-show is handled as cancel + report; a richer
   dispute flow is still P1.)*
3. ✅ **Account safety (report/block)** — `reports` + `blocks` tables; report a gig (JobDetail) or a user
   (chat menu); block hides that user's gigs from Browse and ends chat. *Still to do:* automated content
   moderation + rate-limiting sign-ups; wire the "verified" badge to real signals.
4. 🟡 **Crash/error monitoring + analytics** — foundation in place: a root `ErrorBoundary`
   (recoverable fallback instead of a white screen) and a pluggable `src/lib/analytics.js`
   (`track`/`captureError`/`identify`) wired through the core funnel (sign-in/up, gig posted,
   booking created/accepted, job verified) and key catch blocks. *Remaining:* paste a Sentry DSN +
   PostHog key into `analytics.js`, install the native SDKs, and rebuild the dev client to send real data.
5. ⏳ **Push delivery on a real build** — ship a dev/TestFlight build with `expo-notifications`; verify on a
   physical device (the simulator can't receive remote push).

## P1 — Strongly wanted for a good trial

6. **Phone verification (SMS OTP)** — higher-trust identity than email alone (Supabase phone auth or Twilio).
7. **Location & maps** — `expo-location` is installed but unused. Show distance to gigs, sort by "near me",
   and a map view of nearby jobs (TaskRabbit/Thumbtack lean heavily on location). Store lat/lng on jobs.
8. **Tips** — let posters add a tip at verification (TaskRabbit supports tipping); flows through Stripe to
   the earner.
9. **Cash income log + net-profit summary** in the Tax Center (see taxes section).
10. **Better scheduling** — the current slot picker is freeform text; add real date/time slots with
    availability, reminders before a gig, and calendar integration.
11. **Dispute / "something went wrong"** path on a completed gig before payment is captured.
12. **Saved/favorite gigs & posters; "rehire"** shortcut.
13. **Empty-state + onboarding polish, skeleton loaders, optimistic UI audit** for a smooth first run.

## P2 — Growth / expansion

14. Recurring gigs + employer/business accounts + invoicing (the "contract from employers" ask).
15. Background checks / ID verification (Stripe Identity or Checkr) for higher-trust categories.
16. In-app calling with number masking; richer notifications (digest, preferences).
17. Referral program, promo codes, featured/urgent gig boosts (monetization beyond the service fee).
18. Web/admin dashboard for support + moderation; data export; GDPR/CCPA delete.
19. Internationalization, accessibility pass, dark mode.

---

## Engineering hygiene to address alongside features
- **Storage privacy**: `avatars`, `job-photos`, `chat-photos`, `completion-photos`, `receipts` are all
  public-read for simplicity. Receipts (and arguably chat/completion photos) are sensitive — move to
  private buckets with signed URLs before a real launch.
- **Secrets**: the Supabase anon/publishable keys and Stripe publishable key are in the client (fine), but
  confirm no secret keys ever ship in the bundle.
- **Realtime/notif consistency**: notifications are client-driven (the actor calls `send-push`). For events
  that can happen while the actor is offline, consider DB triggers + `pg_net` later.
- **Tests**: there are none. Add a smoke test/E2E (Detox/Maestro) for the core book→accept→complete→verify
  loop before the trial.
