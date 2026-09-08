-- Every dispute notice was INBOX-ONLY, on the one deadline where silence costs money.
--
-- `dispute_notify_respondent` writes the row in the same transaction — deliberately,
-- replacing an unawaited fetch from the accuser's client that returned false on any
-- failure and was never retried. But there is no database→push rail in this project:
-- `send-push` authenticates a signed-in user's token and a trigger has no user. So
-- "they have asked to pay 60%, you have until Sep 10 21:44 UTC to reply before that goes
-- through" reached an earner ONLY if they happened to open the app — and branch 3 then
-- settles at the poster's figure on a silence the platform never actually broke.
--
-- The notification SETTINGS screen promises an email for exactly this category.
--
-- The rail is the shape `notify_safety_report` already uses: pg_net POST, config and
-- secret in `app_flags` (never a GUC — a GUC is invisible, needs superuser, and cannot be
-- read back, which is how the safety pager sat dead for four weeks in 2026-07), and the
-- channel watched by `ctl_alert_not_dispatching` so switching it off cannot be silent.
--
-- It posts to `send-push`, which already owns the Expo fan-out, dead-token pruning, the
-- per-category preference check and the branded email templates. A second copy of that
-- was the alternative and would have been the wrong trade. The gateway still requires a
-- JWT: the POST carries the ANON key, which is public and ships in every client, so this
-- adds no unauthenticated surface and `config.toml` is unchanged.

insert into public.app_flags (key, value, enabled)
values ('notify_dispatch',
        jsonb_build_object(
          'url', 'https://nfioebqsgmmzhbksxozc.functions.supabase.co/send-push',
          'secret', (select value->>'secret' from public.app_flags where key = 'controls_alert'),
          'anon_key', 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu'
        ),
        true)
on conflict (key) do nothing;

comment on table public.app_flags is
  'Three kinds of row, and /flags must not render them alike: feature kill switches, '
  'alert/dispatch CHANNELS (controls_alert, safety_alert, notify_dispatch — url+secret, '
  'auto-expiring mute), and CONFIG rows whose payload is `value` and whose `enabled` bit '
  'nothing reads (stripe_mode, storage_public_origin, controls_heartbeat).';

-- ── The dispatch ────────────────────────────────────────────────────────────────────
create or replace function public.dispatch_notification(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg jsonb;
begin
  select value into cfg from public.app_flags where key = 'notify_dispatch' and enabled;
  -- Not configured, or muted. Silent by design: the inbox row is already written and is
  -- the durable record; this is the extra reach. ctl_alert_not_dispatching is what makes
  -- the muted state visible, rather than an exception here that would roll back the
  -- caller's whole transaction — including the notification we are trying to deliver.
  if cfg is null or coalesce(cfg->>'url', '') = '' or coalesce(cfg->>'secret', '') = '' then
    return;
  end if;

  perform net.http_post(
    url := cfg->>'url',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- The gateway's verify_jwt check. The anon key is public — it ships in every
      -- client — so this is not a secret and does not authorise anything by itself.
      'Authorization', 'Bearer ' || coalesce(cfg->>'anon_key', ''),
      'apikey', coalesce(cfg->>'anon_key', ''),
      -- THIS is the authorisation, and it is all the caller supplies besides one id.
      'x-notify-secret', cfg->>'secret'
    ),
    body := jsonb_build_object('notificationId', p_notification_id)
  );
end;
$function$;

revoke execute on function public.dispatch_notification(uuid) from public;
revoke execute on function public.dispatch_notification(uuid) from anon;
revoke execute on function public.dispatch_notification(uuid) from authenticated;

-- ── The trigger hands it the row it just wrote ──────────────────────────────────────
--
-- Body reproduced from the live pg_proc definition with the dispatch appended. The
-- notification insert now RETURNS its id so the two cannot come apart: no dispatch
-- without a row, and no row whose id we then have to go looking for.
create or replace function public.dispute_notify_respondent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  j_title text;
  j_id    uuid;
  n_id    uuid;
