-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 5 — database fixes. Applied via `supabase db push`.
--
--  #1 CRITICAL: the POSTER branch of guard_bookings_write did ZERO status-transition
--     validation, so a poster could force a booking straight to 'verified' (forging
--     an earner review for work never done) or cancel a settled/paid booking. Add
--     explicit transition validation mirroring the earner branch, and pin the
--     counterparty-owned fields (earner_done, completion_photos, amendment_note,
--     counter_offer, tip_amount) so the poster can't forge them.
--  #2 HIGH: nothing stopped two earners booking the same slot. Add a partial unique
--     index so a second ACTIVE booking on a slot fails atomically, and maintain
--     job_slots.taken from a trigger so the flag can never diverge from reality.
--  #3/#4 MEDIUM: earnings credit was a non-atomic check-then-act (double-credit race)
--     and the webhook never credited at all. Add an atomic SECURITY DEFINER
--     credit_earnings(payment_id) RPC that both functions call exactly once.
--  #9 LOW: job_slots UPDATE was USING(true) — anyone could flip any slot. Restrict
--     to the gig's poster (the taken trigger handles book/cancel).
--  #10 LOW: drop the dead cross-counterparty profiles UPDATE policy (recompute now
--     runs through a SECURITY DEFINER RPC) — owner-only again.
--  #11 LOW: bind reviews.role to the review direction so it can't be mislabeled.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── #1 CRITICAL — poster-path status validation + counterparty-field pinning ──
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
    return new;
  end if;

  -- Poster drives the lifecycle but may NOT re-point the booking, forge the
  -- earner's flags/proof, or make an illegal status jump.
  if auth.uid() = poster then
    new.earner_id         := old.earner_id;
    new.job_id            := old.job_id;
    new.earner_done       := old.earner_done;       -- earner owns their done-flag
    new.completion_photos := old.completion_photos; -- and their proof-of-work
    new.amendment_note    := old.amendment_note;    -- earner authors the request
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;         -- tips only via service role
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('confirmed','declined','cancelled'))
      or (old.status = 'confirmed' and new.status = 'cancelled')
      or (old.status = 'confirmed' and new.status = 'completed' and new.earner_done and new.poster_done)
      or (old.status = 'completed' and new.status = 'verified')
    ) then
      new.status := old.status;  -- reject any illegal transition
    end if;
    return new;
  end if;

  -- Earner may update only their own side.
  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;
    new.earner_id      := old.earner_id;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;
    new.amendment_note := old.amendment_note;
    new.tip_amount     := old.tip_amount;     -- earner can't forge a tip
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

-- ── #2 HIGH — one active booking per slot, enforced atomically ────────────────
create unique index if not exists bookings_one_active_per_slot
  on public.bookings (slot_id)
  where slot_id is not null and status in ('pending','confirmed','completed','verified');

-- Keep job_slots.taken authoritative from the DB, regardless of any client write.
create or replace function public.sync_slot_taken()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare s uuid;
begin
  s := coalesce(new.slot_id, old.slot_id);
  if s is not null then
    update public.job_slots set taken = exists (
      select 1 from public.bookings b
      where b.slot_id = s and b.status in ('pending','confirmed','completed','verified')
    ) where id = s;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_sync_slot_taken on public.bookings;
create trigger trg_sync_slot_taken
  after insert or update or delete on public.bookings
  for each row execute function public.sync_slot_taken();

-- ── #3/#4 MEDIUM — atomic, exactly-once earnings credit ───────────────────────
-- A single conditional UPDATE claims the credit (flips earnings_credited only if it
-- was false) and runs the profiles increment in the SAME transaction, so concurrent
-- callers (capture retry, webhook) can never double-credit, and a failure rolls the
-- whole thing back (the flag stays false) so a later retry still credits.
create or replace function public.credit_earnings(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount  integer;
  v_earner  uuid;
  v_dollars numeric;
begin
  update public.payments
     set earnings_credited = true
   where id = p_payment_id
     and coalesce(earnings_credited, false) = false
     and status = 'captured'
     and coalesce(earner_amount_cents, 0) > 0
   returning earner_amount_cents into v_amount;

  if v_amount is null then
    return false;  -- already credited, not captured, or nothing to credit
  end if;

  select b.earner_id into v_earner
    from public.payments p
    join public.bookings b on b.id = p.booking_id
   where p.id = p_payment_id;

  if v_earner is null then
    return false;
  end if;

  v_dollars := v_amount::numeric / 100;
  update public.profiles
     set earnings_today = coalesce(earnings_today, 0) + v_dollars,
         earnings_week  = coalesce(earnings_week,  0) + v_dollars,
         earnings_total = coalesce(earnings_total, 0) + v_dollars
   where id = v_earner;
  return true;
end;
$$;

revoke execute on function public.credit_earnings(uuid) from public, anon, authenticated;

-- ── #9 LOW — only the gig's poster may mutate its slots ───────────────────────
drop policy if exists "slots_update_any" on public.job_slots;
drop policy if exists "slots_update_poster" on public.job_slots;
create policy "slots_update_poster" on public.job_slots for update using (
  exists (select 1 from public.jobs j where j.id = job_slots.job_id and j.poster_id = auth.uid())
);

-- ── #10 LOW — owner-only profile UPDATE (drop the dead counterparty grant) ─────
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "users can update own profile" on public.profiles;
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- ── #11 LOW — bind reviews.role to the review direction (and to the booking) ───
drop policy if exists "reviews_insert_auth" on public.reviews;
create policy "reviews_insert_auth" on public.reviews for insert with check (
  auth.uid() = reviewer_id
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.status = 'verified'
      and b.job_id = reviews.job_id
      and (
        (j.poster_id = auth.uid() and b.earner_id = reviewed_user_id and role = 'earner')   -- poster rates the earner's work
        or (b.earner_id = auth.uid() and j.poster_id = reviewed_user_id and role = 'poster') -- earner rates the poster as a client
      )
  )
);
