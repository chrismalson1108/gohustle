-- ─────────────────────────────────────────────────────────────────────────────
-- "Where is my money" — the half the app could not answer.
--
-- The Transactions screen deliberately refuses to say when money reaches a bank,
-- because we did not know. Capture is a DESTINATION CHARGE: the funds land in the
-- earner's Stripe Connect account immediately, and Stripe then pays out to their bank
-- on that account's own schedule. We stored the first half and nothing of the second,
-- so the app could honestly say "released to your payout account" and no more.
--
-- That is the single most common support question any marketplace gets, and the
-- honest fix is not a better macro — it is knowing the answer. Stripe already emits
-- it: payout.created carries an ESTIMATED arrival_date, payout.paid the real one.
--
-- ── WHY A TABLE AND NOT A LIVE API CALL ─────────────────────────────────────
--
-- The screen could call Stripe on each open. It should not: it would put a
-- third-party latency and outage in the path of a screen people open when they are
-- anxious about money, and it would show nothing at all when Stripe is slow. Events
-- arrive once and are stored; the screen reads our own database.
--
-- ── WHAT THIS DELIBERATELY DOES NOT CLAIM ───────────────────────────────────
--
-- It does not say WHICH gig is in WHICH payout. Stripe batches many transfers into
-- one payout, and resolving that means walking balance transactions per payout. So a
-- payment says "released on <date>" and the payouts list says "$X arriving <date>" —
-- both true — rather than a per-gig bank date that would be a guess.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.stripe_payouts (
  id            uuid primary key default gen_random_uuid(),
  payout_id     text not null unique,          -- Stripe po_…
  account_id    text not null,                 -- the connected acct_… it belongs to
  user_id       uuid references public.profiles(id) on delete set null,
  amount_cents  bigint not null,
  currency      text not null default 'usd',
  status        text not null,                 -- pending | in_transit | paid | failed | canceled
  method        text,                          -- standard | instant
  arrival_date  timestamptz,                   -- estimated on created, actual on paid
  failure_code  text,
  failure_message text,
  bank_last4    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists stripe_payouts_user_idx on public.stripe_payouts (user_id, arrival_date desc);
create index if not exists stripe_payouts_status_idx on public.stripe_payouts (status, arrival_date);

alter table public.stripe_payouts enable row level security;

-- Earners read their own payouts. Nothing else: writes come only from the webhook,
-- which runs as service_role and is exempt from RLS. Matching the grant to the policy
-- from the start, per the parity migration.
drop policy if exists stripe_payouts_select_own on public.stripe_payouts;
create policy stripe_payouts_select_own on public.stripe_payouts
  for select to authenticated
  using (user_id = auth.uid());

grant select on public.stripe_payouts to authenticated;
revoke insert, update, delete on public.stripe_payouts from anon, authenticated;

-- ── A payout that failed is money the earner is still waiting for ───────────
-- Stripe retries some failures and not others; a failed payout usually means the bank
-- details are wrong or the account was closed. The earner sees "paid" on their gig and
-- nothing in their bank, and has no way to tell which is true. This is the control
-- that turns that into something someone knows about.
create or replace function public.ctl_payout_failed()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.payout_id,
         jsonb_build_object(
           'user_id', p.user_id,
           'account_id', p.account_id,
           'amount_dollars', round(p.amount_cents::numeric / 100, 2),
           'status', p.status,
           'failure_code', p.failure_code,
           'failure_message', p.failure_message,
           'arrival_date', p.arrival_date,
           'days_since', round(extract(epoch from now() - p.created_at) / 86400.0, 1),
           'note', 'a payout to an earner''s bank failed — they have been told the '
                   'gig was paid and the money is not there')
    from public.stripe_payouts p
   where p.status = 'failed'
$$;

revoke execute on function public.ctl_payout_failed() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('payout_failed',
   'A payout to an earner''s bank failed',
   'high', 'money',
   'The app tells an earner their gig was released and paid. If the payout to their '
   'bank then fails, they have no way to distinguish that from a slow bank, and we '
   'have no way to know unless the event is stored. Usually wrong bank details or a '
   'closed account — both need a person to reach out.',
   'ctl_payout_failed')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── A payout stuck in transit far past its estimate ─────────────────────────
create or replace function public.ctl_payout_overdue()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.payout_id,
         jsonb_build_object(
           'user_id', p.user_id,
           'amount_dollars', round(p.amount_cents::numeric / 100, 2),
           'status', p.status,
           'arrival_date', p.arrival_date,
           'days_overdue', round(extract(epoch from now() - p.arrival_date) / 86400.0, 1),
           'note', 'this payout passed its estimated arrival date and Stripe has not '
                   'reported it paid — the earner is chasing money we said was coming')
    from public.stripe_payouts p
   where p.status in ('pending','in_transit')
     and p.arrival_date is not null
     and p.arrival_date < now() - interval '3 days'
$$;

revoke execute on function public.ctl_payout_overdue() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('payout_overdue',
   'A payout is past its estimated arrival and still not paid',
   'medium', 'money',
   'Stripe gives an estimated arrival date and the app shows it. If that date passes '
   'with no payout.paid event, the earner is chasing money on a promise we made. '
   'Three days of slack absorbs weekends and bank holidays.',
   'ctl_payout_overdue')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
