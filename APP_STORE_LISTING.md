# GoHustlr — App Store Listing Content (draft)

Prepared for App Store Connect (app Apple ID `6790460957`, bundle `com.gohustlr.app`).
**Review before publishing.** Nothing here is submitted for App Review without your go-ahead.

---

## App Information

- **Name:** GoHustlr
- **Subtitle (≤30):** `Hire help. Earn cash nearby.`
- **Primary category:** Business  ·  **Secondary:** Lifestyle
  - _Rationale: local labor/gig-services marketplace — Business captures "find work / side hustle," Lifestyle covers on-demand local services. Avoid Finance (Stripe is a means, not the product)._
- **Content rights:** Does NOT contain third-party content (all first-party or user-generated).

## Promotional Text (≤170)
Need a hand or want to earn on the side? GoHustlr connects you with ID-verified neighbors for moving, cleaning, tutoring and more—secure payments and real reviews.

## Keywords (≤100 chars, no spaces)
`gig,odd,jobs,task,hire,handyman,local,errand,moving,cleaning,tutor,labor,freelance,make,money,mover`

## Description
GoHustlr is the local marketplace that connects people who need real-world help with skilled locals ready to do the work. Whether you need a hand around the house or you're looking to earn on your own schedule, it all happens in one simple, secure app built around real people in your community.

No agencies. No guesswork. Just neighbors helping neighbors get things done.

**NEED SOMETHING DONE? HIRE LOCAL HELP.**
Post a gig in seconds and let nearby helpers come to you. Moving and heavy lifting, cleaning, tutoring, yard work, furniture assembly, errands, pet care, event help, and just about anything else on your to-do list. Add photos and details, set your pay, choose a time, and book with confidence.

You stay in control the whole way. Compare profiles, ratings, and reviews before you hire, message directly to work out the details, and keep your payment protected until the job is finished. You only release funds when you're happy with the work.

- Post a job with photos, pay, location, and a time that suits you
- Discover trusted, nearby helpers with location-based search and a map view
- Chat in the app to confirm the details before anyone shows up
- Pay securely and release funds only when the work is done
- Rate your helper and build a network of people you trust

**WANT TO EARN? TURN YOUR TIME INTO INCOME.**
GoHustlr makes it easy to find flexible, in-person work close to home. Browse open gigs, grab the time slots that fit around your life, do great work, and get paid. Set your skills, show off your ratings, and grow a reputation that brings in more jobs and better pay over time.

- Find local gigs matched to your skills and availability
- Book time slots that fit your schedule, including recurring work
- Get paid quickly with secure payouts straight to your bank
- Earn tips when you go above and beyond
- Track your income and expenses in the built-in Tax Center

**BUILT FOR TRUST AND SAFETY.**
- ID verification helps confirm there are real people behind profiles
- Two-sided reviews mean posters and earners both build a reputation
- Secure escrow-style payments hold funds until the work is confirmed complete
- Private in-app messaging keeps your phone number and email to yourself
- Report and block tools keep you in control of who you deal with

**HOW IT WORKS.**
1. Sign up and set up your profile in minutes
2. Post a gig or browse work near you
3. Book a time and chat to lock in the details
4. Get the job done, then pay or get paid securely
5. Leave a review and do it all again

Every account can both post gigs and pick up work, so you're never locked into one side.

GoHustlr is currently in beta. Join early, tell us what you think, and help shape a better way to get local work done.

Questions or feedback? Reach us anytime at mainmail@gohustlr.com or visit gohustlr.com.

---

## Age Rating → expect **17+** (16+ under Apple's 2026 bands)
Driven entirely by open user-generated content + user-to-user messaging (NOT mature content). All content-descriptor questions = **None**. You attest UGC moderation controls (content filter, block, report, published contact), but Apple still assigns the higher band for open UGC + messaging.

Key answers: all violence/sexual/drug/gambling/profanity descriptors = **None**; Users can message = **Yes**; App has UGC = **Yes**; Moderation controls = **Yes**; Made for Kids = **No**; Unrestricted web access = **No**.

