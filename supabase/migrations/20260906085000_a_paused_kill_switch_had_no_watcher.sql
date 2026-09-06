-- ─────────────────────────────────────────────────────────────────────────────
-- A feature switched OFF costs nothing. Nobody is told, and nothing expires.
--
-- 20260806280000 made a disabled CONTROL a standing finding, on the argument that
-- switching detection off "must keep costing a line in the digest for as long as it
-- lasts, so switching detection off is a conscious and RECURRING decision rather than a
-- thing that happens once at 2am and is forgotten". 20260814100000 then gave the two
-- ALERT flags (safety_alert, controls_alert) both halves of that treatment: a mute with a
-- 24-hour deadline, and ctl_alert_not_dispatching to report the channel dark while it
-- lasts.
--
-- The product kill switches — payments_enabled, posting_enabled, signups_enabled,
-- tips_enabled, assistant_enabled, promotions_enabled — got NEITHER, and only half of
-- that was deliberate. 20260814100000:71-76 excludes them from auto-expiry on purpose,
-- and that decision is right: re-enabling a pager resumes telling you things, while
-- re-enabling payments resumes taking money 24 hours into a Stripe incident. That is not
-- a decision a timer gets to make. But the auto-expiry was the only half anyone scoped;
-- nobody wrote the watcher. No control in the registry reads a kill switch at all.
--
-- So a paused feature is visible on exactly one surface: a red pill on /flags, which
-- exists only for whoever happens to open that page. The hourly page, the daily digest,
-- /controls and the dashboard all read clean. An admin pauses payments at 23:00 during a
-- Stripe incident, Stripe recovers at 02:00, and every accept fails for the next two days
-- with "payments are temporarily paused" while the board says "No open findings. That is
-- the good outcome."
--
-- ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
--
-- A FINDING, never an auto-re-enable. The nag IS the mechanism: it costs a line in every
-- digest for as long as the pause lasts, and it resolves itself the moment the switch
-- goes back on. Nothing here ever writes `enabled`, and the probe asserts that.
--
-- SEVERITY IS MEDIUM, AND THAT IS THE POINT. controls-alert pages hourly on new
-- critical/high findings only; medium reaches the daily digest. Paging an operator within
-- the hour for a switch they deliberately flipped a minute ago is noise arriving at the
-- exact moment they can least act on it — and noise is what gets a control disabled. The
-- failure being caught is not the pause, it is the pause that outlives the incident,
-- which is a next-morning problem by construction.
--
-- ── WATCHED BY DEFAULT, EXCUSED BY EXCEPTION ────────────────────────────────
--
-- The obvious implementation is a hardcoded list of the six switches. That would
-- reproduce the very bug being fixed, one flag later: the seventh kill switch somebody
-- adds would be unwatched, silently, exactly as these six were. So the control watches
-- EVERY app_flags row that is off, and carries two narrow excusals:
--
--   · safety_alert / controls_alert — already reported, by name and by cause, by
--     ctl_alert_not_dispatching, which additionally knows about blank urls and missing
--     secrets. A second finding for the same condition is duplicate noise, not coverage.
--   · a row whose own value says `off_is_normal` — today that is exactly
--     bonus_cash_payout_enabled, which 20260806070000 seeds OFF deliberately (credits are
--     bounded by what the user would have paid us; cash is not) and which would otherwise
--     be a permanent finding from the moment this lands. The excuse lives IN THE ROW
--     rather than in this function's body, so it is visible on /flags to the person
--     standing in front of the switch, and so marking a new flag normally-off is a data
--     change rather than a migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The one flag whose OFF state is the intended state ────────────────────
-- Marked BEFORE the control is registered, so the first sweep after this migration cannot
-- open a finding against a decision made on purpose in 20260806070000.
update public.app_flags
   set value = value || jsonb_build_object('off_is_normal', true),
       note  = case
                 when coalesce(note, '') like '%off_is_normal%' then note
                 else coalesce(note, '') ||
                      ' Marked off_is_normal: this switch is MEANT to sit off, so '
                      'ctl_feature_flag_off does not report it. Remove that marker in the '
                      'same change that turns it on.'
               end
 where key = 'bonus_cash_payout_enabled';

