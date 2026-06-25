-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 6 — database fixes. Applied via `supabase db push`.
--
--  #1 CRITICAL (reproducibility): the guard TRIGGERS that bind guard_bookings_write
--     / guard_profiles_write to their tables lived only in untracked standalone
--     files, so a tracked `db push` deployed the functions but never the triggers,
--     leaving bookings & profiles unguarded. Create the trigger bindings here, and
--     fold the other untracked hardening (stripe-table policies, guard_student_verified
--     search_path, party-scoped message insert, owner-only profile update) into the
--     tracked path so it reproduces the hardened live DB.
--  #2/#6 (regression): the round-5 poster branch pinned amendment_note — but the
--     POSTER authors the proposal, so it silently wiped the note. Let the poster
--     write it again.
--  #13: the poster branch never pinned amendment_status, so a poster could self-set
--     'accepted' and unlock locked core terms without the earner agreeing. Restrict
--     poster-driven amendment_status to 'pending' (propose) / 'none' (clear).
--  #8 (regression): #9's slot lockdown never dropped the round-3 slots_update_party
--     policy, so earners could still flip any slot they booked. Drop it.
--  #5/#10: credit tips atomically (was a lost-update read-modify-write).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── #2/#6/#13 — corrected bookings guard (amendment authoring + status) ───────
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

  -- Poster drives the lifecycle. They legitimately AUTHOR the amendment note, so it
  -- is not pinned here — but they may only PROPOSE ('pending') or CLEAR ('none') an
  -- amendment, never self-accept/decline it (that response is the earner's, and it
  -- unlocks locked core terms). All other counterparty-owned fields stay pinned.
  if auth.uid() = poster then
    new.earner_id         := old.earner_id;
    new.job_id            := old.job_id;
    new.earner_done       := old.earner_done;       -- earner owns their done-flag
    new.completion_photos := old.completion_photos; -- and their proof-of-work
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;         -- tips only via service role
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
      new.status := old.status;  -- reject any illegal transition
    end if;
    return new;
  end if;

  -- Earner may update only their own side (and must not forge the poster's note).
  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;
    new.earner_id      := old.earner_id;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;
    new.amendment_note := old.amendment_note;  -- poster authors the note
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

-- ── #1 — bind the guard triggers on the tracked path ──────────────────────────
drop trigger if exists trg_guard_bookings_write on public.bookings;
create trigger trg_guard_bookings_write
  before insert or update on public.bookings
  for each row execute function public.guard_bookings_write();

drop trigger if exists trg_guard_profiles_write on public.profiles;
create trigger trg_guard_profiles_write
  before update on public.profiles
  for each row execute function public.guard_profiles_write();

-- guard_student_verified: pin search_path if the function exists (it's defined in a
-- standalone file; skip cleanly on a base that doesn't have it yet).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'guard_student_verified'
             and pronamespace = 'public'::regnamespace) then
    execute 'alter function public.guard_student_verified() set search_path = public';
  end if;
end $$;

-- ── #8 — drop the lingering permissive slot-update policy ─────────────────────
drop policy if exists "slots_update_party" on public.job_slots;
drop policy if exists "slots_update_any"   on public.job_slots;
drop policy if exists "slots_update_poster" on public.job_slots;
create policy "slots_update_poster" on public.job_slots for update using (
  exists (select 1 from public.jobs j where j.id = job_slots.job_id and j.poster_id = auth.uid())
);

-- ── #4 (defense) — re-assert the hardened policies a fix_lifecycle re-run reverts
-- Party-scoped message insert (sender must be a party to the booking).
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id
      and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
  )
);
-- Owner-only profile update (recompute runs through a SECURITY DEFINER RPC now).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- ── #12 — stripe_* tables: clients may read their own row only (writes = service)
drop policy if exists "stripe_accounts_own"         on public.stripe_accounts;
drop policy if exists "stripe_accounts_select_own"  on public.stripe_accounts;
create policy "stripe_accounts_select_own" on public.stripe_accounts
  for select using (auth.uid() = user_id);
drop policy if exists "stripe_customers_own"        on public.stripe_customers;
drop policy if exists "stripe_customers_select_own" on public.stripe_customers;
create policy "stripe_customers_select_own" on public.stripe_customers
  for select using (auth.uid() = user_id);

-- ── #5/#10 — atomic tip credit (one row-locked UPDATE each; no lost updates) ──
create or replace function public.credit_tip(p_booking uuid, p_earner uuid, p_cents integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_cents is null or p_cents <= 0 then
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

revoke execute on function public.credit_tip(uuid, uuid, integer) from public, anon, authenticated;