begin
  -- A reversal row accuses nobody (see 20260909040000), and a row that is already
  -- settled has no window to offer. Both would be a clock over our signature on a
  -- decision the reader cannot change.
  if new.proposed_pct is null or new.pct_paid is not null then return new; end if;

  select j.title, j.id into j_title, j_id
    from public.bookings b join public.jobs j on j.id = b.job_id
   where b.id = new.booking_id;

  if new.respondent_id is not null then
    insert into public.notifications (user_id, type, title, body, job_id, data)
    values (
      new.respondent_id,
      'dispute',
      'The poster reported a problem',
      'They have asked to pay ' || new.proposed_pct::text || '% on '
        || coalesce(j_title, 'your gig')
        || '. You have until '
        || to_char(coalesce(new.settle_after, now() + interval '48 hours') at time zone 'UTC',
                   'Mon DD HH24:MI') || ' UTC to reply before that goes through — '
        || 'open it to see why and respond.',
      j_id,
      jsonb_build_object('dispute_id', new.id, 'booking_id', new.booking_id, 'tab', 'EarnTab')
    )
    returning id into n_id;

    -- Reach them OUTSIDE the app. pg_net queues the request and returns immediately, so
    -- this does not hold the caller's transaction open on a network call.
    perform public.dispatch_notification(n_id);
  end if;
  return new;
end;
$function$;

