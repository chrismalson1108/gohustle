-- ─────────────────────────────────────────────────────────────────────────────
-- A code on a referral-bonus campaign says "applied", burns a seat, and buys nothing.
--
-- `promotions.kind` has three values and only TWO of them have a consumer:
--
--   fee_override    → consume_promo_grant        (…20260814120000:114 `p2.kind = 'fee_override'`)
--   poster_discount → consume_poster_discount    (…20260806340000:87  `p2.kind = 'poster_discount'`)
--   bonus           → NOBODY. accrue_referral_bonus (20260806250000:62) mints straight
--                     into bonus_ledger off the `referrals` table and never looks at a
--                     grant at all.
--
-- redeem_promo_code and grant_promotion_to_users were both written without reference to
-- `kind`. So a code minted against a bonus campaign walks the whole happy path: the
-- promotion is active and in window, the code seat is burned
-- (20260806070000:305-311), and a grant is inserted (:314) whose fee_bps is NULL —
-- forced NULL for this kind by promotions_kind_shape (20260806110000:43-48). The RPC
-- returns TRUE. The user is told their code applied.
--
-- Nothing then reads that grant, ever. And it is PERMANENT: promo_grants_one_per_user_promo
-- makes the claim unique per (user, promotion), so every later attempt at the same code
-- short-circuits through the already-claimed branch (:299-302) and returns TRUE again,
-- still buying nothing. Revoking the grant does not free the slot — the unique index is
-- not partial on revoked_at — so support cannot even re-issue.
--
-- ── THE FIX: a POSITIVE list, not a bonus exclusion ──────────────────────────
-- The gate names the kinds that HAVE a consumer rather than excluding the one that does
-- not. A fourth kind added later is inert on the day it is added, exactly like `bonus`
-- was, and an exclusion list would silently welcome it. This way the fourth kind is
-- refused until someone teaches a consumer about it and adds it here.
--
-- The gate sits BEFORE the already-claimed branch on purpose: a grant minted before this
-- migration is just as inert, and continuing to answer "applied" to the person holding it
-- is the whole complaint.
--
-- ── AND A CONTROL, because the gate is not retroactive ───────────────────────
-- Stopping issuance does nothing about codes already printed and grants already held.
-- Those are the silent-wrong-state this created: an operator hands out fifty codes and
-- learns nothing until a user says the code did not work. ctl_inert_promo_artifact names
-- the campaign, counts the artifacts, and says which kinds are spendable.
--
-- Found by the 2026-08-12 incentives audit (money-db-incentives#7); re-verified against
-- current code 2026-09-05 — redeem_promo_code and grant_promotion_to_users each still
-- have exactly one definition and neither mentions `kind`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. redeem_promo_code — refuse a code for a kind nothing can spend ────────
-- Rewritten whole (this is the only definition, 20260806070000:252); the sole change is
-- the KIND GATE block below.
create or replace function public.redeem_promo_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  c     public.promo_codes%rowtype;
  p     public.promotions%rowtype;
  tries integer;
  okv   boolean := false;
begin
  if uid is null then return false; end if;

  -- Count ATTEMPTS in the window, not successes. 8/hour.
  select count(*) into tries from public.promo_redeem_attempts
   where user_id = uid and created_at > now() - interval '1 hour';
  if tries >= 8 then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  select * into c from public.promo_codes
   where upper(btrim(code)) = upper(btrim(p_code));
  if not found
     or (c.expires_at is not null and c.expires_at <= now())
     or (c.bound_user_id is not null and c.bound_user_id <> uid) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  select * into p from public.promotions where id = c.promotion_id;
  if not found or p.status <> 'active' or p.starts_at > now()
     or (p.ends_at is not null and p.ends_at <= now()) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  -- KIND GATE. A grant only ever reaches a booking through consume_promo_grant
  -- ('fee_override') or consume_poster_discount ('poster_discount'). Any other kind
  -- produces a grant no consumer matches — a claim the holder is told they have and can
  -- never spend, permanently, because the claim is unique per (user, promotion).
  --
  -- Ahead of the already-claimed branch deliberately: an inert grant minted before this
  -- migration must stop answering "applied" too.
  --
  -- Same shape as every other refusal here: plain false, no distinct error. The reason a
  -- code fails is not the caller's business — distinct errors are how a redeem endpoint
  -- becomes an existence oracle over a human-typeable keyspace.
  if p.kind is null or p.kind not in ('fee_override', 'poster_discount') then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  -- ALREADY CLAIMED: succeed idempotently WITHOUT burning a code seat. Incrementing
  -- first and inserting second meant a user retyping their own code consumed a
  -- redemption every time, silently draining a campus code from the person holding it.
  if exists (select 1 from public.promo_grants where user_id = uid and promotion_id = p.id) then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, true);
    return true;
  end if;

  -- Increment IS the check — no read-then-decide window.
  update public.promo_codes
     set redemptions_used = redemptions_used + 1
   where id = c.id and redemptions_used < max_redemptions;
  if not found then
    insert into public.promo_redeem_attempts (user_id, ok) values (uid, false);
    return false;
  end if;

  -- SNAPSHOT the benefit. A later admin edit cannot re-price this claim.
  insert into public.promo_grants (user_id, promotion_id, code_id, fee_bps, uses_allowed, expires_at)
  values (uid, p.id, c.id, p.fee_bps, p.uses_allowed, p.ends_at)
  on conflict (user_id, promotion_id) do nothing;
  okv := found;

  -- Lost a race to a concurrent claim: hand the seat back rather than eat it.
  if not okv then
    update public.promo_codes set redemptions_used = greatest(0, redemptions_used - 1) where id = c.id;
    okv := true;  -- they hold a grant either way, so this is still a success
  end if;

  insert into public.promo_redeem_attempts (user_id, ok) values (uid, okv);
  return okv;
