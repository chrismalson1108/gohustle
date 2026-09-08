# GoHustlr — iOS submission pack

Everything needed to fill in App Store Connect for app **6790460957** (`com.gohustlr.app`),
plus the things that must be true *before* you press **Add for Review**.

Companion documents: `APP_STORE_LISTING.md` (the copy rationale and the privacy-label
reasoning), `TESTFLIGHT.md` (build + upload mechanics), `KNOWN_RISKS.md` (the risk
register this cites), `BETA_QA_PLAN.md` (the manual passes to walk before shipping).

Screenshots are in `docs/app-store/screenshots/`. Regenerate with
`node scripts/app-store-screenshots/render.mjs`. Paste-ready copy, one plain file per
field, is in `docs/app-store/listing/`.

Driving the App Store Connect UI with a local browser agent instead of filling it in by
hand? `COWORK_PROMPT.md` in this directory is the self-contained instruction set — same
answers, plus the guardrails (never press submit, never guess, stop and ask) that a agent
clicking through a live app record needs.

---

## 1. Blockers — fix these before submitting

Ordered by how early they stop you.

### 1.1 The version number does not match the binary — this one blocks the upload

App Store Connect has the version as **1.0**. `app.json` has `"version": "1.4.2"`, which
becomes the build's `CFBundleShortVersionString`. **A build only attaches to the App Store
version whose string it matches**, so a 1.4.2 build will never appear in the Build picker
on a 1.0 version page. Pick one:

- **Set the app to 1.0.0** — edit `app.json` → `expo.version` to `"1.0.0"` and rebuild.
  Cleanest for a first public release; 1.4.2 is internal TestFlight history nobody outside
  has seen. Note this changes nothing about the fingerprint-based OTA runtime.
- **Or rename the App Store version to 1.4.2** — in App Store Connect, change the version
  string on the version page. Keeps continuity with TestFlight builds.

Either way the two strings must be identical before the build will show up.

### 1.2 iPad support is declared, so iPad screenshots are mandatory

`app.json` has `ios.supportsTablet: true`. That puts iPad layout in review scope and makes a
**13-inch iPad screenshot set (2064 × 2752)** a required upload. Nothing in this repo
records an iPad layout pass, and every screen was designed against a 428pt phone.

**Recommendation: drop the declaration for 1.0** — set `ios.supportsTablet: false` and
rebuild. It removes a required asset set and a whole rejection surface, and it is reversible
in any later release once iPad is actually tested. If you keep it, you must both test the
iPad layout and produce that screenshot set; the generator here only emits iPhone sizes.

### 1.3 The description still frames the app as a beta

Guideline **2.2 (Beta Testing)** — App Store listings may not present the app as a trial or
beta. The paragraph beginning *"GoHustlr is currently in beta…"* has to go. The
ready-to-paste description in §2 already has it removed.

### 1.4 The reviewer needs a payment path that works on live keys

Review notes referencing Stripe's `4242 4242 4242 4242` only work while
`app_flags.stripe_mode` is `test`. On live keys that card is declined, and a reviewer who
cannot complete a booking files a Guideline **2.1** rejection for incomplete functionality.

This is a decision, not something to paper over. Options, best first:

1. **Pre-seed the demo accounts with bookings already in every state** — pending,
   confirmed, completed, verified, plus one refunded — so the reviewer can *observe* the
   full escrow lifecycle, the Transactions ledger and the payout copy without initiating a
   charge. Then leave exactly one **$1 demo gig** for the single live charge. Say all of
   this explicitly in the review notes.
2. **Submit while `stripe_mode` is `test`**, then flip to live at release. Works, but you
   ship a build whose first real users transact against a config the reviewer never saw,
   and `ctl_stripe_id_mode_mismatch` will have opinions about the switchover.

Whichever you pick, the reviewer must **never** land in a Stripe Connect onboarding form —
pre-complete Connect onboarding and identity verification on the demo earner.

