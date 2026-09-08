# Browser-agent prompt — corrections to the published App Store Connect listing

Two things filed with Apple do not match what the code actually does. Both were verified
against the repository on 2026-09-08. Paste everything below the line into the
locally-running browser agent.

**Nothing here is a guess.** Each correction cites the file that proves it.

---

You previously completed the App Store Connect listing for **GoHustlr** (Apple ID
**6790460957**, iOS App Version **1.0**). A source-code audit has since found two entries
that do not match the app's actual behaviour. Both must be corrected before submission.

## Rules

1. **Do NOT click "Add for Review" or "Submit for Review".** A human submits.
2. **Change only what is listed below.** Everything else on the listing was verified as
   correct — do not "improve" it.
3. If a screen does not look the way this describes, **stop and ask** rather than
   improvising. These are compliance statements on a live app record.
4. Report the before and after value of every field you touch.

---

## Correction 1 — App Privacy: Diagnostics IS collected (this one is required)

**What is currently filed:** Diagnostics marked as **not collected**.

**Why that is wrong:** the app has no third-party crash SDK (no Sentry, no Firebase, no
Crashlytics — confirmed absent from `package.json`), and the previous answer was reasoned
from that. But the app ships its own first-party crash sink:

- `src/lib/analytics.js` → `captureError()` → `reportError()` POSTs to the
  `log-client-error` Supabase edge function.
- That function inserts into the `client_errors` table, whose `user_id` column is a
  foreign key to `profiles(id)` — so the data **is linked to the user's identity**.
- `src/components/ErrorBoundary.js` reports render crashes through the same path with
  `fatal: true`, i.e. genuine crash reporting.
- There are 14 `captureError` call sites across booking, payment capture, tipping and gig
  posting.

The absence of a vendor SDK is not the absence of collection. Apple compares the label
against observed network behaviour, and this transmits on error in production.

**What to do:**

Go to **App Privacy → Edit** (the data-collection questionnaire). Add the **Diagnostics**
category and select these two data types:

| Data type | Purpose | Linked to the user | Used for tracking |
|---|---|---|---|
| **Crash Data** | App Functionality | **Yes** | **No** |
| **Other Diagnostic Data** | App Functionality | **Yes** | **No** |

Do **not** add **Performance Data** — no launch-time, hang-rate or energy metrics are
collected.

**Leave everything else on the privacy label exactly as it is.** In particular these were
audited and confirmed correct — do not change them:

- **Usage Data / Product Interaction stays NOT collected.** `track()` writes only an
  in-memory ring buffer and a development-only console line. Nothing is transmitted.
- **Precise Location stays "collected but NOT linked to the user."** Verified: the mileage
  tracker holds GPS points in memory only and persists nothing but the accumulated
  distance; job coordinates are rounded server-side to 2 decimal places (~1.1 km) by
  `capture_job_location()`; no other latitude/longitude column exists anywhere in the
  schema, and profiles store no coordinates.
- **Sensitive Info stays NOT collected.** Stripe Identity's hosted flow never returns the
  document or selfie to the app.
- **Tracking stays "No" on every data type.** No advertising SDK, no IDFA, no ATT prompt.

Save, and complete the publish step if App Store Connect presents one. Confirm the section
shows as published, not draft.

---

## Correction 2 — App Review Notes: the payment paragraph is not achievable

**What is currently filed**, in the App Review Information notes:

> A $1 demo gig is available if you would like to complete a live booking end to end.

**Why that is wrong:** the app ships a **Stripe test-mode publishable key**, hardcoded at
`src/lib/stripeClient.js` line 4 (`pk_test_51Thvn…`). It is a literal in the source, not
an environment variable, so the production build carries it. On a test key a reviewer's
real card is **declined**. Following that instruction leads to a failed payment, which is
a Guideline 2.1 rejection for incomplete functionality — the exact outcome the note was
written to avoid.

**Ask the user which of these two they chose before editing anything.** Do not pick for
them. The user has been given both options and knows which applies.

### If the user says "submitting in TEST mode" (the current build)

Replace the `DEMO PAYMENT PATH` paragraph with exactly:

```
DEMO PAYMENT PATH
This build is configured with Stripe test credentials, so no real money moves and no real card is charged. To complete a booking end to end, use test card 4242 4242 4242 4242 with any future expiry date, any 3-digit CVC and any postal code. The demo account also has bookings already in each state (pending, confirmed, completed and verified) so the full escrow lifecycle can be observed without creating a new one.
```

### If the user says "switching to LIVE keys before the build"

Replace the `DEMO PAYMENT PATH` paragraph with exactly:

```
DEMO PAYMENT PATH
The demo account has bookings already in each state (pending, confirmed, completed and verified), so the full escrow lifecycle — authorization on booking, capture on verification, and the resulting payout record — can be reviewed without initiating a charge. If you would prefer to complete a booking yourself, a $1.00 demo gig is available on the account; it is a live charge for one dollar, which we will refund.
```

Save the App Review Information section.

---

## Correction 3 — one wording softening (recommended, not required)

The review notes currently say report and block controls are on **every** listing. The
audit found:

- **Conversations**: report AND block — `src/components/MessageSheet.js` (`handleBlock`,
  `doBlock`, plus a report sheet). Correct.
- **Profiles**: report AND block — `src/screens/PublicProfileScreen.js` ("Block this
  user"). Correct.
- **Listings**: report yes (`ReportSheet` on the browse card's ⋯ menu and "Report this
  gig" on the detail screen). **Block is not on the listing itself** — it is two taps
  away, by tapping the poster to open their profile and blocking there.

Apple's Guideline 1.2 requires *a mechanism* to block abusive users, which exists and is
reachable. But the sentence as filed overstates it, and a reviewer who taps a listing
looking for a block button will not find one. Change that one sentence to:

```
Gig listings, profiles, messages, reviews and photos are user-generated. All text passes through an automated moderation filter before it is stored, all uploaded images are scanned, and report controls appear on every listing, profile and conversation. Blocking a user is available from their profile and from any conversation with them. Reports reach a staffed moderation queue. Users must be 18+ and accept the Terms and the Independent Contractor Agreement at sign-up.
```

Everything else in that paragraph was verified true: text moderation runs before storage
(`moderateText` in `PostJobScreen` and `MessageSheet`), image scanning runs on every upload
(`moderate-image` in `src/lib/uploadImage.js`), and reports land in a staffed queue (the
admin console's `/moderation` page).

---

## What was audited and needs NO change

Report these back so the user knows they were checked, and do not touch them:

- Age rating answers
- Content Rights (No)
- Pricing (Free) and availability
- Manual release
- Privacy Policy URL
- Promotional text, description, keywords, support and marketing URLs, copyright
- Subtitle and categories
- Screenshot set and order

---

## Finish

Do not click "Add for Review". Report:

1. The before and after value of each field you changed.
2. Which payment option the user chose for Correction 2.
3. Confirmation that App Privacy shows as **published**, not draft.
