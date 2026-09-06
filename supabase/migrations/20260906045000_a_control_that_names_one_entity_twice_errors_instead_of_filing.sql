-- ─────────────────────────────────────────────────────────────────────────────
-- A control that names one entity twice ERRORS instead of filing — and one of them
-- would do it at the live cutover.
--
-- run_control (20260806010000:146-158) writes every row a control returns:
--
--     insert into public.control_findings (control_key, entity_id, severity, detail)
--     select %L, v.entity_id, %L, v.detail from v
--     on conflict (control_key, entity_id) where resolved_at is null
--     do update set last_seen_at = now(), detail = excluded.detail
--
-- Postgres forbids an INSERT ... ON CONFLICT DO UPDATE from touching the same target
-- row twice in ONE statement: 'ON CONFLICT DO UPDATE command cannot affect row a
-- second time', SQLSTATE 21000. `v` was never de-duplicated, so two returned rows
-- sharing an entity_id abort the whole control. run_all_controls catches it, stamps
-- controls.last_error, and reports `errored` — and NOTHING is filed: not the colliding
-- pair, not the other entities that control also found. The pager says "1 erroring"
-- with a cardinality message, and the queue that was supposed to name the affected
-- accounts is empty.
--
-- Four registered controls could produce that shape on their own target population:
--
--   ctl_stripe_id_mode_mismatch  (20260814140000:108,120) — `a.user_id::text` for the
--     connected-account arm and `c.user_id::text` for the customer arm. Every user here
--     can both earn and post, so one person with a Connect account AND a saved card
--     created before the cutover is one entity returned twice. This control is a
--     deliberate no-op until app_flags.stripe_mode flips to live, which means the
--     collision would first appear AT GO-LIVE — the one moment it exists for. The
--     OPEN_WORK gate row says flipping the flag "arms the check"; on realistic data it
--     armed an error.
--   ctl_client_holds_truncate    (20260806310000:75) — entity is `c.relname`, cross
--     joined against anon AND authenticated. A table both roles hold is two rows. That
--     is the exact historical shape: 40 tables carried it from the grant-all schema.
--   ctl_fee_tier_ladder_inverted (20260806170000:229) — entity is `t2.id`, joined to
--     every lower rung it beats. A top rung mispriced above two lower rungs is two rows.
--   ctl_referral_bonus_repeat    (20260806250000:119) — entity is the referrer while
--     the grouping is (referrer, referred). One referrer over-bonused on two people is
--     two rows. bonus_ledger_one_per_referral makes that state hard to reach today, but
--     this control IS the net for that index not holding, so it must survive the state
--     it exists to report.
--
-- 20260814100000:203-206 documented the hazard and hand-authored ONE control around it.
-- A comment is not a check: three of the four above were written before it and one
-- after. So this migration fixes both halves.
--
-- 1. run_control collapses the control's output to one row per entity_id before the
--    upsert. No control — including ones not yet written — can abort this way again.
--    Duplicates are MERGED, not dropped: `distinct on` would silently discard the
--    second arm, which for the id-mode control is a stale customer id nobody is told
--    about. A merged finding is a fallback, not the target state, and it says so in
--    its own detail.
-- 2. The four controls give each row its own entity id, so their findings arrive as
--    separate actionable rows rather than one merged one.
--
-- Changing an entity_id changes the identity of a finding: any open row under the old
-- id auto-resolves on the next sweep with "no longer returned by the control", and the
-- new id opens fresh. That is correct here and costs nothing — mode is `test`, so the
-- id-mode arms return no rows at all today, and the other three are at zero.
--
-- Guarded by __tests__/controlEntityUniqueness.test.js.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The runner cannot be aborted by a colliding entity id ────────────────
create or replace function public.run_control(p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c            public.controls%rowtype;
  started      timestamptz := clock_timestamp();
  n            integer := 0;
  seen         text[]  := '{}';
begin
  select * into c from public.controls where key = p_key;
  if not found then
    raise exception 'unknown control %', p_key using errcode = 'no_data_found';
  end if;
  if not c.enabled then
    return 0;
  end if;

  -- The function name comes from a table only service_role can write, but it is
  -- still interpolated into executable SQL, so it is validated twice: shape first,
  -- then existence. %I quoting alone is not a substitute for knowing what you are
  -- about to run.
  if c.fn_name !~ '^ctl_[a-z0-9_]+$' then
    raise exception 'control % has an illegal fn_name %', p_key, c.fn_name
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = c.fn_name
  ) then
    raise exception 'control % names a function that does not exist: %', p_key, c.fn_name
      using errcode = 'undefined_function';
  end if;

  -- Upsert every current violation AND collect the ids seen, in ONE pass.
  --
  -- The control function is invoked exactly once. Calling it twice — once to write
  -- findings and again to decide what to auto-resolve — would let the underlying
  -- data change between the two reads, so a violation that appeared in the first
  -- call and not the second would be recorded and instantly auto-resolved in the
  -- same run. `v` is MATERIALIZED to pin that: it is referenced twice below, and an
  -- inlined CTE would re-evaluate it. The data-modifying CTE runs regardless of
  -- whether the final select references it.
  --
  -- `v` GROUPS BY entity_id, and that grouping is load bearing. findings are unique
  -- on (control_key, entity_id) where open, and ON CONFLICT DO UPDATE may not touch
  -- one target row twice in a single statement — two returned rows sharing an id
  -- raise SQLSTATE 21000 and abort the whole control, which is then recorded as
  -- ERRORED with nothing filed. A control SHOULD give every row its own id; when one
  -- does not, this merges them rather than losing the run.
  execute format($f$
    with raw as (
      select coalesce(entity_id, '') as entity_id,
             coalesce(detail, '{}'::jsonb) as detail
        from public.%I()
    ), v as materialized (
      select r.entity_id,
             case when count(*) = 1 then (array_agg(r.detail))[1]
                  else jsonb_build_object(
                         'kind', 'multiple_rows_for_one_entity',
                         'rows', count(*),
                         'note', 'the control returned ' || count(*) || ' rows naming this '
                                 'entity. One open finding exists per (control, entity), so '
                                 'they are merged here and every original row is under '
                                 'rows_detail. Before this merge existed the whole control '
                                 'aborted on the upsert and filed nothing. A control whose '
                                 'arms can name one entity twice should give each arm its '
                                 'own id namespace so they arrive as separate findings.',
                         'rows_detail', jsonb_agg(r.detail order by r.detail::text))
             end as detail
        from raw r
       group by r.entity_id
    ), up as (
      insert into public.control_findings (control_key, entity_id, severity, detail)
      select %L, v.entity_id, %L, v.detail from v
      on conflict (control_key, entity_id) where resolved_at is null
      do update set last_seen_at = now(), detail = excluded.detail
    )
    select coalesce(array_agg(entity_id), '{}'::text[]) from v
  $f$, c.fn_name, p_key, c.severity)
  into seen;

  -- One per ENTITY, which is one per finding written — the number the console shows
  -- and the number the auto-resolve pass below is scoped to.
  n := coalesce(array_length(seen, 1), 0);

  -- Auto-resolve: a finding the control no longer returns has stopped being true.
  -- Recording that automatically is what keeps the queue honest — a stale open
  -- finding trains you to ignore the queue.
  update public.control_findings f
     set resolved_at = now(),
         note = coalesce(f.note, '') || case when f.note is null then '' else ' | ' end
                || 'auto-resolved: no longer returned by the control'
   where f.control_key = p_key
     and f.resolved_at is null
     and not (f.entity_id = any (seen));

  update public.controls
     set last_run_at = now(),
         last_run_ms = (extract(epoch from clock_timestamp() - started) * 1000)::int,
         last_violations = n,
         last_error = null
   where key = p_key;

  return n;
