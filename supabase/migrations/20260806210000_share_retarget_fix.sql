-- ─────────────────────────────────────────────────────────────────────────────
-- A share link can never be retargeted at another booking (2026-08-06).
--
-- gig_shares_revoke_own was:
--     for update using (auth.uid() = created_by) with check (auth.uid() = created_by)
--
-- WITH CHECK validates the NEW row and only ever looked at created_by, so the owner of
-- a share could UPDATE its booking_id to point at any booking at all — including one
-- they are not a party to — and then read that booking through their own token. The
-- insert policy's party check was doing real work; the update policy handed a way
-- straight past it.
--
-- 20260806200000 made this materially worse: view_gig_share now returns the EXACT
-- ADDRESS for a confirmed booking, so retargeting became an address-disclosure hole
-- rather than a status-disclosure one.
--
-- RLS cannot express "this column may not change" — a policy sees the new row, not the
-- old one — so the fix is a pin trigger, the same shape the rest of this codebase uses
-- for server-owned columns. Revocation and relabelling stay possible; identity does not.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.pin_gig_share_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  -- Everything that decides WHAT this link points at and WHO owns it is immutable.
  -- A client may only ever revoke it, relabel it, or shorten its life.
  new.booking_id := old.booking_id;
  new.created_by := old.created_by;
  new.token      := old.token;
  new.view_count := old.view_count;
  new.last_viewed_at := old.last_viewed_at;
  new.created_at := old.created_at;
  -- Extending your own link's life is fine; a client cannot use it to outlive the
  -- booking because view_gig_share re-reads status on every call.
  return new;
end;
$$;

revoke execute on function public.pin_gig_share_identity() from public, anon, authenticated;

drop trigger if exists trg_z_pin_gig_share_identity on public.gig_shares;
create trigger trg_z_pin_gig_share_identity
  before update on public.gig_shares
  for each row execute function public.pin_gig_share_identity();

-- A share whose booking is not the one it was minted for should be impossible now.
-- This control exists to prove that stays true rather than to be believed.
create or replace function public.ctl_share_points_at_foreign_booking()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select s.id::text,
         jsonb_build_object(
           'token_prefix', left(s.token, 12),
           'created_by', s.created_by,
           'booking_id', s.booking_id,
           'booking_earner', b.earner_id,
           'note', 'this share points at a booking its creator is not the earner on')
    from public.gig_shares s
    join public.bookings b on b.id = s.booking_id
   where s.revoked_at is null
     and b.earner_id <> s.created_by
$$;

revoke execute on function public.ctl_share_points_at_foreign_booking() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('share_points_at_foreign_booking',
   'A live share link points at a booking its creator is not on',
   'critical', 'security',
   'gig_shares_insert_own only allows minting a link for your own accepted booking, and '
   'trg_z_pin_gig_share_identity makes booking_id immutable afterwards. A row that '
   'violates this means one of those two was bypassed — and since view_gig_share '
   'discloses the exact address of a confirmed booking, that is a location leak.',
   'ctl_share_points_at_foreign_booking')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
