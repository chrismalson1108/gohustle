# Draft fixes — NOT APPLIED, NOT REVIEWED

Candidate migrations and regression tests produced by the exploit stage of the
2026-08-12 payments audit. They are kept **outside `supabase/migrations/`** on purpose, so
`supabase db push --linked` cannot pick them up.

Nothing here has been executed, reviewed, or applied to any database.

## ⚠️ Timestamp collision

`20260812070000_alerting_is_watched.sql` and
`20260812070000_promo_counterfactual_is_the_pinned_baseline.sql` carry the **same**
timestamp. Migrations apply in filename order, so as written their relative order is
ambiguous. Renumber before either is moved into `supabase/migrations/`.

## Contents

| File | Addresses |
|---|---|
| `20260812070000_alerting_is_watched.sql` | Nothing watches the alert-dispatch flags — the 2026-07-10 silent death recurring with a new key. Adds a control that reads `app_flags` rather than only `net._http_response`. |
| `alertingWatched.test.js` | Regression test for the above. |
| `20260812070000_promo_counterfactual_is_the_pinned_baseline.sql` | Promo cost is measured against the standing rate, blind to the loyalty tier, so a campaign is charged for benefit the tier already delivered. |
| `promo-baseline.test.js` | Regression test for the above. |

## Before using any of these

Per the plan's test protocol: **write the failing test first and watch it fail against
unfixed code.** These tests were written alongside their fixes, so they have never been
observed failing — which is exactly the property that makes a test meaningful. Run each
against current `master` and confirm it fails before trusting that it verifies anything.

Note also that the plan sequences the promo-counterfactual fix **together with** the
kind-aware `settle_booking_benefits` change as a single migration, because both rewrite
`consume_promo_grant` and `settle_booking_benefits`. Applying this one alone means writing
those bodies twice — which is precisely the reproduction error that caused the worst
finding in the audit.
