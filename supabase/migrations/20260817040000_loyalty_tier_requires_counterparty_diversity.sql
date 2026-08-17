-- ─────────────────────────────────────────────────────────────────────────────
-- The loyalty ladder is farmable by two accounts, and it is not enabled yet — which is
-- the only reason this is cheap to fix.
--
-- earner_completed_count is `count(*) from bookings where earner_id = p_user and status =
-- 'verified'` (20260806120000:65-67) and tier_fee_bps picks the highest rung that count
-- clears. Nothing looks at WHO the counterparty was. So one person with two accounts —
-- one posting, one earning — books, accepts, verifies, and repeats. Fifty round trips
-- buys the Veteran rate permanently.
--
-- It is not free to farm: `bonus_ledger` vests on outcome and every loop pays a real
-- platform fee, which is the property that protects the REFERRAL system. But a fee TIER
-- is different in kind — it is a permanent rate reduction, so the farming cost is paid
-- once and the discount never stops. Fifty gigs at 10% to unlock 7% forever pays for
-- itself and then compounds.
--
-- ── THE STANDARD FIX: REQUIRE STRANGERS ─────────────────────────────────────
-- Count DISTINCT counterparties alongside volume. It is the ordinary anti-collusion
-- control for any marketplace reputation ladder, and it works because the farmer's cost
-- stops being "do the loop N times" and becomes "recruit N real, unrelated people" —
-- which is indistinguishable from actually building a reputation, and that is the point.
--
-- Deliberately NOT amount-weighting as well. It is a second knob with its own failure
-- mode (a few large self-dealt gigs beat many small honest ones), and diversity already
-- makes the attack require other humans. One control that closes the hole beats two that
-- interact in ways nobody has modelled.
--
-- ── WHY NOW ─────────────────────────────────────────────────────────────────
-- All three rungs ship `enabled = false` (20260806120000:213-217), so no earner holds a
-- tier and nothing re-prices. The rate is pinned per booking at `fee_bps_quoted`, so
-- tightening this AFTER a rung goes live would never reach the bookings already struck at
-- the loose threshold — the farmed rate would simply persist. This is the last moment it
-- costs nothing.
--
-- Found by the 2026-08-12 payments audit (incentives F15), reproduced 2026-08-14.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.fee_tiers
  add column if not exists min_distinct_posters integer not null default 0
    check (min_distinct_posters >= 0);

comment on column public.fee_tiers.min_distinct_posters is
  'Distinct posters the earner has completed verified work for. Guards the ladder against '
  'a two-account loop: volume alone is farmable, "N unrelated people" is not.';

-- Distinct counterparties, on exactly the same basis as earner_completed_count — verified
-- bookings only, so it is derived from real work rather than from applications.
create or replace function public.earner_distinct_posters(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(count(distinct j.poster_id), 0)::int
    from public.bookings b
    join public.jobs j on j.id = b.job_id
   where b.earner_id = p_user
     and b.status = 'verified'
$$;

revoke execute on function public.earner_distinct_posters(uuid) from public, anon;
grant execute on function public.earner_distinct_posters(uuid) to authenticated, service_role;

-- Both thresholds, or no rung. Same shape as before — highest qualifying rung wins.
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
     and t.min_distinct_posters <= public.earner_distinct_posters(p_user)
   order by t.min_completed desc
   limit 1
$$;

revoke execute on function public.tier_fee_bps(uuid) from public, anon;
grant execute on function public.tier_fee_bps(uuid) to authenticated, service_role;

-- Diversity scales with the rung: a bigger permanent discount should cost more strangers.
-- Roughly a third of the gig count, which keeps it reachable for a genuine regular who
-- works for a handful of repeat clients while making the two-account loop useless.
update public.fee_tiers set min_distinct_posters = 3  where min_completed = 10;
update public.fee_tiers set min_distinct_posters = 6  where min_completed = 25;
update public.fee_tiers set min_distinct_posters = 10 where min_completed = 50;


-- ── Prove the loop stops buying the rate ────────────────────────────────────
do $$
declare
  earner uuid; poster uuid; jid uuid; got integer; i int;
  posters uuid[];
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select array_agg(id) into posters from (
    select id from public.profiles where deleted_at is null limit 12
  ) p;
  if posters is null or array_length(posters, 1) < 12 then
    raise exception 'need 12 live profiles to stage counterparty diversity, found %',
      coalesce(array_length(posters, 1), 0);
  end if;
  earner := posters[1];

  -- Enable the top rung for the duration. They all ship disabled, so without this the
  -- probe proves nothing either way.
  update public.fee_tiers set enabled = true where min_completed = 50;

  -- ── The farm: 50 verified gigs, ONE counterparty ──────────────────────────
  -- A job per booking, because bookings carry a UNIQUE (job_id, earner_id) — one earner
  -- cannot book the same gig twice. That constraint does not slow a farmer down at all;
  -- it just means the second account posts fifty gigs instead of one, which is what this
  -- stages.
  poster := posters[2];
  for i in 1..50 loop
    insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
    values (poster, 'tier farm probe ' || i, 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
    returning id into jid;
    insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'verified');
  end loop;

  if public.earner_completed_count(earner) < 50 then
    raise exception 'staging wrong: only % verified bookings', public.earner_completed_count(earner);
  end if;

  got := public.tier_fee_bps(earner);
  if got is not null then
    raise exception 'FIX FAILED: 50 gigs from ONE poster still bought the % bps rate', got;
  end if;
  raise notice 'the two-account loop no longer buys a tier: 50 verified gigs, 1 counterparty, no rung';

  -- And the OLD rule would have handed it over — that is the discrimination.
  if not exists (
    select 1 from public.fee_tiers t
     where t.enabled and t.min_completed <= public.earner_completed_count(earner)
  ) then
    raise exception 'probe is not discriminating: the old count-only rule would not have granted a tier either';
  end if;
  raise notice 'discriminates: the old count-only rule WOULD have granted it on the same rows';

  -- ── The real regular: same 50 gigs, spread across 10 strangers ────────────
  for i in 3..12 loop
    insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
    values (posters[i], 'tier diversity probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
    returning id into jid;
    insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'verified');
  end loop;

  if public.earner_distinct_posters(earner) < 10 then
    raise exception 'staging wrong: % distinct posters', public.earner_distinct_posters(earner);
  end if;

  got := public.tier_fee_bps(earner);
  if got is null then
    raise exception 'FALSE NEGATIVE: a genuine earner with 10 distinct posters got no tier';
  end if;
  raise notice 'a genuine regular still earns it: % distinct counterparties, % bps',
    public.earner_distinct_posters(earner), got;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'loyalty diversity probe passed; all staged rows and the tier flag rolled back';
  else
    raise;
  end if;
end $$;
