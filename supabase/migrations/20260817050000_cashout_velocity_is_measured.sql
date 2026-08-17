-- ─────────────────────────────────────────────────────────────────────────────
-- The gig rail has no velocity limit anywhere, and nothing measures it either.
--
-- The shape of the attack is standard and this platform has every leg of it:
--   · destination charges, platform is merchant of record
--     (stripe-create-payment-intent: application_fee_amount + transfer_data.destination)
--   · funds reach the earner's Connect account at capture, and Stripe pays out daily
--   · chargebacks are absorbed by the platform, decided deliberately in 20260813160000
--   · no cap on how much can move to one earner, in any window, from anyone
--
-- So: stolen card, post a gig, "hire" your own second account, verify, cash out. The
-- chargeback lands weeks later and the platform eats it. That is a bust-out, and it is the
-- reason marketplaces instrument this before they need to.
--
-- ── WHY THIS MEASURES RATHER THAN BLOCKS ────────────────────────────────────
-- A hard cap is the wrong first move here, and not because caps are wrong — because there
-- is no traffic yet to calibrate one against. A threshold picked with no baseline either
-- sits so high it never fires or so low it blocks the only real users on the platform, and
-- the second failure is the one that gets a control switched off permanently.
--
-- The standard sequence is instrument, baseline, then enforce. This is step one, and it is
-- deliberately the only step being taken now: at beta volume a wrong cap costs a real
-- earner their money, while a missing measurement costs nothing until there is something
-- to see. **Step two is a hard gate on capture** — the one lever the platform actually
-- holds, since capture is what releases funds — and it should be written once these
-- numbers have a month of real distribution behind them.
--
-- ── WHY THE PREDICATE IS VOLUME **AND** CONCENTRATION ───────────────────────
-- Volume alone fires on a legitimately busy earner and on any large honest gig, which on
-- this platform's seed data means firing forever — the permanent-noise failure already
-- fixed three times here. Concentration alone fires on every new earner with one client.
-- Together they describe the actual fraud: a lot of money, from almost nobody.
--
-- The window is ROLLING, which is what keeps it honest. Velocity is inherently recent, so
-- old activity ages out and a finding that is no longer true resolves itself instead of
-- sitting on the board being scrolled past.
--
-- Connect account age rides in the detail rather than the predicate. A days-old payout
-- account is the strongest single signal a reviewer has, but folding it in would make one
-- control answer two questions and neither cleanly.
--
-- Found by the 2026-08-12 payments audit (incentives F9 / JSON #42), reproduced 2026-08-14.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_earner_cashout_velocity()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with moved as (
    select b.earner_id,
           sum(coalesce(p.earner_amount_cents, 0))          as cents,
           count(*)                                          as captures,
           count(distinct j.poster_id)                       as posters,
           min(p.captured_at)                                as first_capture,
           max(p.captured_at)                                as last_capture
      from public.payments p
      join public.bookings b on b.id = p.booking_id
      join public.jobs j     on j.id = b.job_id
     where p.captured_at > now() - interval '7 days'
       and coalesce(p.earner_amount_cents, 0) > 0
     group by b.earner_id
  )
  select m.earner_id::text,
         jsonb_build_object(
           'kind', 'cashout_velocity',
           'cents_7d', m.cents,
           'captures_7d', m.captures,
           'distinct_posters_7d', m.posters,
           'first_capture', m.first_capture,
           'last_capture', m.last_capture,
           -- The strongest signal a reviewer has, carried as evidence rather than as part
           -- of the test: a payout account opened days before the money moved.
           'connect_account_age_days',
             (select round(extract(epoch from now() - a.created_at) / 86400.0, 1)
                from public.stripe_accounts a where a.user_id = m.earner_id),
           'note', 'a large amount reached one earner in seven days from very few '
                   'counterparties. That is the bust-out shape: stolen card, self-dealt '
                   'gig, cash out before the chargeback lands — and chargebacks are '
                   'absorbed by the platform by design. It is also what a legitimate '
                   'earner with one big client looks like, which is why this asks for a '
                   'human rather than blocking anything.',
           'remedy', 'Open the earner and the poster(s) in the console. Look for: a '
                     'Connect account opened just before the money moved, a poster with '
                     'no other activity, gigs with no messages, and completion photos '
                     'that do not match the work. If it is fraud, suspend both and refund '
                     'the captures — the platform eats the chargeback either way, so '
                     'acting before the payout is the only thing that limits the loss.'
         )
    from moved m
   -- Volume AND concentration. Either alone is noise; together they are the attack.
   where m.cents >= 200000            -- $2,000 to one earner inside a week
     and m.posters < 3                -- from almost nobody