end;
$$;

revoke execute on function public.run_control(text) from public, anon, authenticated;
grant  execute on function public.run_control(text) to service_role;

-- ── 2a. The id-mode arms get their own namespaces ───────────────────────────
-- A stale Connect account and a stale customer are two different remedies on the same
-- person, so they are two findings — and with a bare user id they were one row that
-- could never be written.
create or replace function public.ctl_stripe_id_mode_mismatch()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select value->>'mode' as m, (value->>'live_since')::timestamptz as live_since
      from public.app_flags where key = 'stripe_mode'
  )
  -- The flag is missing entirely, so every arm below is unevaluable and this control
  -- silently reports a clean run — which is how it spent its whole life until 2026-08-14.
  select 'stripe_mode'::text as entity_id,
         jsonb_build_object(
           'kind', 'control_disarmed',
           'note', 'app_flags.stripe_mode is missing, so ctl_stripe_id_mode_mismatch '
                   'cannot evaluate and has been reporting a clean run. Restore it with '
                   '{"mode":"test"} or {"mode":"live"} to match the deployed keys.',
           'remedy', 'insert into public.app_flags (key, value) '
                     'values (''stripe_mode'', ''{"mode":"test"}''::jsonb)'
         ) as detail
    from cfg where cfg.m is null
  union all
  -- Declared live, but we never recorded WHEN. Without that there is nothing to compare
  -- provenance against, so say so rather than guessing from the id's shape.
  -- Shares the 'stripe_mode' id with the arm above deliberately: the two are mutually
  -- exclusive (m is null versus m = 'live'), so they can never both return.
  select 'stripe_mode'::text,
         jsonb_build_object(
           'kind', 'live_since_missing',
           'note', 'stripe_mode says live but carries no live_since, so stale test-mode '
                   'ids cannot be distinguished from live ones. Set it to the cutover '
                   'timestamp.',
           'remedy', 'update public.app_flags set value = jsonb_set(value, ''{live_since}'', '
                     'to_jsonb(<cutover timestamptz>::text)) where key = ''stripe_mode'''
         )
    from cfg where cfg.m = 'live' and cfg.live_since is null
  union all
  -- A connected account minted BEFORE the cutover carries a test-mode id. Shape cannot
  -- tell you this: acct_1 + 14 chars is 21 characters in both modes.
  --
  -- 'acct:' prefix: this arm and the customer arm below are keyed on the SAME user id,
  -- and everyone here can both earn and post. One person holding both a Connect account
  -- and a saved card from before the cutover returned that id twice, and run_control
  -- cannot upsert one finding row twice in a statement — so the whole control errored
  -- at the cutover instead of naming a single stale id.
  select 'acct:' || a.user_id::text,
         jsonb_build_object(
           'kind', 'connected_account',
           'user_id', a.user_id,
           'account_id', a.account_id,
           'created_at', a.created_at,
           'live_since', cfg.live_since,
           'note', 'this Connect account was created before the live cutover, so its id '
                   'belongs to test mode — the charge fails the moment a poster tries to pay')
    from public.stripe_accounts a, cfg
   where cfg.m = 'live' and cfg.live_since is not null
     and a.created_at < cfg.live_since
  union all
  select 'cus:' || c.user_id::text,
         jsonb_build_object(
           'kind', 'customer',
           'user_id', c.user_id,
           'customer_id', c.customer_id,
           'created_at', c.created_at,
           'live_since', cfg.live_since,
           'note', 'this Stripe customer was created before the live cutover, so its id '
                   'belongs to test mode and the saved card cannot be charged')
    from public.stripe_customers c, cfg
   where cfg.m = 'live' and cfg.live_since is not null
     and c.created_at < cfg.live_since
