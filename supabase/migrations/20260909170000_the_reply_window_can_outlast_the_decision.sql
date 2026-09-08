-- The earner's stated deadline could be 36 hours LATER than the moment the case is
-- actually decided, and a proposal could be admitted after that moment had already passed.
--
-- Two constants describe the same thing and were derived from different clocks:
--
--   dispute_set_defaults caps settle_after at `hold_dies - 12h` = held_since + 6.5 days.
--   dispute_settlement_pct branch 4 captures a contested case in FULL at
--     `coalesce(authorized_at, created_at) + 5 days`.
--
-- So an earner told "you have until <settle_after>" could be looking at a deadline a day
-- and a half after the case had already been decided against the poster; and
-- stripe-capture-payment's MIN_RUNWAY_HOURS of 36 — also measured against the 7-day hold —
-- admitted a proposal until held_since + 5.5 days, which is PAST branch 4's trigger. A
-- proposal made there and contested was auto-captured at the next hourly sweep with
-- nobody having read it: ctl_dispute_contested_unadjudicated fires from held_since + 3
-- days, so it filed its "you have two days" finding on the same sweep that took the money.
-- The promise both clients make — that a person reads the case — had no time to be kept.
--
-- The hold is not the deadline. Branch 4 is. Both derive from it now, with the same 12
-- hours of margin the original derivation already used for the sweep plus a retry.

create or replace function public.dispute_set_defaults()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  b_earner uuid;
  j_poster uuid;
  held_since timestamptz;
begin
  select b.earner_id, j.poster_id into b_earner, j_poster
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  -- Resolved once, here, so no read site has to re-join. Useful on every row,
  -- including a reversal: it names the counterparty either way.
  if new.respondent_id is null then
    new.respondent_id := case when new.raised_by = j_poster then b_earner else j_poster end;
  end if;

  -- ONLY an adjustment gets a clock. A row with no proposed_pct is a refund or a
  -- chargeback record filed by stripe-webhook; giving it a window armed branch 3,
  -- which would settle and auto-close the row whose whole job is to stay open.
  if new.proposed_pct is not null and new.settle_after is null then
    -- coalesce(authorized_at, created_at) — created_at is the FIRST hold ever placed and
    -- a recovery re-hold deliberately leaves it alone (20260806150000).
    select coalesce(p.authorized_at, p.created_at) into held_since
      from public.payments p
     where p.booking_id = new.booking_id
     order by p.created_at desc
     limit 1;

    -- 48 hours — chosen over 72 so a gig finished on Friday still settles over the
    -- weekend — but never past the point where the case is already decided.
    --
    -- The binding deadline is BRANCH 4, at held_since + 5 days, not the authorization's
    -- own death at + 7. Capping against the hold let us tell an earner they had until
    -- day 6.5 while a contest would be captured in full on day 5. 12 hours of margin
    -- covers the hourly sweep plus a retry, exactly as before.
    new.settle_after := least(
      now() + interval '48 hours',
      coalesce(held_since + interval '5 days' - interval '12 hours', now() + interval '48 hours')
    );
    -- Never backwards: a hold already past that point would otherwise be given a window
    -- in the past, which reads as "the reply window has closed" before the earner has
    -- been told anything. stripe-capture-payment refuses to open a proposal that late at
    -- all (MIN_RUNWAY_HOURS), so this is a backstop for a row written another way.
    if new.settle_after <= now() then
      new.settle_after := now() + interval '1 hour';
    end if;
  end if;

  return new;
end;
$function$;

do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid;
  sa timestamptz; auto_at timestamptz; held timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 170000', 'Handyman', 200, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;

  -- ── A FRESH hold: the ordinary 48-hour window is unchanged ─────────────────
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 20000, 1400, 18600, 'authorized', 'pi_probe_170000', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe fresh', 60) returning id into did;
  select settle_after into sa from public.disputes where id = did;
  if sa < now() + interval '47 hours' or sa > now() + interval '49 hours' then
    raise exception 'FIX FAILED: a fresh hold no longer gets ~48h (got %)', sa;
  end if;
  delete from public.disputes where id = did;

  -- ── AN AGED hold: the window must close BEFORE branch 4 decides it ─────────
  update public.payments set authorized_at = now() - interval '3 days 12 hours' where booking_id = bid;
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe aged', 60) returning id into did;
  select settle_after into sa from public.disputes where id = did;
  select coalesce(authorized_at, created_at) into held from public.payments where booking_id = bid;
  auto_at := held + interval '5 days';
  if sa >= auto_at then
    raise exception 'FIX FAILED: the earner is told % but branch 4 decides it at % — the deadline outlasts the decision', sa, auto_at;
  end if;
  if auto_at - sa < interval '11 hours' then
    raise exception 'FIX FAILED: only % between the window closing and the auto-capture', auto_at - sa;
  end if;

  raise notice 'probe: fresh hold still 48h; an aged one closes % before branch 4 decides it', auto_at - sa;
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
