-- ─────────────────────────────────────────────────────────────────────────────
-- Watch the last mile of alerting (2026-08-06).
--
-- controls_sweep_and_page dispatches with `perform net.http_post(...)` inside a
-- begin/exception block. pg_net is ASYNCHRONOUS: http_post returns a request id
-- immediately, so that handler catches only a failure to ENQUEUE — never a non-2xx
-- response. Nothing read net._http_response.
--
-- This was not theoretical. net._http_response id=1 recorded 404 {"error":"not_found"}
-- at 00:27:56 (controls-alert was not yet deployed) and NOTHING anywhere noticed:
-- controls.last_error was null for every control, no finding existed, and /controls
-- rendered its green "all controls ran recently with no errors" banner. The alerting
-- system could not report its own alerting being down — which is precisely the failure
-- mode the whole framework was built to end.
--
-- So: a control that reads pg_net's own response log. It is deliberately the LAST link
-- in the chain that can still be checked from inside the database.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_alert_dispatch_failing()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public, net, extensions
as $$
  select r.id::text,
         jsonb_build_object(
           'status_code', r.status_code,
           'body', left(coalesce(r.content, ''), 200),
           'when', r.created,
           'note', 'an alert or reconciliation dispatch did not return 2xx — the '
                   'channel that tells you about problems is itself failing')
    from net._http_response r
   where r.created > now() - interval '25 hours'
     and (r.status_code is null or r.status_code < 200 or r.status_code >= 300)
$$;

revoke execute on function public.ctl_alert_dispatch_failing() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('alert_dispatch_failing',
   'An alert or reconciliation dispatch did not return 2xx',
   'high', 'security',
   'pg_net is asynchronous, so the sweep''s exception handler catches only a failure to '
   'ENQUEUE — a 404, a 403 from a rotated secret, or a function that stopped being '
   'deployed all return cleanly and vanish. This reads pg_net''s own response log. It '
   'already happened once: a 404 went entirely unrecorded while /controls showed all '
   'green.',
   'ctl_alert_dispatch_failing')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
