-- ─────────────────────────────────────────────────────────────────────────────
-- H1 (beta-not-actually-closed): server-side closed-beta signup gate (2026-07-10).
--
-- Before this, "closed beta" was a policy intention only — signup was open Supabase
-- email/password (and Google/Apple OAuth) with the embedded anon key, and
-- gohustlr.com had open public signup. This adds the missing TECHNICAL control: an
-- allowlist consulted inside handle_new_user (the SECURITY DEFINER trigger that runs
-- for every new auth.users row, covering email/password AND OAuth). A signup whose
-- email is not allowlisted raises, which rolls back the auth.users insert — a true
-- server-side rejection, not a client check.
--
-- Operating it:
--   • Invite someone:  insert into public.beta_allowlist(email) values ('x@y.edu');
--   • Open the beta to everyone (kill-switch, no redeploy):
--                      insert into public.beta_allowlist(email) values ('*');
--   • Re-close it:     delete from public.beta_allowlist where email = '*';
-- Existing users are unaffected — the trigger only fires on NEW signups.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.beta_allowlist (
  email    text primary key,
  note     text,
  added_at timestamptz not null default now()
);

-- RLS on, no policies: only service_role (admin console / SQL editor) and the
-- SECURITY DEFINER signup trigger (runs as the table owner, bypassing RLS) can read
-- it. Clients cannot enumerate who has been invited.
alter table public.beta_allowlist enable row level security;

-- Seed the founder so the owner is never locked out of their own signup path.
insert into public.beta_allowlist (email, note)
values ('mainmail@gohustlr.com', 'founder')
on conflict (email) do nothing;

-- Re-create handle_new_user with the gate at the top. PRESERVES the existing
-- hardening: security definer + `set search_path = public` (from
-- 20260624200000_function_search_path.sql) and the exact profile-insert body. The
-- earlier `revoke execute ... from public/anon/authenticated`
-- (20260702000000) is retained automatically — create-or-replace does not reset
-- privileges.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Closed-beta gate (H1). A single row with email = '*' opens signups to all.
  -- Case-insensitive match (GoTrue lowercases emails, but be defensive).
  if not exists (
    select 1 from public.beta_allowlist
    where email = '*' or lower(email) = lower(new.email)
  ) then
    raise exception 'signup_not_allowlisted'
      using errcode = 'check_violation',
            hint = 'This email is not on the GoHustlr beta list.';
  end if;

  insert into public.profiles (id, name, avatar_initial, member_since)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data->>'name', new.email), 1)),
    to_char(now(), 'Mon YYYY')
  );
  return new;
end;
$$;
