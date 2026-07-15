-- ─────────────────────────────────────────────────────────────────────────────
-- Lock down reports trust/resolution columns against client forgery (2026-07-15).
--
-- reports_insert_own only pins reporter_id, and no CHECK / trigger / column-scoped
-- INSERT grant protects the trust fields. So an authenticated user could PATCH/insert
-- reports rows with source='auto' (rendered as "🤖 Auto-moderation" in the admin queue
-- INSTEAD of the reporter link — hiding the fabricator and lending false system
-- authority that can drive an unjust ban) and could stamp resolved_at/resolved_by/
-- resolution (spoofing console-internal state). These fields are legitimately written
-- ONLY by service-role paths (the moderation edge functions and the console).
--
-- This adds a BEFORE INSERT/UPDATE trigger that, for any non-service-role write,
-- forces source back to 'user' and nulls the resolution fields. Mirrors the
-- guard_profiles_write / guard_prohibited_content denylist-guard pattern already used
-- across the repo. Service role bypasses (unchanged).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_reports_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role (moderation edge functions / admin console) may set source='auto'
  -- and the resolution fields; a normal authenticated client may not.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- Force system-attribution and resolution columns to their non-privileged values.
  new.source := 'user';

  if tg_op = 'INSERT' then
    new.resolved_at  := null;
    new.resolved_by  := null;
    new.resolution   := null;
  else
    -- On a client UPDATE, resolution state can never be advanced by the reporter.
    new.resolved_at  := old.resolved_at;
    new.resolved_by  := old.resolved_by;
    new.resolution   := old.resolution;
  end if;

  return new;
end;
$$;

-- Trigger functions must not be directly callable by clients.
revoke execute on function public.guard_reports_write() from public, anon, authenticated;

drop trigger if exists trg_guard_reports_write on public.reports;
create trigger trg_guard_reports_write
  before insert or update on public.reports
  for each row execute function public.guard_reports_write();
