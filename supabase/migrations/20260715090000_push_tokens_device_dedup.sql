-- C17 (server-side device dedup): a single physical device produces ONE Expo push
-- token. If two accounts sign in on the same device, both rows (same `token`, different
-- `user_id`) survive in push_tokens, so the previous account keeps receiving this
-- device's notifications. The client already replaces its own row, but nothing evicts
-- the OTHER user's row for the same device token.
--
-- Enforce it in the database: on INSERT, delete any existing row carrying the same
-- device token but owned by a different user. Owner-scoped RLS still gates who may
-- insert; this trigger only reclaims the device token for the newest signer.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS then CREATE.

create or replace function public.push_tokens_evict_stale_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Same physical device token, different account → drop the stale owner's row so a
  -- shared device stops delivering the previous account's notifications.
  delete from public.push_tokens
  where token = new.token
    and user_id <> new.user_id;
  return new;
end;
$$;
revoke execute on function public.push_tokens_evict_stale_device() from public;

drop trigger if exists trg_push_tokens_evict_stale_device on public.push_tokens;
create trigger trg_push_tokens_evict_stale_device
  before insert on public.push_tokens
  for each row
  execute function public.push_tokens_evict_stale_device();
