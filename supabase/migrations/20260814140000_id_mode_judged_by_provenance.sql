-- ─────────────────────────────────────────────────────────────────────────────
-- The id-mode control judged SHAPE, and the shape is identical in both modes.
--
-- 20260814080000 fixed half of this control — the flag it reads was never created, so it
-- could not fire at all. The other half was carried forward unchanged, and it is wrong in
-- both directions:
--
--   account arm:  a.account_id like 'acct_1%' and length(a.account_id) < 22
--   customer arm: c.customer_id like 'cus_%'  and length(c.customer_id) < 18
--
-- A Stripe account id is `acct_1` + 14 characters = 21, in BOTH modes. The mode lives in
-- the API KEY (sk_test_ / sk_live_), never in the object id. This project's own test
-- account acct_1ThvnME0UZFlVCOp is 21 characters and a live one has the identical shape.
-- So `length < 22` matches EVERY account ever created — and `< 18` matches NO customer,
-- since a customer id is `cus_` + 14 = 18 exactly.
--
-- One arm flags everything, the other flags nothing. At cutover the first would bury a
-- real finding in a row per connected account, which is the same "permanent noise" failure
-- as the discount control fixed earlier today. I reported that arm's 8 hits as real signal
-- when I applied 20260814080000; it was the predicate matching every row.
--
-- ── JUDGE PROVENANCE, NOT SHAPE ─────────────────────────────────────────────
-- An id is stale iff it was minted BEFORE the platform switched to live keys. So stamp
-- when that happened and compare against it. `live_since` is set the first time the flag
-- is written as live and never moved afterwards, so a later edit of the flag cannot
-- silently re-date every account.
--
-- Found by the 2026-08-12 payments audit, reproduced 2026-08-14.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.trg_stripe_mode_stamps_live_since()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key <> 'stripe_mode' then return new; end if;
  if coalesce(new.value->>'mode', '') = 'live' then
    -- Precedence: an EXPLICIT live_since on this write wins, then the existing stamp,
    -- then now(). All three matter.
    --
    -- Explicit-wins is not optional: the control's own remedy tells an operator to set
    -- the cutover timestamp by hand when it is missing, so a trigger that discarded it
    -- would make that instruction impossible to follow. (It did, in the first draft, and
    -- the probe caught it by being unable to move the date.)
    --
    -- Existing-next is what stops the accident: a plain `set value = '{"mode":"live"}'`,
    -- which is what the console toggle writes, preserves the original cutover instead of
    -- re-dating every account to today and silently emptying the control.
    new.value := jsonb_set(
      new.value,
      '{live_since}',
      to_jsonb(coalesce(
        new.value->>'live_since',
        case when tg_op = 'UPDATE' then old.value->>'live_since' end,
        now()::text)),
      true);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_z_stripe_mode_live_since on public.app_flags;
create trigger trg_z_stripe_mode_live_since
  before insert or update on public.app_flags
  for each row execute function public.trg_stripe_mode_stamps_live_since();

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
  select a.user_id::text,
         jsonb_build_object(
           'kind', 'connected_account',
           'account_id', a.account_id,
           'created_at', a.created_at,
           'live_since', cfg.live_since,
           'note', 'this Connect account was created before the live cutover, so its id '
                   'belongs to test mode — the charge fails the moment a poster tries to pay')
    from public.stripe_accounts a, cfg
   where cfg.m = 'live' and cfg.live_since is not null
     and a.created_at < cfg.live_since
  union all
  select c.user_id::text,
         jsonb_build_object(
           'kind', 'customer',
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

-- ── Prove all four states ───────────────────────────────────────────────────
do $$
declare
  n_test int; n_no_since int; n_stale int; n_fresh int; n_old_shape int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1. Declared test: silent.
  select count(*) into n_test from public.ctl_stripe_id_mode_mismatch();
  if n_test <> 0 then
    raise exception 'expected silence while mode=test, got % rows', n_test;
  end if;
  raise notice 'mode=test: silent';

  -- 2. Declared live with NO live_since. The trigger now guarantees the stamp, so this
  -- state is unreachable through it — which is the point. The arm survives as a net for a
  -- row written before the trigger existed, or one edited around it. Reaching it therefore
  -- means turning the trigger off, which is exactly how it could occur in practice.
  alter table public.app_flags disable trigger trg_z_stripe_mode_live_since;
  update public.app_flags set value = '{"mode":"live"}'::jsonb where key = 'stripe_mode';
  select count(*) into n_no_since from public.ctl_stripe_id_mode_mismatch()
   where detail->>'kind' = 'live_since_missing';
  alter table public.app_flags enable trigger trg_z_stripe_mode_live_since;

  -- And with the trigger ON, the same write cannot produce that state at all.
  update public.app_flags set value = '{"mode":"live"}'::jsonb where key = 'stripe_mode';
  if exists (select 1 from public.ctl_stripe_id_mode_mismatch()
              where detail->>'kind' = 'live_since_missing') then
    raise exception 'the trigger did not stamp live_since on a plain live write';
  end if;
  raise notice 'the trigger guarantees a cutover stamp; the missing-stamp arm is a net, not a normal path';

  -- 3. Declared live with a cutover AFTER every existing account: all of them are stale.
  update public.app_flags
     set value = jsonb_build_object('mode', 'live', 'live_since', (now() + interval '1 day')::text)
   where key = 'stripe_mode';
  select count(*) into n_stale from public.ctl_stripe_id_mode_mismatch()
   where detail->>'kind' in ('connected_account', 'customer');

  -- 4. Declared live with a cutover BEFORE every existing account: none are stale.
  update public.app_flags
     set value = jsonb_build_object('mode', 'live', 'live_since', (now() - interval '10 years')::text)
   where key = 'stripe_mode';
  select count(*) into n_fresh from public.ctl_stripe_id_mode_mismatch()
   where detail->>'kind' in ('connected_account', 'customer');

  -- What the OLD length predicate did: acct_1 + 14 = 21 chars, so `< 22` matched EVERY
  -- account regardless of mode or age.
  select count(*) into n_old_shape from public.stripe_accounts a
   where a.account_id like 'acct_1%' and length(a.account_id) < 22;

  if n_stale <= n_fresh then
    raise exception 'FIX FAILED: provenance makes no difference (stale % vs fresh %)', n_stale, n_fresh;
  end if;
  if n_fresh <> 0 then
    raise exception 'FALSE POSITIVE: accounts created AFTER the cutover were flagged (% rows)', n_fresh;
  end if;
  raise notice 'provenance discriminates: % stale before the cutover, % after', n_stale, n_fresh;
  raise notice 'the OLD shape predicate matched % accounts — every one of them, in either mode', n_old_shape;

  if n_no_since <> 1 then
    raise exception 'live with no live_since should report exactly one row, got %', n_no_since;
  end if;
  raise notice 'live with no cutover stamp reports its own ambiguity rather than guessing';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'id-mode provenance probe passed; flag restored by rollback';
  else
    raise;
  end if;
end $$;
