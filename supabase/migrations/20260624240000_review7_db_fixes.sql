-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 7 — database fixes. Applied via `supabase db push`.
--
--  #3 MEDIUM: bookings.slot_id had no FK and was never checked against job_id, so
--     an attacker could book their OWN throwaway gig while pointing slot_id at a
--     VICTIM's slot — sync_slot_taken then marked the victim's slot taken and the
--     one-active-per-slot unique index locked the real earner out (booking DoS).
--     Validate slot ownership in the guard, clean orphans, and add the missing FK.
--  #2 MEDIUM: the tip credit could strand (earner under-credited) if the credit ran
--     after the idempotency ledger row was already written and then failed — the
--     retry saw the duplicate ledger row and skipped crediting. Make it recoverable
--     with a single transactional claim_and_credit_tip RPC + a `credited` flag.
--  #8 LOW: disputes.pct_paid had no bound — clamp it 0..100.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── #3 — guard now rejects a slot that doesn't belong to the booked job ───────
create or replace function public.guard_bookings_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  poster uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select poster_id into poster from public.jobs where id = coalesce(new.job_id, old.job_id);

  if tg_op = 'INSERT' then
    new.status      := 'pending';
    new.earner_done := false;
    new.poster_done := false;
    new.earner_rating := null;
    if new.earner_id = poster then
      raise exception 'You cannot book your own gig';
    end if;
    -- A booked slot must belong to the job being booked — otherwise a caller could
    -- occupy/lock another gig's slot by referencing it from their own booking.
    if new.slot_id is not null and not exists (
      select 1 from public.job_slots s where s.id = new.slot_id and s.job_id = new.job_id
    ) then
      raise exception 'slot does not belong to this job';
    end if;
    return new;
  end if;

  -- Poster drives the lifecycle. They author the amendment note, and may only
  -- PROPOSE ('pending') or CLEAR ('none') an amendment — never self-accept it.
  if auth.uid() = poster then
    new.earner_id         := old.earner_id;
    new.job_id            := old.job_id;
    new.slot_id           := old.slot_id;
    new.earner_done       := old.earner_done;
    new.completion_photos := old.completion_photos;
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;
    if new.amendment_status is distinct from old.amendment_status
       and new.amendment_status not in ('pending', 'none') then
      new.amendment_status := old.amendment_status;
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('confirmed','declined','cancelled'))
      or (old.status = 'confirmed' and new.status = 'cancelled')
      or (old.status = 'confirmed' and new.status = 'completed' and new.earner_done and new.poster_done)
      or (old.status = 'completed' and new.status = 'verified')
    ) then
      new.status := old.status;
    end if;
    return new;
  end if;

  -- Earner may update only their own side (and never re-points the slot/job).
  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;
    new.earner_id      := old.earner_id;
    new.slot_id        := old.slot_id;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;
    new.amendment_note := old.amendment_note;
    new.tip_amount     := old.tip_amount;
    if new.status is distinct from old.status
       and not (new.status = 'completed' and old.poster_done)
       and not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
      new.status := old.status;
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- Null any pre-existing orphaned slot references, then add the missing FK.
update public.bookings b set slot_id = null
 where slot_id is not null
   and not exists (select 1 from public.job_slots s where s.id = b.slot_id);
alter table public.bookings drop constraint if exists bookings_slot_id_fkey;
alter table public.bookings add constraint bookings_slot_id_fkey
  foreign key (slot_id) references public.job_slots(id) on delete set null;

-- ── #2 — recoverable, exactly-once tip credit ────────────────────────────────
alter table public.tip_ledger add column if not exists credited boolean default false;
-- Existing ledger rows were already credited by the old path — mark them so a
-- retry can't re-credit them through the new claim flow.
update public.tip_ledger set credited = true where credited is distinct from true;

create or replace function public.claim_and_credit_tip(
  p_pi text, p_booking uuid, p_earner uuid, p_cents integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  if p_cents is null or p_cents <= 0 then
    return;
  end if;

  -- Record the tip once (idempotent on the PaymentIntent id).
  insert into public.tip_ledger (booking_id, payment_intent_id, earner_id, amount_cents)
  values (p_booking, p_pi, p_earner, p_cents)
  on conflict (payment_intent_id) do nothing;

  -- Claim the credit: only the call that flips credited false->true increments, so
  -- a retry after a mid-way failure still credits exactly once. Runs in ONE
  -- transaction with the increments below, so a failure rolls the claim back.
  update public.tip_ledger set credited = true
   where payment_intent_id = p_pi and coalesce(credited, false) = false
   returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    return;
  end if;

  if p_booking is not null then
    update public.bookings
       set tip_amount = coalesce(tip_amount, 0) + p_cents::numeric / 100
     where id = p_booking;
  end if;
  if p_earner is not null then
    update public.profiles
       set earnings_today = coalesce(earnings_today, 0) + p_cents::numeric / 100,
           earnings_week  = coalesce(earnings_week,  0) + p_cents::numeric / 100,
           earnings_total = coalesce(earnings_total, 0) + p_cents::numeric / 100
     where id = p_earner;
  end if;
end;
$$;

revoke execute on function public.claim_and_credit_tip(text, uuid, uuid, integer) from public, anon, authenticated;

-- ── #8 — bound the client-written dispute percentage ─────────────────────────
alter table public.disputes drop constraint if exists disputes_pct_paid_chk;
alter table public.disputes add constraint disputes_pct_paid_chk
  check (pct_paid is null or (pct_paid >= 0 and pct_paid <= 100));
