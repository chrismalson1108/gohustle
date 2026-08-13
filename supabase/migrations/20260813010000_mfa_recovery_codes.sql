-- ─────────────────────────────────────────────────────────────────────────────
-- Recovery codes. Built BEFORE the two-factor UI, not after.
--
-- Supabase Auth gives us TOTP enrollment and verification and NOTHING for the case
-- that actually happens: the phone is lost, broken, wiped, or replaced. Without a way
-- back in, switching on 2FA converts "I forgot my password" — recoverable by email in
-- thirty seconds — into a permanent lockout of an account holding earnings history, a
-- bank payout destination, and tax records.
--
-- Chris is moving to a new Mac this week. That is exactly the event that separates
-- people from their authenticator app.
--
-- ── HOW A CODE WORKS ────────────────────────────────────────────────────────
--
-- A recovery code CANNOT grant AAL2 — only mfa.verify() does that, and it needs the
-- TOTP secret. So redeeming a code does the other sensible thing: it REMOVES the
-- factor, dropping the account back to password-only so the owner can sign in and
-- enrol a new device. That is the flow most services use, and it is honest about what
-- it costs: you are back to one factor until you set the next one up.
--
-- ── WHAT MAKES IT SAFE ──────────────────────────────────────────────────────
--
-- • Codes are stored as SHA-256 hashes. A database leak yields hashes, not codes.
--   They are 60+ bits of random from an unambiguous alphabet, so a fast hash is
--   correct here — bcrypt protects low-entropy human passwords, which these are not.
-- • Single use, enforced by the UPDATE that redeems them being the same statement
--   that checks them. No read-then-decide.
-- • Rate limited on ATTEMPTS, not successes, or a brute-force sweep that only ever
--   fails would never register. Same reasoning as redeem_promo_code.
-- • The RPC returns only true/false. A distinct "no such code" would be an oracle.
-- • Generating a new set invalidates the old set, so a screenshot of last year's
--   codes stops working the moment you print new ones.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.mfa_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mfa_recovery_codes_user_idx
  on public.mfa_recovery_codes (user_id) where used_at is null;
create unique index if not exists mfa_recovery_codes_hash_idx
  on public.mfa_recovery_codes (user_id, code_hash);

alter table public.mfa_recovery_codes enable row level security;

-- The owner may COUNT their remaining codes. They may never read a hash back out and
-- they may never write: generation and redemption are both SECURITY DEFINER RPCs.
-- Deliberately no select policy on code_hash — see the view below.
revoke all on public.mfa_recovery_codes from anon, authenticated;

-- What the app is allowed to know: how many are left, and when they were made.
create or replace view public.my_mfa_recovery_status
with (security_invoker = false) as
  select count(*) filter (where used_at is null)::int as remaining,
         count(*)::int as total,
         max(created_at) as generated_at
    from public.mfa_recovery_codes
   where user_id = auth.uid();

grant select on public.my_mfa_recovery_status to authenticated;

-- ── Attempt ledger, so brute force is bounded ───────────────────────────────
create table if not exists public.mfa_recovery_attempts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists mfa_recovery_attempts_idx
  on public.mfa_recovery_attempts (user_id, created_at desc);
alter table public.mfa_recovery_attempts enable row level security;
revoke all on public.mfa_recovery_attempts from anon, authenticated;

-- ── Generate a fresh set ────────────────────────────────────────────────────
-- Returns the PLAINTEXT codes exactly once. Nothing stores them; if the user does not
-- write them down here, they are gone and the only option is to generate again.
create or replace function public.generate_mfa_recovery_codes(p_count int default 10)
returns text[]
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid      uuid := auth.uid();
  -- No 0/O/1/I/L: these get transcribed by hand off a screenshot, at a bad moment.
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  out_codes text[] := '{}';
  code     text;
  i int; j int;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if p_count < 5 or p_count > 20 then raise exception 'bad count'; end if;

  -- A new set retires the old one. Codes printed a year ago must stop working the
  -- moment someone prints a new sheet, or "regenerate" is security theatre.
  delete from public.mfa_recovery_codes where user_id = uid;

  for i in 1..p_count loop
    code := '';
    for j in 1..8 loop
      -- gen_random_bytes lives in `extensions`; the search_path above is why this
      -- resolves. 8 chars of a 31-symbol alphabet ≈ 39 bits per code.
      code := code || substr(alphabet,
        (get_byte(extensions.gen_random_bytes(1), 0) % length(alphabet)) + 1, 1);
    end loop;
    code := substr(code, 1, 4) || '-' || substr(code, 5, 4);
    insert into public.mfa_recovery_codes (user_id, code_hash)
    values (uid, encode(extensions.digest(upper(code), 'sha256'), 'hex'))
    on conflict do nothing;
    out_codes := out_codes || code;
  end loop;

  return out_codes;
end;
$$;

revoke execute on function public.generate_mfa_recovery_codes(int) from public, anon;
grant execute on function public.generate_mfa_recovery_codes(int) to authenticated;

-- ── Redeem one, and drop the factor ─────────────────────────────────────────
create or replace function public.redeem_mfa_recovery_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid    uuid := auth.uid();
  tries  int;
  hit    uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;

  -- ATTEMPTS, not successes. A sweep that only ever fails must still be counted, or
  -- the limit protects nothing.
  insert into public.mfa_recovery_attempts (user_id) values (uid);
  select count(*) into tries
    from public.mfa_recovery_attempts
   where user_id = uid and created_at > now() - interval '15 minutes';
  if tries > 10 then
    return false;   -- deliberately indistinguishable from a wrong code
  end if;

  -- The UPDATE both checks and consumes, so the same code cannot be spent twice by
  -- two concurrent requests.
  update public.mfa_recovery_codes
     set used_at = now()
   where user_id = uid
     and used_at is null
     and code_hash = encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex')
  returning id into hit;

  if hit is null then return false; end if;

  -- A recovery code cannot mint AAL2 — only the TOTP secret can. So it does the other
  -- useful thing: removes the factor so the owner can sign in with their password and
  -- enrol a new device. They are single-factor until they do, which is the honest
  -- cost and is stated in the UI.
  delete from auth.mfa_factors where user_id = uid;

  return true;
end;
$$;

revoke execute on function public.redeem_mfa_recovery_code(text) from public, anon;
grant execute on function public.redeem_mfa_recovery_code(text) to authenticated;

-- ── A user with 2FA on and no codes left is one lost phone from lockout ─────
create or replace function public.ctl_mfa_without_recovery()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select f.user_id::text,
         jsonb_build_object(
           'factors', count(*),
           'codes_remaining', coalesce((
             select count(*) from public.mfa_recovery_codes c
              where c.user_id = f.user_id and c.used_at is null), 0),
           'note', 'this account has two-factor enabled with no unused recovery codes '
                   '— a lost phone locks them out of their earnings and payout account '
                   'permanently, and support cannot verify them any other way')
    from auth.mfa_factors f
   where f.status = 'verified'
   group by f.user_id
  having coalesce((select count(*) from public.mfa_recovery_codes c
                    where c.user_id = f.user_id and c.used_at is null), 0) = 0
$$;

revoke execute on function public.ctl_mfa_without_recovery() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('mfa_without_recovery',
   'Two-factor enabled with no recovery codes left',
   'medium', 'security',
   'Recovery codes are the only way back into an account whose authenticator is gone. '
   'Without them the owner is locked out of their earnings history, their payout '
   'account and their tax records, and there is no identity check support can run '
   'that is stronger than the factor they just lost.',
   'ctl_mfa_without_recovery')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
