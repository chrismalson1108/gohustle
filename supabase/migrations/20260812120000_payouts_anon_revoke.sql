-- The default grant struck immediately. stripe_payouts came out of 20260812110000
-- with SELECT held by `anon` — I granted only `authenticated`, and Postgres/Supabase
-- default privileges supplied the rest.
--
-- RLS denies it today (the only policy is `to authenticated`), so nothing leaks. But
-- this is precisely the drift 20260812100000... sorry, 20260812040000 spent 131
-- revokes removing, and re-introducing it on a table of bank-payout amounts one
-- migration later would be the clearest possible demonstration of why grant/RLS
-- parity has to be asserted rather than remembered.
revoke all on public.stripe_payouts from anon;

do $$
declare bad text;
begin
  select string_agg(privilege_type, ',') into bad
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'stripe_payouts' and grantee = 'anon';
  if bad is not null then
    raise exception 'anon still holds % on stripe_payouts', bad;
  end if;
  if not has_table_privilege('authenticated', 'public.stripe_payouts', 'SELECT') then
    raise exception 'authenticated lost SELECT on stripe_payouts';
  end if;
  raise notice 'stripe_payouts grants match policy: authenticated SELECT only';
end $$;