---

## App Privacy (nutrition label) — from a codebase scan

| Data type | Collected | Linked to user | Tracking | Purpose |
|---|---|---|---|---|
| Contact Info — Name | ✅ | ✅ | ❌ | App Functionality |
| Contact Info — Email | ✅ | ✅ | ❌ | App Functionality |
| Contact Info — Phone | ❌ | — | — | (not collected) |
| User Content — Photos | ✅ | ✅ | ❌ | App Functionality |
| User Content — Other (messages, reviews, bio, gig text) | ✅ | ✅ | ❌ | App Functionality |
| User Content — Customer Support | ✅ | ✅ | ❌ | App Functionality |
| Identifiers — User ID | ✅ | ✅ | ❌ | App Functionality |
| Identifiers — Device ID (push token) | ✅ | ✅ | ❌ | App Functionality |
| Location — Coarse (city) | ✅ | ✅ | ❌ | App Functionality |
| Location — Precise (GPS) | ⚠️ judgment call | ❌ | ❌ | App Functionality |
| Financial — Payment Info (Stripe) | ⚠️ recommended ✅ | ✅ | ❌ | App Functionality |
| Financial — Other (tax center, earnings) | ✅ | ✅ | ❌ | App Functionality |
| Purchases — Purchase History | ✅ | ✅ | ❌ | App Functionality |
| Other — Date of Birth / Age | ✅ | ✅ | ❌ | App Functionality (18+ gate) |
| Usage Data — Product Interaction | ❌ today (analytics off) | — | — | ⚠️ flip to ✅ when you add PostHog/Amplitude |
| Diagnostics — Crash Data | ❌ today (Sentry off) | — | — | ⚠️ flip to ✅ when you add Sentry |
| Sensitive Info — Gov ID/selfie | ❌ (Stripe Identity hosted) | — | — | verify you never pull raw doc back |

**Tracking = NO across the board** (no ATT/IDFA, no ad SDKs).

### Judgment calls you must decide
1. **Precise Location:** GPS is used only on-device (distance sort, mileage) and never persisted — could be marked "not collected." But your privacy policy says you collect GPS, so it's marked collected to match + be review-safe. Decide the stance and align the label with the policy.
2. **Payment Info:** Card data goes into Stripe's SDK/hosted flow; your backend never stores card numbers. Recommended to declare Payment Info anyway (most marketplaces do). Confirm no PAN/CVV ever hits your servers/logs.
3. **ID verification (Sensitive Info):** Document + selfie are handled entirely by Stripe Identity; app never receives them → marked not collected. Confirm you never pull the raw doc back via Stripe API.
4. **Analytics/Diagnostics are OFF today** so marked not-collected. The moment you add a PostHog/Sentry key, you MUST update the label (Usage Data + Diagnostics, linked to identity).

---

## App Review notes (paste into App Review Information)
_(Full text also generated — includes the closed-beta/demo-account explanation and the marketplace-services / not-IAP rationale per Guideline 3.1.3(e)/3.1.5.)_

**Demo accounts needed (you must create + pre-verify these, then fill passwords):**
- Poster: `demo-poster@gohustlr.com` / _(set password, add to beta allowlist, confirm email)_
- Earner: `demo-earner@gohustlr.com` / _(same)_

## TestFlight "Test Information"
- **Feedback email:** mainmail@gohustlr.com
- **Beta description + What to Test:** generated (covers sign-in incl. Google/Apple, onboarding, posting, booking lifecycle, messaging, Stripe escrow with test card 4242…, report/block, Tax Center).

---

## What still needs YOU
- **Screenshots** — required; must be real captures from the app (we'll grab these once it's installable via TestFlight).
- **Price** — set Free (assumed) or choose a tier.
- **Demo accounts** — create + pre-verify the two above, add to beta allowlist.
- **Decide the 3 privacy judgment calls** above.
- **Privacy Policy URL + Support URL** on gohustlr.com (App Store requires a reachable privacy-policy URL).