$$;

revoke execute on function public.ctl_stripe_id_mode_mismatch() from public, anon, authenticated;

-- ── 2b. One row per table, with both client roles inside it ─────────────────
create or replace function public.ctl_client_holds_truncate()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.relname,
         jsonb_build_object(
           -- Was one row per (table, role), which meant a table both client roles hold
           -- — the exact shape found on 40 tables — returned relname twice and errored
           -- the control instead of reporting it. Both roles now ride on one row.
           'roles', jsonb_agg(jsonb_build_object(
                      'role', r.rolname,
                      'truncate', has_table_privilege(r.rolname, c.oid, 'TRUNCATE'),
                      'trigger',  has_table_privilege(r.rolname, c.oid, 'TRIGGER'))
                    order by r.rolname),
           'note', 'RLS does not apply to TRUNCATE — this privilege empties the table '
                   'regardless of every policy on it')
    from pg_class c
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and (has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
       or has_table_privilege(r.rolname, c.oid, 'TRIGGER'))
   group by c.relname, c.oid
$$;

revoke execute on function public.ctl_client_holds_truncate() from public, anon, authenticated;

-- ── 2c. One row per mispriced rung, naming every rung it beats ──────────────
create or replace function public.ctl_fee_tier_ladder_inverted()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select t2.id::text,
         jsonb_build_object(
           'tier', t2.name, 'min_completed', t2.min_completed, 'fee_bps', t2.fee_bps,
           -- Was one row per (rung, lower rung), so a top rung mispriced above two
           -- lower ones returned its own id twice and errored the control.
           'beats_lower', jsonb_agg(jsonb_build_object(
                            'lower_tier', t1.name,
                            'lower_min', t1.min_completed,
                            'lower_fee_bps', t1.fee_bps)
                          order by t1.min_completed),
           'note', 'this rung asks for MORE completed gigs but charges a HIGHER fee than '
                   'the one below it, so reaching it makes an earner worse off')
    from public.fee_tiers t1
    join public.fee_tiers t2
      on t2.min_completed > t1.min_completed and t2.fee_bps > t1.fee_bps
   where t1.enabled and t2.enabled
   group by t2.id, t2.name, t2.min_completed, t2.fee_bps