$$;

revoke execute on function public.ctl_earner_cashout_velocity() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('earner_cashout_velocity',
   'Large amount cashed out to one earner from very few counterparties',
   'high', 'abuse',
   'Destination charges put funds in the earner''s Connect account at capture, Stripe pays '
   'out daily, and the platform absorbs chargebacks by deliberate decision. There is no '
   'velocity cap anywhere on that rail, so a stolen card funding a self-dealt gig cashes '
   'out before the dispute arrives. This does not block — there is no traffic baseline yet '
   'to calibrate a cap against, and at beta volume a wrong threshold costs a real earner '
   'their money. It measures, so that a cap can be written against real numbers.',
   'ctl_earner_cashout_velocity')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove both halves of the predicate are load-bearing ─────────────────────
do $$
declare
  earner uuid; jid uuid; bid uuid; i int;
  people uuid[]; n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select array_agg(id) into people from (
    select id from public.profiles where deleted_at is null limit 5
  ) p;
  if coalesce(array_length(people, 1), 0) < 5 then
    raise exception 'need 5 live profiles to stage this';
  end if;
  earner := people[1];

  -- Baseline: whatever this earner already has must not already trip it, or every
  -- assertion below is measuring the wrong thing.
  select count(*) into n from public.ctl_earner_cashout_velocity() where entity_id = earner::text;
  if n <> 0 then
    raise exception 'staging invalid: this earner already trips the control (% rows)', n;
  end if;

  -- ── The attack: $2,500 in a week, all from ONE counterparty ───────────────
  for i in 1..5 loop
    insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
    values (people[2], 'velocity probe ' || i, 'Odd Jobs', 500, 'flat', 'Probe', 'probe', 'cancelled')
    returning id into jid;
    insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'verified')
    returning id into bid;
    insert into public.payments
      (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
       status, captured_at, earnings_credited)
    values (bid, 'pi_velocity_probe_' || i, 50000, 3500, 50000, 'captured', now() - interval '1 day', true);
  end loop;

  select count(*) into n from public.ctl_earner_cashout_velocity() where entity_id = earner::text;
  if n <> 1 then
    raise exception 'FIX FAILED: $2,500 from one counterparty in a week reported % rows', n;
  end if;
  raise notice 'the bust-out shape fires: 5 captures, 1 counterparty, $2,500 in seven days';

  -- ── Concentration is load-bearing: same money, spread across strangers ────
  update public.jobs j set poster_id = people[2 + (abs(hashtext(j.id::text)) % 3)]
   where j.title like 'velocity probe %';
  select count(distinct j.poster_id) into n
    from public.jobs j where j.title like 'velocity probe %';
  if n < 3 then
    raise exception 'staging wrong: only % distinct posters after spreading', n;
  end if;
  select count(*) into n from public.ctl_earner_cashout_velocity() where entity_id = earner::text;
  if n <> 0 then
    raise exception 'FALSE POSITIVE: the same money from 3+ counterparties still fired';
  end if;
  raise notice 'concentration is load-bearing: identical money across 3 posters is silent';

  -- ── Volume is load-bearing: one counterparty again, but small ─────────────
  update public.jobs set poster_id = people[2] where title like 'velocity probe %';
  update public.payments set earner_amount_cents = 1000
   where payment_intent_id like 'pi_velocity_probe_%';
  select count(*) into n from public.ctl_earner_cashout_velocity() where entity_id = earner::text;
  if n <> 0 then
    raise exception 'FALSE POSITIVE: $50 total from one poster fired';
  end if;
  raise notice 'volume is load-bearing: one counterparty at $50 total is silent';

  -- ── The window is rolling, so a finding ages out instead of sticking ──────
  update public.payments set earner_amount_cents = 50000,
                             captured_at = now() - interval '30 days'
   where payment_intent_id like 'pi_velocity_probe_%';
  select count(*) into n from public.ctl_earner_cashout_velocity() where entity_id = earner::text;
  if n <> 0 then
    raise exception 'a 30-day-old cashout still fires — this control would never resolve';
  end if;
  raise notice 'rolling window: old activity ages out, so findings resolve rather than accumulate';

  if not exists (select 1 from public.controls
                  where key = 'earner_cashout_velocity' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'cashout velocity probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
