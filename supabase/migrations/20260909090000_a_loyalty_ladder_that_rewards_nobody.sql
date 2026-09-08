-- The loyalty ladder cannot reward anybody at the rate the platform actually charges.
--
-- Measured against production 2026-09-08. `fee_tiers` holds three rungs —
--
--   Regular   10 gigs / 3 posters   900 bps
--   Trusted   25 gigs / 6 posters   800 bps
--   Veteran   50 gigs / 10 posters  700 bps
--
-- — and the standing rate has been 700 bps since 2026-08-12 ("expedited beta testing").
-- The pinned rate is LOWEST-WINS across the standing rate, the earner's tier and any
-- promotion grant, so the best rung a 50-gig veteran can reach delivers
-- least(700, 700) = 700: exactly what a first-timer pays. The ladder is a no-op.
--
-- It is not live harm today — all three rungs ship `enabled = false`, so nothing is
-- promised to anyone. It becomes harm the moment somebody enables them, which is a
-- one-click operation on /pricing, believing they have just given their best earners a
-- discount. Nobody's fee moves, no error is raised, and no control says a word.
--
-- The two existing tier controls cannot see this. `ctl_fee_tier_ladder_inverted` catches
-- a rung charging MORE than a lower rung, and `ctl_fee_tier_below_floor` catches a rung
-- at or under the processing floor. Both compare rungs to EACH OTHER or to the floor.
-- Neither compares a rung to the standing rate, which is the only comparison that decides
-- whether the rung does anything at all.
--
-- Deliberately NOT fixed by rewriting the rungs: what the ladder should pay is a pricing
-- decision, not a defect. 900/800/700 were set on 2026-08-12 against a 1000 bps standing
-- rate, where they delivered 1%, 2% and 3% off; the beta cut to 700 the same day made
-- them moot. Whoever re-opens the beta rate has to decide whether the ladder follows it
-- down. This control is what makes sure that decision is TAKEN rather than missed.

create or replace function public.ctl_fee_tier_inert()
returns table(entity_id text, detail jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  select t.id::text,
         jsonb_build_object(
           'kind', 'fee_tier_inert',
           'tier', t.name,
           'tier_fee_bps', t.fee_bps,
           'standing_fee_bps', public.fee_bps_at(now()),
           'min_completed', t.min_completed,
           'min_distinct_posters', t.min_distinct_posters,
           'remedy', 'This loyalty rung is enabled but charges ' || t.fee_bps ||
                     ' bps against a standing rate of ' || public.fee_bps_at(now()) ||
                     ' bps. The pinned rate is lowest-wins, so an earner who reaches this '
                     || 'rung pays exactly what a first-timer pays — the rung rewards '
                     || 'nobody and the ladder is decorative. Either lower the rung below '
                     || 'the standing rate on /pricing, or disable it so the platform is '
                     || 'not advertising a benefit it does not deliver.'
         )
    from public.fee_tiers t
   where t.enabled
     and t.fee_bps >= public.fee_bps_at(now());
$function$;

revoke execute on function public.ctl_fee_tier_inert() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name)
values (
  'fee_tier_inert',
  'A loyalty rung is enabled but cannot beat the standing rate',
  'medium',
  'money',
  'The pinned fee is lowest-wins across the standing rate, the earner tier and any '
  || 'promotion, so a rung at or above the standing rate delivers nothing. Measured '
  || '2026-09-08: all three rungs sit at 900/800/700 against a standing 700, so the '
  || 'whole ladder is a no-op the moment it is switched on. The two existing tier '
  || 'controls compare rungs to each other and to the processing floor, never to the '
  || 'standing rate, so neither can see it. Medium, not high: it is a promise that '
  || 'silently does nothing, not money going astray.',
  'ctl_fee_tier_inert'
)
on conflict (key) do update
  set title = excluded.title, severity = excluded.severity, domain = excluded.domain,
      why = excluded.why, fn_name = excluded.fn_name;

-- ── Probe: it discriminates, and it is silent on a ladder that works ───────
do $$
declare
  n int;
  standing int := public.fee_bps_at(now());
  tid uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Today's real shape: all rungs disabled, so the control must be SILENT.
  select count(*) into n from public.ctl_fee_tier_inert();
  if n <> 0 then
    raise exception 'CONTROL WRONG: it fires while every rung is disabled (found %)', n;
  end if;

  -- Enable a rung AT the standing rate — the exact live shape, and a no-op.
  insert into public.fee_tiers (name, min_completed, min_distinct_posters, fee_bps, enabled, note)
  values ('probe inert rung', 99, 99, standing, true, 'probe')
  returning id into tid;
  select count(*) into n from public.ctl_fee_tier_inert() where entity_id = tid::text;
  if n <> 1 then
    raise exception 'CONTROL CANNOT DISCRIMINATE: a rung at the standing rate did not fire';
  end if;

  -- Lower it BELOW the standing rate — now it genuinely rewards someone.
  update public.fee_tiers set fee_bps = greatest(500, standing - 100) where id = tid;
  select count(*) into n from public.ctl_fee_tier_inert() where entity_id = tid::text;
  if n <> 0 then
    raise exception 'CONTROL WRONG: it fires on a rung that beats the standing rate';
  end if;

  -- Disabled is a deliberate state and must never be reported.
  update public.fee_tiers set fee_bps = standing + 200, enabled = false where id = tid;
  select count(*) into n from public.ctl_fee_tier_inert() where entity_id = tid::text;
  if n <> 0 then
    raise exception 'CONTROL WRONG: it fires on a DISABLED rung';
  end if;

  raise notice 'probe: inert rungs are reported, useful rungs and disabled rungs are not';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
