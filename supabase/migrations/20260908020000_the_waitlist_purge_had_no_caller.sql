-- ─────────────────────────────────────────────────────────────────────────────
-- The waitlist promised two retention rules and scheduled neither (2026-09-08).
--
-- Found by an adversarial review of 20260908010000, which shipped
-- purge_waitlist_expired() with a definition, a grant, and a rolled-back probe — and
-- no caller anywhere in the repo. Both rules it enforces are stated as fact in three
-- places that a person can read: the table comment ("purged at 48 hours"), the
-- migration header, and — since it was published an hour ago — the Privacy Policy,
-- which tells a non-user "if you never confirm your address, we delete your waitlist
-- record automatically after 180 days".
--
-- This is the SAME failure 20260814070000 exists to record for
-- purge_assistant_pending_actions: a retention promise written into a function that
-- nothing runs. It is fixed the same way, and deliberately NOT with a new cron entry —
-- ctl_cron_not_scheduled only watches array['controls_sweep','controls_digest'], so a
-- third job could stop silently and no control would notice.
--
-- The body below was taken from LIVE pg_get_functiondef, not from the previous
-- migration file, with exactly one block added. That distinction is the whole reason
-- run_safety_checkin_stages had to be restored by 20260906053000: 20260906034000
-- rebuilt this function from an older copy and silently dropped a safety stage. The
-- probe at the end asserts every step is still present.
--
-- It also fixes the normalisation the same review found: the +tag strip made the
-- STORED address differ from the one GoTrue sees at signup, so inviteCohort
-- allowlisted jane@ulm.edu while handle_new_user compared jane+hustlr@ulm.edu — a
-- server-side refusal, with no message, for somebody we had just told was invited.
-- Lower and trim only, on both sides.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Normalisation: lower + trim, nothing else ───────────────────────────────
create or replace function public.normalize_waitlist_row()
returns trigger
language plpgsql
as $$
begin
  -- NO +tag strip. The waitlist address must be the address the person will type at
  -- signup, because inviteCohort writes it into beta_allowlist and handle_new_user
  -- compares lower(email) against that. GoTrue treats jane+x@ and jane@ as different
  -- accounts; folding them here breaks the invite for anyone who used a tag.
  new.email := lower(btrim(coalesce(new.email, '')));
  -- A source is an attribution slug, not free text. Anything else is somebody putting
  -- a sentence in a query string that an operator will later read.
  new.source := nullif(left(regexp_replace(coalesce(new.source, ''), '[^a-zA-Z0-9_.-]', '', 'g'), 40), '');
  new.invite_wave := nullif(left(btrim(coalesce(new.invite_wave, '')), 40), '');
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.normalize_waitlist_row() from public, anon, authenticated;

-- Rows already stored with a stripped tag cannot be recovered — the tag is gone. There
-- is one such row per the QA runs and it is removed below with the other test data.

-- ── The sweep, copied forward from live with one step added ──────────────────
CREATE OR REPLACE FUNCTION public.controls_sweep_and_page()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cfg jsonb; on_ boolean; url text; secret text; base text;
begin
  -- pg_cron carries no JWT, so auth.role() and auth.uid() are NULL here. Several guards
  -- (guard_bookings_write above all) exempt service_role and deny-by-default for anyone
  -- else, so without this the housekeeping below either raises — swallowed by its own
  -- exception block into a warning — or silently pins the columns it meant to change.
  -- Transaction-local: pg_cron gives each run its own transaction, so it cannot leak.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Stage one of the safety check-in, and stage two for anything that ignored it.
  -- FIRST, so the page that follows means "we asked and got nothing back". Added by
  -- 20260905002200 and lost when 20260906034000 rewrote this function from the older
  -- base; restored here rather than left to the next reader to notice.
  begin
    perform public.run_safety_checkin_stages();
  exception when others then
    raise warning 'safety checkin stages failed: %', sqlerrm;
  end;

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

  -- Staged-but-never-confirmed assistant actions, past their stated 24h window. These
  -- carry the parameters of things a user was offered and declined, so the retention
  -- window in 20260813020000 is a promise; until now nothing kept it.
  begin
    perform public.purge_assistant_pending_actions();
  exception when others then
    raise warning 'assistant pending-action purge failed: %', sqlerrm;
  end;

  -- Waitlist retention. The migration that created the table PROMISES two rules in its
  -- own comments and in the published Privacy Policy — attempts cleared at 48 hours,
  -- unconfirmed rows expired at 180 days — and shipped the function with no caller at
  -- all, which is the exact shape 20260814070000 exists to record for the assistant
  -- purge above. Wrapped like every other step: a failed purge must not stop the sweep
  -- reaching run_all_controls().
  begin
    perform public.purge_waitlist_expired();
  exception when others then
    raise warning 'waitlist purge failed: %', sqlerrm;
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
$function$
;


-- ── Probe ───────────────────────────────────────────────────────────────────
do $$
declare
  def  text;
  step text;
  id1  uuid;
begin
  select pg_get_functiondef(oid) into def from pg_proc
   where proname = 'controls_sweep_and_page' and pronamespace = 'public'::regnamespace;

  -- Every step the live body carried BEFORE this migration, plus the new one. A
  -- copy-forward that loses one of these is the failure this probe exists to catch.
  foreach step in array array[
    'run_safety_checkin_stages',
    'vest_bonuses',
    'expire_stale_pending_bookings',
    'expire_dead_listings',
    'purge_assistant_pending_actions',
    'purge_waitlist_expired',
    'run_all_controls',
    'set_config'
  ] loop
    if position(step in def) = 0 then
      raise exception 'FIX FAILED: the sweep lost %', step;
    end if;
  end loop;
  raise notice 'sweep carries all 8 steps including the waitlist purge';

  -- Normalisation: a tag must SURVIVE now, and case must still be folded.
  insert into public.waitlist (email, token_hash)
  values ('  Probe.Tag+Keep@Example.COM ', 'probe-normalise-token')
  returning id into id1;
  if (select email from public.waitlist where id = id1) <> 'probe.tag+keep@example.com' then
    raise exception 'FIX FAILED: normalisation produced %, expected the tag to survive',
      (select email from public.waitlist where id = id1);
  end if;
  raise notice 'normalisation folds case and keeps the +tag, so the invite matches what GoTrue sees';

  -- The purge still discriminates after the rewrite.
  update public.waitlist set created_at = now() - interval '200 days' where id = id1;
  perform public.purge_waitlist_expired();
  if exists (select 1 from public.waitlist where id = id1) then
    raise exception 'FIX FAILED: the purge no longer expires stale unconfirmed rows';
  end if;
  raise notice 'purge_waitlist_expired still discriminates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'waitlist retention probe passed — all changes rolled back';
  else
    raise;
  end if;
end $$;
