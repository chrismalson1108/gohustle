# Pre-launch data reset (runbook)

Wipes the accumulated **test activity** from the production database so beta users start
from a clean slate, while leaving **accounts, identity and the legal audit trail intact**.

> ## ✅ EXECUTED 2026-09-06 — database half. Storage still outstanding.
>
> Run against production before closed beta, on Chris's instruction, with Stripe
> deliberately left on TEST keys (so §5 was NOT performed: `stripe_accounts`,
> `stripe_customers` and `app_flags.stripe_mode` are untouched and testers keep their
> cards and Connect onboarding).
>
> **Deleted:** 20 jobs · 90 slots · 21 bookings · 7 payments · 36 messages ·
> 93 notifications · 5 reviews · 21 badges · 83 assistant messages · 11 reports ·
> 6 support tickets + 8 ticket messages · 1 gig share · 2 check-ins · 3 payout events ·
> 1 tip ledger row · 15 client errors, and all derived profile counters reset.
>
> **Preserved and verified after the fact:** 16 profiles (9 onboarded — nobody is bounced
> back through onboarding), 52 legal acceptances (nobody re-consents), 2 ID verifications,
> 1 student verification, 5 push tokens, 2 allowlist rows, 275 categories, 7
> `stripe_accounts`, 5 `stripe_customers`, 2 avatars.
>
> **Verified in the app:** Browse reads "0 gigs available", Profile reads 0 jobs / $0 /
> "—" rating, no My Jobs badge, still signed in, no onboarding or consent gate.
>
> ⚠️ **STORAGE IS STILL OUTSTANDING** — see the storage step below. 5 objects remain
> (2 chat-photos, 3 completion-photos, ~670 KB). They are unreachable through the app now
> that their rows are gone (private buckets whose policies need a booking or message that
> no longer exists), so this is dead weight rather than exposure. `supabase storage rm`
> needs CLI ≥ 2.11x; this machine is on 2.106.
>
> **Two things a re-run must know.** First, `storage.protect_delete()` raises 42501 on ANY
> direct `delete from storage.objects` — and because the purge is one atomic block, that
> single statement rolled the entire thing back on the first attempt. Storage must be a
> separate step through the Storage API. Second, the CLI parses a leading `--` comment as
> a flag, so pass the file with `--file`, never inline via `$(cat …)`.
>
> Written 2026-07-22 while the app was still TestFlight-only on Stripe **test** keys.
>
> ⚠️ **Re-verified against the live schema 2026-09-06 before running, and it was incomplete.** Twelve
> tables that hold activity did not exist when this was drafted — support threads,
> safety check-ins, gig share links, Stripe payout events, the promo/bonus ledgers, the
> assistant's staged actions and the client error sink. Running the original list would
> have left test support tickets and a LIVE share link (which discloses an exact street
> address) in a database advertised as clean. Storage was missing too. Both are fixed
> below. Re-verify again before running: this file has now been wrong once.

Run this **once**, immediately before opening the beta — after the last round of internal
testing, before the first real user signs up.

---

## 0. Decisions already made

| Question | Decision |
|---|---|
| Reports & blocks | **Delete** — all of it was testing the report/block flows |
| `stripe_accounts` / `stripe_customers` | **Delete, but only as part of the test→live Stripe switch** (§5). Do not clear them while still on test keys |
| Profiles / auth users | **Keep.** Reset counters only |
| `legal_acceptances` | **Keep.** It is a compliance audit trail — deleting it destroys the record *and* forces every user back through the consent gate |
| ID / student verification | **Keep.** These are real verifications, not test data |

---

## 1. Preconditions

