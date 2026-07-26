-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (HIGH, idor): guard_booking_photo_paths validated against the
-- CLIENT-SUPPLIED earner_id (2026-07-26).
--
-- 20260722030000 added this guard so a booking's completion/before photo paths must
-- live under the earner's own completion-photos folder. It resolved the expected
-- prefix from `new.earner_id` — but on UPDATE that value is whatever the client sent,
-- and this trigger runs BEFORE the one that restores it.
--
-- Trigger order on public.bookings is alphabetical by name:
--     trg_guard_booking_photo_paths   <   trg_guard_bookings_write
-- ('_' sorts before 's'), so the photo guard sees the forged earner_id and
-- trg_guard_bookings_write only pins it back afterwards.
--
-- Exploit: PATCH your own booking with earner_id = <victim> and a completion_photos
-- entry of '<victim>/<file>.jpg'. This guard compares the path against the forged id
-- and passes; the later guard restores the real earner_id. The stored row is a
-- booking the attacker IS a party to that references a victim's private completion
-- photo — and the completion-photos read policy is party-scoped on exactly that
-- reference, so the attacker can then have a signed URL issued for someone else's
-- proof-of-work photo (often the interior of a client's home).
--
-- Fix: resolve the prefix from OLD on UPDATE, NEW only on INSERT — the same
-- OLD-not-NEW correction 20260722000000 applied to guard_bookings_write for the same
-- underlying reason. On INSERT there is no OLD and bookings_insert_own already pins
-- earner_id to auth.uid().
--
-- Function body is otherwise generated from 20260722030000 verbatim; only the prefix
-- resolution changes. Trigger definition re-created unchanged. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_booking_photo_paths()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_prefix text;
  entry           text;
  obj_path        text;
begin
  -- Service role (edge functions / admin) is trusted; skip.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- Completion/before photos are uploaded by the EARNER under their own folder.
  --
  -- Resolve the earner from OLD on UPDATE; NEW only on INSERT. new.earner_id is
  -- client-supplied, and this trigger fires BEFORE trg_guard_bookings_write restores
  -- it (trigger order is alphabetical: 'trg_guard_booking_photo_paths' <
  -- 'trg_guard_bookings_write', because '_' sorts before 's'). Validating against
  -- new.earner_id therefore let a caller PATCH earner_id to a victim's id alongside a
  -- completion_photos entry under that victim's folder: this guard compared the path
  -- to the FORGED id and passed, then the later guard restored the real earner_id —
  -- leaving a booking the attacker is party to that references another user's private
  -- completion photo, which is what the party-scoped storage read policy keys on.
  -- Same OLD-not-NEW fix as 20260722000000_fix_guard_bookings_auth_branch.sql.
  -- On INSERT there is no OLD, and bookings_insert_own pins earner_id to auth.uid().
  expected_prefix := coalesce(old.earner_id, new.earner_id)::text || '/';

  foreach entry in array (
    coalesce(new.completion_photos, '{}'::text[]) || coalesce(new.before_photos, '{}'::text[])
  ) loop
    if entry is null or entry = '' then
      continue;
    end if;
    -- Strip any URL prefix up to and including '/completion-photos/'; a bare path
    -- is left as-is. Mirrors guard_message_image_path.
    obj_path := regexp_replace(entry, '^.*/completion-photos/', '');
    if left(obj_path, length(expected_prefix)) <> expected_prefix then
      raise exception 'booking photos must reference the earners own completion-photos folder'
        using errcode = 'check_violation';
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.guard_booking_photo_paths() from public, anon, authenticated;

drop trigger if exists trg_guard_booking_photo_paths on public.bookings;
create trigger trg_guard_booking_photo_paths
  before insert or update of completion_photos, before_photos on public.bookings
  for each row execute function public.guard_booking_photo_paths();