### 1.5 The iOS location purpose string does not cover mileage tracking

`app.json` declares, in both `NSLocationWhenInUseUsageDescription` and the `expo-location`
plugin:

> GoHustlr uses your location to show gigs near you and sort them by distance.

The app reads location for **three** things, and that string describes one of them:

| Where | What it does | Covered? |
|---|---|---|
| `HomeScreen` | one-shot fix for distance sort | yes |
| `LocationPicker` | "use my location" to fill a gig or profile location | loosely |
| `EarnScreen` | **`watchPositionAsync` — continuous tracking during a drive, to auto-log mileage into the Tax Center** | **no** |

Continuous tracking that feeds a tax-deduction record is not "show gigs near you and sort
them by distance". Apple checks purpose strings against observed behaviour, and a user
reading that prompt would not expect a drive tracker. Replace both copies with one string
that covers all three:

> GoHustlr uses your location to show gigs near you, sort them by distance, and — when you
> start a drive — to log your mileage for your tax records.

This is native config, so it needs a rebuild; batch it with the version change in §1.1.
Foreground permission is correct and should stay — the tracker uses `watchPositionAsync`
under when-in-use only, and there is no `UIBackgroundModes: location`, which keeps the app
out of the far heavier background-location review path.

### 1.6 The remaining pre-flight items

