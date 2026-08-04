-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 admin operations (2026-08-04). Backing schema for the console changes
-- that make an open beta supportable. Five independent pieces, all idempotent:
--
--   1. client_errors.dev      — tell a local Metro crash from a real user's
--   2. app_flags              — runtime kill switches (no redeploy)
--   3. disputes resolution    — a dispute can END, which unblocks earner payout
--   4. payments refunds       — a reversal becomes representable at all
--   5. dashboard metrics      — net of refunds, plus the queues that need action
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Dev vs production crashes ─────────────────────────────────────────────
-- Every row currently in /errors came from a local Metro dev session
-- (127.0.0.1:8081, dev=true) — the founder's own machine. In an open beta those
-- bury the crashes that actually matter, and the page gives no way to tell them
-- apart: a dev-only crash and a TestFlight crash render identically.
--
-- Defaults FALSE so existing rows read as production. That is the wrong answer for
-- the handful of historical dev rows, but it is the safe direction: a real crash
-- must never be hidden by a default.
alter table public.client_errors add column if not exists dev boolean not null default false;
create index if not exists client_errors_prod_idx
  on public.client_errors (created_at desc) where dev = false;


-- ── 2. Runtime kill switches ─────────────────────────────────────────────────
-- The entire runtime config surface of this product was one '*' row in
-- beta_allowlist, edited by hand in the SQL editor. There was no way to pause
-- payments during a Stripe incident, pause posting during a spam wave, or switch
-- off the Hustlr AI assistant — which can post gigs and book work on a user's
-- behalf, the widest blast radius in the product, with no off switch.
create table if not exists public.app_flags (
  key        text primary key,
  enabled    boolean not null default true,
  value      jsonb   not null default '{}'::jsonb,
  note       text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- RLS on with NO policies + grants revoked: invisible and inert to anon and
-- authenticated, same shape as admin_users / client_errors / moderation_flags. Only
-- the service role (console) writes, and only app_flag() below reads.
alter table public.app_flags enable row level security;
revoke all on public.app_flags from anon, authenticated;
grant all on public.app_flags to service_role;

-- The reader every enforcement point calls. STABLE so it can sit in a policy or a
-- trigger without re-planning, and DEFAULTS TO ENABLED for an unknown key — a flag
-- that has never been created must behave exactly like today's code, so adding an
-- enforcement point can never itself take a feature down.
create or replace function public.app_flag(p_key text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select enabled from public.app_flags where key = p_key), true);
$$;

revoke execute on function public.app_flag(text) from public, anon;
-- `authenticated` may read a flag: the clients need to grey out a paused feature
-- rather than let a user walk into a refusal. Flags are operational state, not secrets.
grant execute on function public.app_flag(text) to authenticated, service_role;

-- Seed the switches the runbooks reference, all ON (= today's behaviour).
insert into public.app_flags (key, note) values
  ('signups_enabled',   'Master switch for new account creation. OFF = handle_new_user refuses.'),
  ('payments_enabled',  'OFF = no new escrow holds. In-flight bookings still settle.'),
  ('posting_enabled',   'OFF = no new gigs can be posted. Existing gigs stay bookable.'),
  ('tips_enabled',      'OFF = the tip endpoint refuses.'),
  ('assistant_enabled', 'OFF = Hustlr AI refuses. It can post gigs and book work — this is the widest blast radius in the product.')
on conflict (key) do nothing;


-- ── 3. Disputes can be resolved ──────────────────────────────────────────────
-- disputes had six columns and no lifecycle, so a row was terminal. That was not
-- merely a missing feature: earner-claim-payment refuses to settle a booking with
-- ANY dispute row, so an unresolvable dispute withheld a worker's pay permanently,
-- by construction. Adding a status is what lets that gate ever reopen.
alter table public.disputes add column if not exists status text not null default 'open';
alter table public.disputes add column if not exists assigned_to uuid references auth.users(id);
alter table public.disputes add column if not exists resolved_at timestamptz;
alter table public.disputes add column if not exists resolved_by uuid references auth.users(id);
alter table public.disputes add column if not exists resolution_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'disputes_status_check') then
    alter table public.disputes add constraint disputes_status_check
      check (status in ('open', 'investigating', 'resolved', 'rejected'));
  end if;
end $$;

-- The queue triages on this.
create index if not exists disputes_open_idx
  on public.disputes (created_at desc) where resolved_at is null;

-- Clients may READ their own dispute's new fields (the existing
-- disputes_select_parties policy already scopes rows to the two parties) but must
-- never write them — resolution is an admin act. The table has no update policy at
-- all, so authenticated UPDATE is already denied; this makes it explicit and
-- survives someone adding a permissive policy later.
revoke update on public.disputes from anon, authenticated;


