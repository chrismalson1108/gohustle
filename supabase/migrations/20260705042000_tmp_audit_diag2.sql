-- TEMPORARY diagnostic (corrected: payload is json, cast to jsonb). Dropped later.
create or replace function public.admin_debug_audit()
returns table (created_at timestamptz, ip_col text, payload jsonb)
language plpgsql
security definer
stable
set search_path = auth, public
as $$
begin
  return query
    select e.created_at, e.ip_address::text, e.payload::jsonb
    from auth.audit_log_entries e
    order by e.created_at desc
    limit 6;
end
$$;
revoke execute on function public.admin_debug_audit() from public, anon, authenticated;
grant execute on function public.admin_debug_audit() to service_role;
