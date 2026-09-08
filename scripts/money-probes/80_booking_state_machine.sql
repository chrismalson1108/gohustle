-- The booking state machine AS ENFORCED, not as documented. Rolled back.
--
-- LIFECYCLE_STATE_MACHINES.md describes the transitions; guard_bookings_write is what
-- actually allows or refuses them. This walks every transition from every status, as the
-- POSTER and as the EARNER, and prints what really happens — a refusal, a silent pin, or
-- a success. A silent pin is the dangerous outcome: PostgREST returns no error, so a
-- client reports success on a write the database discarded.
--
-- The one that matters most: completed -> verified must be impossible without a CAPTURED
-- payment, because ctl_settled_without_captured_payment is critical on exactly that shape
-- and the whole dispute model depends on a proposal leaving the booking `completed`.
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid;
  from_st text; to_st text; got text;
  msg text := '';
  actor text;
  actor_id uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;

  foreach actor in array array['poster','earner'] loop
    actor_id := case actor when 'poster' then poster else earner end;
    msg := msg || format(E'\n  ── as the %s ──', actor);
    foreach from_st in array array['pending','confirmed','completed','verified','cancelled','declined'] loop
      foreach to_st in array array['confirmed','completed','verified','cancelled','declined'] loop
        if from_st = to_st then continue; end if;

        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
        insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
        values ('SM probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
        returning id into jid;
        insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
        values (jid, earner, from_st, from_st in ('completed','verified'), from_st in ('completed','verified'))
        returning id into bid;
        -- An AUTHORIZED (never captured) hold, so completed->verified has no capture behind it.
        insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                                     status, payment_intent_id, created_at, authorized_at)
        values (bid, 10000, 700, 9300, 'authorized', 'pi_sm_' || bid, now(), now());

        perform set_config('request.jwt.claims',
                           json_build_object('role','authenticated','sub',actor_id::text)::text, true);
        begin
          update public.bookings set status = to_st where id = bid;
          perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
          select status into got from public.bookings where id = bid;
          if got = to_st then
            msg := msg || format(E'\n    %-10s -> %-10s ALLOWED', from_st, to_st);
          else
            -- The write was accepted and then discarded by the guard. No error reaches
            -- the client, which is what makes this the dangerous outcome.
            msg := msg || format(E'\n    %-10s -> %-10s SILENTLY PINNED back to %s', from_st, to_st, got);
          end if;
        exception when others then
          perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
          msg := msg || format(E'\n    %-10s -> %-10s refused (%s)', from_st, to_st,
                               left(sqlerrm, 48));
        end;
      end loop;
    end loop;
  end loop;

  -- ── The safety-critical one: cancelling a gig the earner has STARTED ────
  -- CLAUDE.md: cancel is allowed "from pending or confirmed, only before the earner
  -- marks started". An earner who has tapped Start is on somebody's doorstep; a poster
  -- cancelling out from under them at that point is a safety question, not a money one.
  msg := msg || E'\n  ── cancelling a STARTED gig ──';
  foreach actor in array array['poster','earner'] loop
    actor_id := case actor when 'poster' then poster else earner end;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
    values ('Started probe', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open')
    returning id into jid;
    insert into public.bookings (job_id, earner_id, status, started_at)
    values (jid, earner, 'confirmed', now() - interval '20 minutes') returning id into bid;
    insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                                 status, payment_intent_id, created_at, authorized_at)
    values (bid, 10000, 700, 9300, 'authorized', 'pi_started_' || bid, now(), now());

    perform set_config('request.jwt.claims',
                       json_build_object('role','authenticated','sub',actor_id::text)::text, true);
    begin
      update public.bookings set status = 'cancelled' where id = bid;
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
      select status into got from public.bookings where id = bid;
      msg := msg || format(E'\n    %s cancels a STARTED gig -> %s', actor,
                           case when got = 'cancelled' then 'ALLOWED' else 'pinned back to ' || got end);
    exception when others then
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
      msg := msg || format(E'\n    %s cancels a STARTED gig -> refused (%s)', actor, left(sqlerrm, 44));
    end;
  end loop;

  raise exception E'BOOKING STATE MACHINE, AS ENFORCED (rolled back):%', msg;
end $$;
