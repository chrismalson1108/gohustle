-- ─────────────────────────────────────────────────────────────────────────────
-- The share token was client-minted with Math.random(), and its life was unbounded.
--
-- A gig share token is the SOLE credential for a page that discloses the gig's exact
-- street address, both parties' first names, and live status, to anyone holding the
-- link and with no account required. Two problems with how it was issued.
--
-- ── 1. Math.random() IS NOT A CSPRNG ────────────────────────────────────────
--
-- SafetyBar.mintToken built the token from Math.random(), which in every JS engine is
-- a fast non-cryptographic PRNG (xorshift128+ in V8/JSC) with a small internal state
-- and no forward secrecy. Observing enough outputs from one context recovers the state
-- and yields every subsequent token from it. Practical exploitability is limited —
-- an attacker cannot usually see the victim's own RNG stream — but "the attacker would
-- need to work for it" is the wrong standard for the credential protecting where a
-- lone worker is physically standing. gen_random_bytes is a CSPRNG and costs nothing.
--
-- ── 2. THE LINK COULD OUTLIVE THE GIG FOREVER ───────────────────────────────
--
-- Both expires_at and token were client-supplied on INSERT, and pin_gig_share_identity
-- deliberately allowed a client to EXTEND expires_at, reasoning that "a client cannot
-- use it to outlive the booking because view_gig_share re-reads status on every call".
--
-- That reasoning does not survive completion. view_gig_share discloses the exact
-- address whenever status is in (confirmed, completed, verified) — and 'verified' is
-- TERMINAL. Once a gig is finished the status check stops being a bound at all, so an
-- earner could hold a link that discloses a poster's home address permanently, long
-- after any safety purpose has passed.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- Minting moves server-side. create_gig_share generates the token with gen_random_bytes,
-- derives expires_at itself, and is the only way to create a row — INSERT is revoked
-- from authenticated, so a client cannot choose either value. Every share now lives at
-- most SHARE_MAX_HOURS (24) from creation, enforced on INSERT and again on UPDATE so
-- extension cannot walk past it.
--
-- Revocation, relabelling and shortening stay entirely with the earner: those are the
-- controls that make the feature safe to use, and none of them can lengthen exposure.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Mint ────────────────────────────────────────────────────────────────────
create or replace function public.create_gig_share(
  p_booking uuid,
  p_label   text default null,
  p_hours   integer default 12)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  max_hours constant integer := 24;
  hrs   integer;
  tok   text;
  live  text;
begin
  if p_booking is null then
    raise exception 'booking required' using errcode = 'check_violation';
  end if;

  -- Same condition gig_shares_insert_own and job_locations_party_read enforce: only the
  -- EARNER, and only once the booking has actually been accepted. Minting on a pending
  -- application would read out an address the earner is not yet entitled to.
  if not exists (
    select 1 from public.bookings b
     where b.id = p_booking
       and b.earner_id = auth.uid()
       and b.status in ('confirmed', 'completed', 'verified')
  ) then
    raise exception 'You can only share a gig you have been booked for.'
      using errcode = 'check_violation';
  end if;

  -- Hand back a live link rather than minting a second one. Someone who sends it to
  -- their housemate and then their mother must be sending the SAME link, or revoking
  -- one leaves the other quietly live. This was previously done client-side, where it
  -- was advisory; here it is authoritative.
  select token into live from public.gig_shares
   where booking_id = p_booking
     and created_by = auth.uid()
     and revoked_at is null
     and expires_at > now()
   order by created_at desc
   limit 1;
  if found then return live; end if;

  hrs := least(greatest(coalesce(p_hours, 12), 1), max_hours);
  -- 24 bytes of CSPRNG = 192 bits. view_gig_share requires >= 16 chars; this is 52.
  --
  -- SCHEMA-QUALIFIED deliberately. pgcrypto lives in `extensions` on Supabase, and this
  -- function pins search_path = public (as every SECURITY DEFINER here must, so the
  -- caller cannot redirect a name to their own object). An unqualified call therefore
  -- fails at RUNTIME with 42883 — caught in simulation before it shipped.
  tok := 'tok_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.gig_shares (booking_id, created_by, token, label, expires_at)
  values (p_booking, auth.uid(), tok,
          nullif(btrim(coalesce(p_label, '')), ''),
          now() + make_interval(hours => hrs));

  return tok;
end;
$$;

revoke execute on function public.create_gig_share(uuid, text, integer) from public, anon;
grant  execute on function public.create_gig_share(uuid, text, integer) to authenticated;

-- ── The client may no longer choose the token or the expiry ─────────────────
-- create_gig_share is SECURITY DEFINER so it is unaffected by this.
revoke insert on public.gig_shares from authenticated;
drop policy if exists gig_shares_insert_own on public.gig_shares;

-- ── Bound the life on UPDATE too ────────────────────────────────────────────
-- Reproduced from the live pin trigger with the expiry clamp added; every existing pin
-- is preserved.
create or replace function public.pin_gig_share_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_hours constant integer := 24;
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

  -- SHORTEN, NEVER LENGTHEN PAST THE CEILING. The previous version allowed unlimited
  -- extension on the grounds that view_gig_share re-reads booking status — but
  -- 'verified' is terminal, so after completion that check bounds nothing and a link
  -- disclosing the poster's exact address could be kept alive forever.
  if new.expires_at > old.created_at + make_interval(hours => max_hours) then
    new.expires_at := old.created_at + make_interval(hours => max_hours);
  end if;

  return new;
end;
$$;

revoke execute on function public.pin_gig_share_identity() from public, anon, authenticated;

-- ── Control ─────────────────────────────────────────────────────────────────
create or replace function public.ctl_share_link_overlong()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select s.id::text,
         jsonb_build_object(
           'booking_id', s.booking_id,
           'created_by', s.created_by,
           'created_at', s.created_at,
           'expires_at', s.expires_at,
           'hours', round(extract(epoch from s.expires_at - s.created_at) / 3600.0, 1),
           'token_looks_client_minted', s.token !~ '^tok_[0-9a-f]{48}$')
    from public.gig_shares s
   where s.revoked_at is null
     and s.expires_at > s.created_at + interval '24 hours'
$$;

revoke execute on function public.ctl_share_link_overlong() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('share_link_overlong',
   'A gig share link is set to outlive the 24-hour ceiling',
   'high', 'security',
   'A share token is the only credential for a page that discloses a gig''s exact '
   'street address to anyone holding the link. Its life is capped at 24 hours from '
   'creation, on INSERT and on UPDATE. A row past that ceiling means the clamp is not '
   'holding and someone''s address is exposed for longer than the safety purpose that '
   'justified disclosing it.',
   'ctl_share_link_overlong')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
