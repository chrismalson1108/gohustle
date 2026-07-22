# Pre-launch data reset (runbook)

Wipes the accumulated **test activity** from the production database so beta users start
from a clean slate, while leaving **accounts, identity and the legal audit trail intact**.

> **Not yet executed.** Written 2026-07-22 while the app was still TestFlight-only on
> Stripe **test** keys. Nothing in here has been run against production.

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

commit;
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
  poster_review_count  = 0;
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