1. **Take a backup and confirm it is non-empty.** `supabase db dump` needs Docker running.
   If Docker is unavailable, the JSON export below is a valid substitute for a dataset this
   small (~300 rows) — it was used on 2026-07-21 and produced 24 usable table files.

   ```bash
   cd ~/Documents/gohustle
   DIR=~/gohustlr-db-backup-$(date +%Y%m%d-%H%M%S); mkdir -p "$DIR"
   for t in profiles jobs job_slots job_requirements bookings messages conversation_state \
            reviews payments notifications badges user_challenges expenses income_entries \
            saved_jobs favorites saved_searches reports blocks assistant_threads \
            assistant_messages stripe_accounts stripe_customers legal_acceptances push_tokens; do
     supabase db query "select * from $t" --linked --output json > "$DIR/$t.json" || echo "FAILED: $t"
   done
   chmod -R 700 "$DIR"   # contains PII — keep it out of the repo, never commit
   ```

2. **No live escrow holds.** Verify every payment is in a terminal state first; deleting a
   row with an uncaptured authorization orphans money on the customer's card:

   ```sql
   select status, count(*) from payments group by 1;
   -- Abort if anything is 'requires_capture' / uncaptured. Capture or cancel it first.
   ```

3. **Announce downtime** if any tester is mid-flow. This is not transactional across the app.

---

## 2. What is deleted vs preserved

**Deleted** — all gig activity: jobs, slots, requirements, bookings, messages,
conversation state, payments, disputes, tips, reviews, notifications, badges, challenges,
expenses, income entries, saved gigs/searches, favorites, reports, blocks, assistant threads.

**Preserved** — `profiles` rows (name, username, bio, skills, avatar, city, school, role,
goals, availability, referral code, DOB, `onboarding_done`), `auth.users`,
`legal_acceptances`, `legal_documents`, `verified` + `id_verification_status`,
`student_verified`, `push_tokens`, `notification_preferences`, `beta_allowlist`, admin tables.

### Snapshot at time of writing (2026-07-21)

`job_slots` 63 · `notifications` 60 · `messages` 43 · `job_requirements` 31 ·
`assistant_messages` 20 · `conversation_state` 19 · `bookings` 18 · `jobs` 15 ·
`badges` 8 · `user_challenges` 8 · `assistant_threads` 5 · `favorites` 4 · `reports` 4 ·
`reviews` 3 · `saved_jobs` 3 · `expenses` 2 · `payments` 2 · `blocks` 1 · `saved_searches` 1
— against 16 profiles (9 onboarded, 3 with earnings, 2 ID-verified, 1 student-verified).

Re-count before running; these numbers will have moved.

---

## 3. The purge

Cascade behaviour is **verified against the live schema** — deleting `jobs` alone removes
most of the graph. Run inside a transaction so a mid-way failure rolls back.

```sql
begin;

-- Cascades to: bookings -> (messages, conversation_state, payments, disputes, tip_ledger)
--              job_slots, job_requirements, saved_jobs
delete from jobs;

-- Not reachable by cascade (these FKs are SET NULL, or hang off profiles instead of jobs).
delete from reviews;
delete from notifications;
delete from badges;
delete from user_challenges;
delete from expenses;
delete from income_entries;
delete from favorites;
delete from saved_searches;
delete from reports;
delete from blocks;
delete from assistant_messages;
delete from assistant_threads;
delete from moderation_flags;

-- Belt and braces: anything orphaned by a SET NULL rule above.
delete from bookings;
delete from payments;
delete from messages;
delete from conversation_state;
delete from tip_ledger;
delete from disputes;

-- ── ADDED 2026-09-06. Every table below postdates this runbook's first draft
-- (2026-07-22) and would otherwise SURVIVE the purge. Verified against the live
-- schema on the day: support and safety carried real test rows, and a live share
-- link is a disclosure, not clutter.
delete from support_ticket_messages;
delete from support_tickets;
delete from gig_shares;          -- a share link reveals an exact address; do not leave one live
delete from safety_checkins;
delete from stripe_payouts;      -- test-mode payout events
delete from refund_ledger;
delete from promo_redemptions;
delete from promo_grants;
delete from promo_redeem_attempts;
delete from bonus_ledger;
delete from assistant_pending_actions;
delete from client_errors;       -- test-run crash/edge noise; keeps /errors meaningful on day one

commit;
```

### Storage (not covered by any cascade)

Objects are not FK'd to these tables, so the purge leaves them behind. Clear the
activity buckets and KEEP `avatars` — profile photos belong to the accounts you are
preserving.