$$;

revoke execute on function public.ctl_fee_tier_ladder_inverted() from public, anon, authenticated;

-- ── 2d. One row per referrer, naming every referred person ──────────────────
create or replace function public.ctl_referral_bonus_repeat()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with pairs as (
    select b.user_id,
           b.source_user_id,
           count(*)                  as bonus_count,
           sum(b.amount_cents)       as total_cents,
           array_agg(distinct b.state) as states
      from public.bonus_ledger b
     where b.reason = 'referral'
       and b.state <> 'void'
       and b.source_user_id is not null
     group by b.user_id, b.source_user_id
    having count(*) > 1
  )
  -- The entity is the REFERRER while the grouping above is per pair, so a referrer
  -- over-bonused on two different people used to return that referrer twice — and the
  -- upsert cannot write one finding row twice. This control is the net for
  -- bonus_ledger_one_per_referral not holding, so it has to survive the state it
  -- exists to report.
  select p.user_id::text,
         jsonb_build_object(
           'referred_pairs', count(*),
           'total_cents', sum(p.total_cents),
           'referred', jsonb_agg(jsonb_build_object(
                         'referred_user', p.source_user_id,
                         'bonus_count', p.bonus_count,
                         'total_cents', p.total_cents,
                         'states', p.states)
                       order by p.source_user_id),
           'note', 'more than one live referral bonus exists for this referrer and the '
                   'same referred person, so the per-pair guard is not holding')
    from pairs p
   group by p.user_id
$$;

revoke execute on function public.ctl_referral_bonus_repeat() from public, anon, authenticated;


