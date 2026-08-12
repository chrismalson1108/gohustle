-- ─────────────────────────────────────────────────────────────────────────────
-- ctl_admin_without_mfa: read the authoritative source, and backfill (2026-08-06).
--
-- The control shipped in 20260806090000 tested admin_users.mfa_enrolled_at, which is a
-- DENORMALIZED COPY written by mark_admin_mfa_enrolled (20260804030000). The founder's
-- account enrolled TOTP before that write path existed, so the column is null while
-- auth.mfa_factors shows a verified factor — and the control fired on an account that
-- is, in fact, protected.
--
-- That is the worst kind of control: a permanent false positive. It cannot be resolved
-- by fixing anything, so it sits in the queue teaching whoever reads it that the queue
-- lies. One of those is enough to make people stop reading, which costs more than the
-- control was ever worth.
--
-- Fixed by asking auth.mfa_factors — what requireAdmin's AAL2 check actually depends
-- on — instead of a cache of it. And the cache is backfilled so the console's own
-- display is right too.
-- ─────────────────────────────────────────────────────────────────────────────

update public.admin_users a
   set mfa_enrolled_at = coalesce(a.mfa_enrolled_at, f.created_at, now()),
       mfa_factor_id   = coalesce(a.mfa_factor_id, f.id::text)
  from auth.mfa_factors f
 where f.user_id = a.user_id
   and f.status = 'verified'
   and a.mfa_enrolled_at is null;

create or replace function public.ctl_admin_without_mfa()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select a.user_id::text,
         jsonb_build_object('role', a.role, 'status', a.status,
                            'created_at', a.created_at,
                            'note', 'no verified factor in auth.mfa_factors')
    from public.admin_users a
   where a.status = 'active'
     -- The authoritative source: this is what the AAL2 claim in requireAdmin comes
     -- from. admin_users.mfa_enrolled_at is only a cache of it and can lag.
     and not exists (
       select 1 from auth.mfa_factors f
        where f.user_id = a.user_id and f.status = 'verified'
     )
$$;

revoke execute on function public.ctl_admin_without_mfa() from public, anon, authenticated;