```sql
delete from storage.objects
 where bucket_id in ('job-photos', 'chat-photos', 'completion-photos',
                     'support-photos', 'receipts');
-- Do NOT touch bucket_id = 'avatars'.
```

### Reset the profile counters

Everything here is server-owned and derived from activity that no longer exists.
`guard_profiles_write` pins these columns against client writes, so this must run with
elevated privileges (SQL Editor / service role), not from the app.

```sql
update profiles set
  xp                   = 0,
  earnings_today       = 0,
  earnings_week        = 0,
  earnings_total       = 0,
  earnings_period_date = null,   -- added 20260722010000; null = "no period on record"
  streak_days          = 0,
  weekly_jobs_done     = 0,
  rating               = 5.0,    -- app default for "no reviews yet"
  review_count         = 0,
  poster_rating        = null,
  poster_review_count  = 0,
  -- ADDED 2026-09-06: trigger-maintained from job inserts, so after the purge it
  -- still names the categories of gigs that no longer exist and drives the "your
  -- recent categories" chips in every picker.
  recent_category_slugs = '{}';
```

> Do **not** touch `verified`, `id_verification_status`, `student_verified`,
> `onboarding_done`, `date_of_birth`, or `referral_code`.

---

## 4. Verification

```sql
select 'jobs' t, count(*) n from jobs
union all select 'bookings', count(*) from bookings
union all select 'messages', count(*) from messages
union all select 'reviews',  count(*) from reviews
union all select 'payments', count(*) from payments
union all select 'badges',   count(*) from badges;
-- expect 0 across the board

select count(*) profiles,
       count(*) filter (where coalesce(earnings_total,0) > 0) still_earning,
       count(*) filter (where onboarding_done)                 still_onboarded,
       count(*) filter (where verified)                        still_id_verified
from profiles;
-- expect: profiles unchanged, still_earning = 0, onboarded/verified unchanged

select count(*) from legal_acceptances;  -- expect UNCHANGED (audit trail)
```

Then in the app: sign in, confirm Browse is empty, My Jobs is empty, Profile shows
$0 / 0 jobs / no badges, and that you are **not** bounced back through onboarding or the
consent gate. Post a gig, book it from a second account, and verify the full flow still works.

---

## 5. Stripe test → live (do this at the same time)

`stripe_accounts` (7 rows) and `stripe_customers` (3 rows) hold **test-mode** ids
(`acct_…`, `cus_…`). A live-mode API call with a test id fails, so they must be cleared as
part of the key switch — not before, or you break payouts while still testing.

```sql
-- ONLY as part of flipping to live Stripe keys.
delete from stripe_accounts;
delete from stripe_customers;
```

Everyone then re-runs payout onboarding and re-adds a card against live Stripe.

### 🚫 BLOCKING GATE — live mode has NO webhook endpoints

Verified 2026-08-13 on `acct_1ThvnME0UZFlVCOp`: `stripe webhook_endpoints list --live`
returns an **empty array**. Test mode has two endpoints; live mode has none.

Flip the keys without creating them and every handler in `stripe-webhook` goes dark, with
**no error anywhere**, because nothing is being delivered to fail:

- captures never mark `payments.status = 'captured'` and never credit earnings,
- Connect onboarding never flips `stripe_accounts.onboarded`, so payouts stay off,
- identity verification never resolves (`profiles.id_verification_status` stuck `pending`),
- refunds and chargebacks never record a `disputes` row,
- and no `payout.*` ever reaches `stripe_payouts`, so Bank deposits stays empty forever.

Both endpoints point at the same URL and are told apart only by their signing secret.

```bash
# 1. "Your account" destination — payments, refunds, identity.
stripe webhook_endpoints create --live \
  --url https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-webhook \
  --enabled-events payment_intent.succeeded \
  --enabled-events payment_intent.payment_failed \
  --enabled-events payment_intent.canceled \
  --enabled-events account.updated \
  --enabled-events charge.dispute.created \
  --enabled-events charge.refunded \
  --enabled-events identity.verification_session.verified \
  --enabled-events identity.verification_session.requires_input \
  --enabled-events identity.verification_session.canceled
```