-- ── The new channel is watched like the other two ───────────────────────────────────
create or replace function public.ctl_alert_not_dispatching()
returns table(entity_id text, detail jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  with cfg as (
    select r.key,
           f.key is not null          as present,
           coalesce(f.enabled, true)  as enabled,
           -- Resolved the way the DISPATCHER resolves it, not the way it is stored.
           -- notify_safety_report falls back to the GUCs (20260812070000:76-77) and the
           -- other dispatchers do not; a control that ignored that would report a working
           -- safety pager as dark on any project that still sets them.
           coalesce(
             nullif(f.value->>'url', ''),
             case when r.key = 'safety_alert'
                  then nullif(current_setting('app.safety_alert_url', true), '') end
           ) as url,
           coalesce(
             nullif(f.value->>'secret', ''),
             case when r.key = 'safety_alert'
                  then nullif(current_setting('app.safety_alert_secret', true), '') end
           ) as secret,
           f.disabled_until,
           f.disabled_reason,
           f.updated_by,
           f.updated_at,
           case r.key
             when 'controls_alert'
               then 'the hourly control page, the daily digest, and the Stripe '
                    'reconciliation dispatch that shares this secret'
             when 'notify_dispatch'
               then 'every dispute deadline leaving the app — the push and the email '
                    'telling an earner they have hours left to answer a reduction. '
                    'Dark, the notice is inbox-only and branch 3 settles at the '
                    'poster''s figure on a silence we never actually broke'
             else 'the pager a harassment or assault report rings — the path that sat '
                  'dead from 2026-07-10 to 2026-08-06 without firing once'
           end as what_goes_dark
      from (values ('controls_alert'), ('safety_alert'), ('notify_dispatch')) as r(key)
      left join public.app_flags f on f.key = r.key
  )
  select c.key,
         jsonb_build_object(
           'causes', to_jsonb(array_remove(array[
             case when not c.present                     then 'no_app_flags_row' end,
             case when c.present and not c.enabled       then 'switched_off' end,
             case when c.present and c.url is null       then 'blank_url' end,
             case when c.present and c.secret is null    then 'blank_secret' end
           ], null)),
           'what_goes_dark', c.what_goes_dark,
           'disabled_until', c.disabled_until,
           'disabled_reason', c.disabled_reason,
           'changed_by', c.updated_by,
           'changed_at', c.updated_at,
           'remedy', 'Open /flags and restore this channel. A mute lapses by itself at '
                     || 'disabled_until; a blank url or secret does not, and neither does '
                     || 'a missing row.'
         )
    from cfg c
   where not c.present or not c.enabled or c.url is null or c.secret is null;
$function$;

-- ── Probe ────────────────────────────────────────────────────────────────────────────
do $$
declare
  poster uuid; earner uuid; jid uuid; bid uuid; did uuid; n int; nid uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into poster from public.profiles order by created_at limit 1;
  select id into earner from public.profiles where id <> poster order by created_at limit 1;
  if poster is null or earner is null then raise exception 'probe needs two profiles'; end if;

  -- 1. The channel is configured, so the control is silent about it.
  select count(*) into n from public.ctl_alert_not_dispatching() where entity_id = 'notify_dispatch';
  if n <> 0 then raise exception 'FIX FAILED: the new channel reports as dark while configured (%)', n; end if;

  -- 2. Switch it off — it must be reported, like the other two.
  update public.app_flags set enabled = false where key = 'notify_dispatch';
  select count(*) into n from public.ctl_alert_not_dispatching() where entity_id = 'notify_dispatch';
  if n <> 1 then raise exception 'FIX FAILED: a muted dispatch channel is invisible (%)', n; end if;
  if (select detail->'causes' from public.ctl_alert_not_dispatching() where entity_id = 'notify_dispatch')
       @> '["switched_off"]'::jsonb is not true then
    raise exception 'FIX FAILED: the cause is not named';
  end if;
  update public.app_flags set enabled = true where key = 'notify_dispatch';

  -- 3. …and the other two are still watched.
  update public.app_flags set value = value - 'secret' where key = 'safety_alert';
  select count(*) into n from public.ctl_alert_not_dispatching() where entity_id = 'safety_alert';
  if n <> 1 then raise exception 'FIX FAILED: safety_alert coverage regressed (%)', n; end if;

  -- 4. A proposal still writes exactly ONE inbox row, and the dispatch does not throw.
  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 160000', 'Handyman', 200, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 20000, 1400, 18600, 'authorized', 'pi_probe_160000', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe 160000', 60) returning id into did;
  select count(*) into n from public.notifications
   where (data->>'dispute_id') = did::text and user_id = earner;
  if n <> 1 then raise exception 'FIX FAILED: expected exactly one inbox row, got %', n; end if;

  -- 5. A REVERSAL record still dispatches nothing, because it notifies nobody.
  insert into public.disputes (booking_id, raised_by, reason)
  values (bid, poster, 'Stripe refund on charge ch_probe160 (usd 5.00 refunded)') returning id into did;
  select count(*) into n from public.notifications where (data->>'dispute_id') = did::text;
  if n <> 0 then raise exception 'FIX FAILED: a reversal record notified somebody (%)', n; end if;

  -- 6. A muted channel must not break the write it accompanies.
  --    A SECOND booking, because disputes_one_live_proposal_per_booking (20260909060000)
  --    correctly forbids a second live proposal on the first one — this probe tripped it
  --    on the way in, which is the index doing its job.
  update public.app_flags set enabled = false where key = 'notify_dispatch';
  insert into public.jobs (title, category, pay, pay_type, location, description, poster_id, status)
  values ('Probe 160000b', 'Handyman', 100, 'flat', 'Monroe, LA', 'probe', poster, 'open') returning id into jid;
  insert into public.bookings (job_id, earner_id, status, earner_done, poster_done)
  values (jid, earner, 'completed', true, true) returning id into bid;
  insert into public.payments (booking_id, amount_cents, fee_cents, earner_amount_cents,
                               status, payment_intent_id, created_at, authorized_at)
  values (bid, 10000, 700, 9300, 'authorized', 'pi_probe_160000b', now(), now());
  insert into public.disputes (booking_id, raised_by, reason, proposed_pct)
  values (bid, poster, 'probe 160000 muted', 70) returning id into did;
  select count(*) into n from public.notifications where (data->>'dispute_id') = did::text;
  if n <> 1 then raise exception 'FIX FAILED: a muted dispatch lost the inbox row (%)', n; end if;

  raise notice 'probe: channel watched, muted channel reported and harmless, one inbox row per proposal, reversal silent';
  raise exception 'probe complete — rolling back';
exception
  when others then
    if sqlerrm <> 'probe complete — rolling back' then raise; end if;
    raise notice 'probe complete — rolled back cleanly';
end $$;
