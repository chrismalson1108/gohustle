-- ─────────────────────────────────────────────────────────────────────────────
-- consume_poster_discount double-charged the campaign and the user's grant.
--
-- The function ends with:
--
--   update promotions set redemptions_used = +1, spent_cents = +hit ...
--   update promo_grants set uses_consumed = +1 ...
--   insert into promo_redemptions ... on conflict (booking_id) do nothing;
--
-- The two UPDATEs run BEFORE the conflict is detected. So on any second call for the
-- same booking the budget and the grant are incremented again, and only the redemption
-- ROW is deduplicated — the accounting is not. `on conflict do nothing` swallows the
-- evidence without undoing the charge.
--
-- This is not hypothetical and it is not rare: pin_booking_amount already calls this on
-- INSERT, so every additional call — a retry, a re-quote, a repricing — silently spends
-- the campaign twice and burns two of the poster's uses for one gig.
--
-- Demonstrated live: a single booking against a 500¢ discount left the promotion at
-- spent_cents = 1000 with uses_consumed = 2, while exactly one promo_redemptions row
-- existed. The row count looked correct; the money did not.
--
-- THE FIX IS AN EARLY RETURN, NOT A BIGGER on conflict CLAUSE. The redemption row is
-- the record that this booking has already been priced, so it has to be consulted
-- BEFORE anything is incremented. Returning the amount already recorded also keeps the
-- caller's pin correct — an idempotent call must return the same answer, not zero, or a
-- retry would drop a discount the poster was already granted.
--
-- (Reproduced from the live pg_proc body. consume_promo_grant does NOT share this bug:
-- it inserts without an on-conflict clause, so a duplicate raises and the surrounding
-- savepoint in pin_booking_amount rolls the increments back.)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.consume_poster_discount(
  p_user uuid, p_booking uuid, p_amount_cents integer, p_fee_bps integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g   public.promo_grants%rowtype;
  p   public.promotions%rowtype;
  cap integer;
  hit integer;
  prior integer;
begin
  if p_user is null or p_booking is null then return 0; end if;
  if not coalesce((select enabled from public.app_flags where key = 'promotions_enabled'), true) then
    return 0;
  end if;

  -- ALREADY PRICED. Return what was recorded and touch nothing. This must come before
  -- any increment: the increments used to run first and `on conflict do nothing` hid
  -- the duplicate, so the campaign paid twice for one booking.
  select r.reserved_cents into prior
    from public.promo_redemptions r
   where r.booking_id = p_booking
     and r.released_at is null
   limit 1;
  if found then return coalesce(prior, 0); end if;

  cap := public.poster_discount_headroom(p_amount_cents, p_fee_bps);
  if cap <= 0 then return 0; end if;

  select g2.* into g
    from public.promo_grants g2
    join public.promotions p2 on p2.id = g2.promotion_id
   where g2.user_id = p_user
     and g2.uses_consumed < g2.uses_allowed
     and g2.revoked_at is null
     and (g2.expires_at is null or g2.expires_at > now())
     and p2.kind = 'poster_discount'
     and p2.status = 'active'
     and p2.starts_at <= now()
     and (p2.ends_at is null or p2.ends_at > now())
   order by p2.poster_discount_cents desc nulls last
   limit 1
   for update of g2;
  if not found then return 0; end if;

  select * into p from public.promotions where id = g.promotion_id;
  hit := least(coalesce(p.poster_discount_cents, 0), cap, p.max_benefit_cents);
  if hit <= 0 then return 0; end if;

  -- Insert FIRST, so the unique index on booking_id is the thing that arbitrates a
  -- race. If a concurrent call already claimed this booking, we lose the insert and
  -- must not charge anything.
  insert into public.promo_redemptions
    (grant_id, promotion_id, user_id, booking_id, fee_bps, reserved_cents)
  values (g.id, p.id, p_user, p_booking, coalesce(p_fee_bps, 1000), hit)
  on conflict (booking_id) do nothing;
  if not found then
    select r.reserved_cents into prior
      from public.promo_redemptions r where r.booking_id = p_booking limit 1;
    return coalesce(prior, 0);
  end if;

  update public.promotions
     set redemptions_used = redemptions_used + 1,
         spent_cents      = spent_cents + hit
   where id = p.id
     and redemptions_used < max_redemptions
     and spent_cents + hit <= budget_cents;
  if not found then
    -- Campaign exhausted between the headroom check and here. Undo the claim so the
    -- booking is not left holding a redemption the budget never funded. Scoped to the
    -- row this call inserted: the unique index means it is the only one, but deleting
    -- by booking_id alone would be a loaded gun aimed at another path's row the moment
    -- that index changes.
    delete from public.promo_redemptions
     where booking_id = p_booking and promotion_id = p.id and grant_id = g.id;
    return 0;
  end if;

  update public.promo_grants set uses_consumed = uses_consumed + 1 where id = g.id;

  return hit;
end;
$$;

revoke execute on function public.consume_poster_discount(uuid, uuid, integer, integer)
  from public, anon, authenticated;

-- ── A control for the shape of the defect, not just this instance ───────────
-- Any booking whose recorded redemptions outnumber its charges, or vice versa, means an
-- accounting path incremented without recording. That is the class of bug above.
create or replace function public.ctl_redemption_double_charge()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'promotion', p.name,
           'kind', p.kind,
           'redemptions_used', p.redemptions_used,
           'rows_recorded', count(r.id),
           'spent_cents', p.spent_cents,
           'reserved_sum', coalesce(sum(r.reserved_cents), 0))
    from public.promotions p
    left join public.promo_redemptions r
           on r.promotion_id = p.id and r.released_at is null
   group by p.id, p.name, p.kind, p.redemptions_used, p.spent_cents
  having p.redemptions_used <> count(r.id)
$$;

revoke execute on function public.ctl_redemption_double_charge() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('redemption_double_charge',
   'A campaign''s redemption count disagrees with its recorded redemption rows',
   'critical', 'money',
   'Every charge against a campaign should have exactly one redemption row behind it. '
   'A mismatch means some path incremented redemptions_used or spent_cents without '
   'recording a row — which is precisely how consume_poster_discount double-charged '
   'the budget and burned two of a poster''s uses for one booking, while the row count '
   'still looked correct.',
   'ctl_redemption_double_charge')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