exception when others then
  -- Never leak internals to a caller probing codes.
  return false;
end;
$$;

revoke execute on function public.redeem_promo_code(text) from public, anon;
grant  execute on function public.redeem_promo_code(text) to authenticated, service_role;

-- ── 2. grant_promotion_to_users — refuse the same campaigns, loudly ──────────
-- This one RAISES rather than returning 0. It has no anonymous caller to protect: the
-- only path in is the console's grantToUsers under requireFreshAdmin, which renders
-- error.message straight back to the operator. A silent 0 here reads as "everyone
-- already had it" — the exact wrong lesson.
create or replace function public.grant_promotion_to_users(
  p_promotion uuid, p_user_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.promotions%rowtype;
  n integer := 0;
begin
  select * into p from public.promotions where id = p_promotion;
  if not found then
    raise exception 'unknown promotion %', p_promotion using errcode = 'no_data_found';
  end if;

  if p.kind is null or p.kind not in ('fee_override', 'poster_discount') then
    raise exception
      'a % campaign cannot be granted: nothing consumes a grant of that kind. Referral '
      'bonuses are minted into bonus_ledger when the referred person''s gig is verified, '
      'not claimed by hand.', p.kind
      using errcode = 'invalid_parameter_value';
  end if;

  -- Snapshot the benefit onto each grant, exactly as redeem_promo_code does, so a
  -- later edit to the campaign cannot re-price grants already handed out.
  insert into public.promo_grants (user_id, promotion_id, fee_bps, uses_allowed, expires_at)
  select u, p.id, p.fee_bps, p.uses_allowed, p.ends_at
    from unnest(p_user_ids) as u
   where exists (select 1 from public.profiles pr where pr.id = u)
  on conflict (user_id, promotion_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.grant_promotion_to_users(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.grant_promotion_to_users(uuid, uuid[]) to service_role;

-- ── 3. The control, for the artifacts already out there ──────────────────────
-- One row per CAMPAIGN, not per code: fifty codes on one bonus promotion is one
-- operator mistake and one thing to undo, and fifty findings would be alert fatigue for
-- a single decision.
create or replace function public.ctl_inert_promo_artifact()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'kind', 'inert_promo_artifact',
           'promotion', p.name,
           'promotion_kind', p.kind,
           'status', p.status,
           'codes', (select count(*) from public.promo_codes c where c.promotion_id = p.id),
           'code_seats_burned', coalesce((select sum(c.redemptions_used)
                                            from public.promo_codes c
                                           where c.promotion_id = p.id), 0),
           'grants_held', (select count(*) from public.promo_grants g
                            where g.promotion_id = p.id and g.revoked_at is null),
           'spendable_kinds', jsonb_build_array('fee_override', 'poster_discount'),
           'note', 'codes or grants exist for a campaign whose kind no consumer matches. '
                   'consume_promo_grant matches fee_override and consume_poster_discount '
                   'matches poster_discount; a bonus campaign is paid out of bonus_ledger '
                   'by accrue_referral_bonus and never reads a grant. Anyone who typed one '
                   'of these codes was told it applied and received nothing.',
           'remedy', 'Delete the codes so nobody else burns a seat on them, and tell the '
                     'people holding grants. If the intent was a fee discount, create a '
                     'fee_override campaign and mint codes there — a grant on the bonus '
                     'campaign cannot be converted, and its (user, promotion) slot cannot '
                     'be freed by revoking.'
         )
    from public.promotions p
   where p.kind is distinct from 'fee_override'
     and p.kind is distinct from 'poster_discount'
     and (exists (select 1 from public.promo_codes c where c.promotion_id = p.id)
       or exists (select 1 from public.promo_grants g
                   where g.promotion_id = p.id and g.revoked_at is null))
$$;

revoke execute on function public.ctl_inert_promo_artifact() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('inert_promo_artifact',
   'A promo code or grant exists for a campaign nothing can spend',
   'low', 'money',
   'promotions.kind has three values and only two have a consumer: consume_promo_grant '
   'matches fee_override, consume_poster_discount matches poster_discount, and a bonus '
   'campaign is paid out of bonus_ledger by accrue_referral_bonus without ever reading a '
   'grant. Until 20260906031000 neither redeem_promo_code nor grant_promotion_to_users '
   'looked at kind, so a code on a bonus campaign returned true, burned a seat and minted '
   'a grant nothing would ever match — permanently, since the grant is unique per (user, '
   'promotion). Issuance is now gated; this reports the artifacts that were created '
   'before it, which the gate cannot undo.',
   'ctl_inert_promo_artifact')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- ── Probe: stage the exact broken shape, prove the fix discriminates, roll back ──
do $$
declare
  uid uuid; promo_bonus uuid; promo_fee uuid; promo_code_ok uuid;
  n int; granted int; got boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.promotions (name, kind, status, bonus_cents, budget_cents, max_redemptions)
  values ('inert-artifact probe (bonus)', 'bonus', 'active', 500, 100000, 100)
  returning id into promo_bonus;

  insert into public.promotions (name, kind, status, fee_bps, budget_cents, max_redemptions)
  values ('inert-artifact probe (fee)', 'fee_override', 'active', 0, 100000, 100)
  returning id into promo_fee;

  -- THE GRANT PATH ────────────────────────────────────────────────────────────
  -- Broken behaviour: this call used to insert a grant and return 1.
  begin
    granted := public.grant_promotion_to_users(promo_bonus, array[uid]);
    raise exception 'FIX FAILED: granting a bonus campaign returned % instead of raising', granted;
  exception when invalid_parameter_value then
    raise notice 'granting a bonus campaign is refused, and the operator is told why';
  end;

  if exists (select 1 from public.promo_grants where promotion_id = promo_bonus) then
    raise exception 'FIX FAILED: a grant was minted for a campaign nothing consumes';
  end if;

  -- The same call on a spendable campaign still works — the gate is a kind check, not a
  -- new way for grants to fail.
  granted := public.grant_promotion_to_users(promo_fee, array[uid]);
  if granted <> 1 then
    raise exception 'REGRESSION: granting a fee_override campaign returned % (want 1)', granted;
  end if;
  raise notice 'discriminates: bonus refused, fee_override still granted on the same call';

  -- THE CODE PATH ─────────────────────────────────────────────────────────────
  -- redeem_promo_code reads auth.uid(), so impersonate the staged profile.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  insert into public.promotions (name, kind, status, fee_bps, budget_cents, max_redemptions)
  values ('inert-artifact probe (code, fee)', 'fee_override', 'active', 0, 100000, 100)
  returning id into promo_code_ok;
  insert into public.promo_codes (promotion_id, code, max_redemptions, source)
  values (promo_code_ok, 'PROBE-INERT-FEEOK', 10, 'probe');

  -- The CONTROL case first, and it doubles as proof that nothing else in this function
  -- (the hourly attempt limiter, the promotions_enabled flag) is what refuses below.
  got := public.redeem_promo_code('PROBE-INERT-FEEOK');
  if not got then
    raise exception 'REGRESSION: a fee_override code no longer redeems — the gate is refusing a spendable kind';
  end if;
  select redemptions_used into n from public.promo_codes where code = 'PROBE-INERT-FEEOK';
  if n <> 1 or not exists (select 1 from public.promo_grants
                            where promotion_id = promo_code_ok and user_id = uid) then
    raise exception 'REGRESSION: fee_override code redeemed but burned % seat(s) / minted no grant', n;
  end if;
  raise notice 'a fee_override code still redeems, burns its seat and mints its grant';

  insert into public.promo_codes (promotion_id, code, max_redemptions, source)
  values (promo_bonus, 'PROBE-INERT-BONUS', 10, 'probe');

  got := public.redeem_promo_code('PROBE-INERT-BONUS');
  if got then
    raise exception 'FIX FAILED: a code on a bonus campaign still reports as applied';
  end if;

  -- The seat is the second half of the damage: the old code burned one before minting
  -- the grant nobody could use.
  select redemptions_used into n from public.promo_codes where code = 'PROBE-INERT-BONUS';
  if n <> 0 then
    raise exception 'FIX FAILED: refused the code but burned % seat(s) anyway', n;
  end if;
  if exists (select 1 from public.promo_grants
              where promotion_id = promo_bonus and user_id = uid) then
    raise exception 'FIX FAILED: refused the code but minted the inert grant anyway';
  end if;
  raise notice 'a bonus code is refused, no seat burned, no grant minted';

  -- And the attempt is still recorded, so the rate limiter cannot be walked around by
  -- spraying codes that happen to point at a bonus campaign.
  if not exists (select 1 from public.promo_redeem_attempts
                  where user_id = uid and created_at > now() - interval '1 minute') then
    raise exception 'the refusal was not counted as an attempt — the rate limiter is blind to it';
  end if;
  raise notice 'the refusal still counts as an attempt, so it cannot be sprayed for free';

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- THE CONTROL ───────────────────────────────────────────────────────────────
  -- The gate is not retroactive, so stage the artifact the way it already exists in the
  -- wild: a code sitting on a bonus campaign.
  select count(*) into n from public.ctl_inert_promo_artifact() where entity_id = promo_bonus::text;
  if n <> 1 then
    raise exception 'FIX FAILED: the control reported % rows for a bonus campaign carrying a code', n;
  end if;

  -- A spendable campaign carrying the same artifacts is silent — otherwise this fires on
  -- every healthy campaign and gets muted within a week.
  insert into public.promo_codes (promotion_id, code, max_redemptions, source)
  values (promo_fee, 'PROBE-INERT-FEE', 10, 'probe');
  select count(*) into n from public.ctl_inert_promo_artifact() where entity_id = promo_fee::text;
  if n <> 0 then
    raise exception 'fired on a fee_override campaign, which is the healthy case';
  end if;
  raise notice 'discriminates: the bonus campaign is reported and the fee campaign is not';

  -- Remove the artifacts and the finding closes rather than accumulating.
  delete from public.promo_codes where promotion_id = promo_bonus;
  select count(*) into n from public.ctl_inert_promo_artifact() where entity_id = promo_bonus::text;
  if n <> 0 then
    raise exception 'still open with no codes and no grants — this could never auto-resolve';
  end if;
  raise notice 'clearing the codes closes the finding, so it resolves rather than persisting';

  if not exists (select 1 from public.controls
                  where key = 'inert_promo_artifact' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'inert-promo-artifact probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
