-- ─────────────────────────────────────────────────────────────────────────────
-- Staggered fees: loyalty tiers + direct per-user grants (2026-08-06).
--
-- WHAT THIS ADDS THAT PROMOTIONS CANNOT
--
-- A promotion is a CAMPAIGN: bounded, budgeted, and it ends. A tier is STANDING
-- POLICY: "once you have completed 25 gigs your fee is 8% forever." Modelling the
-- second as the first would mean a promotion nobody may ever end, with a budget that
-- must never run out — i.e. all the ceilings that make promotions safe would have to be
-- disabled, which is exactly how a campaign turns into an unbounded liability nobody
-- is watching.
--
-- Upwork's sliding scale by client-relationship volume is the closest analogue. The
-- point is retention: the earners who have done the most work have the most credible
-- threat to take repeat clients off-platform, and a lower rate is the cheapest possible
-- answer to that.
--
-- THE THRESHOLD IS DERIVED, NOT DECLARED. It counts VERIFIED bookings — work that was
-- actually completed and paid for. Anything a user can inflate on their own (bookings
-- created, gigs applied to, account age) would be a tier you could self-assign.
--
-- HOW IT COMPOSES: the pin takes the BEST (lowest) of standing rate, loyalty tier and
-- promotion. Never the sum, never a stack — the fee is one number and it is whichever
-- of these is kindest. Anything else and two overlapping benefits could drive the rate
-- below the floor by accident.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.fee_tiers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  -- VERIFIED bookings completed as the earner. Derived from real work only.
  min_completed     integer not null check (min_completed >= 0),
  fee_bps           integer not null check (fee_bps between 0 and 3000),
  enabled           boolean not null default true,
  note              text,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now()
);

create unique index if not exists fee_tiers_threshold_uniq on public.fee_tiers (min_completed);

alter table public.fee_tiers enable row level security;
revoke all on public.fee_tiers from anon, authenticated;
grant all on public.fee_tiers to service_role;
-- Readable by users: someone should be able to see the ladder they are climbing, and
-- "do 10 more gigs and your fee drops" is the entire retention mechanic. It is
-- policy, not a secret.
grant select on public.fee_tiers to authenticated;
drop policy if exists fee_tiers_read on public.fee_tiers;
create policy fee_tiers_read on public.fee_tiers for select using (enabled);

comment on table public.fee_tiers is
  'Standing loyalty ladder: complete N verified gigs, pay this rate. Distinct from '
  'promotions, which are budgeted campaigns that end. Composes by taking the LOWEST '
  'applicable rate, never by stacking.';

