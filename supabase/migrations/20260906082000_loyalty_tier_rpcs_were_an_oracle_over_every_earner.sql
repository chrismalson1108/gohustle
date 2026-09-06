-- ─────────────────────────────────────────────────────────────────────────────
-- Any signed-in user could read any other earner's private fee rate, verified-gig count
-- and distinct-counterparty count, one PostgREST call at a time.
--
-- The three loyalty-ladder helpers all take the subject from an ARGUMENT rather than
-- auth.uid(), all run SECURITY DEFINER over `bookings`, `jobs` and `fee_tiers` — and all
-- three end their migration with `grant execute … to authenticated, service_role`:
--
--   earner_completed_count(p_user uuid)   20260806120000:58-71
--   tier_fee_bps(p_user uuid)             20260817040000:66-83  (re-granted there)
--   earner_distinct_posters(p_user uuid)  20260817040000:48-63
--
-- A SECURITY DEFINER function in `public` whose subject is caller-supplied is an ORACLE
-- over that argument. This project already wrote that rule down for exactly this shape —
-- 20260710030000:24-30 keeps `is_blocked_pair` in the `private` schema because a public
-- one "would be a boolean ORACLE over any two users". These three are the same construct
-- and were granted anyway.
--
-- ── WHAT LEAKED ─────────────────────────────────────────────────────────────
-- Every earner id is on a job card, a review and a booking row, so the argument is not a
-- secret. With it:
--   • tier_fee_bps            → the exact platform fee bps that earner pays. That is a
--                               private commercial term: an earner sees their own rate on
--                               their own quote screen and nowhere else, and posters are
--                               never shown it at all.
--   • earner_completed_count  → verified gigs. `profiles.review_count` is public and
--                               close, but it is a count of reviews, not of work, and the
--                               two diverge on every unrated verification.
--   • earner_distinct_posters → how many separate clients they have worked for. Nothing
--                               public exposes this, and since 20260817040000 it is a
--                               threshold in an anti-collusion control — so it also tells
--                               an attacker exactly how far they are from farming a rung.
-- Enumerable, unlogged, and disclosed without the earner's consent.
--
-- ── WHY REVOKING IS FREE ────────────────────────────────────────────────────
-- Nothing in src/, web/, shared/, admin/ or supabase/functions/ calls them; the only
-- caller in the tree is `pin_booking_amount` (20260806320000:169), and that trigger is
-- itself SECURITY DEFINER. A definer function executes with its OWNER's privileges, not
-- the caller's, so removing the `authenticated` grant cannot reach the pin. The probe
-- below asserts that ownership relationship rather than assuming it.
--
-- The clients quote from `fee_bps_at()`, which takes no uid and stays granted. If a
-- screen ever needs "my tier", the answer is a zero-argument `my_fee_tier()` reading
-- auth.uid() — not a re-grant of these.
--
-- Found by the 2026-09-05 platform audit (rls-policies#5).
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.tier_fee_bps(uuid)            from public, anon, authenticated;
revoke execute on function public.earner_completed_count(uuid)  from public, anon, authenticated;
revoke execute on function public.earner_distinct_posters(uuid) from public, anon, authenticated;

-- service_role keeps it: the sweep, the console and any future back-office read are
-- already trusted with the whole table these functions read.
grant execute on function public.tier_fee_bps(uuid)            to service_role;
grant execute on function public.earner_completed_count(uuid)  to service_role;
grant execute on function public.earner_distinct_posters(uuid) to service_role;

comment on function public.tier_fee_bps(uuid) is
  'service_role only. The subject is an ARGUMENT, not auth.uid(), so an authenticated '
  'grant makes this an oracle over any earner''s private fee rate. Called from '
  'pin_booking_amount, which is SECURITY DEFINER and therefore unaffected. A client that '
  'needs "my tier" gets a zero-argument my_fee_tier() reading auth.uid().';
comment on function public.earner_completed_count(uuid) is
  'service_role only — see tier_fee_bps. Discloses an earner''s verified-gig count, which '
  'no public column carries.';
comment on function public.earner_distinct_posters(uuid) is
  'service_role only — see tier_fee_bps. Discloses how many separate clients an earner has '
  'worked for, which is also the anti-collusion threshold in fee_tiers.min_distinct_posters.';


-- ── Prove the grant is gone, that the check would have caught it, and that the
--    pin still reaches these functions ───────────────────────────────────────
do $$
declare
  fns text[] := array[
    'public.tier_fee_bps(uuid)',
    'public.earner_completed_count(uuid)',
    'public.earner_distinct_posters(uuid)'
  ];
  fn      text;
  pin_own oid;
  fn_own  oid;
  secdef  boolean;
begin
  -- 1. The fix itself.
  foreach fn in array fns loop
    if has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'FIX FAILED: authenticated still holds EXECUTE on %', fn;
    end if;
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception 'FIX FAILED: anon still holds EXECUTE on %', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception 'service_role lost EXECUTE on % — the sweep and console need it', fn;
    end if;
  end loop;
  raise notice 'the loyalty helpers are service_role only: no anon, no authenticated';

  -- 2. THE DISCRIMINATION. Put the pre-fix grant back inside this block's
  --    subtransaction and show the assertion above flips — otherwise it is a check that
  --    would pass on the broken schema too, which is the failure mode this house style
  --    exists to prevent.
  begin
    execute 'grant execute on function public.tier_fee_bps(uuid) to authenticated';
    if not has_function_privilege('authenticated', 'public.tier_fee_bps(uuid)', 'EXECUTE') then
      raise exception 'probe is not discriminating: re-granting did not make the check pass';
    end if;
    raise exception 'roll back the re-grant';
  exception when others then
    if sqlerrm <> 'roll back the re-grant' then raise; end if;
  end;

  if has_function_privilege('authenticated', 'public.tier_fee_bps(uuid)', 'EXECUTE') then
    raise exception 'the probe''s re-grant survived its own rollback';
  end if;
  raise notice 'discriminates: the same assertion passes on the pre-fix grant and fails after it, and the probe grant rolled back';

  -- 3. The pin is untouched, and here is WHY rather than a hope. pin_booking_amount is
  --    SECURITY DEFINER, so it executes as its owner; that owner is the same role that
  --    owns tier_fee_bps and therefore holds EXECUTE on it independently of any grant to
  --    authenticated. If either half of that stopped being true, the revoke would have
  --    silently broken booking creation.
  select p.proowner, p.prosecdef into pin_own, secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'pin_booking_amount';
  if pin_own is null then
    raise exception 'pin_booking_amount is missing — the fee pin has no trigger function';
  end if;
  if not secdef then
    raise exception 'pin_booking_amount is no longer SECURITY DEFINER: revoking these grants WOULD break booking inserts';
  end if;

  select p.proowner into fn_own
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tier_fee_bps';
  if fn_own <> pin_own then
    raise exception 'pin_booking_amount (owner %) and tier_fee_bps (owner %) no longer share an owner; the definer call may not be privileged',
      pin_own::regrole, fn_own::regrole;
  end if;
  if not has_function_privilege(pin_own::regrole::text, 'public.tier_fee_bps(uuid)', 'EXECUTE') then
    raise exception 'the pin''s definer owner % cannot execute tier_fee_bps', pin_own::regrole;
  end if;
  raise notice 'the pin is unaffected: pin_booking_amount is SECURITY DEFINER and owned by %, which retains EXECUTE', pin_own::regrole;
end $$;
