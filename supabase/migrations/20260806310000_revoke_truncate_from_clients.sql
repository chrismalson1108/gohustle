-- ─────────────────────────────────────────────────────────────────────────────
-- anon and authenticated held TRUNCATE on 40 tables. RLS does not apply to TRUNCATE.
--
-- Found while checking an audit claim that a user could flood control_findings. That
-- claim was FALSE — control_findings has no client grants at all — but the query used
-- to disprove it showed something worse on the older tables:
--
--   payments, bookings, profiles, reports, reviews, messages, disputes, stripe_accounts,
--   legal_acceptances, tip_ledger, … 40 in total
--
-- all carried TRUNCATE and TRIGGER for BOTH anon and authenticated. Row Level Security
-- is a row-level mechanism; TRUNCATE is a table-level command and is not filtered by it
-- at all. A single TRUNCATE would empty a table outright regardless of every policy on
-- it. TRIGGER is worse in kind — it lets the grantee attach triggers to a table they do
-- not own.
--
-- These came from the original hand-applied schema.sql, which used the
-- `grant all on all tables in schema public to anon, authenticated` pattern. Every table
-- created since by a tracked migration is clean, because those grant explicitly (and
-- `grant all` only ever to service_role) — which is why the newer control, promotion and
-- pricing tables were unaffected.
--
-- ── HOW BAD, HONESTLY ───────────────────────────────────────────────────────
--
-- Not remotely exploitable today. PostgREST has no TRUNCATE verb, so there is no way to
-- reach it with an anon key over the normal API, and no SECURITY DEFINER function in
-- this database issues one (the single `truncate` match in pg_proc is a comment about
-- string truncation in normalize_job_category).
--
-- It is a defence-in-depth failure, not a live breach: it means the platform is one
-- direct database connection, one pooler misconfiguration, or one SQL injection in any
-- SECURITY DEFINER function away from a client role wiping payments and bookings. The
-- privilege buys the application exactly nothing — no client code path has ever needed
-- TRUNCATE, TRIGGER or REFERENCES — so there is no trade-off in removing it.
--
-- SELECT / INSERT / UPDATE / DELETE are deliberately LEFT ALONE. Those are what the app
-- actually uses and what RLS actually gates; revoking them would break the product.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t record;
  n integer := 0;
begin
  for t in
    select c.oid::regclass as tbl
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'r'
       and (has_table_privilege('authenticated', c.oid, 'TRUNCATE')
         or has_table_privilege('anon',          c.oid, 'TRUNCATE')
         or has_table_privilege('authenticated', c.oid, 'TRIGGER')
         or has_table_privilege('anon',          c.oid, 'TRIGGER'))
  loop
    execute format('revoke truncate, trigger, references on %s from anon, authenticated', t.tbl);
    n := n + 1;
  end loop;
  raise notice 'revoked truncate/trigger/references on % tables', n;
end $$;

-- Stop it coming back on anything created later. Default privileges apply per granting
-- role, so this covers objects created by postgres — which is what migrations run as.
alter default privileges in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- ── Control ─────────────────────────────────────────────────────────────────
-- A privilege that RLS cannot moderate should never come back unnoticed.
create or replace function public.ctl_client_holds_truncate()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.relname,
         jsonb_build_object(
           'role', r.rolname,
           'truncate', has_table_privilege(r.rolname, c.oid, 'TRUNCATE'),
           'trigger',  has_table_privilege(r.rolname, c.oid, 'TRIGGER'),
           'note', 'RLS does not apply to TRUNCATE — this privilege empties the table '
                   'regardless of every policy on it')
    from pg_class c
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and (has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
       or has_table_privilege(r.rolname, c.oid, 'TRIGGER'))
$$;

revoke execute on function public.ctl_client_holds_truncate() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('client_holds_truncate',
   'A client role holds TRUNCATE or TRIGGER on a public table',
   'critical', 'security',
   'Row Level Security is a row-level mechanism and does not apply to TRUNCATE, so this '
   'privilege empties a table regardless of every policy protecting it; TRIGGER lets the '
   'grantee attach triggers to a table they do not own. No client code path needs '
   'either. Both were held by anon and authenticated on 40 tables — including payments, '
   'bookings and profiles — inherited from the original grant-all schema.',
   'ctl_client_holds_truncate')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