- **`beta_allowlist` must keep its `'*'` row** through review, or the reviewer cannot sign
  up at all. (This is also why `ctl_waitlist_invite_broken` stays deliberately silent —
  see CLAUDE.md's Waitlist section.)
- **Seed visible gig inventory** in a market the reviewer will land in. App Review is in
  California; the browse feed is distance-sorted and a `LAUNCH_ZIPS` Monroe-only feed can
  read as an empty app. Seed gigs the demo accounts can see.
- **Push the migrations and deploy the edge functions** — `supabase db push --linked`, then
  each function by hand (`supabase/config.toml` records which ones must keep
  `verify_jwt = false`; a blanket deploy re-enables gateway JWT verification and silently
  kills safety paging).
- **Sign in with Apple token revocation on account deletion** (5.1.1(v)) is a known,
  deliberate gap — KNOWN_RISKS §16 rates it *likely-rejection, not a hard blocker*, and
  explains why a rushed patch is worse than the gap. Go in knowing it may come back.

---

## 2. Field-by-field — copy and paste

> Paste from **`docs/app-store/listing/`** rather than out of the code blocks below —
> one plain file per field, so a stray fence or a line of surrounding prose cannot ride
> along. App Store Connect rejects an over-length field with an error that names the
> limit but not the cause, which sends you auditing copy that was never the problem.
> The blocks here are the same text, kept inline so this document reads on its own.

### App Information (set once, not per-version)

| Field | Value |
|---|---|
| Name | `GoHustlr` |
| Subtitle | `Hire help. Earn cash nearby.` (28/30) |
| Primary category | Business |
| Secondary category | Lifestyle |
| Content rights | Does **not** contain third-party content |
| Privacy Policy URL | `https://gohustlr.com/legal/privacy` |

Category rationale: Business captures "find work / side hustle", Lifestyle covers on-demand
local services. Avoid Finance — Stripe is a means, not the product.

### Version 1.0 page (the screen in your screenshots)

**Promotional Text** (163/170) — editable without a new build, so this is the line to change
for campaigns:

```
Need a hand, or want to earn on the side? GoHustlr connects you with ID-verified neighbors for moving, cleaning, tutoring and more — secure payments, real reviews.
```

**Keywords** (99/100) — leave exactly as they are, they already fit:

```
gig,odd,jobs,task,hire,handyman,local,errand,moving,cleaning,tutor,labor,freelance,make,money,mover
```

**Support URL** — change from `https://gohustlr.com` to the page that actually takes a
message:

```
https://gohustlr.com/contact
```

**Marketing URL** (optional):

```
https://gohustlr.com
```

**Copyright** — `2026 GoHustlr` is correct as entered.

**Description** — the beta paragraph removed, everything else unchanged:

```
GoHustlr is the local marketplace that connects people who need real-world help with skilled locals ready to do the work. Whether you need a hand around the house or you're looking to earn on your own schedule, it all happens in one simple, secure app built around real people in your community.

No agencies. No guesswork. Just neighbors helping neighbors get things done.

NEED SOMETHING DONE? HIRE LOCAL HELP.
Post a gig in seconds and let nearby helpers come to you. Moving and heavy lifting, cleaning, tutoring, yard work, furniture assembly, errands, pet care, event help, and just about anything else on your to-do list. Add photos and details, set your pay, choose a time, and book with confidence.

You stay in control the whole way. Compare profiles, ratings, and reviews before you hire, message directly to work out the details, and keep your payment protected until the job is finished. You only release funds when you're happy with the work.

- Post a job with photos, pay, location, and a time that suits you
- Discover trusted, nearby helpers with location-based search and a map view
- Chat in the app to confirm the details before anyone shows up
- Pay securely and release funds only when the work is done
- Rate your helper and build a network of people you trust

WANT TO EARN? TURN YOUR TIME INTO INCOME.
GoHustlr makes it easy to find flexible, in-person work close to home. Browse open gigs, grab the time slots that fit around your life, do great work, and get paid. Set your skills, show off your ratings, and grow a reputation that brings in more jobs and better pay over time.

- Find local gigs matched to your skills and availability
- Book time slots that fit your schedule, including recurring work
- Get paid quickly with secure payouts straight to your bank
- Earn tips when you go above and beyond
- Track your income and expenses in the built-in Tax Center

BUILT FOR TRUST AND SAFETY.
- ID verification helps confirm there are real people behind profiles
- Two-sided reviews mean posters and earners both build a reputation
- Secure escrow-style payments hold funds until the work is confirmed complete
- Private in-app messaging keeps your phone number and email to yourself
- Report and block tools keep you in control of who you deal with

HOW IT WORKS.
1. Sign up and set up your profile in minutes
2. Post a gig or browse work near you
3. Book a time and chat to lock in the details
4. Get the job done, then pay or get paid securely
5. Leave a review and do it all again

Every account can both post gigs and pick up work, so you're never locked into one side.

Questions or feedback? Reach us anytime at mainmail@gohustlr.com or visit gohustlr.com.
```

**App Store Version Release** — your page has *Automatically release this version*
selected. Switch to **Manually release this version** for the first release, so approval
does not put the app on sale at whatever hour the review finishes. You want to flip
`stripe_mode` to live, confirm the controls board is green, and *then* release.

---

## 3. App Review Information

**Sign-in required**: already checked. Fill in the demo earner's credentials — the reviewer
will exercise both sides from one account, since every GoHustlr account can both post and
earn.

**Demo accounts to create and pre-verify** (both need a confirmed email, a row in
`beta_allowlist`, completed onboarding, accepted current legal docs, and — for the earner —
completed Stripe Connect onboarding and identity verification):

- Poster: `demo-poster@gohustlr.com`
- Earner: `demo-earner@gohustlr.com`

**Contact Information**: your name, a phone number Apple can actually reach during review,
and `mainmail@gohustlr.com`.

**Notes** — adjust the payment paragraph to match the decision you made in §1.4:

```
GoHustlr is a two-sided local services marketplace. One account can both post gigs and pick up work, so the demo credentials above are enough to see the whole product.

WHAT TO TRY
1. Browse — the home tab lists gigs near you with category filters, search and a map view.
2. Open a gig — tap any listing to see the pay breakdown, the poster's rating and the available time slots.
3. Book — pick a slot and tap "Book this gig". The booking appears under My Jobs.
4. Message — open the booking and message the poster in-app.
5. Hire — the Hire tab posts a gig from the other side.
6. Transactions — You > Settings > Money shows the payment ledger, escrow state and receipts.

PAYMENTS ARE NOT IN-APP PURCHASES
GoHustlr facilitates payment for real-world, in-person services performed between two people (moving, cleaning, tutoring, yard work). Under Guideline 3.1.3(e) and 3.1.5(a) these are physical goods and services consumed outside the app, so they are processed by Stripe rather than in-app purchase. Nothing digital is unlocked by a payment.

HOW PAYMENT WORKS
The poster's card is authorized when they accept a booking and is only captured after they verify the work was completed. The earner is paid out to their own bank account through Stripe Connect. GoHustlr takes a percentage service fee, which is shown to the earner before they book.

DEMO PAYMENT PATH
[Describe here exactly what you seeded — e.g. "The demo account already has bookings in every state (pending, confirmed, completed, verified and refunded) so the full lifecycle can be observed without a charge. A $1 demo gig is available if you would like to complete a live booking end to end."]

USER-GENERATED CONTENT
Gig listings, profiles, messages, reviews and photos are user-generated. All text passes through an automated moderation filter before it is stored, all uploaded images are scanned, and every listing, profile and conversation carries report and block controls. Reports reach a staffed moderation queue. Users must be 18+ and accept the Terms and the Independent Contractor Agreement at sign-up.

CONTACT
mainmail@gohustlr.com
```

---

## 4. App Privacy (the nutrition label)

Set this under App Privacy, not on the version page. **Tracking is NO across the board** —
there is no ATT prompt, no IDFA and no ad SDK in the build.

| Data type | Collected | Linked | Purpose |
|---|---|---|---|
| Contact Info — Name | Yes | Yes | App Functionality |
| Contact Info — Email | Yes | Yes | App Functionality |
| User Content — Photos | Yes | Yes | App Functionality |
| User Content — Other (messages, reviews, bio, gig text) | Yes | Yes | App Functionality |
| User Content — Customer Support | Yes | Yes | App Functionality |
| Identifiers — User ID | Yes | Yes | App Functionality |
| Identifiers — Device ID (push token) | Yes | Yes | App Functionality |
| Location — Coarse | Yes | Yes | App Functionality |
| Location — Precise | Yes | No | App Functionality |
| Financial Info — Payment Info | Yes | Yes | App Functionality |
| Financial Info — Other (earnings, Tax Center) | Yes | Yes | App Functionality |
| Purchases — Purchase History | Yes | Yes | App Functionality |
| Other Data — Date of Birth | Yes | Yes | App Functionality (18+ gate) |
| Diagnostics — Crash Data | Yes | Yes | App Functionality |
| Diagnostics — Other Diagnostic Data | Yes | Yes | App Functionality |
| Contact Info — Phone | No | — | not collected |
| Sensitive Info — Gov ID / selfie | No | — | Stripe Identity hosted; the app never receives the document |
| Usage Data — Product Interaction | No | — | `track()` only writes an in-memory ring buffer |

Three of these are judgment calls, explained in full in `APP_STORE_LISTING.md`:

1. **Precise Location** is used on-device only (distance sort, mileage logging) and never
   persisted — arguably "not collected". It is declared anyway because the published
   privacy policy says GPS is collected, and the label must not contradict the policy.
2. **Payment Info** never reaches your servers — card data goes to Stripe's SDK. Declared
   anyway, as most marketplaces do. Confirm no PAN or CVV ever appears in your logs.
3. **Analytics and Diagnostics are off today.** The moment you set `SENTRY_DSN` or
   `ANALYTICS_KEY` (`src/lib/analytics.js`), you must come back and flip Usage Data and
   Diagnostics to collected-and-linked. A stale privacy label is its own violation.

---

## 5. Age rating

Expect **17+** (16+ under Apple's 2026 bands), driven entirely by open user-generated
content plus user-to-user messaging — not by mature content.

- Every violence / sexual content / drugs / gambling / profanity descriptor: **None**
- Users can communicate with each other: **Yes**
- App contains user-generated content: **Yes**
- Moderation controls (filter, block, report, published contact): **Yes**
- Made for Kids: **No**
- Unrestricted web access: **No**

---

## 6. Screenshots

Generated at exact App Store pixel sizes from the current UI, using the real design tokens
in `shared/theme.js` and the real Ionicons glyph set. Demo content is fictional.

```
docs/app-store/screenshots/
├── iphone-6.9/          1320 × 2868   (6.9-inch — iPhone 16/17 Pro Max class)
│   ├── app-screens/     plain device captures
│   └── with-captions/   same screens with a marketing caption
└── iphone-6.5/          1284 × 2778   (6.5-inch — the slot your console is showing)
    ├── app-screens/
    └── with-captions/
```

Seven screens, in the order they should be uploaded — App Store Connect only uses the
**first three** on the install sheet, so the order matters:

| # | Screen | Caption on the marketing set |
|---|---|---|
| 1 | Browse | Find real work near you |
| 2 | Gig details + payout breakdown | See exactly what you take home |
| 3 | My Jobs (active booking) | Every gig, start to finish |
| 4 | Messages | Chat in-app. Your number stays private |
| 5 | Transactions | Secure payments, real receipts |
| 6 | Progress (You tab) | Build a reputation that pays |
| 7 | Post a gig | Post a gig in under a minute |

**Which set to upload:** `with-captions` converts better on the store and is what most
marketplaces ship. `app-screens` is the unadorned version — use it if you would rather the
listing read as a plain product tour.

⚠️ **These are rendered from the code, not captured from a running device.** Every value,
colour, corner radius, icon and string was taken from the actual components, and the money
maths follows `shared/pricing.js` at the live 700 bps rate (a $120 gig nets the earner
$111.60). They are accurate, but they have not been diffed against a real device capture.
Before you upload, install the TestFlight build and check screen 1 and screen 2 against the
real thing. If anything differs, fix the generator and re-run it rather than hand-editing a
PNG.

Apple requires screenshots to show the app in use. These do — nothing here depicts a
feature that does not exist. The one thing to keep true: if a screen changes materially,
regenerate rather than leaving a stale image on the listing.

---

## 7. Build, upload, submit

```bash
# 0. Guard against the react-native-maps fingerprint drift — it exits non-zero
#    with the remedy, and `eas build` misleadingly exits 0 when it hits this.
node scripts/preflight-eas-build.mjs

# 1. Build. Build number auto-increments (eas.json production profile).
eas build --platform ios --profile production

# 2. Upload to App Store Connect. Credentials are already in eas.json's submit block.
eas submit --platform ios --profile production
```

Then in App Store Connect: **Build → +**, pick the build (it will only appear if §1.1 is
resolved), fill in everything above, and **Add for Review**.

Export compliance is already answered — `ITSAppUsesNonExemptEncryption: false` is in
`app.json`, so Apple will not ask.

---

## 8. Final check before you press the button

- [ ] `app.json` version matches the App Store version string exactly (§1.1)
- [ ] iPad decision made — declaration dropped, or a 13" screenshot set uploaded (§1.2)
- [ ] Description carries no beta framing (§1.3)
- [ ] Demo accounts exist, are email-confirmed, onboarded, allowlisted, and have Connect +
      identity already completed (§1.4)
- [ ] The reviewer's payment path is real and described in the notes (§1.4)
- [ ] `beta_allowlist` still has its `'*'` row
- [ ] Gig inventory is visible to the demo accounts
- [ ] `supabase db push --linked` run; edge functions deployed by hand
- [ ] Privacy Policy URL and Support URL both resolve
- [ ] App Privacy, age rating and pricing (Free) all completed
- [ ] Screenshots spot-checked against the TestFlight build (§6)
- [ ] Release set to **manual**
- [ ] `BETA_QA_PLAN.md` walked on the exact build being submitted
