-- ─────────────────────────────────────────────────────────────────────────────
-- The double-charge control pages CRITICAL on every bonus campaign that ever paid out,
-- because it reconciles all three campaign kinds against a ledger only two of them write.
--
-- ctl_redemption_double_charge (20260806240000:128-147) compares promotions.redemptions_used
-- against count(promo_redemptions) for EVERY row in promotions. p.kind is emitted into the
-- detail jsonb and never filtered on.
--
-- promo_redemptions is written by exactly two functions — consume_promo_grant (kind =
-- 'fee_override') and consume_poster_discount (kind = 'poster_discount'). A BONUS campaign
-- is charged somewhere else entirely: accrue_referral_bonus (20260806250000:71-91) inserts
-- into bonus_ledger and then increments redemptions_used and spent_cents on the campaign,
-- and never touches promo_redemptions. So the first referral bonus a campaign ever mints
-- puts it at redemptions_used = 1 against 0 rows, and the next :05 sweep opens a CRITICAL
-- 'money' finding on it.
--
-- Three separate costs, and the third is the one that matters:
--   1. It pages. controls_sweep_and_page fires on a NEWLY-open finding, and this one opens
--      the moment a bonus campaign does the thing it was created to do.
--   2. It can never auto-resolve. run_control resolves what a control stops returning, and
--      this control keeps returning the campaign for as long as any bonus stands.
--   3. control_findings is unique on (control_key, entity_id) where resolved_at is null.
--      So once the false positive is open on a bonus campaign, a GENUINE double charge on
--      that same campaign lands on the row that is already there and is indistinguishable
--      from it. The control that exists to catch an unrecorded increment is blinded, on
--      exactly the campaigns whose accounting it cannot currently read.
--
-- THE FIX IS NOT TO EXEMPT BONUS CAMPAIGNS. Their counter is real money — it is what
-- max_redemptions and budget_cents bound — so dropping them from the reconciliation would
-- trade a false positive for a blind spot, which is the worse of the two. Instead each kind
-- is reconciled against the ledger that actually records its charges:
--
--   fee_override / poster_discount → promo_redemptions, one live row per charge
--   bonus                          → bonus_ledger, one non-void MINTING row per charge
--
-- "Minting row" is `source_booking_id is not null`, and that qualifier is load-bearing.
-- consume_fee_credit splits a partly-usable credit by inserting a second bonus_ledger row
-- for the spent half with source_booking_id NULL (20260806080000:197-200) — a bookkeeping
-- split of an existing bonus, not a new charge against the campaign. Counting it would
-- reintroduce the same class of false positive from the other direction. The minting rows
-- are one-per-charge by construction: bonus_ledger_dedupe is unique on
-- (user_id, reason, source_booking_id) where source_booking_id is not null.
--
-- Arm 1 is written as `kind <> 'bonus'` rather than an allow-list on purpose. A fourth kind
-- added later with its own ledger would then show up here as noise, which is visible and
-- fixable; an allow-list would leave it silently unreconciled, which is this exact bug.
--
-- ONE THING THIS NEWLY MAKES VISIBLE, and it is a true positive, not a regression:
-- vest_bonuses (20260814150000:44-96) returns budget with `redemptions_used = greatest(0,
-- redemptions_used - 1)` joined against a per-PROMOTION aggregate, so voiding two bonuses
-- on one campaign in one sweep returns both amounts to spent_cents but only ONE use. Arm 2
-- reports that drift, because it is drift — the campaign's remaining seat count is wrong.
-- Fixing the decrement is a change to vest_bonuses and belongs with its own proof.
--
-- Found by the money-db-pinning audit (money-db-pinning#3), reproduced against current
-- code 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_redemption_double_charge()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  -- ── Kinds whose charges are recorded in promo_redemptions ────────────────
  select p.id::text,
         jsonb_build_object(
           'promotion', p.name,
           'kind', p.kind,
           'ledger', 'promo_redemptions',
           'redemptions_used', p.redemptions_used,
           'rows_recorded', count(r.id),
           'spent_cents', p.spent_cents,
           'reserved_sum', coalesce(sum(r.reserved_cents), 0),
           'note', 'this campaign''s redemption counter disagrees with the redemption '
                   'rows behind it. Some path incremented redemptions_used or spent_cents '
                   'without recording a row, or released a row without returning the use.')
    from public.promotions p
    left join public.promo_redemptions r
           on r.promotion_id = p.id and r.released_at is null
   -- Everything except bonus. An unknown future kind lands here and is loud rather than
   -- silently unreconciled, which is how this control went wrong the first time.
   where p.kind <> 'bonus'
   group by p.id, p.name, p.kind, p.redemptions_used, p.spent_cents
  having p.redemptions_used <> count(r.id)

  union all

  -- ── Bonus campaigns, whose charges are recorded in bonus_ledger ──────────
  select p.id::text,
         jsonb_build_object(
           'promotion', p.name,
           'kind', p.kind,
           'ledger', 'bonus_ledger',
           'redemptions_used', p.redemptions_used,
           'rows_recorded', count(b.id),
           'spent_cents', p.spent_cents,
           'minted_sum', coalesce(sum(b.amount_cents), 0),
           'note', 'this bonus campaign''s redemption counter disagrees with the live '
                   'bonuses minted against it. accrue_referral_bonus charges the campaign '
                   'and records the bonus in bonus_ledger, so one non-void minting row '
                   'should stand behind every use. Fewer uses than rows means a void '
                   'returned budget without returning the seat.')
    from public.promotions p
    left join public.bonus_ledger b
           on b.promotion_id = p.id
          and b.state <> 'void'
          -- The minting rows only. A split half of an already-charged bonus carries a
          -- NULL source_booking_id and is not a second charge against the campaign.
          and b.source_booking_id is not null
   where p.kind = 'bonus'
   group by p.id, p.name, p.kind, p.redemptions_used, p.spent_cents
  having p.redemptions_used <> count(b.id)
$$;

revoke execute on function public.ctl_redemption_double_charge() from public, anon, authenticated;

-- The registry row already exists and keeps its key, severity and domain. Only the WHY
-- changes, because the old one described a reconciliation that could not read the
-- campaigns whose ledger it never looked at.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('redemption_double_charge',
   'A campaign''s redemption count disagrees with its recorded redemption rows',
   'critical', 'money',
   'Every charge against a campaign should have exactly one live row behind it, in the '
   'ledger that kind of campaign actually writes: promo_redemptions for fee_override and '
   'poster_discount, bonus_ledger for bonus. A mismatch means some path incremented '
   'redemptions_used or spent_cents without recording a row — which is precisely how '
   'consume_poster_discount double-charged the budget and burned two of a poster''s uses '
   'for one booking, while the row count still looked correct.',
   'ctl_redemption_double_charge')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it: the false positive goes, the real defect still fires ──────────
do $$
declare
  uid uuid;
  bonus_promo uuid; fee_promo uuid; grant_id uuid;
  n int; old_rows int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- ── A healthy bonus campaign that has minted exactly one bonus ───────────
  insert into public.promotions (name, kind, status, bonus_cents, budget_cents, max_redemptions,
                                 redemptions_used, spent_cents)
  values ('redemption reconciliation probe — bonus', 'bonus', 'active', 1000, 100000, 100, 1, 1000)
  returning id into bonus_promo;

  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state, source_booking_id, vests_at)
  values (uid, bonus_promo, 'probe_referral', 1000, 'credit', 'pending',
          gen_random_uuid(), now() + interval '7 days');

  -- THE DISCRIMINATION. The old body reconciled this campaign against promo_redemptions,
  -- which no bonus path ever writes — so it saw 1 <> 0 and opened a CRITICAL finding that
  -- could never resolve. Assert that shape is really present, then assert the fix is silent.
  select count(*) into old_rows
    from public.promo_redemptions r where r.promotion_id = bonus_promo and r.released_at is null;
  if old_rows <> 0 then
    raise exception 'staging wrong: a bonus campaign should have no promo_redemptions rows, found %', old_rows;
  end if;
  if (select redemptions_used from public.promotions where id = bonus_promo) = old_rows then
    raise exception 'staging wrong: the old control would not have fired on this row, so it proves nothing';
  end if;
  raise notice 'old body: redemptions_used 1 vs 0 promo_redemptions rows — a permanent CRITICAL on a healthy campaign';

  select count(*) into n from public.ctl_redemption_double_charge() where entity_id = bonus_promo::text;
  if n <> 0 then
    raise exception 'FIX FAILED: a healthy bonus campaign still reports % row(s)', n;
  end if;
  raise notice 'fixed: a bonus campaign reconciled against bonus_ledger is silent';

  -- ── A bonus campaign really is reconciled, not merely exempted ───────────
  update public.promotions set redemptions_used = 2, spent_cents = 2000 where id = bonus_promo;
  select count(*) into n from public.ctl_redemption_double_charge() where entity_id = bonus_promo::text;
  if n <> 1 then
    raise exception 'a bonus campaign charged twice for one minted bonus reported % row(s) — that is a blind spot, not a fix', n;
  end if;
  raise notice 'a genuine unrecorded charge on a BONUS campaign still fires — the counter is watched, not exempted';

  -- Voiding the bonus and returning the seat resolves it, so findings do not accumulate.
  update public.bonus_ledger set state = 'void', void_reason = 'probe'
   where promotion_id = bonus_promo;
  update public.promotions set redemptions_used = 0, spent_cents = 0 where id = bonus_promo;
  select count(*) into n from public.ctl_redemption_double_charge() where entity_id = bonus_promo::text;
  if n <> 0 then
    raise exception 'a fully unwound bonus campaign still reports % row(s) — this could never auto-resolve', n;
  end if;
  raise notice 'unwinding the bonus closes the finding, so it resolves rather than standing forever';

  -- A split half of an already-charged bonus is not a second charge.
  update public.promotions set redemptions_used = 1, spent_cents = 1000 where id = bonus_promo;
  update public.bonus_ledger set state = 'payable', void_reason = null where promotion_id = bonus_promo;
  insert into public.bonus_ledger
    (user_id, promotion_id, reason, amount_cents, delivery, state, applied_at, applied_booking_id, source_booking_id)
  values (uid, bonus_promo, 'probe_referral', 400, 'credit', 'applied', now(), gen_random_uuid(), null);
  select count(*) into n from public.ctl_redemption_double_charge() where entity_id = bonus_promo::text;
  if n <> 0 then
    raise exception 'a consume_fee_credit split was counted as a second charge — % row(s)', n;
  end if;
  raise notice 'a credit split carrying a NULL source_booking_id is not counted as a charge';

  -- ── And the arm that already worked still works ──────────────────────────
  insert into public.promotions (name, kind, status, fee_bps, budget_cents, max_redemptions,
                                 redemptions_used, spent_cents)
  values ('redemption reconciliation probe — fee', 'fee_override', 'active', 0, 100000, 100, 2, 1000)
  returning id into fee_promo;

  insert into public.promo_grants (user_id, promotion_id, fee_bps, uses_allowed, uses_consumed)
  values (uid, fee_promo, 0, 2, 2) returning id into grant_id;

  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (grant_id, fee_promo, uid, gen_random_uuid(), 0, 500);

  select count(*) into n from public.ctl_redemption_double_charge() where entity_id = fee_promo::text;
  if n <> 1 then
    raise exception 'FIX FAILED: two charges against one redemption row on a fee_override campaign reported % row(s)', n;
  end if;
  raise notice 'a fee_override campaign charged twice for one row still fires — the original detector is intact';

  update public.promotions set redemptions_used = 1 where id = fee_promo;
  select count(*) into n from public.ctl_redemption_double_charge() where entity_id = fee_promo::text;
  if n <> 0 then
    raise exception 'a reconciled fee_override campaign still reports % row(s)', n;
  end if;
  raise notice 'and goes quiet once the counter and the rows agree';

  if not exists (select 1 from public.controls
                  where key = 'redemption_double_charge' and enabled and not external
                    and fn_name = 'ctl_redemption_double_charge') then
    raise exception 'not registered as an in-database control — run_all_controls would never call it';
  end if;
  raise notice 'still registered in the roster run_all_controls actually iterates';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'redemption reconciliation probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
