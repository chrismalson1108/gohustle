-- ─────────────────────────────────────────────────────────────────────────────
-- Gigs whose every time slot is in the past stay bookable forever.
--
-- Found by Chris driving Hustlr AI: it offered him "Meandering analyst" with slots on
-- Tue Jul 28 — sixteen days ago — on a gig he had already WORKED AND COMPLETED
-- (booking 5206da9f, verified, both parties done). He asked why a finished gig was
-- being sold to him again. It is a fair question and the answer is that nothing ever
-- closes a listing.
--
-- 4 of the 11 open jobs in production are in this state: slots exist, none of them are
-- in the future, and the job is still `open`.
--
-- ── WHY IT LOOKED FINE ──────────────────────────────────────────────────────
--
-- SlotPicker hides past slots (src/components/SlotPicker.js:11), so a human opening
-- the gig sees no bookable times and moves on. That UI filter is the ONLY thing
-- standing between a dead listing and a booking:
--
--   • the browse list still counts and shows the job,
--   • JobsContext.bookJob never checks starts_at,
--   • and the assistant does not use SlotPicker at all — it reads job_slots directly,
--     which is why it cheerfully offered seven expired times.
--
-- A rule enforced only in one component is not enforced. This puts it in the database,
-- where the app, the assistant, the website and anything written later all inherit it.
--
-- ── FLEXIBLE SLOTS ARE NOT DEAD ─────────────────────────────────────────────
--
-- "Flexible — Contact to Schedule" carries starts_at = NULL by design (PostJob attaches
-- one when the poster picks no times, so a gig can never be un-bookable). NULL means
-- "any time", so every predicate below reads `starts_at is null or starts_at > now()`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Refuse a booking on a slot that has already passed ───────────────────
create or replace function public.guard_booking_slot_not_past()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  slot_start timestamptz;
begin
  if new.slot_id is null then return new; end if;

  select starts_at into slot_start from public.job_slots where id = new.slot_id;

  -- NULL = flexible, always bookable. A small grace window absorbs a slot starting
  -- moments ago while someone is mid-checkout, which is a legitimate booking.
  if slot_start is not null and slot_start < now() - interval '1 hour' then
    raise exception 'That time has already passed — pick a later slot.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_booking_slot_not_past() from public, anon, authenticated;

drop trigger if exists trg_a_guard_booking_slot_not_past on public.bookings;
create trigger trg_a_guard_booking_slot_not_past
  before insert on public.bookings
  for each row execute function public.guard_booking_slot_not_past();

-- ── 2. Close listings that can no longer be worked ──────────────────────────
-- A job with slots, none of them future, and nothing live attached to it is finished
-- whether or not anyone said so. Leaving it `open` sells work that cannot happen —
-- and, as here, re-sells work the person already did.
--
-- Deliberately conservative: a job with ANY live booking is left alone, because that
-- booking still needs its lifecycle (mark done, verify, pay) and closing the listing
-- underneath it would be a second bug.
create or replace function public.expire_dead_listings()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.jobs j
     set status = 'cancelled'
   where j.status = 'open'
     -- has scheduled slots …
     and exists (select 1 from public.job_slots s where s.job_id = j.id)
     -- … and not one of them is still ahead of us (NULL = flexible = always ahead)
     and not exists (
       select 1 from public.job_slots s
        where s.job_id = j.id
          and (s.starts_at is null or s.starts_at > now()))
     -- nothing live still depends on the listing
     and not exists (
       select 1 from public.bookings b
        where b.job_id = j.id
          and b.status in ('pending', 'confirmed', 'completed'));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.expire_dead_listings() from public, anon, authenticated;

-- ── 3. Run it hourly, beside the other lifecycle sweeps ─────────────────────
-- Reproduced from the LIVE controls_sweep_and_page body with one call added.
create or replace function public.controls_sweep_and_page()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cfg jsonb; on_ boolean; url text; secret text; base text;
begin
  begin
    perform public.vest_bonuses();
  exception when others then
    raise warning 'bonus vesting failed: %', sqlerrm;
  end;

  begin
    perform public.expire_stale_pending_bookings(14);
  exception when others then
    raise warning 'stale pending expiry failed: %', sqlerrm;
  end;

  -- Listings whose every slot is in the past. Without this a finished gig keeps being
  -- offered — including back to the person who already worked it.
  begin
    perform public.expire_dead_listings();
  exception when others then
    raise warning 'dead listing expiry failed: %', sqlerrm;
  end;

  perform public.run_all_controls();

  cfg    := public.alert_config('controls_alert');
  on_    := coalesce((select enabled from public.app_flags where key = 'controls_alert'), true);
  url    := nullif(cfg->>'url', '');
  secret := coalesce(cfg->>'secret', '');
  if url is null then return; end if;
  base := regexp_replace(url, '/controls-alert$', '');

  begin
    perform net.http_post(
      url     := base || '/reconcile-stripe',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('days', 14, 'limit', 200),
      timeout_milliseconds := 120000
    );
  exception when others then
    raise warning 'stripe reconciliation dispatch failed: %', sqlerrm;
  end;

  if not on_ then return; end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-controls-secret', secret),
      body    := jsonb_build_object('mode', 'page'),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning 'controls page dispatch failed: %', sqlerrm;
  end;
end;
$function$;

-- ── 4. Notice the state rather than assume the sweep is working ─────────────
create or replace function public.ctl_dead_listing_open()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select j.id::text,
         jsonb_build_object(
           'title', j.title,
           'poster_id', j.poster_id,
           'slots', (select count(*) from public.job_slots s where s.job_id = j.id),
           'latest_slot', (select max(s.starts_at) from public.job_slots s where s.job_id = j.id),
           'live_bookings', (select count(*) from public.bookings b
                              where b.job_id = j.id
                                and b.status in ('pending','confirmed','completed')),
           'note', 'every time slot on this listing is in the past — it is still being '
                   'browsed and offered, including back to people who already worked it')
    from public.jobs j
   where j.status = 'open'
     and exists (select 1 from public.job_slots s where s.job_id = j.id)
     and not exists (
       select 1 from public.job_slots s
        where s.job_id = j.id
          and (s.starts_at is null or s.starts_at > now()))
$$;

revoke execute on function public.ctl_dead_listing_open() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('dead_listing_open',
   'An open listing has no time slot left in the future',
   'medium', 'lifecycle',
   'Browse counts it, search returns it, and Hustlr AI offers its expired slots — '
   'which is how a completed gig got offered back to the person who had already done '
   'it. The hourly sweep closes these; a finding here means one slipped through, or '
   'is held open by a live booking that needs a human.',
   'ctl_dead_listing_open')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Close the ones already out there ────────────────────────────────────────
do $$
declare n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select public.expire_dead_listings() into n;
  raise notice 'closed % dead listing(s)', n;
end $$;
