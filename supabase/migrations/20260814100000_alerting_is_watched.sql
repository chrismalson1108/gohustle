-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing watches the alerting flags. The 2026-07-10 silence, with a new key.
--
-- 20260806020000 moved dispatch config out of a GUC into app_flags and said why:
-- "a control can now check 'is alerting configured?' and page if not". 20260806030000
-- repeated the promise. No such control was ever written: until this migration, not one
-- row in the registry read app_flags for 'controls_alert' or 'safety_alert'.
--
-- So every dispatcher can be silenced with no cost and no tell. Each of these returns
-- BEFORE net.http_post, and each is the LAST definition of that function in filename
-- order, which is what is live:
--
--   controls_sweep_and_page  20260814070000:68,82
--   controls_digest          20260812070000:46,50
--   notify_safety_report     20260812070000:75,79
--
-- The only control watching alerting, ctl_alert_dispatch_failing (20260806160000), reads
-- net._http_response — it can see a dispatch that was ATTEMPTED and came back non-2xx. A
-- dispatch never attempted writes no row there, so that control returns nothing, any
-- finding it had AUTO-RESOLVES on the next sweep (run_control resolves what a control
-- stops returning), and /controls goes green. Controls keep running, findings keep being
-- written, and nobody is told. It is worse than the GUC version in one respect: switching
-- the channel off is the natural response to ctl_alert_dispatch_failing being noisy, and
-- doing so ERASES the finding that was complaining.
--
-- Four ways to the same silence, and only one of them is a switch: the row is gone, the
-- switch is off, value.url is blank, value.secret is blank. A blank secret is not
-- cosmetic — controls-alert answers 503 not_configured when it cannot find one
-- (controls-alert/index.ts:61-62), reconcile-stripe authenticates against the same value
-- (reconcile-stripe/index.ts:47), and safety-alert 403s a call carrying the empty string.
--
-- TWO HALVES.
--
-- 1. VISIBILITY. ctl_alert_not_dispatching reads app_flags directly for both keys and
--    names every broken shape it finds. It resolves url and secret exactly the way the
--    dispatcher does — including the GUC fallback that only notify_safety_report has — so
--    it cannot report a channel as dead that is in fact alive through the other path. A
--    control that cries wolf is a control somebody deletes.
--
-- 2. BOUNDING. Disabling a control is already "a MUTE, not a switch" (20260806350000):
--    disabled_until, plus reenable_expired_controls() at the top of run_all_controls. That
--    protection covers the controls REGISTRY and stops at these flags. The same valve is
--    extended to exactly these two keys, so alerting cannot be switched off for a noisy
--    incident and then forgotten. Maximum silence becomes ~24 hours instead of unbounded.
--
-- The re-enable is called from run_all_controls, next to the one it mirrors, and NOT from
-- controls_sweep_and_page. Two reasons. The sweep already runs run_all_controls before it
-- reads `enabled` for the page, so a lapsed mute lifts in the same run either way; and the
-- sweep had been redefined SEVEN times when this was written, two of those in the two days
-- before it, against three for run_all_controls in eight days — so reproducing the sweep
-- here to add one line is the larger chance of silently reverting somebody else's in-flight
-- change. The console's "Run sweep now" picks the re-enable up too.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. The draft of this fix logged every attempted
-- dispatch to a new public.alert_dispatches ledger so the control could also catch "on,
-- configured, and still not firing". That is a real gap and it is a DIFFERENT one — it
-- catches a dead cron job, not a disarmed flag — and it costs a schema object plus the
-- CLAUDE.md inventory rows claudeMdInventory.test.js demands for one. It belongs in its
-- own change, with its own probe. This one closes the flag hole only.
--
-- Honest limitation, stated because it is the reason part 2 carries weight: a finding
-- from part 1 still cannot be emailed while the channel it names is the channel that is
-- off. It shows on /controls and in the next digest after the mute lapses.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The mute gets a deadline — on these two keys and nothing else ─────────
alter table public.app_flags
  add column if not exists disabled_until  timestamptz,
  add column if not exists disabled_reason text;

comment on column public.app_flags.disabled_until is
  'Only meaningful for safety_alert and controls_alert: when the mute lapses and the '
  'channel switches itself back on. Deliberately NOT applied to the feature kill '
  'switches — payments_enabled must never un-pause itself on a timer 24 hours into a '
  'Stripe incident. Re-enabling a pager only resumes telling you things; re-enabling '
  'payments resumes taking money, and that is a decision a person makes.';