-- How many verified gigs has this earner actually completed?
create or replace function public.earner_completed_count(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(count(*), 0)::int
    from public.bookings b
   where b.earner_id = p_user and b.status = 'verified'
$$;

revoke execute on function public.earner_completed_count(uuid) from public, anon;
grant execute on function public.earner_completed_count(uuid) to authenticated, service_role;

-- The tier rate for a user, or NULL if they have not reached the first rung.
create or replace function public.tier_fee_bps(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select t.fee_bps
    from public.fee_tiers t
   where t.enabled
     and t.min_completed <= public.earner_completed_count(p_user)
   order by t.min_completed desc
   limit 1
$$;

revoke execute on function public.tier_fee_bps(uuid) from public, anon;
grant execute on function public.tier_fee_bps(uuid) to authenticated, service_role;

-- ── Compose it into the pin ──────────────────────────────────────────────────
create or replace function public.pin_booking_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j        record;
  promoBps integer;
  tierBps  integer;
begin
  if tg_op = 'INSERT' then
    select pay, pay_type, estimated_hours, poster_id into j
      from public.jobs where id = new.job_id;
    if not found or j.pay is null then
      return new;
    end if;

    new.amount_cents_quoted := round(
      coalesce(new.counter_offer, j.pay)
      * (case when j.pay_type = 'hourly' then coalesce(j.estimated_hours, 1) else 1 end)
      * 100
    )::integer;

    new.fee_bps_quoted := public.fee_bps_at(now());

    -- Loyalty tier: standing policy, no budget, no expiry. Lowest wins.
    begin
      tierBps := public.tier_fee_bps(new.earner_id);
      if tierBps is not null then
        new.fee_bps_quoted := least(new.fee_bps_quoted, tierBps);
      end if;
    exception when others then
      raise warning 'tier lookup failed for booking %: %', new.id, sqlerrm;
    end;

    -- Promotion: a bounded campaign. Also lowest-wins, never additive — two benefits
    -- summing could drive the rate below the floor by accident.
    begin
      promoBps := public.consume_promo_grant(new.earner_id, new.id, new.amount_cents_quoted);
      if promoBps is not null then
        new.fee_bps_quoted := least(new.fee_bps_quoted, promoBps);
      end if;
    exception when others then
      raise warning 'promo application failed for booking %: %', new.id, sqlerrm;
    end;

    begin
      new.fee_credit_cents := coalesce(public.consume_fee_credit(
        new.earner_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted), 0);
    exception when others then
      new.fee_credit_cents := 0;
      raise warning 'fee credit application failed for booking %: %', new.id, sqlerrm;
    end;

    begin
      new.poster_discount_cents := coalesce(public.consume_poster_discount(
        j.poster_id, new.id, new.amount_cents_quoted, new.fee_bps_quoted), 0);
      new.poster_discount_cents := least(
        new.poster_discount_cents,
        greatest(0, public.poster_discount_headroom(new.amount_cents_quoted, new.fee_bps_quoted)
                    - coalesce(new.fee_credit_cents, 0)));
    exception when others then
      new.poster_discount_cents := 0;
      raise warning 'poster discount failed for booking %: %', new.id, sqlerrm;
    end;

    return new;
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.amount_cents_quoted    := old.amount_cents_quoted;
    new.fee_bps_quoted         := old.fee_bps_quoted;
    new.fee_credit_cents       := old.fee_credit_cents;
    new.poster_discount_cents  := old.poster_discount_cents;
  end if;
  return new;
end;
$$;

revoke execute on function public.pin_booking_amount() from public, anon, authenticated;

-- ── Grant a promotion directly to chosen users, with no code ─────────────────
-- Win-back and VIP offers must NOT be public codes: an offer aimed at lapsed users
-- that leaks to active ones is margin given away for behaviour you already had.
create or replace function public.grant_promotion_to_users(
  p_promotion uuid, p_user_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.promotions%rowtype;
  n integer := 0;
begin
  select * into p from public.promotions where id = p_promotion;
  if not found then
    raise exception 'unknown promotion %', p_promotion using errcode = 'no_data_found';
  end if;

  -- Snapshot the benefit onto each grant, exactly as redeem_promo_code does, so a
  -- later edit to the campaign cannot re-price grants already handed out.
  insert into public.promo_grants (user_id, promotion_id, fee_bps, uses_allowed, expires_at)
  select u, p.id, p.fee_bps, p.uses_allowed, p.ends_at
    from unnest(p_user_ids) as u
   where exists (select 1 from public.profiles pr where pr.id = u)
  on conflict (user_id, promotion_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.grant_promotion_to_users(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.grant_promotion_to_users(uuid, uuid[]) to service_role;

-- Seed a sensible ladder, DISABLED. Enabling a rung is a pricing decision with a
-- permanent margin cost, so it should be a deliberate click rather than something a
-- migration turned on while nobody was looking.
insert into public.fee_tiers (name, min_completed, fee_bps, enabled, note) values
  ('Regular',  10, 900, false, 'After 10 verified gigs — 9%. First rung, cheap to give.'),
  ('Trusted',  25, 800, false, 'After 25 — 8%. These earners have real off-platform leverage.'),
  ('Veteran',  50, 700, false, 'After 50 — 7%. Retention at the top of the distribution.')
on conflict (min_completed) do nothing;

-- A tier that undercuts the processing floor is a rate that cannot be honoured.
create or replace function public.ctl_fee_tier_below_floor()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select t.id::text,
         jsonb_build_object('name', t.name, 'fee_bps', t.fee_bps,
           'note', 'at this rate a typical $50 gig would settle at the processing floor',
           'fee_on_50', public.platform_fee_cents(5000, t.fee_bps),
           'floor_on_50', ceil(5000 * 0.029)::int + 30 + 25)
    from public.fee_tiers t
   where t.enabled
     and public.platform_fee_cents(5000, t.fee_bps) <= (ceil(5000 * 0.029)::int + 30 + 25)
$$;

revoke execute on function public.ctl_fee_tier_below_floor() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('fee_tier_below_floor',
   'A loyalty tier priced at or under the processing floor',
   'medium', 'money',
   'The floor stops it settling at a loss, but a tier whose rate is entirely absorbed '
   'by card processing earns the platform nothing on every gig those earners do — '
   'permanently, since tiers do not expire. Almost always a typo in basis points.',
   'ctl_fee_tier_below_floor')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, fn_name = excluded.fn_name;
