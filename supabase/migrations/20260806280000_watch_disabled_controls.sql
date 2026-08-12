-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing watched for detection being switched off.
--
-- ctl_admin_login_bruteforce — a security control on the console that holds the
-- service-role key — was disabled at 02:26 on 2026-08-12 (admin_audit_log id 145,
-- during the adversarial audit window) and stayed off. Every sweep afterwards reported
-- "0 errored, 0 stale" and was telling the truth: a disabled control cannot error and
-- cannot go stale. It simply is not looking.
--
-- That is the blind spot. The whole control framework exists so problems announce
-- themselves, and the one state it could not see was its own eyes being closed.
--
-- Every disabled control is now a finding. Not an error — disabling one is legitimate,
-- and there are good reasons to do it during an incident — but it must keep costing a
-- line in the digest for as long as it lasts, so switching detection off is a conscious
-- and RECURRING decision rather than a thing that happens once at 2am and is forgotten.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_control_disabled()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select c.key,
         jsonb_build_object(
           'title', c.title,
           'severity_when_firing', c.severity,
           'domain', c.domain,
           'last_run_at', c.last_run_at,
           'disabled_by', (
             select jsonb_build_object('admin_id', a.admin_id, 'at', a.created_at, 'ip', a.ip)
               from public.admin_audit_log a
              where a.action = 'control.disable' and a.target_id = c.key
              order by a.created_at desc limit 1))
    from public.controls c
   where not c.enabled
$$;

revoke execute on function public.ctl_control_disabled() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('control_disabled',
   'A control is switched off — that area is no longer being watched',
   'high', 'security',
   'A disabled control reports neither errors nor staleness, so the sweep keeps saying '
   '"0 errored, 0 stale" while an entire class of problem goes unwatched. This is how '
   'ctl_admin_login_bruteforce sat off for hours after the audit without anyone '
   'noticing. Disabling a control is legitimate, but it should cost a line in the '
   'digest every day it lasts rather than being a decision made once and forgotten.',
   'ctl_control_disabled')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