create or replace function public.trg_alert_flag_disable_expires()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The scope guard is the first statement on purpose. Everything below is safe only
  -- because re-enabling one of these two keys resumes NOTIFICATION and nothing else.
  if new.key not in ('safety_alert', 'controls_alert') then
    return new;
  end if;
  if not new.enabled then
    -- Same shape as trg_control_disable_expires: an explicitly supplied window is kept
    -- (that is a deliberate act), an absent one becomes 24 hours. The console's toggle
    -- writes only `enabled`, so every accidental disable lands in the second branch.
    if old.enabled or new.disabled_until is null then
      new.disabled_until := coalesce(
        nullif(new.disabled_until, old.disabled_until),
        now() + interval '24 hours');
    end if;
  else
    new.disabled_until  := null;
    new.disabled_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_z_alert_flag_disable_expires on public.app_flags;
create trigger trg_z_alert_flag_disable_expires
  before update of enabled, disabled_until on public.app_flags
  for each row execute function public.trg_alert_flag_disable_expires();

-- Anything already off gets a window too, so the fix cannot be pre-dated by having
-- switched the pager off yesterday.
update public.app_flags
   set disabled_until = coalesce(disabled_until, now() + interval '24 hours')
 where not enabled
   and key in ('safety_alert', 'controls_alert');

create or replace function public.reenable_expired_alert_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.app_flags
     set enabled = true,
         disabled_until = null,
         disabled_reason = null,
         updated_at = now()
   where key in ('safety_alert', 'controls_alert')
     and not enabled
     and disabled_until is not null
     and disabled_until <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.reenable_expired_alert_flags()
  from public, anon, authenticated;
grant  execute on function public.reenable_expired_alert_flags() to service_role;

-- Tell the truth on /flags, where somebody is standing when they flip the switch. The
-- guard on the note keeps this idempotent and keeps it from clobbering an operator's own
-- wording on a re-run.
update public.app_flags
   set note = coalesce(note, '') ||
              ' Switching this OFF is a MUTE, not a switch: it lifts itself after 24 '
              'hours, and ctl_alert_not_dispatching reports the channel as dark for as '
              'long as it lasts.'
 where key in ('safety_alert', 'controls_alert')
   and coalesce(note, '') not like '%MUTE, not a switch%';

-- ── 2. Lift a lapsed mute before the sweep reads the flag ───────────────────
-- REPRODUCED FROM THE LAST DEFINITION IN FILENAME ORDER (20260806350000), which is what
-- is live — it returns a TABLE and filters `not external`, neither of which survives
-- being retyped from memory. The only change is the block added at the top.
create or replace function public.run_all_controls()
returns TABLE(control_key text, violations integer, errored boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  n integer;
begin
  -- A mute that has lapsed is lifted BEFORE the sweep, so a control whose window
  -- expired reports in this run rather than the next one.
  perform public.reenable_expired_controls();

  -- The same sentence, for the channel that carries the report outward. Wrapped where
  -- the line above is not: a failure to lift a mute must never stop the controls
  -- themselves from running, because the findings are the load-bearing half.
  begin
    perform public.reenable_expired_alert_flags();
  exception when others then
    raise warning 'alert flag re-enable failed: %', sqlerrm;
  end;

  for r in select key from public.controls where enabled and not external order by key loop
    begin
      n := public.run_control(r.key);
      control_key := r.key; violations := n; errored := false;
      return next;
    exception when others then
      update public.controls
         set last_run_at = now(), last_error = sqlerrm, last_violations = null
       where key = r.key;
      control_key := r.key; violations := null; errored := true;
      return next;
    end;
  end loop;
end;
$fn$;

revoke execute on function public.run_all_controls() from public, anon, authenticated;

-- ── 3. The control ──────────────────────────────────────────────────────────
-- ONE ROW PER CHANNEL, never one per cause. run_control upserts findings with
-- `on conflict (control_key, entity_id) where resolved_at is null do update`, and two
-- rows sharing an entity_id in a single run abort the whole control with a cardinality
-- violation — the control would then be recorded as ERRORED, which is a different and
-- more confusing failure than the one it exists to report. So every broken shape is
-- named inside `causes` on the single row for that channel.
create or replace function public.ctl_alert_not_dispatching()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select r.key,
           f.key is not null          as present,
           coalesce(f.enabled, true)  as enabled,
           -- Resolved the way the DISPATCHER resolves it, not the way it is stored.
           -- notify_safety_report falls back to the GUCs (20260812070000:76-77) and the
           -- two controls_alert dispatchers do not; a control that ignored that would
           -- report a working safety pager as dark on any project that still sets them.
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
             else 'the pager a harassment or assault report rings — the path that sat '
                  'dead from 2026-07-10 to 2026-08-06 without firing once'
           end as what_goes_dark
      from (values ('controls_alert'), ('safety_alert')) as r(key)
      left join public.app_flags f on f.key = r.key
  )
  select c.key,
         jsonb_build_object(
           -- Slugs, not sentences, for the same reason ctl_payment_ledger_impossible
           -- uses them: they are greppable, they survive rewording, and a finding that
           -- persists across runs keeps a stable shape in the queue. The prose for each
           -- lives in the registry `why`, which /controls renders next to it.
           'causes', to_jsonb(array_remove(array[
             -- no row at all: the dispatcher reads value->>'url' off a row that does
             -- not exist, so url comes back null and it returns before it posts
             case when not c.present                     then 'no_app_flags_row' end,
             -- the switch: every dispatcher early-returns ahead of net.http_post
             case when c.present and not c.enabled       then 'switched_off' end,
             -- blanked url: same early return, no switch involved and no audit row
             case when c.present and c.url is null       then 'blank_url' end,
             -- blanked secret: it still posts, and is turned away — controls-alert
             -- answers 503 not_configured, safety-alert 403s the empty string
             case when c.present and c.secret is null    then 'blank_secret' end
           ]::text[], null)),
           'what_goes_dark', c.what_goes_dark,
           'enabled', c.enabled,
           'has_url', c.url is not null,
           'has_secret', c.secret is not null,
           'mute_lifts_at', c.disabled_until,
           'mute_reason', c.disabled_reason,
           'changed_by', c.updated_by,
           'changed_at', c.updated_at,
           'note', 'controls still run and findings are still written. Nobody is being '
                   'told about them, and this finding cannot be emailed either — it is '
                   'visible on /controls and in the first digest after the mute lapses.')
    from cfg c
   -- `not present` is not a trigger on its own: with the GUCs set, a missing row is a
   -- channel that still dispatches. It is reported through the url/secret arms, where it
   -- is actually true, and named in `causes` when it is the reason.
   where not c.enabled or c.url is null or c.secret is null