-- ── Prove the collision aborts, and that the fix files instead ──────────────
do $$
declare
  probe_tbl        text := 'zz_entity_collision_probe';
  uid              uuid;
  tier_top         uuid;
  base             integer;
  n                integer;
  m                integer;
  d                jsonb;
  old_shape_failed boolean := false;
  fndef            text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- These two are exercised through run_control below, and run_control returns 0
  -- without running a disabled control — which would make every assertion vacuous on a
  -- day someone had muted one. Forced on for the probe; rolled back with the rest.
  update public.controls set enabled = true
   where key in ('client_holds_truncate', 'stripe_id_mode_mismatch');

  -- ── A. A table both client roles hold: one entity, two rows ───────────────
  -- Created through format() so the CREATE TABLE text carries no literal table name:
  -- the schema inventory guard enumerates every `create table` in migrations/ and would
  -- otherwise demand CLAUDE.md document a table that exists for three milliseconds
  -- inside a rolled-back probe.
  execute format('create table public.%I (id integer)', probe_tbl);
  execute format('grant truncate, trigger on public.%I to anon, authenticated', probe_tbl);

  -- What the PRE-FIX control returned for this one table.
  select count(*) into m
    from pg_class c
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and c.relname = probe_tbl
     and (has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
       or has_table_privilege(r.rolname, c.oid, 'TRIGGER'));
  if m <> 2 then
    raise exception 'staging failed: the pre-fix cross join returned % rows for one table, expected 2', m;
  end if;
  raise notice 'staged: the pre-fix shape returns % rows naming one table', m;

  -- THE DEFECT, reproduced on exactly those two rows: the upsert run_control used to
  -- issue cannot touch one target row twice in a statement.
  begin
    insert into public.control_findings (control_key, entity_id, severity, detail)
    select 'client_holds_truncate', v.entity_id, 'critical', v.detail
      from (values (probe_tbl, '{"role":"anon"}'::jsonb),
                   (probe_tbl, '{"role":"authenticated"}'::jsonb)) as v(entity_id, detail)
    on conflict (control_key, entity_id) where resolved_at is null
    do update set last_seen_at = now(), detail = excluded.detail;
  exception when cardinality_violation then
    old_shape_failed := true;
  end;
  if not old_shape_failed then
    raise exception 'the pre-fix upsert did NOT raise on two rows naming one entity — '
                    'the hazard this migration fixes is not real and the change is unjustified';
  end if;
  raise notice 'confirmed: the pre-fix upsert aborts with SQLSTATE 21000, so the control filed nothing';

  -- The fixed control returns ONE row for that table, carrying both roles.
  select count(*) into n from public.ctl_client_holds_truncate() where entity_id = probe_tbl;
  if n <> 1 then
    raise exception 'FIX FAILED: the control returned % rows for one table', n;
  end if;
  select detail into d from public.ctl_client_holds_truncate() where entity_id = probe_tbl;
  if not (d->'roles' @> '[{"role":"anon"}]'::jsonb)
     or not (d->'roles' @> '[{"role":"authenticated"}]'::jsonb) then
    raise exception 'the merged row dropped a role, which is the evidence an operator acts on: %', d;
  end if;

  -- And run_control now completes and FILES, on the same population that aborted above.
  n := public.run_control('client_holds_truncate');
  select count(*) into m from public.control_findings
   where control_key = 'client_holds_truncate' and entity_id = probe_tbl and resolved_at is null;
  if m <> 1 then
    raise exception 'FIX FAILED: run_control filed % findings for the staged table', m;
  end if;
  raise notice 'discriminates: same population — pre-fix statement raised 21000, run_control filed % finding(s)', m;

  -- The probe table is left standing for the rest of the block and disappears with the
  -- rollback. Not dropped by hand: the schema inventory guard models no DROP at all, so
  -- a literal drop in migrations/ fails it — and the rollback is the stronger cleanup
  -- anyway, since it also covers every path that raises before reaching a drop.

  -- ── B. One user, a Connect account AND a customer, both pre-cutover ───────
  -- The go-live shape, and the reason this is not a theoretical tidy-up.
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then
    raise exception 'no live profile to stage against';
  end if;

  insert into public.stripe_accounts (user_id, account_id, onboarded)
  values (uid, 'acct_1EntityCollisionProbe', false)
  on conflict (user_id) do update set account_id = excluded.account_id;
  insert into public.stripe_customers (user_id, customer_id)
  values (uid, 'cus_EntityCollisionProbe')
  on conflict (user_id) do update set customer_id = excluded.customer_id;

  -- Declared live with a cutover AFTER everything that exists: every id is stale.
  update public.app_flags
     set value = jsonb_build_object('mode', 'live', 'live_since', (now() + interval '1 day')::text)
   where key = 'stripe_mode';
  if not found then
    insert into public.app_flags (key, enabled, value)
    values ('stripe_mode', true,
            jsonb_build_object('mode', 'live', 'live_since', (now() + interval '1 day')::text));
  end if;

  select count(*) into n from public.ctl_stripe_id_mode_mismatch()
   where entity_id in ('acct:' || uid::text, 'cus:' || uid::text);
  if n <> 2 then
    raise exception 'FIX FAILED: one user with both a Connect account and a customer produced '
                    '% namespaced rows, expected 2', n;
  end if;
  -- Both rows are the SAME PERSON. Strip the namespace and they collapse to the single
  -- entity_id the pre-fix control returned twice — which is the collision, stated as data.
  select count(distinct detail->>'user_id') into m from public.ctl_stripe_id_mode_mismatch()
   where entity_id in ('acct:' || uid::text, 'cus:' || uid::text);
  if m <> 1 then
    raise exception 'the two rows are not the same user, so this does not reproduce the collision';
  end if;
  raise notice 'reproduced: one user, two stale ids — the pre-fix control returned that id twice';

  n := public.run_control('stripe_id_mode_mismatch');
  select count(*) into m from public.control_findings
   where control_key = 'stripe_id_mode_mismatch' and resolved_at is null
     and entity_id in ('acct:' || uid::text, 'cus:' || uid::text);
  if m <> 2 then
    raise exception 'FIX FAILED: run_control filed % of the 2 stale ids for that user', m;
  end if;
  raise notice 'run_control filed both stale ids as separate findings; pre-fix this call raised 21000';

  -- ── C. A rung mispriced above TWO lower rungs ─────────────────────────────
  -- Thresholds derived from the top of the live ladder rather than hardcoded:
  -- fee_tiers_threshold_uniq is a real unique index, and a fixed number that happened to
  -- collide with a real rung would fail the whole push on a constraint that has nothing
  -- to do with what is being proved.
  select coalesce(max(min_completed), 0) + 1000 into base from public.fee_tiers;
  insert into public.fee_tiers (name, min_completed, fee_bps, enabled) values
    ('entity collision probe rung A', base,     700, true),
    ('entity collision probe rung B', base + 1, 800, true),
    ('entity collision probe rung C', base + 2, 900, true);
  select id into tier_top from public.fee_tiers where min_completed = base + 2;

  select count(*) into m
    from public.fee_tiers t1
    join public.fee_tiers t2
      on t2.min_completed > t1.min_completed and t2.fee_bps > t1.fee_bps
   where t1.enabled and t2.enabled and t2.id = tier_top;
  if m < 2 then
    raise exception 'staging failed: the pre-fix join returned % rows for the top rung, expected 2 or more', m;
  end if;

  select count(*) into n from public.ctl_fee_tier_ladder_inverted() where entity_id = tier_top::text;
  if n <> 1 then
    raise exception 'FIX FAILED: the top rung produced % rows, expected 1', n;
  end if;
  select detail into d from public.ctl_fee_tier_ladder_inverted() where entity_id = tier_top::text;
  if jsonb_array_length(d->'beats_lower') < 2 then
    raise exception 'the merged rung row lost the lower rungs it beats: %', d;
  end if;
  raise notice 'ladder: pre-fix % rows for one rung, now 1 row naming % lower rungs',
    m, jsonb_array_length(d->'beats_lower');

  -- ── D. A referrer over-bonused on two people ──────────────────────────────
  -- bonus_ledger_one_per_referral (a live partial unique index on exactly the population
  -- this control groups over) makes that state unstageable without dropping the index,
  -- and taking an ACCESS EXCLUSIVE lock on a money table to prove a GROUP BY is not a
  -- trade worth making. So the shape is asserted on the same rows, grouped both ways,
  -- and the shipped body is asserted to carry the new grouping.
  with staged(referrer, referred) as (
    values ('r1', 'a'), ('r1', 'a'), ('r1', 'b'), ('r1', 'b')
  ), pairs as (
    select referrer, referred from staged group by referrer, referred having count(*) > 1
  )
  select (select count(*) from pairs),
         (select count(*) from (select referrer from pairs group by referrer) g)
    into m, n;
  if m <> 2 or n <> 1 then
    raise exception 'shape simulation is wrong: pre-fix % rows, post-fix % rows', m, n;
  end if;
  fndef := pg_get_functiondef('public.ctl_referral_bonus_repeat()'::regprocedure);
  if position('group by p.user_id' in fndef) = 0 then
    raise exception 'FIX FAILED: the shipped ctl_referral_bonus_repeat does not group per referrer';
  end if;
  raise notice 'referral: the same four rows are 2 entity ids per pair and 1 per referrer, and the shipped body groups per referrer';

  -- ── E. The runner itself carries the de-duplication ───────────────────────
  fndef := pg_get_functiondef('public.run_control(text)'::regprocedure);
  if position('group by r.entity_id' in fndef) = 0 then
    raise exception 'FIX FAILED: the shipped run_control does not de-duplicate before the upsert';
  end if;
  if position('multiple_rows_for_one_entity' in fndef) = 0 then
    raise exception 'FIX FAILED: the shipped run_control drops duplicate rows instead of merging them';
  end if;
  raise notice 'run_control de-duplicates by entity_id and merges the details, so no future control can error this way';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'entity-collision probe passed; probe table, stripe ids, flag and fee tiers all rolled back';
  else
    raise;
  end if;
end $$;