-- ── 2. The watcher ───────────────────────────────────────────────────────────
create or replace function public.ctl_feature_flag_off()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select f.key,
         jsonb_build_object(
           'note', f.note,
           -- Two clocks, both reported, because they answer different questions and
           -- either can be the misleading one on its own. updated_at moves on ANY write
           -- to the row (a note edit, a value merge), so it understates how long the pause
           -- has run; the audit row is the act itself, but exists only for pauses made
           -- through the console and is absent for anything set by migration or by hand.
           -- Naming which one produced `hours_off` beats quietly picking one.
           'off_since', coalesce(a.created_at, f.updated_at),
           'off_since_source', case when a.created_at is not null then 'admin_audit_log'
                                    else 'app_flags.updated_at' end,
           'hours_off', round(extract(epoch from (now() - coalesce(a.created_at, f.updated_at)))
                              / 3600.0, 1),
           'paused_by', jsonb_build_object('admin_id', a.admin_id, 'at', a.created_at, 'ip', a.ip),
           'last_touched_by', f.updated_by,
           'what_is_off', 'the feature this switch gates is refusing every request, '
                          'platform-wide, for every user. That refusal is deliberate and '
                          'reversible — the point of this finding is that a pause taken '
                          'during an incident outlives the incident, and until now the '
                          'only surface that said so was a red pill on /flags.',
           'remedy', 'If the incident is over, turn it back on at /flags (admin tier, '
                     'step-up required). If the pause is meant to last, it still costs a '
                     'line in the digest every day, on purpose. A switch that is MEANT to '
                     'sit off permanently is marked in its own row instead: update '
                     'public.app_flags set value = value || ''{"off_is_normal":true}''::jsonb '
                     'where key = ''<key>'' — for a decision, never to quiet an incident.'
         )
    from public.app_flags f
    left join lateral (
      select l.admin_id, l.created_at, l.ip
        from public.admin_audit_log l
       where l.action = 'flag.disable' and l.target_id = f.key
       order by l.created_at desc
       limit 1
    ) a on true
   where not f.enabled
     -- Reported in full, with causes, by ctl_alert_not_dispatching.
     and f.key not in ('safety_alert', 'controls_alert')
     and not coalesce((f.value->>'off_is_normal')::boolean, false)
$$;

revoke execute on function public.ctl_feature_flag_off() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('feature_flag_off',
   'A feature is paused platform-wide, and has been for a while',
   'medium', 'lifecycle',
   'A kill switch left off after the incident that justified it is invisible: the daily '
   'digest, the hourly page, /controls and the dashboard all read clean while payments, '
   'posting or signups refuse every request. The only surface that said so was a red pill '
   'on /flags, which exists only for whoever opens that page. Same argument '
   'ctl_control_disabled makes for detection and 20260814100000 makes for the pagers — '
   'switching something off must keep costing a line in the digest, so it stays a '
   'conscious and recurring decision rather than one made once at 2am and forgotten. '
   'Deliberately a finding and never an auto-re-enable: a timer must not resume taking '
   'money. Deliberately medium: it reaches the daily digest rather than paging the '
   'operator an hour after they flipped the switch themselves. Watches every app_flags '
   'row that is off, not a list of the six that exist today, so the next kill switch is '
   'covered the moment it is added; a row that is MEANT to sit off carries '
   'value.off_is_normal.',
   'ctl_feature_flag_off')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Prove it discriminates, on staged rows, rolled back ─────────────────────
do $$
declare
  base int; d jsonb; n int; still_off boolean; hrs numeric;
