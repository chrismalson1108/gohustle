-- Security fix: the chat-photos private-read policy (chat_photos_party_read,
-- 20260701000000_private_chat_photos.sql) authorizes signed URLs by matching a
-- storage object against messages.image_url — a free-text column the SENDER fully
-- controls. Without this guard, an authenticated user who is a party to ANY booking
-- could insert a message whose image_url points at a VICTIM's chat-photos object
-- (`<victimUid>/<file>`) and then mint a signed URL for it, reading a DM image from
-- a conversation they were never part of.
--
-- Fix: enforce that whenever messages.image_url is set, the referenced storage object
-- lives under the SENDER's own folder (`<sender_id>/...`). A forged path pointing at
-- another user's folder is rejected at write time, so the read policy — which trusts
-- the message row — can no longer be abused. Handles both the current bare-path form
-- (`<uid>/<file>`) and any legacy full-URL form (`.../chat-photos/<uid>/<file>`).

create or replace function public.guard_message_image_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  obj_path text;
  expected_prefix text;
begin
  if new.image_url is null or new.image_url = '' then
    return new;
  end if;
  -- Strip any URL prefix up to and including '/chat-photos/'; a bare path is left as-is.
  obj_path := regexp_replace(new.image_url, '^.*/chat-photos/', '');
  expected_prefix := new.sender_id::text || '/';
  if left(obj_path, length(expected_prefix)) <> expected_prefix then
    raise exception 'message image must reference the senders own chat-photos folder'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_message_image_path() from public, anon, authenticated;

drop trigger if exists trg_guard_message_image_path on public.messages;
create trigger trg_guard_message_image_path
  before insert or update of image_url on public.messages
  for each row execute function public.guard_message_image_path();
