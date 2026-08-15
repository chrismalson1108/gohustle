-- ─────────────────────────────────────────────────────────────────────────────
-- A control gated on a flag that no migration ever creates.
--
-- `ctl_stripe_id_mode_mismatch` (20260806350000) opens with
--
--     select coalesce((select value->>'mode' from public.app_flags
--                       where key = 'stripe_mode'), 'test') m
--
-- and every arm of it then requires `mode.m = 'live'`. Nothing anywhere inserts a
-- `stripe_mode` row — not this migration, not the seed at 20260804010000, nothing — so
-- the coalesce has always returned 'test' and every arm has always been false. The
-- control is registered, enabled, runs hourly, and is structurally incapable of
-- returning a row.
--
-- That is the exact failure this codebase keeps re-learning: a correct handler wired to
-- nothing, reporting success because nothing was delivered to fail. `run_all_controls`
-- records it as a clean run. The board shows green.
--
-- What it is supposed to catch is a live cutover with test-mode Stripe ids still in
-- `stripe_accounts` / `stripe_customers` — an id minted in one mode is meaningless in the
-- other, and the failure surfaces at the moment a poster tries to pay. That is precisely
-- the window where nobody wants to discover their detector was never armed.
--
-- Found by the 2026-08-12 payments audit, which sat unmerged on a branch for three days.
--
-- TWO CHANGES:
--  1. Create the flag, value 'test', which is the truth today (publishable key is
--     pk_test_…). Behaviour is unchanged — still zero findings — but the control is now
--     armed, and /flags can flip it at cutover.
--  2. Make ABSENCE loud. If the row is ever deleted the control now reports that it
--     cannot do its job, instead of silently returning nothing. A detector that has been
--     disarmed should look different from a system with no problems.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.app_flags (key, enabled, value, note)
values (
  'stripe_mode',
  true,
  '{"mode":"test"}'::jsonb,
  'Which Stripe mode the deployed keys belong to: {"mode":"test"} or {"mode":"live"}. '
  'Read by ctl_stripe_id_mode_mismatch, which is a NO-OP while this says test — that is '
  'correct, not broken. Flip it to live as part of the cutover, in the same change that '
  'swaps the keys, or the control keeps checking for the wrong thing.'
)
on conflict (key) do nothing;

create or replace function public.ctl_stripe_id_mode_mismatch()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with mode as (
    select (select value->>'mode' from public.app_flags where key = 'stripe_mode') m
  )
  -- The flag is missing entirely. Every arm below is mode-conditional, so without it this
  -- control silently returns nothing forever — which is how it spent its whole life until
  -- 2026-08-14. Report the disarming itself.
  select 'stripe_mode'::text as entity_id,
         jsonb_build_object(
           'kind', 'control_disarmed',
           'note', 'app_flags.stripe_mode is missing, so ctl_stripe_id_mode_mismatch '
                   'cannot evaluate and has been reporting a clean run. Restore it with '
                   '{"mode":"test"} or {"mode":"live"} to match the deployed keys.',
           'remedy', 'insert into public.app_flags (key, value) '
                     'values (''stripe_mode'', ''{"mode":"test"}''::jsonb)'
         ) as detail
    from mode where mode.m is null
  union all
  select a.user_id::text,
         jsonb_build_object(
           'kind', 'connected_account',
           'account_id', a.account_id,
           'declared_mode', (select m from mode),
           'note', 'a Stripe id stored under one mode is meaningless in the other — '
                   'the charge fails at the moment a poster tries to pay')
    from public.stripe_accounts a, mode
   where mode.m = 'live' and a.account_id like 'acct_1%' and length(a.account_id) < 22
  union all
  select c.user_id::text,
         jsonb_build_object('kind', 'customer', 'customer_id', c.customer_id,
                            'declared_mode', (select m from mode),
                            'note', 'stale customer id for the declared Stripe mode')
    from public.stripe_customers c, mode
   where mode.m = 'live' and c.customer_id like 'cus_%' and length(c.customer_id) < 18
$$;

revoke execute on function public.ctl_stripe_id_mode_mismatch() from public, anon, authenticated;

-- ── Prove all three states, rolled back ─────────────────────────────────────
do $$
declare
  n_test int; n_missing int; n_live int; saved jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select value into saved from public.app_flags where key = 'stripe_mode';
  if saved is null then
    raise exception 'FIX FAILED: the flag this migration creates is not there';
  end if;

  -- 1. Declared test (today's truth): silent, and correctly so.
  select count(*) into n_test from public.ctl_stripe_id_mode_mismatch();
  if n_test <> 0 then
    raise exception 'expected silence while mode=test, got % rows', n_test;
  end if;
  raise notice 'mode=test: silent, which is correct — not the same as unarmed';

  -- 2. Flag deleted: must now SAY so rather than return nothing.
  delete from public.app_flags where key = 'stripe_mode';
  select count(*) into n_missing from public.ctl_stripe_id_mode_mismatch()
   where entity_id = 'stripe_mode';
  if n_missing <> 1 then
    raise exception 'FIX FAILED: a missing flag still produces silence (% rows)', n_missing;
  end if;
  raise notice 'flag missing: control reports its own disarming — this is the whole fix';

  -- 3. Declared live with a test-shaped id present: the thing it was written for.
  insert into public.app_flags (key, enabled, value)
  values ('stripe_mode', true, '{"mode":"live"}'::jsonb);
  insert into public.stripe_accounts (user_id, account_id, onboarded)
  select id, 'acct_1ShortTest', false from public.profiles where deleted_at is null limit 1
  on conflict do nothing;

  select count(*) into n_live from public.ctl_stripe_id_mode_mismatch()
   where entity_id <> 'stripe_mode';
  if n_live < 1 then
    raise exception 'FIX FAILED: mode=live did not flag a test-shaped account id (% rows)', n_live;
  end if;
  raise notice 'mode=live: flags the test-shaped id it was written to catch (% rows)', n_live;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'stripe-mode probe passed; flag and staged rows rolled back';
  else
    raise;
  end if;
end $$;