$$;

revoke execute on function public.ctl_alert_not_dispatching()
  from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('alert_not_dispatching',
   'An alert channel cannot dispatch — switched off, unconfigured, or missing',
   'high', 'security',
   'Two migrations promised a control that reads the dispatch config back and pages if '
   'alerting is not wired up, and none was written. ctl_alert_dispatch_failing reads '
   'net._http_response, so it sees only dispatches that were ATTEMPTED and failed — a '
   'dispatch never attempted produces no row, that control returns nothing, its finding '
   'auto-resolves, and /controls renders green while every money and safety finding goes '
   'undelivered. That is the state safety paging sat in from 2026-07-10 to 2026-08-06. '
   'Muting a noisy channel during an incident stays legitimate: it costs a line here and '
   'expires in 24 hours, instead of being a decision made once and forgotten.',
   'ctl_alert_not_dispatching')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Prove it discriminates, on the real keys and the real shapes, rolled back ─
do $$
declare
  base_new int; base_old int; after_old int;
  d jsonb; n int; ok boolean; lifts timestamptz; still_off boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- The GUC fallback is transaction-local here so the probe is deterministic on a
  -- project that has set it and on this one, which never did. Both states are exercised.
  perform set_config('app.safety_alert_url', '', true);
  perform set_config('app.safety_alert_secret', '', true);

  -- Today's live config, printed rather than asserted. If this is non-zero on apply, the
  -- control has found something real on the first run — most likely value.secret, which
  -- 20260806020000 deliberately left out of the seed to be set out of band.
  select count(*) into base_new from public.ctl_alert_not_dispatching();
  raise notice 'live config as it stands: % channel(s) cannot dispatch', base_new;

  -- Baseline the incumbent watcher rather than asserting it is empty: net._http_response
  -- carries whatever really happened in the last 25 hours, and the claim being tested is
  -- that DISARMING alerting adds nothing to it.
  select count(*) into base_old from public.ctl_alert_dispatch_failing();

  -- ── Shape 1: switched off, exactly the way /flags does it ────────────────
  update public.app_flags
     set enabled = false, updated_at = now()
   where key = 'controls_alert';

  select count(*) into after_old from public.ctl_alert_dispatch_failing();
  if after_old <> base_old then
    raise exception 'probe invalid: ctl_alert_dispatch_failing moved for an unrelated reason';
  end if;
  -- RAISE takes ONE string literal as its format, so these stay on one line however long
  -- they get: plpgsql reads the format as a single token and adjacent-literal
  -- concatenation, which the rest of this file leans on, is a syntax error here.
  raise notice 'OLD behaviour on this data: the pager is off and the incumbent control still returns % rows, the same % as before. That is the bug.', after_old, base_old;

  select detail into d from public.ctl_alert_not_dispatching()
   where entity_id = 'controls_alert';
  if d is null then
    raise exception 'FIX FAILED: controls_alert switched off and the new control is silent';
  end if;
  if not (d->'causes' @> '["switched_off"]'::jsonb) then
    raise exception 'FIX FAILED: the cause does not name the switch: %', d->'causes';
  end if;
  raise notice 'NEW behaviour on the same data: named, with causes %', d->'causes';

  -- ── The mute is bounded, and bounded only here ───────────────────────────
  select disabled_until into lifts from public.app_flags where key = 'controls_alert';
  if lifts is null or lifts <= now() or lifts > now() + interval '25 hours' then
    raise exception 'FIX FAILED: disable did not get a ~24h deadline (%)', lifts;
  end if;

  -- A live window is honoured. An expiring valve that fires early is just a broken switch.
  n := public.reenable_expired_alert_flags();
  select not enabled into still_off from public.app_flags where key = 'controls_alert';
  if n <> 0 or not still_off then
    raise exception 'FIX FAILED: the mute lifted before its window (% rows)', n;
  end if;

  update public.app_flags set disabled_until = now() - interval '1 minute'
   where key = 'controls_alert';
  n := public.reenable_expired_alert_flags();
  select enabled into ok from public.app_flags where key = 'controls_alert';
  if n <> 1 or not ok then
    raise exception 'FIX FAILED: a lapsed mute was not lifted (% rows, enabled=%)', n, ok;
  end if;
  raise notice 'a lapsed mute lifts itself — alerting cannot be off indefinitely by accident';

  -- The scope guard, which is the part that could do harm if it were wrong. A kill
  -- switch that un-kills itself 24 hours into a Stripe incident is the wrong-direction
  -- failure, so payments_enabled must get no deadline and must survive the sweeper even
  -- with an expired one forced onto it.
  update public.app_flags set enabled = false where key = 'payments_enabled';
  select disabled_until into lifts from public.app_flags where key = 'payments_enabled';
  if lifts is not null then
    raise exception 'FIX FAILED: payments_enabled was given an auto-expiry (%)', lifts;
  end if;
  update public.app_flags set disabled_until = now() - interval '1 day'
   where key = 'payments_enabled';
  perform public.reenable_expired_alert_flags();
  select not enabled into still_off from public.app_flags where key = 'payments_enabled';
  if not still_off then
    raise exception 'FIX FAILED: payments resumed on a timer — never do this';
  end if;
  raise notice 'payments_enabled: no deadline, and not lifted even when one is forced on';
  update public.app_flags set enabled = true, disabled_until = null
   where key = 'payments_enabled';

  -- ── Shape 2: a blank url, and the GUC fallback it must respect ───────────
  perform set_config('app.safety_alert_url', 'https://example.invalid/safety-alert', true);
  perform set_config('app.safety_alert_secret', 'probe-secret', true);
  update public.app_flags set value = (value - 'url') - 'secret' where key = 'safety_alert';
  if exists (select 1 from public.ctl_alert_not_dispatching() where entity_id = 'safety_alert') then
    raise exception 'FIX FAILED: reported a channel dark that still dispatches via the GUC';
  end if;
  raise notice 'blank value.url + a set GUC: silent, because notify_safety_report still posts';

  perform set_config('app.safety_alert_url', '', true);
  perform set_config('app.safety_alert_secret', '', true);
  select detail into d from public.ctl_alert_not_dispatching() where entity_id = 'safety_alert';
  if d is null then
    raise exception 'FIX FAILED: no url anywhere and the safety channel is not reported';
  end if;
  if not (d->'causes' @> '["blank_url", "blank_secret"]'::jsonb) then
    raise exception 'FIX FAILED: blank url and blank secret not both named: %', d->'causes';
  end if;

  -- ── Shape 3: the row is gone entirely ────────────────────────────────────
  delete from public.app_flags where key = 'safety_alert';
  select detail into d from public.ctl_alert_not_dispatching() where entity_id = 'safety_alert';
  if d is null or not (d->'causes' @> '["no_app_flags_row"]'::jsonb) then
    raise exception 'FIX FAILED: a deleted alerting row is not reported: %', d;
  end if;
  raise notice 'all four shapes reported: off, blank url, blank secret, row deleted';

  -- ── The finding actually records ─────────────────────────────────────────
  -- Break the other channel too, so the expected count is 2 whatever the live config
  -- happened to be — a probe whose assertion depends on production state proves nothing
  -- on the day production changes. safety_alert is now broken three ways at once (no
  -- row, no url, no secret), which is the arrangement that would trip run_control's
  -- on-conflict if the control emitted a row per cause instead of per channel.
  update public.app_flags set value = value - 'secret' where key = 'controls_alert';
  select count(*) into n from public.ctl_alert_not_dispatching() where entity_id = 'safety_alert';
  if n <> 1 then
    raise exception 'FIX FAILED: % rows for one channel — run_control will abort on the upsert', n;
  end if;
  n := public.run_control('alert_not_dispatching');
  if n <> 2 then
    raise exception 'FIX FAILED: run_control recorded % findings, expected one per channel', n;
  end if;
  raise notice 'run_control wrote % findings, one per channel', n;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'alerting-watch probe passed; every staged flag change rolled back';
  else
    raise;
  end if;
end $$;
