# RUNBOOK — Money

What to do when money goes wrong. Written 2026-08-04, for the beta.

**Escalation contact:** whoever holds the `SAFETY_ONCALL_EMAIL` inbox.
**Target response:** 4h for anything in §1–§3, 24h for §4–§6.
**Do not** resolve a money incident without leaving an `admin_user_notes` entry on
every affected account. That note is the only durable record of *why* you acted.

---

## 0. Where things live

| Thing | Where |
|---|---|
| Admin console | `https://admin.gohustlr.com` (TOTP required) |
| Payments list | `/payments` — filter by `authorized` / `captured` / `cancelled` / `failed` |
| One booking end-to-end | `/bookings/<id>` — escrow panel, both parties, full conversation, photos |
| Server-side failures | `/errors` — `platform = edge` rows are edge-function failures; `fatal` = money didn't move when it should have |
| Stripe | Dashboard (TEST while `NEXT_PUBLIC_STRIPE_DASHBOARD_BASE` ends in `/test`) |
| Alert email | Resend → `SAFETY_ONCALL_EMAIL`, falling back to `mainmail@gohustlr.com` |

**The money model in one paragraph.** Poster accepts → `stripe-create-payment-intent`
places a **manual-capture authorization** (a hold, not a charge) with
`transfer_data.destination` = the earner's Connect account and a 10%
`application_fee_amount`. Both parties mark done → `completed`. Poster verifies →
`stripe-capture-payment` captures fully, or partially at `pct ≥ 0.5` with a written
reason (which inserts a `disputes` row). Tips are a **separate** off-session
destination charge with **no** application fee. These are **destination charges**, so
the platform is merchant of record: a chargeback claws back from the *platform*
balance while the earner's money already left.

> **`payments.amount_cents` is the ORIGINAL AUTHORIZATION and is never rewritten.**
> The amount actually collected is `earner_amount_cents + fee_cents`. Never quote
> `amount_cents` to a poster as "what you paid".

---

## 1. Authorization about to expire on completed work

**Symptom:** a booking is `completed` but the poster hasn't verified. Stripe
authorizations die at **~7 days**. When it lapses, the earner did the work and there
is nothing behind it.

1. `/payments?status=authorized` → find rows where `created_at` is 5+ days old.
2. Open `/bookings/<id>`. Confirm the work actually happened: `earner_done`,
   completion photos, the conversation.
3. If the work is genuine, nudge the poster — `/users/<posterId>` → **Notify user**
   (writes their in-app inbox, pushes to their device, optionally emails).
4. If the poster is unresponsive and the scheduled start was **3+ days** ago, the
   earner can self-settle in-app via `earner-claim-payment`. Tell them to.
   - That path **refuses** if there is an open dispute or report on the booking.
     There is currently **no console override** — see §7.
5. If the hold has already lapsed: there is no way to recover it. The poster must
   re-pay. Record it in `admin_user_notes` on both accounts.

---

## 2. Chargeback (`charge.dispute.created`)

**You get an email** titled "Dispute opened". The webhook already inserted a
`disputes` row and flagged the booking (auto-settlement suppressed).

1. Open the Stripe Dashboard link in the email. Note the **reason code** and the
   **evidence deadline** — Stripe's deadline is hard.
2. Open `/bookings/<id>` and assemble evidence. Everything you need is already
   stored: before photos, completion photos, the full conversation with signed
   image URLs, both ratings, `started_at`, and the slot time.
3. Submit evidence **in Stripe**. The console cannot do this.
4. Money reality: the earner has likely already been paid out (daily payouts, no
   `delay_days`). If you lose, the platform eats it.
5. If the same poster appears twice: suspend. `/users/<id>` → **Suspend**, reason
   `repeat chargeback`. A second chargeback should never be able to place a third hold.

> **Known gap:** the dashboard's `GMV captured` and `Platform fees` are **not**
> reduced by refunds or chargebacks — `payments.status` has no `refunded` state. Treat
> those tiles as gross, not net, until that ships.

---

## 3. A capture failed / the poster can't pay

**Symptom:** `/errors` shows a `fatal` row from `stripe-capture-payment`, or a poster
reports "Verify & Rate" failing.