begin
  -- Start from a known state for every key this probe touches, so nothing below depends
  -- on which flags happen to be off in production today. Rolled back with the rest.
  update public.app_flags set enabled = true
   where key in ('payments_enabled', 'posting_enabled', 'signups_enabled',
                 'tips_enabled', 'assistant_enabled', 'promotions_enabled');
  delete from public.app_flags where key = 'probe_unknown_switch_enabled';

  -- Everything genuinely paused right now. Every assertion below is a DELTA on this.
  select count(*) into base from public.ctl_feature_flag_off();

  -- ── The scenario in the header, exactly ──────────────────────────────────
  update public.app_flags
     set enabled = false, updated_at = now() - interval '38 hours'
   where key = 'payments_enabled';

  select detail into d from public.ctl_feature_flag_off() where entity_id = 'payments_enabled';
  if d is null then
    raise exception 'FIX FAILED: payments are paused platform-wide and the control is silent';
  end if;
  hrs := (d->>'hours_off')::numeric;
  if hrs < 37 or hrs > 39 then
    raise exception 'FIX FAILED: a 38-hour pause was reported as % hours off', hrs;
  end if;
  raise notice 'paused payments named after % hours (source %)', hrs, d->>'off_since_source';

  -- ── It reports, and never repairs ────────────────────────────────────────
  -- The wrong-direction failure. A control that un-paused payments on the platform's
  -- behalf would be far worse than the blindness it replaces.
  n := public.run_control('feature_flag_off');
  select not enabled into still_off from public.app_flags where key = 'payments_enabled';
  if not still_off then
    raise exception 'FIX FAILED: running the control turned payments back on — never do this';
  end if;
  if n <> base + 1 then
    raise exception 'FIX FAILED: run_control recorded % findings, expected %', n, base + 1;
  end if;
  if not exists (select 1 from public.control_findings
                  where control_key = 'feature_flag_off' and entity_id = 'payments_enabled'
                    and resolved_at is null) then
    raise exception 'FIX FAILED: the sweep did not write a finding for the paused switch';
  end if;
  raise notice 'the finding records, and the switch is untouched';

  -- ── One row per flag ─────────────────────────────────────────────────────
  -- run_control upserts on (control_key, entity_id); two rows for one key abort the whole
  -- sweep on the conflict, taking every other control down with it.
  select count(*) into n from public.ctl_feature_flag_off() where entity_id = 'payments_enabled';
  if n <> 1 then
    raise exception 'FIX FAILED: % rows for one flag — run_control aborts on the upsert', n;
  end if;

  -- ── Watched by DEFAULT, not by a list ────────────────────────────────────
  update public.app_flags set enabled = false
   where key in ('posting_enabled', 'signups_enabled', 'tips_enabled',
                 'assistant_enabled', 'promotions_enabled');
  select count(*) into n from public.ctl_feature_flag_off();
  if n <> base + 6 then
    raise exception 'FIX FAILED: six switches off, % reported', n - base;
  end if;

  -- A flag this migration has never heard of. If the control were a hardcoded list this
  -- is the assertion that would fail — and it is the exact shape of the bug being fixed.
  insert into public.app_flags (key, enabled, note)
  values ('probe_unknown_switch_enabled', false, 'staged by a rolled-back probe');
  if not exists (select 1 from public.ctl_feature_flag_off()
                  where entity_id = 'probe_unknown_switch_enabled') then
    raise exception 'FIX FAILED: a kill switch added later is unwatched — the original bug';
  end if;
  raise notice 'a flag nobody enumerated is watched the moment it is switched off';

  -- ── The two excusals, and only those two ─────────────────────────────────
  update public.app_flags set enabled = false where key in ('safety_alert', 'controls_alert');
  if exists (select 1 from public.ctl_feature_flag_off()
              where entity_id in ('safety_alert', 'controls_alert')) then
    raise exception 'FIX FAILED: alert channels double-reported alongside ctl_alert_not_dispatching';
  end if;

  if exists (select 1 from public.ctl_feature_flag_off()
              where entity_id = 'bonus_cash_payout_enabled') then
    raise exception 'FIX FAILED: a deliberately-off switch is a permanent finding';
  end if;
  -- ...and the marker on the row is the ONLY thing excusing it, not its name.
  update public.app_flags set value = value - 'off_is_normal', enabled = false
   where key = 'bonus_cash_payout_enabled';
  if not exists (select 1 from public.ctl_feature_flag_off()
                  where entity_id = 'bonus_cash_payout_enabled') then
    raise exception 'FIX FAILED: the excusal is by key, not by the marker on the row';
  end if;
  raise notice 'excused by the row it is written on, not by a name baked into the check';

  -- ── And it goes quiet the moment the pause ends ──────────────────────────
  update public.app_flags set enabled = true
   where key in ('payments_enabled', 'posting_enabled', 'signups_enabled', 'tips_enabled',
                 'assistant_enabled', 'promotions_enabled', 'probe_unknown_switch_enabled');
  if exists (select 1 from public.ctl_feature_flag_off()
              where entity_id in ('payments_enabled', 'posting_enabled', 'signups_enabled',
                                  'tips_enabled', 'assistant_enabled', 'promotions_enabled',
                                  'probe_unknown_switch_enabled')) then
    raise exception 'FIX FAILED: a switch turned back on still reads as paused';
  end if;
  raise notice 'restored switches report clean — the finding auto-resolves on the next sweep';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'kill-switch watch probe passed; every staged flag change rolled back';
  else
    raise;
  end if;
end $$;

-- ── The fix is present and WIRED, asserted against the live catalog ─────────
do $$
declare fn boolean; reg boolean;
begin
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'ctl_feature_flag_off')
    into fn;
  -- run_all_controls iterates the REGISTRY (`where enabled and not external`). A function
  -- nobody registered never runs and the board still shows green — the failure mode one
  -- level up from this one.
  select exists (select 1 from public.controls
                  where key = 'feature_flag_off' and fn_name = 'ctl_feature_flag_off'
                    and enabled and not external)
    into reg;
  if not fn then
    raise exception 'FIX FAILED: ctl_feature_flag_off was not created';
  end if;
  if not reg then
    raise exception 'FIX FAILED: the control is not registered, so the sweep never runs it';
  end if;
  if not coalesce((select (value->>'off_is_normal')::boolean from public.app_flags
                    where key = 'bonus_cash_payout_enabled'), false) then
    raise exception 'FIX FAILED: bonus_cash_payout_enabled unmarked — it is deliberately '
                    'off and would be a permanent finding from the first sweep';
  end if;
  raise notice 'ctl_feature_flag_off registered, in the sweep, and the one standing '
               'deliberate pause is excused';
end $$;
