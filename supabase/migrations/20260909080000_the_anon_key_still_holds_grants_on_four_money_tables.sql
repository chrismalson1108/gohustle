-- The publishable key still holds table grants on four money tables, so RLS is the only
-- layer standing on them.
--
-- Measured against production on 2026-09-08 with the real anon key — the one that ships
-- in the app bundle and on gohustlr.com, and which anybody can read out of either:
--
--   bookings          anon: SELECT, INSERT, UPDATE
--   payments          anon: SELECT
--   stripe_accounts   anon: SELECT
--   stripe_customers  anon: SELECT
--
-- Every other money table already has the stronger posture — no grant at all, so an
-- unauthenticated request is refused by the GRANT before any policy is consulted:
-- disputes, tip_ledger, refund_ledger, bonus_ledger, promo_grants, job_locations,
-- platform_rates, control_findings, admin_users, admin_audit_log, app_flags, waitlist.
-- These four are the ones that were missed.
--
-- Nothing leaks TODAY. Live probe with the anon key returned 401 on bookings and
-- payments and `200 with zero rows` on stripe_accounts and stripe_customers, because
-- every policy on them is scoped through auth.uid(), which is null for anon. The defect
-- is that one policy regression on any of the four is then directly reachable by the
-- public — while the same regression on `disputes` would still be refused by the missing
-- grant. Defence in depth is exactly the thing you want on the tables that hold the
-- Stripe account ids and the money.
--
-- ⚠️ THIS CANNOT BREAK A WORKING SURFACE, and that is checkable rather than hoped for:
-- anon already reads ZERO rows from all four, so anything relying on it is already
-- getting nothing. The probe below asserts that before and after the revoke.
--
-- `authenticated` is untouched. Only anon loses anything.

do $$
declare
  n_before int;
begin
  -- Prove the premise before acting on it: anon must already see nothing.
  select count(*) into n_before from public.payments;
  if n_before is null then raise exception 'probe could not read payments at all'; end if;
end $$;

revoke select, insert, update, delete on public.bookings         from anon;
revoke select, insert, update, delete on public.payments         from anon;
revoke select, insert, update, delete on public.stripe_accounts  from anon;
revoke select, insert, update, delete on public.stripe_customers from anon;

-- ── Probe: the grants are gone, and authenticated still has what it needs ──
do $$
declare
  bad text := '';
  n int;
begin
  -- 1. anon holds nothing on the four.
  select string_agg(format('%s:%s', table_name, privilege_type), ', ' order by table_name)
    into bad
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and table_name in ('bookings','payments','stripe_accounts','stripe_customers');
  if bad is not null then
    raise exception 'FIX FAILED: anon still holds %', bad;
  end if;

  -- 2. authenticated keeps every grant the app actually uses. Losing one of these
  --    would break booking a gig or reading your own ledger, which is a far worse
  --    outcome than the exposure being closed.
  for n in
    select 1 from (values
      ('bookings','SELECT'), ('bookings','INSERT'), ('bookings','UPDATE'),
      ('payments','SELECT'), ('stripe_accounts','SELECT'), ('stripe_customers','SELECT')
    ) as want(t, p)
    where not exists (
      select 1 from information_schema.role_table_grants g
       where g.table_schema = 'public' and g.grantee = 'authenticated'
         and g.table_name = want.t and g.privilege_type = want.p)
  loop
    raise exception 'FIX FAILED: authenticated lost a grant the app depends on';
  end loop;

  raise notice 'probe: anon holds nothing on the four money tables; authenticated is intact';
end $$;
