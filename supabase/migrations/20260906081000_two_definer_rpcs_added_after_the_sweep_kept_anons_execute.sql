-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (LOW): the 2026-07-26 anon sweep was a one-time statement, so every
-- SECURITY DEFINER function written after it inherited anon's EXECUTE again — and
-- two of them were never revoked.
--
-- 20260726080000_revoke_anon_execute_definer_fns.sql established the rule this repo
-- has followed since: "No definer RPC in this app is meant to be callable without a
-- session", and it swept `revoke execute ... from anon` across every SECURITY DEFINER
-- function that existed AT THAT MOMENT. It is a sweep, not a change to the schema's
-- default privileges — stock Supabase keeps granting EXECUTE on each new function in
-- `public` to `anon` (and PUBLIC keeps Postgres's built-in EXECUTE default), so the
-- clock restarts for every function created afterwards. Nothing in `npm test` noticed,
-- because nothing was watching this invariant at all.
--
-- Replaying every create/drop/grant/revoke across supabase/schema.sql, the legacy
-- migration_*.sql files and all 240 tracked migrations in apply order — with a new
-- signature inheriting the default grant, `create or replace` of an existing signature
-- preserving the ACL it already had, and the 2026-07-26 sweep applied at its position —
-- leaves exactly two non-trigger SECURITY DEFINER functions that hold BOTH the anon
-- grant and PUBLIC's default, i.e. two that an unauthenticated caller holding the
-- embedded anon key can invoke over /rest/v1/rpc:
--
--   · public.resolve_category_slug(text)
--       20260805000000_dynamic_categories.sql:540 ends with only
--       `grant execute ... to authenticated`. Every non-trigger definer sibling in the
--       same file revokes (`notify_saved_searches` :800, `area_market_stats` :876) —
--       this one was missed. It runs as owner over `public.categories`, whose anon
--       SELECT that same migration revoked at :170, so it is the only anon-reachable
--       read of that table: slug resolution and merged_into chains, with no session.
--   · public.capped_override_bps(integer, integer, integer, integer)
--       20260814120000 added a fourth parameter (`p_baseline_bps integer default null`).
--       A new argument list is a NEW function in Postgres, not a replacement, so the
--       `revoke ... from public, anon` that 20260813050000:82 applied to the 3-arg form
--       did not carry over and the 4-arg form was created with fresh default grants.
--
-- The data either one leaks is trivial — a category slug, and an arithmetic function
-- over the public rate card. The defect is that the repo's stated anon-surface
-- invariant has been quietly false for a month and would have stayed false for the next
-- definer RPC written with the same (entirely natural) grant-only line.
--
-- Fix, in three parts:
--   1. Revoke both from `public, anon` — BOTH roles, because revoking anon alone leaves
--      Postgres's built-in PUBLIC EXECUTE in place and anon inherits through it. That is
--      the two-verb pattern every other definer function in this schema already carries
--      (20260702000000 for PUBLIC, 20260726080000 for anon).
--   2. Re-sweep the whole definer surface, so anything created between this file being
--      written and it being pushed is closed too. `view_gig_share(text)` is excluded by
--      name: its anon grant is deliberate (20260806200000:133) — a share link is opened
--      by a friend who has no account.
--   3. Assert the result against pg_proc rather than against the SQL above.
--
-- The permanent guard is __tests__/definerAnonExecute.test.js, which replays the same
-- privilege history off disk and fails on any definer function left anon-executable
-- outside that one allowlisted exception. A sweep fixes today; the test is what makes
-- tomorrow's function fail loudly instead of silently.
--
-- Idempotent. authenticated / service_role grants are untouched, so every signed-in
-- flow — the assistant's resolve_category_slug RPC, the console's Categories page,
-- consume_promo_grant's internal call — is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The two that drifted ──────────────────────────────────────────────────
revoke execute on function public.resolve_category_slug(text) from public, anon;
-- Restated, not new: the assistant calls this under the user's token and the console's
-- Categories page calls it with the service client. Neither may be collateral damage.
grant execute on function public.resolve_category_slug(text) to authenticated, service_role;

-- The 4-arg form is the one created without a revoke; the 3-arg form it overloads is
-- already closed (20260813050000:82) and re-revoking it is a no-op. Both are written as
-- plain statements rather than hidden inside an `execute` string, because the guard test
-- reads these revokes off disk and a quoted one is invisible to it.
revoke execute on function public.capped_override_bps(integer, integer, integer, integer) from public, anon;
revoke execute on function public.capped_override_bps(integer, integer, integer) from public, anon;

-- ── 2. Re-sweep, so the gap cannot be reopened by anything already in flight ──
-- Same shape as the 2026-07-26 sweep, with two differences: PUBLIC is revoked as well
-- as anon (revoking anon alone is the incomplete verb this file exists to correct), and
-- the one deliberate exception is excluded by name instead of being re-granted after.
do $$
declare
  r record;
  skipped text;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       -- `is distinct from` and not `<>`: if view_gig_share is absent, to_regprocedure
       -- returns null and `<>` would be null for every row, sweeping nothing at all.
       and p.oid is distinct from to_regprocedure('public.view_gig_share(text)')
       -- Only what this role can actually revoke. An extension function in `public`
       -- owned by another role would abort the whole push on "must be owner of
       -- function" — the 2026-07-26 sweep over this same set found none, but a
       -- migration that cannot apply fixes nothing.
       and pg_has_role(current_user, p.proowner, 'usage')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into skipped
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and not pg_has_role(current_user, p.proowner, 'usage');
  if skipped is not null then
    raise notice 'not swept (owned by another role, revoke them as that role): %', skipped;
  end if;
end $$;

-- ── 3. Assert the effect, against the catalog ────────────────────────────────
do $$
declare
  leaked text;
  n      int;
begin
  if to_regprocedure('public.resolve_category_slug(text)') is null then
    raise exception 'resolve_category_slug(text) is missing — this migration is asserting against nothing';
  end if;

  if has_function_privilege('anon', 'public.resolve_category_slug(text)', 'execute') then
    raise exception 'FIX FAILED: anon can still EXECUTE resolve_category_slug(text)';
  end if;
  raise notice 'resolve_category_slug(text) no longer answers to the anon key';

  if to_regprocedure('public.capped_override_bps(integer, integer, integer, integer)') is not null
     and has_function_privilege('anon', 'public.capped_override_bps(integer, integer, integer, integer)', 'execute') then
    raise exception 'FIX FAILED: anon can still EXECUTE the 4-arg capped_override_bps';
  end if;
  raise notice 'the 4-arg capped_override_bps no longer answers to the anon key';

  -- The half of the fix that is easy to get wrong: the callers that SHOULD still work.
  if not has_function_privilege('authenticated', 'public.resolve_category_slug(text)', 'execute') then
    raise exception 'authenticated lost EXECUTE on resolve_category_slug(text) — the assistant and both category pickers would 42501';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_category_slug(text)', 'execute') then
    raise exception 'service_role lost EXECUTE on resolve_category_slug(text) — the console Categories page merges through it';
  end if;
  raise notice 'authenticated and service_role keep EXECUTE, so no signed-in flow changed';

  -- The deliberate exception must survive the sweep, or every already-sent safety
  -- share link 42501s for the friend holding it.
  if to_regprocedure('public.view_gig_share(text)') is not null
     and not has_function_privilege('anon', 'public.view_gig_share(text)', 'execute') then
    raise exception 'the sweep took view_gig_share(text) with it — outstanding gig share links would stop resolving';
  end if;
  raise notice 'view_gig_share(text) is still anon-callable, which is the one intended exception';

  -- Nothing else on the whole definer surface answers without a session.
  select count(*),
         string_agg(sig, ', ' order by sig)
    into n, leaked
    from (
      select p.oid::regprocedure::text as sig
        from pg_proc p
        join pg_namespace n2 on n2.oid = p.pronamespace
       where n2.nspname = 'public'
         and p.prosecdef
         and p.oid is distinct from to_regprocedure('public.view_gig_share(text)')
         -- Same restriction as the sweep: anything this role cannot revoke was
         -- reported above as a notice rather than silently failing the assertion.
         and pg_has_role(current_user, p.proowner, 'usage')
         and has_function_privilege('anon', p.oid, 'execute')
    ) s;
  if n > 0 then
    raise exception 'FIX INCOMPLETE: % SECURITY DEFINER function(s) still executable by anon: %', n, leaked;
  end if;
  raise notice 'no SECURITY DEFINER function in public is anon-executable except view_gig_share';
end $$;

-- ── Prove the sweep discriminates, then roll it back ─────────────────────────
-- Stage a function in exactly the state the two above were in — created with the stock
-- default grants and no revoke — and show that (a) it starts anon-executable, which is
-- the defect, and (b) the sweep this migration runs closes it.
do $$
declare
  before_sweep boolean;
  after_sweep  boolean;
  r record;
begin
  execute $probe$
    create function public.zz_anon_sweep_probe() returns int
    language sql stable security definer set search_path = public as 'select 1'
  $probe$;
  -- Reproduce the Supabase default that is the whole mechanism here: a brand new
  -- function in `public` arrives with EXECUTE granted to anon (and to PUBLIC).
  execute 'grant execute on function public.zz_anon_sweep_probe() to anon';

  before_sweep := has_function_privilege('anon', 'public.zz_anon_sweep_probe()', 'execute');
  if not before_sweep then
    raise exception 'probe could not reproduce the defect — the assertion below would prove nothing';
  end if;
  raise notice 'a definer function created with the stock grants IS anon-executable — that is the finding';

  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.proname = 'zz_anon_sweep_probe'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;

  after_sweep := has_function_privilege('anon', 'public.zz_anon_sweep_probe()', 'execute');
  if after_sweep then
    raise exception 'FIX FAILED: the sweep left the probe anon-executable';
  end if;
  raise notice 'discriminates: anon-executable before the sweep, 42501 after';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'anon-sweep probe passed; the staged function is rolled back';
  else
    raise;
  end if;
end $$;

-- Verify post-deploy — must return 42501 with the anon key and 200 with a user token:
--   curl -X POST "$SUPABASE_URL/rest/v1/rpc/resolve_category_slug" \
--     -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
--     -d '{"input":"lawn care"}'