-- ── 4. Refunds are representable ─────────────────────────────────────────────
-- There was no refund code anywhere in the repo, and payments.status is constrained
-- to ('authorized','captured','cancelled','failed') — so a reversal could not be
-- recorded AT ALL. The charge.refunded and charge.dispute.created webhook handlers
-- only inserted a disputes row and emailed; payments was never touched. Dashboard
-- GMV and platform fees therefore overstated revenue permanently, by the value of
-- every reversal the platform ever took.
--
-- Deliberately NOT a new status value: a refunded payment was still captured, and
-- every existing status filter in the console and the RPCs would silently drop it
-- from its bucket if the status changed underneath them. An amount is also the only
-- thing that can express a PARTIAL refund.
alter table public.payments add column if not exists refunded_cents integer not null default 0;
alter table public.payments add column if not exists refunded_at    timestamptz;
alter table public.payments add column if not exists refund_reason  text;
alter table public.payments add column if not exists refunded_by    uuid references auth.users(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_refunded_cents_check') then
    alter table public.payments add constraint payments_refunded_cents_check
      check (refunded_cents >= 0 and refunded_cents <= amount_cents);
  end if;
end $$;

create index if not exists payments_refunded_idx
  on public.payments (refunded_at desc) where refunded_cents > 0;

-- Same reasoning as disputes: refunds are an admin/webhook act, never a client one.
revoke update on public.payments from anon, authenticated;

-- Escrow-expiry watch: an authorization dies at ~7 days, and if it lapses on work
-- that was actually done, the earner is simply unpaid. The console needs to see them
-- coming, so this is the index behind the "expiring" filter.
create index if not exists payments_authorized_age_idx
  on public.payments (created_at) where status = 'authorized';


-- ── 5. Dashboard metrics: net of refunds, plus the actionable queues ─────────
-- Supersedes 20260726040000_gmv_uses_captured_amount.sql. Every key that migration
-- returned is preserved (the dashboard reads them by name); gmv/fees are now NET,
-- and four counts are added for the new queues.
create or replace function public.admin_dashboard_metrics()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'users_total',        (select count(*) from public.profiles),
    'signups_today',      (select count(*) from public.profiles where created_at >= date_trunc('day', now())),
    'signups_7d',         (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
    'signups_30d',        (select count(*) from public.profiles where created_at >= now() - interval '30 days'),
    'suspended_users',    (select count(*) from public.profiles where suspended_at is not null),
    'jobs_open',          (select count(*) from public.jobs where status = 'open'),
    'jobs_total',         (select count(*) from public.jobs),
    'bookings_pending',   (select count(*) from public.bookings where status = 'pending'),
    'bookings_confirmed', (select count(*) from public.bookings where status = 'confirmed'),
    'bookings_completed', (select count(*) from public.bookings where status = 'completed'),
    'bookings_verified',  (select count(*) from public.bookings where status = 'verified'),
    -- NET of refunds and chargebacks. Previously the gross captured total, which
    -- could only ever go up.
    'gmv_captured_cents', (select coalesce(sum(coalesce(earner_amount_cents,0) + coalesce(fee_cents,0)
                                              - coalesce(refunded_cents,0)), 0)
                             from public.payments where status = 'captured'),
    -- A refund reverses the platform fee proportionally: refunding half the charge
    -- gives back half the fee. Floored at 0 so an over-refund cannot show negative fees.
    'fees_captured_cents',(select coalesce(sum(greatest(0,
                              coalesce(fee_cents,0) - round(
                                coalesce(fee_cents,0)::numeric
                                * coalesce(refunded_cents,0)
                                / nullif(coalesce(earner_amount_cents,0) + coalesce(fee_cents,0), 0)
                              )::integer)), 0)
                             from public.payments where status = 'captured'),
    'refunded_cents',     (select coalesce(sum(refunded_cents), 0) from public.payments),
    'escrow_held_cents',  (select coalesce(sum(amount_cents), 0) from public.payments where status = 'authorized'),
    -- Holds within 48h of the ~7-day Stripe expiry. Every one of these is a worker
    -- about to go unpaid on completed work.
    'holds_expiring_48h', (select count(*) from public.payments
                            where status = 'authorized' and created_at <= now() - interval '5 days'),
    'disputes_total',     (select count(*) from public.disputes),
    'disputes_open',      (select count(*) from public.disputes where resolved_at is null),
    'disputes_7d',        (select count(*) from public.disputes where created_at >= now() - interval '7 days'),
    'reports_total',      (select count(*) from public.reports),
    'reports_open',       (select count(*) from public.reports where resolved_at is null and source is distinct from 'auto'),
    'reports_7d',         (select count(*) from public.reports where created_at >= now() - interval '7 days'),
    -- Bookings where exactly one side pressed done. Mutual completion means these
    -- sit forever with nobody at fault and the authorization ticking down.
    'bookings_one_sided', (select count(*) from public.bookings
                            where status in ('confirmed','completed')
                              and coalesce(earner_done,false) <> coalesce(poster_done,false)),
    'errors_fatal_7d',    (select count(*) from public.client_errors
                            where fatal and not dev and created_at >= now() - interval '7 days')
  )
$$;

revoke execute on function public.admin_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to service_role;


-- ── 5b. A browsable user list ────────────────────────────────────────────────
-- /users rendered NOTHING until you typed a search term, and admin_find_users caps
-- at 25 rows — so you could not browse your own user base, could not answer "who
-- signed up today", and the dashboard's Suspended tile linked to a page that could
-- not list suspended users. Same row shape as admin_find_users (the page renders
-- both through one component), plus a window-function total so the pager knows
-- whether there is a next page without a second round trip.
create or replace function public.admin_list_users(
  p_filter text default 'all',
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id            uuid,
  email         text,
  name          text,
  username      text,
  created_at    timestamptz,
  suspended_at  timestamptz,
  verified      boolean,
  rating        numeric,
  review_count  integer,
  total         bigint
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, u.email::text, p.name, p.username, p.created_at,
         p.suspended_at, p.verified, p.rating, p.review_count,
         count(*) over () as total
  from public.profiles p
  join auth.users u on u.id = p.id
  where case p_filter
          when 'suspended' then p.suspended_at is not null
          when 'verified'  then p.verified
          when 'new'       then p.created_at >= now() - interval '7 days'
          when 'students'  then coalesce(p.student_verified, false)
          else true
        end
  order by p.created_at desc
  limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset)
$$;

revoke execute on function public.admin_list_users(text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_list_users(text, integer, integer) to service_role;


-- ── 6. Enforce the flags that belong in the database ─────────────────────────
-- A flag nobody checks is worse than no flag: the console would show a switch that
-- silently does nothing, and an operator would believe an incident was contained.
-- payments/tips/assistant are enforced in their edge functions; the two below have
-- no single chokepoint above the database.

-- signups_enabled. Body is the LIVE definition (pulled from pg_proc, not from a
-- migration file that may have drifted) with only the flag check added, so the
-- closed-beta gate and the exact profile insert are preserved verbatim.
--
-- Distinct from the beta_allowlist gate below it: the allowlist answers "is THIS
-- PERSON invited", the flag answers "are we accepting anyone at all right now" —
-- the switch you reach for during an abuse wave, when even invited signups should
-- stop. Checked first because it is the cheaper, broader refusal.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_flag('signups_enabled') then
    raise exception 'signups_paused'
      using errcode = 'check_violation',
            hint = 'GoHustlr sign-ups are paused right now. Please try again later.';
  end if;

  -- Closed-beta gate (H1). A single row with email = '*' opens signups to all.
  -- Case-insensitive match (GoTrue lowercases emails, but be defensive).
  if not exists (
    select 1 from public.beta_allowlist
    where email = '*' or lower(email) = lower(new.email)
  ) then
    raise exception 'signup_not_allowlisted'
      using errcode = 'check_violation',
            hint = 'This email is not on the GoHustlr beta list.';
  end if;

  insert into public.profiles (id, name, avatar_initial, member_since)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data->>'name', new.email), 1)),
    to_char(now(), 'Mon YYYY')
  );
  return new;
end;
$$;

-- posting_enabled. A SEPARATE trigger rather than an edit to guard_jobs_write:
-- that function carries the whole write-authorization model for jobs, and a
-- kill switch is not worth the risk of touching it. Fires first (name sorts before
-- guard_*), exempts service_role so admin and system paths are never blocked.
create or replace function public.guard_posting_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if not public.app_flag('posting_enabled') then
    raise exception 'posting_paused'
      using errcode = 'check_violation',
            hint = 'Posting new gigs is paused right now. Please try again shortly.';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_posting_flag() from public, anon, authenticated;

drop trigger if exists trg_a_guard_posting_flag on public.jobs;
create trigger trg_a_guard_posting_flag
  before insert on public.jobs
  for each row execute function public.guard_posting_flag();