1. `/errors` → filter fatal. The row names the function and carries the context.
2. Open `/bookings/<id>` → **Open in Stripe**. Check the PaymentIntent status.
   - `requires_capture` → the hold is alive; ask the poster to retry in-app.
   - `canceled` → the hold is gone (§1).
   - `succeeded` → it actually worked; the failure was after capture. Check
     whether `payments.status` says `captured` and whether the earner's earnings
     moved. If not, this is a ledger drift — record it and credit by hand.
3. **Do not capture from the Stripe Dashboard as a shortcut.** A Dashboard capture
   fires `payment_intent.succeeded`, and that handler credits the earner the
   **pre-computed full split** without reading `amount_received` — so a partial
   capture credits the earner too much and overstates GMV. Fix that first (see
   `ADMIN_AUDIT_2026-08-04.md` L7) or accept the drift knowingly and note it.

---

## 4. Tip charged but not credited

**Symptom:** `/errors` — `fatal`, from `stripe-tip`, message "Tip charged but NOT
credited". The context has `payment_intent`, `booking_id`, `earner_id`, `tip_cents`.

The card is charged and the funds are heading to the earner's connected account, but
`tip_ledger` has no row, so the earner's dashboard is short and nothing reconciles it
automatically. Most likely cause: `trg_guard_tip_caps` firing on a race.

Pick one, then note it:
- **Refund** the PaymentIntent in Stripe (cleanest — nobody is owed anything, and it
  needs no DB surgery). **Prefer this.**
- **Credit by hand**: update the earner's `profiles.earnings_*` and the booking's
  `tip_amount` directly.
  > Do **not** try to fix it by inserting a fresh `tip_ledger` row — `trg_guard_tip_caps`
  > evaluates the caps on any insert carrying a *new* `payment_intent_id`, so a manual
  > reconciliation row can be rejected by the very cap that caused the problem. The
  > trigger exempts only a replay of an already-stored PaymentIntent.

---

## 5. Tip refused as over-cap

Not an incident. Since 2026-08-04 tips are capped at
**max(2× captured, $200) per booking**, **3 tips per booking**, and **$500 per poster
per rolling 24h** (`supabase/migrations/20260804000000_tip_caps.sql`). The user sees
honest copy telling them the remaining headroom.

If a legitimate high-value tip is blocked, raise the specific limit in that migration
and re-push — do **not** disable the trigger. Tips carry no platform fee and pay out
daily, so an uncapped tip channel is a laundering vector, not a generosity feature.

---

## 6. Payout failed / earner can't get paid

1. `/users/<id>` shows their Connect state.
2. `restricted` or `pending` means Stripe wants something from the user, or is
   reviewing. Neither is fixable from the console — the user must complete Stripe's
   flow. The app's Payments screen now opens a pre-scoped support ticket for exactly
   this case.
3. `payout.failed` from Stripe is **not currently handled** by `stripe-webhook`, so
   there is no alert. Until it is, check the Stripe Dashboard directly when an earner
   reports missing money.

---

## 7. What the console still cannot do

Be honest with the user rather than promising something that doesn't exist:

- **No refunds.** There is no refund code anywhere in the repo. Refunds happen in the
  Stripe Dashboard and the ledger will not reflect them.
- **No dispute resolution.** `disputes` rows have no status or owner. Once one exists,
  `earner-claim-payment` is blocked on that booking **permanently**.
- **No booking intervention.** No force-cancel, force-complete, re-open, or
  clear-`started_at`.
- **No bulk anything**, and `/payments` is capped at 60 rows with no search.

Each of these is scoped in `ADMIN_AUDIT_2026-08-04.md` §4.

---

## 8. Stripe Radar rules to add by hand (Dashboard → Radar → Rules)

Zero code, effective immediately, and the cheapest fraud control available:

```
Block    if :card_number_attempts_1h: > 3
Block    if :ip_country: != :card_country:        # US-only marketplace
Review   if :card_funding: = 'prepaid' and :amount_in_usd: > 100
```

`outcome.risk_score` needs Radar for Fraud Teams (~$0.07/txn) — worth it against a
single chargeback, but the three rules above work on the base plan.
