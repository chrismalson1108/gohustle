-- ─────────────────────────────────────────────────────────────────────────────
-- Move alert dispatch config out of GUCs and into app_flags (2026-08-06).
--
-- THE LIVE FAILURE THIS FIXES
--
-- trg_notify_safety_report has been on public.reports since 2026-07-10. The
-- safety-alert function is deployed, RESEND_API_KEY is set, SAFETY_ALERT_SECRET is
-- set. But notify_safety_report() opens with:
--
--     url := current_setting('app.safety_alert_url', true);
--     if url is null or url = '' then return new; end if;
--
-- and `app.safety_alert_url` was NEVER SET on this project — `select name from
-- pg_settings where name like 'app.%'` returns nothing, and the only per-database
-- setting is app.settings.jwt_exp. So every harassment or assault report since that
-- date has hit the early return and paged NOBODY. The queue was poll-only in
-- practice, which is the exact condition the migration was written to end.
--
-- The early return is right — a failed alert must never roll back a safety report.
-- The defect is the configuration channel. A GUC set by `alter database ... set` is
-- invisible (nothing surfaces "this is unset"), needs superuser (so it cannot be
-- applied by db push, which is why it never was), and cannot be managed from the
-- console. It fails silent by construction.
--
-- app_flags is already the runtime-config surface: service-role-only, edited from
-- /flags, audited. Config that lives in a table can be READ BACK and asserted on —
-- which means a control can now check "is alerting configured?" and page if not.
-- Monitoring that can verify its own transport is the whole point.
--
-- The shared secret sits in app_flags.value alongside the URL. That table has RLS on
-- with no policies and all grants revoked from anon and authenticated, so this is the
-- same protection the GUC had, minus the invisibility.
--
-- Backwards compatible: the GUC is still consulted as a fallback, so a project that
-- HAS set it keeps working unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

-- Config reader. Returns '{}' rather than null for an absent key so callers can use
-- ->> without a null guard on every access.
create or replace function public.alert_config(p_key text)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select value from public.app_flags where key = p_key), '{}'::jsonb);
$$;

revoke execute on function public.alert_config(text) from public, anon, authenticated;
grant  execute on function public.alert_config(text) to service_role;

-- Seed the row WITHOUT the secret. The secret is set out of band, never in a
-- migration — migrations are committed to git and a secret in git is a secret you
-- have to rotate. `enabled` here is a genuine kill switch: flip it off to stop
-- paging during a known-noisy incident without dropping the config.
insert into public.app_flags (key, enabled, value, note)
values (
  'safety_alert',
  true,
  jsonb_build_object('url', 'https://nfioebqsgmmzhbksxozc.functions.supabase.co/safety-alert'),
  'Dispatch config for trg_notify_safety_report. value.url + value.secret; secret is '
  'set out of band and must match the safety-alert function''s SAFETY_ALERT_SECRET. '
  'OFF = safety reports still save but do not page.'
)
on conflict (key) do update
  set value = public.app_flags.value || excluded.value,
      note  = excluded.note;

-- Rewritten dispatcher: app_flags first, GUC as fallback. Reproduced from
-- 20260710050000 with only the config lookup and the enabled check changed; the
-- never-roll-back-the-report behaviour is preserved exactly.
create or replace function public.notify_safety_report()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  cfg    jsonb := public.alert_config('safety_alert');
  on_    boolean := coalesce((select enabled from public.app_flags where key = 'safety_alert'), true);
  url    text := coalesce(nullif(cfg->>'url', ''), current_setting('app.safety_alert_url', true));
  secret text := coalesce(nullif(cfg->>'secret', ''), current_setting('app.safety_alert_secret', true), '');
begin
  if not on_ or url is null or url = '' then
    return new;
  end if;
  begin
    perform net.http_post(
      url     := url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-safety-secret', secret),
      body    := jsonb_build_object('report_id', new.id, 'record', to_jsonb(new))
    );
  exception when others then
    raise warning 'safety-alert dispatch failed for report %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke execute on function public.notify_safety_report() from public, anon, authenticated;

-- Same dispatch config shape for the control framework's own alerts.
insert into public.app_flags (key, enabled, value, note)
values (
  'controls_alert',
  true,
  jsonb_build_object('url', 'https://nfioebqsgmmzhbksxozc.functions.supabase.co/controls-alert'),
  'Dispatch config for the control sweep. value.url + value.secret. '
  'OFF = controls still run and record findings, but do not page.'
)
on conflict (key) do nothing;
