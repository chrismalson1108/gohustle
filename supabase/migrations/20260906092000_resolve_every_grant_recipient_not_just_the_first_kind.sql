-- ─────────────────────────────────────────────────────────────────────────────
-- The pricing console's direct-grant box resolves recipients by username OR by
-- email, never both — and there was no batch email lookup for it to use.
--
-- admin/app/(console)/pricing/actions.ts:114 matched the whole pasted list against
-- profiles.username first, and only fell back to auth emails `if (!ids.length)`. One
-- username in a list of ten therefore suppressed the email lookup for the other nine:
-- the RPC granted to one user and the console reported
-- "Granted to 1 of 10. Anyone already holding it was skipped." — attributing nine
-- people who were never looked up to a skip that never happened. The field is labelled
-- "Emails or usernames", so the mixed list is the intended input, not a misuse.
--
-- The fallback it did have was worse than one-shot: a single
-- `auth.admin.listUsers({ perPage: 1000 })` page, which silently stops resolving anyone
-- past the first thousand accounts. Growing past 1000 users would have turned this into
-- the same wrong message with no code change.
--
-- admin_find_user_id(text) (20260804030000) is the right lookup and the wrong shape: it
-- returns a scalar, so resolving 500 entries is 500 round trips and — worse — a miss is
-- indistinguishable from a shorter answer. The console needs to NAME the entries that
-- matched nothing, which means one row per input.
--
-- So: a batch sibling with identical matching semantics (lower(trim(...)) against
-- auth.users.email) that returns a row for EVERY input, id null when nothing matched.
-- Same lockdown as its sibling — this is a membership oracle over auth.users, so
-- service_role only, and the assertion below fails if that ever loosens.
--
-- No probe stages rows here: nothing in this repo's migrations writes auth.users, and
-- an assertion that had to invent an account to prove itself would be the more dangerous
-- of the two. The read-only probe below proves the property the console actually depends
-- on — one row per entry, misses included — against whatever accounts exist, and proves
-- the batch agrees with the scalar sibling it is replacing. The console-side
-- discrimination (mixed list, old algorithm vs new) is proven in
-- __tests__/grantRecipientResolution.test.js.
--
-- Found by the 2026-09-05 audit (admin-console#11).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_find_user_ids(p_emails text[])
returns table (lookup_email text, user_id uuid)
language sql
security definer
stable
set search_path = public
as $$
  select e.addr, hit.id
    from unnest(coalesce(p_emails, array[]::text[])) as e(addr)
    left join lateral (
      select u.id
        from auth.users u
       where lower(u.email) = lower(trim(e.addr))
       order by u.created_at
       limit 1
    ) hit on true
$$;

comment on function public.admin_find_user_ids(text[]) is
  'Batch sibling of admin_find_user_id. One row per input, user_id null when nothing '
  'matched, so a caller can name the entries that resolved to nobody. service_role only.';

revoke execute on function public.admin_find_user_ids(text[]) from public, anon, authenticated;
grant execute on function public.admin_find_user_ids(text[]) to service_role;


do $$
declare
  known_email text;
  known_id    uuid;
  absent_a    text := 'no-such-account-a@resolve-probe.invalid';
  absent_b    text := 'no-such-account-b@resolve-probe.invalid';
  n           integer;
  got         uuid;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'admin_find_user_ids'
  ) then
    raise exception 'FIX ABSENT: admin_find_user_ids was not created';
  end if;

  -- A lookup that answers "does this email have an account?" is an enumeration oracle.
  -- Its sibling is service_role only and so is this.
  if has_function_privilege('authenticated', 'public.admin_find_user_ids(text[])', 'execute')
     or has_function_privilege('anon', 'public.admin_find_user_ids(text[])', 'execute') then
    raise exception 'FIX WRONG: admin_find_user_ids is executable by app clients — that is an account-existence oracle';
  end if;
  raise notice 'admin_find_user_ids exists and is reachable only by service_role';

  -- THE PROPERTY THE CONSOLE DEPENDS ON: one row per entry, misses included. The scalar
  -- sibling cannot express this — a miss just shortens the answer, which is exactly how
  -- nine unlooked-up people got reported as "already holding it".
  select count(*) into n from public.admin_find_user_ids(array[absent_a, absent_b]);
  if n <> 2 then
    raise exception 'FIX FAILED: two unmatched entries returned % rows, so the caller cannot name them', n;
  end if;
  select count(*) into n
    from public.admin_find_user_ids(array[absent_a, absent_b]) where user_id is not null;
  if n <> 0 then
    raise exception 'FIX WRONG: invented an account for an address nobody holds (% rows)', n;
  end if;
  raise notice 'two misses return two rows with null ids, so unmatched entries are nameable';

  -- Pick a subject whose lower(email) is unique, so "batch agrees with scalar" below is a
  -- real assertion rather than a race between two `limit 1`s over the same duplicate set.
  select u.email, u.id into known_email, known_id
    from auth.users u
   where u.email is not null
     and (select count(*) from auth.users u2 where lower(u2.email) = lower(u.email)) = 1
   order by u.created_at
   limit 1;

  if known_email is null then
    raise notice 'no unambiguous account exists here, so the positive half of the probe is skipped';
  else
    -- Matching semantics must be the sibling's, case and whitespace included, or the
    -- console would resolve a different set than /team does.
    select f.user_id into got
      from public.admin_find_user_ids(array['  ' || upper(known_email) || ' ']) f;
    if got is distinct from known_id then
      raise exception 'FIX FAILED: batch lookup did not match its own account case-insensitively (% vs %)', got, known_id;
    end if;
    if got is distinct from public.admin_find_user_id(known_email) then
      raise exception 'FIX FAILED: batch and scalar lookups disagree, so /pricing and /team would resolve different people';
    end if;
    raise notice 'batch agrees with admin_find_user_id, trimming and case-folding the same way';

    -- The mixed case is the whole finding: a list that contains a hit AND a miss must
    -- still resolve the hit, and must still report the miss.
    select count(*) into n
      from public.admin_find_user_ids(array[absent_a, known_email, absent_b])
     where user_id is not null;
    if n <> 1 then
      raise exception 'FIX FAILED: a mixed list resolved % accounts, expected exactly 1', n;
    end if;
    select count(*) into n from public.admin_find_user_ids(array[absent_a, known_email, absent_b]);
    if n <> 3 then
      raise exception 'FIX FAILED: a mixed list returned % rows, expected one per entry', n;
    end if;
    raise notice 'a mixed hit/miss list resolves the hit and still reports both misses';
  end if;

  raise notice 'admin_find_user_ids probe passed';
end $$;