```bash
# 2. "Connected accounts" destination — same URL, different secret. Without the payout
#    events, bank-deposit arrival dates never populate (this was the test-mode bug).
stripe webhook_endpoints create --live --connect \
  --url https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1/stripe-webhook \
  --enabled-events account.updated \
  --enabled-events payout.created \
  --enabled-events payout.updated \
  --enabled-events payout.paid \
  --enabled-events payout.failed \
  --enabled-events payout.canceled
```

Each `create` returns a `secret` (`whsec_…`) **once**. Store them — the account one as
`STRIPE_WEBHOOK_SECRET`, the Connect one as `STRIPE_WEBHOOK_SECRET_CONNECT`:

```bash
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref nfioebqsgmmzhbksxozc
npx supabase secrets set STRIPE_WEBHOOK_SECRET_CONNECT=whsec_... --project-ref nfioebqsgmmzhbksxozc
```

**Do this BEFORE the key switch, not after.** A live charge that arrives while the secret
is missing fails signature verification, Stripe retries for ~3 days and then gives up —
and the booking is left authorized-but-never-captured with real money held on a real card.

Verify before proceeding:

```bash
stripe webhook_endpoints list --live   # expect 2, both enabled, one with "application" set
```

### ⚠️ The key switch is not a single server-side toggle

The two Stripe keys live in **different places**, and Stripe requires both to be from the
same mode:

- **Secret key** — Supabase edge-function env var `STRIPE_SECRET_KEY`. Changeable instantly,
  server-side, no app release.
- **Publishable key** — **hardcoded** in `src/lib/stripeClient.js`. Changeable only by
  shipping a new build.

Flipping the secret to `sk_live_` **breaks every already-installed build**, because the app
would confirm a live PaymentIntent with a test publishable key. Sequence it deliberately:

1. Move the publishable key out of source into an EAS env var per build profile.
2. Ship + submit that build.
3. Only once it is the minimum supported version: switch the Supabase secret to live and run
   the deletes above.

There is also no way to test payments after going live — test cards (`4242…`), test bank
numbers and test SSNs only work with test keys. Keep a test-mode environment alongside
(a second Supabase project, since secrets are per-project) or you will have no safe way to
exercise a payment change.

---

## 6. Loose ends

- **Storage buckets are not touched.** Deleting rows orphans files in `job-photos`,
  `completion-photos` and `chat-photos`. Harmless but worth pruning; **do not** touch
  `avatars`, which is still referenced by `profiles.avatar_url`.
- **Badges re-award themselves.** `useBadgeSync` re-evaluates from live data, so wiping
  activity correctly returns everyone to 0 badges — no separate cleanup needed.
- **Push tokens are kept**, so existing devices keep receiving notifications.
- **Rollback** is manual: re-insert from the JSON backup in §1, parents before children
  (`profiles` → `jobs` → `job_slots`/`job_requirements` → `bookings` → everything else).
  There is no transactional undo once committed.

## Flip `app_flags.stripe_mode` in the same change that swaps the keys

`ctl_stripe_id_mode_mismatch` reads this flag and is a deliberate no-op while it says
`test`. Leave it behind and the control keeps checking for the wrong thing at exactly the
moment it matters.

Writing `{"mode":"live"}` stamps `live_since` automatically (trigger
`trg_z_stripe_mode_live_since`), and a later plain write preserves that first stamp rather
than re-dating it. Supply `live_since` explicitly only if the real cutover happened at a
different moment than the flag write.

**Correction to an earlier note here:** it previously said the control would flag "8
test-shaped Stripe ids". That figure came from the old predicate, which tested the id's
LENGTH — and a Stripe account id is `acct_1` + 14 characters = 21 in *both* modes, so it
matched every account that has ever existed. It was not signal. The control now judges
provenance (`created_at < live_since`), so what it flags after the cutover is genuinely the
set of ids minted under test keys — clear those rows as part of the reset and the control
goes quiet on its own.
