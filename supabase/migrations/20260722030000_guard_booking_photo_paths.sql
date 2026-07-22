-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY: pin bookings.completion_photos / before_photos to the earner's own
-- storage folder (2026-07-22).
--
-- The completion-photos bucket is private; completion_party_read
-- (20260707010000_private_completion_photos) authorizes a signed URL when the
-- requested object appears in some booking's completion_photos/before_photos array
-- AND the caller is a party to that booking. Those arrays are written by the earner
-- when marking a job done, and guard_bookings_write()'s EARNER branch
-- (20260722000000) does NOT pin completion_photos/before_photos — so an earner can
-- PATCH their own booking's completion_photos to reference a VICTIM's object path
-- (`<victimUid>/<file>`) and then mint a signed URL for it, reading another user's
-- private proof-of-work photo from a booking they were never part of.
--
-- This is the exact class of bug the chat-photos guard (20260702010000) already
-- closes for messages.image_url. Fix identically: whenever completion_photos or
-- before_photos is set on a booking, require every entry to live under the booking's
-- EARNER folder (`<earner_id>/...`). A forged path pointing at another user's folder
-- is rejected at write time, so the read policy can no longer be abused. Handles the
-- bare-path form (`<uid>/<file>`) and any legacy full-URL form
-- (`.../completion-photos/<uid>/<file>`). Service role bypasses. Idempotent.
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
  expected_prefix := new.earner_id::text || '/';

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
