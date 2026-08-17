-- ─────────────────────────────────────────────────────────────────────────────
-- One date is not enough to answer the question the Activate dialog asks.
--
-- 20260817000000 moved /team off the stale cache and onto auth.mfa_factors, which was
-- the right source. It reports max(created_at) — one timestamp — and within an hour that
-- proved too thin to act on: a pending admin's row read "authenticator enrolled
-- Aug 17, 6:02 PM" three days after he was added, and nothing on the screen could say
-- whether that was a SECOND factor appearing beside an older one or the only one there
-- has ever been. Those two have opposite meanings.
--
--   one factor, dated when they were invited      → they enrolled and forgot where
--   one factor, dated long after                  → something happened that day
--   TWO factors                                   → somebody enrolled beside them
--
-- max() is still the right headline — the newest factor is the one nobody has vouched
-- for — but it hides exactly the case that matters most.
--
-- ── WHY THE NAME MATTERS TOO ────────────────────────────────────────────────
-- The friendly name records WHERE a factor was enrolled, and the two surfaces disagree
-- on purpose: src/lib/mfa.js:96 enrols as 'GoHustlr' (app and web), admin/app/mfa/page.tsx
-- as 'GoHustlr Admin' (console). So the name distinguishes "set up in the app" from "set
-- up on the console" without anyone having to open the Supabase dashboard — and that
-- difference is also why the two cannot collide on gotrue's per-user friendly-name
-- uniqueness, which is what let the console's old fall-through enrol a second factor
-- beside an existing one at all.
--
-- Return type changes, so the old signature must be DROPPED rather than replaced —
-- create or replace cannot change a function's output columns.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.admin_team_list();

create or replace function public.admin_team_list()
returns table (
  user_id          uuid,
  email            text,
  name             text,
  role             text,
  status           text,
  mfa_enrolled_at  timestamptz,
  mfa_factor_count integer,
  mfa_factors      jsonb,
  created_at       timestamptz,
  disabled_at      timestamptz,
  note             text
)
language sql
security definer
stable
set search_path = public
as $$
  select a.user_id, u.email::text, p.name, a.role, a.status,
         -- The headline stays the NEWEST factor: it is the one nobody has confirmed.
         f.enrolled_at,
         coalesce(f.n, 0),
         -- Every verified factor, oldest first, so a second one appearing beside an
         -- original is visible as a second one rather than as a moved date.
         coalesce(f.list, '[]'::jsonb),
         a.created_at, a.disabled_at, a.note
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
    left join lateral (
      select max(mf.created_at) as enrolled_at,
             count(*)::int      as n,
             jsonb_agg(
               jsonb_build_object('name', mf.friendly_name, 'created_at', mf.created_at)
               order by mf.created_at
             ) as list
        from auth.mfa_factors mf
       where mf.user_id = a.user_id
         and mf.status = 'verified'
    ) f on true
   order by (a.status = 'active') desc, a.created_at
$$;

revoke execute on function public.admin_team_list() from public, anon, authenticated;
grant execute on function public.admin_team_list() to service_role;


-- ── Prove a second factor is visible AS a second factor ─────────────────────
do $$
declare
  uid uuid;
  has_secret boolean;
  n int; lst jsonb; reported timestamptz;
  t_old timestamptz := now() - interval '30 days';
  t_new timestamptz := now() - interval '2 hours';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select u.id into uid
    from auth.users u
    join public.profiles p on p.id = u.id and p.deleted_at is null
   where not exists (select 1 from public.admin_users a where a.user_id = u.id)
     and not exists (
       select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')
   limit 1;
  if uid is null then
    raise exception 'no unenrolled non-admin account to stage against';
  end if;

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'mfa_factors' and column_name = 'secret'
  ) into has_secret;

  insert into public.admin_users (user_id, role, status) values (uid, 'support', 'pending');

  -- No factors: an empty ARRAY, not null, so the page can map over it unguarded.
  select t.mfa_factor_count, t.mfa_factors into n, lst
    from public.admin_team_list() t where t.user_id = uid;
  if n <> 0 or lst <> '[]'::jsonb then
    raise exception 'baseline wrong: count % list %', n, lst;
  end if;

  -- One factor enrolled the way the APP enrols one.
  if has_secret then
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr', 'totp', 'verified', 'PROBEONLYNOTASECRET', t_old, t_old);
  else
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr', 'totp', 'verified', t_old, t_old);
  end if;

  select t.mfa_factor_count, t.mfa_factors, t.mfa_enrolled_at into n, lst, reported
    from public.admin_team_list() t where t.user_id = uid;
  if n <> 1 then raise exception 'one factor reported as %', n; end if;
  if lst->0->>'name' <> 'GoHustlr' then
    raise exception 'the app factor was not named: %', lst;
  end if;
  raise notice 'one factor, named % and dated — the surface it was enrolled on is now readable', lst->0->>'name';

  -- A SECOND factor, enrolled the way the CONSOLE enrols one. This is the state the old
  -- single-timestamp version could not distinguish from the line above: both render as
  -- one date, and only the date moves.
  if has_secret then
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr Admin', 'totp', 'verified', 'PROBEONLYNOTASECRET2', t_new, t_new);
  else
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), uid, 'GoHustlr Admin', 'totp', 'verified', t_new, t_new);
  end if;

  select t.mfa_factor_count, t.mfa_factors, t.mfa_enrolled_at into n, lst, reported
    from public.admin_team_list() t where t.user_id = uid;

  if n <> 2 then
    raise exception 'FIX FAILED: two factors reported as %', n;
  end if;
  if jsonb_array_length(lst) <> 2 then
    raise exception 'FIX FAILED: the list carries % entries, not 2', jsonb_array_length(lst);
  end if;
  -- Oldest first, so the original is identifiable as the original.
  if lst->0->>'name' <> 'GoHustlr' or lst->1->>'name' <> 'GoHustlr Admin' then
    raise exception 'factors are not oldest-first: %', lst;
  end if;
  -- And the headline still points at the one nobody has vouched for.
  if reported <> t_new then
    raise exception 'the headline moved off the newest factor: % vs %', reported, t_new;
  end if;
  raise notice 'discriminates: the old single timestamp showed only %, which is identical to the one-factor case; the count now says 2 and names both', reported;

  -- Unverified factors stay out of all three figures, or an abandoned half-enrolment
  -- would read as somebody enrolling beside them.
  update auth.mfa_factors set status = 'unverified' where user_id = uid and friendly_name = 'GoHustlr Admin';
  select t.mfa_factor_count into n from public.admin_team_list() t where t.user_id = uid;
  if n <> 1 then
    raise exception 'an unverified factor was counted (count %)', n;
  end if;
  raise notice 'unverified factors are excluded from the count as well as the date';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'team-page factor-detail probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
