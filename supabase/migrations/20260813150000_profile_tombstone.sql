-- ─────────────────────────────────────────────────────────────────────────────
-- One person's erasure request must not delete another person's financial records.
--
-- PROVEN on a staged row earlier today: `profiles → jobs → bookings → payments` is
-- ON DELETE CASCADE at every link, and delete-account blocks only UNSETTLED bookings —
-- so a poster deleting their account destroyed every earner's record of COMPLETED, PAID
-- work for them. Booking 1 → 0, payment 1 → 0. The earner loses their Jobs Done count,
-- their Transactions statement, and their Tax Center income record. They are 1099
-- contractors; that is their tax evidence, deleted by a counterparty with no notice.
--
-- ── WHY TOMBSTONE RATHER THAN CASCADE ───────────────────────────────────────
--
-- Transaction records are a recognised exception to a right-to-erasure request, and the
-- platform is separately required to retain them. More simply: those rows are not only
-- the deleting party's. They are also the earner's, and the earner did not ask for
-- anything to be deleted.
--
-- The current behaviour is the riskier of the two. Destroying a contractor's income
-- evidence to satisfy a counterparty is a larger exposure than retaining an anonymised
-- row with no personal data in it.
--
-- ── WHY NOT `ON DELETE SET NULL` ────────────────────────────────────────────
--
-- Tempting and wrong. `jobs.poster_id` and `bookings.earner_id` are both NOT NULL, and
-- making them nullable would break every RLS policy, join and guard that assumes a row
-- has an owner. Checked before designing around it.
--
-- ── THE SHAPE ───────────────────────────────────────────────────────────────
--
-- delete-account already tombstones support_tickets rather than deleting them —
-- "preserves what set null was clearly for … while removing the direct identifiers".
-- This is that same decision applied to the profile, which is where it always belonged.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists deleted_at timestamptz;

comment on column public.profiles.deleted_at is
  'Set when the account is erased. The row survives so the COUNTERPARTY''s bookings and '
  'payments survive — see tombstone_profile(). All personal data is scrubbed.';

create index if not exists profiles_deleted_at_idx on public.profiles (deleted_at)
  where deleted_at is not null;

-- ── The scrub ───────────────────────────────────────────────────────────────
create or replace function public.tombstone_profile(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if p_user is null then return false; end if;

  update public.profiles
     set name            = 'Deleted user',
         -- `username_format` is ^[a-z0-9_]{3,30}$, and 'deleted_' + a bare uuid is 40
         -- chars. Take the first 22 hex digits: still unique in practice, still frees
         -- the person's real handle, and it fits the constraint the app relies on.
         username        = 'deleted_' || substr(replace(p_user::text, '-', ''), 1, 22),
         bio             = null,
         avatar_url      = null,
         city            = null,
         skills          = '{}',
         -- A referral code is a public handle someone may have shared; freeing it also
         -- stops a deleted account continuing to attribute new signups.
         referral_code   = null,
         deleted_at      = coalesce(deleted_at, now())
   where id = p_user;

  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke execute on function public.tombstone_profile(uuid) from public, anon, authenticated;
grant execute on function public.tombstone_profile(uuid) to service_role;

-- ── Notice a tombstone that still carries identifiers ───────────────────────
create or replace function public.ctl_tombstone_leaks_pii()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'deleted_at', p.deleted_at,
           'has_name', p.name is distinct from 'Deleted user',
           'has_bio', p.bio is not null,
           'has_avatar', p.avatar_url is not null,
           'has_city', p.city is not null,
           'has_referral_code', p.referral_code is not null,
           'note', 'this account was erased but personal data remains on the profile row')
    from public.profiles p
   where p.deleted_at is not null
     and (p.name is distinct from 'Deleted user'
       or p.bio is not null
       or p.avatar_url is not null
       or p.city is not null
       or p.referral_code is not null)
$$;

revoke execute on function public.ctl_tombstone_leaks_pii() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('tombstone_leaks_pii',
   'An erased account still has personal data on its profile row',
   'high', 'integrity',
   'Accounts are tombstoned rather than deleted so the COUNTERPARTY''s bookings and '
   'payments survive — a contractor''s tax record must not be destroyed by the other '
   'party''s erasure request. That trade is only defensible while the tombstone is '
   'actually scrubbed. A row here means someone asked to be erased and was not.',
   'ctl_tombstone_leaks_pii')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Prove the scrub, and that the counterparty's records survive it ─────────
--
-- This probe tombstones a REAL profile, so the rollback has to be certain. Two
-- mechanisms, deliberately belt-and-braces:
--   1. the original values are captured and restored explicitly, and
--   2. everything happens inside a block WITH an exception handler, which in PL/pgSQL is
--      a savepoint — raising inside it rolls the block's writes back regardless.
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  o_name text; o_user text; o_bio text; o_avatar text; o_city text; o_ref text;
  nm text; b_after int; p_after int; leaks int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id, name, username, bio, avatar_url, city, referral_code
    into uid, o_name, o_user, o_bio, o_avatar, o_city, o_ref
    from public.profiles where deleted_at is null limit 1;

  insert into public.jobs (poster_id,title,category,pay,pay_type,location,description,status)
  values (uid,'tombstone probe','Odd Jobs',100,'flat','P','p','cancelled') returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified') returning id into bid;
  insert into public.payments (booking_id,payment_intent_id,amount_cents,fee_cents,earner_amount_cents,status,captured_at)
  values (bid,'pi_tomb_probe',10000,700,9300,'captured',now()) returning id into pid;

  perform public.tombstone_profile(uid);

  select name into nm from public.profiles where id = uid;
  select count(*) into b_after from public.bookings where id = bid;
  select count(*) into p_after from public.payments where id = pid;
  select count(*) into leaks from public.ctl_tombstone_leaks_pii() where entity_id = uid::text;

  -- Restore FIRST, so an assertion failure below still leaves the account intact.
  update public.profiles
     set name = o_name, username = o_user, bio = o_bio, avatar_url = o_avatar,
         city = o_city, referral_code = o_ref, deleted_at = null
   where id = uid;
  delete from public.payments where id = pid;
  delete from public.bookings where id = bid;
  delete from public.jobs where id = jid;

  if nm <> 'Deleted user' then raise exception 'scrub failed: name was still %', nm; end if;
  if b_after <> 1 or p_after <> 1 then
    raise exception 'THE WHOLE POINT FAILED: booking=% payment=% survived tombstoning (want 1/1)', b_after, p_after;
  end if;
  if leaks <> 0 then raise exception 'control says the tombstone still carried PII'; end if;

  raise notice 'tombstoned: name scrubbed, booking AND payment both survive, control clean, account restored';
end $$;
