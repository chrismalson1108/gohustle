-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 5 (idempotent). Run in the Supabase SQL editor.
-- Fixes found by the final whole-codebase review:
--   1. INSTANT BOOK regression — guard_bookings_write forces every INSERT to
--      'pending', which silently broke the instant-book feature. A dedicated
--      BEFORE INSERT trigger (runs AFTER the guard, service-definer) re-confirms a
--      booking when the target job is genuinely instant_book and has no counter-
--      offer. This keeps the self-confirm hole closed (only instant_book gigs auto-
--      confirm) and makes instant book work consistently on web AND mobile.
--   2. guard_bookings_write — the earner could cancel from ANY status (incl.
--      completed/verified after capture) and could re-point job_id/earner_id. Now
--      a cancel is allowed only from pending/confirmed, and job_id/earner_id are
--      pinned to their old values for earner writes.
--   3. job_slots / job_requirements had no DELETE policy, so editing a gig (delete-
--      then-reinsert) silently duplicated rows. Add owner-scoped DELETE policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 & 2. Rewritten bookings guard ---------------------------------------------
create or replace function public.guard_bookings_write()
returns trigger
language plpgsql
security definer
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

  -- UPDATE. The poster drives the lifecycle (RLS scopes the row to their job).
  if auth.uid() = poster then
    return new;
  end if;

  -- The earner may update only their own side.
  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;        -- can't re-point the booking to another gig
    new.earner_id      := old.earner_id;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer; -- locked after booking
    new.amendment_note := old.amendment_note; -- only the poster proposes the note
    -- Status: the earner may finish a mutually-done job, or cancel a booking that
    -- has NOT yet reached a terminal/settled state. Everything else reverts.
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

drop trigger if exists trg_guard_bookings_write on public.bookings;
create trigger trg_guard_bookings_write
  before insert or update on public.bookings
  for each row execute function public.guard_bookings_write();

-- 1. Instant-book auto-confirm (runs AFTER the guard; service-definer) ---------
create or replace function public.instant_book_confirm()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Only a clean pending booking with no counter-offer on an instant-book gig.
  if new.status = 'pending' and new.counter_offer is null then
    if exists (select 1 from public.jobs j where j.id = new.job_id and j.instant_book = true) then
      new.status := 'confirmed';
    end if;
  end if;
  return new;
end;
$$;

-- Name sorts after trg_guard_bookings_write so the guard's pending-force runs first.
drop trigger if exists trg_instant_book_confirm on public.bookings;
create trigger trg_instant_book_confirm
  before insert on public.bookings
  for each row execute function public.instant_book_confirm();

-- 3. DELETE policies for gig sub-rows (owner only) ----------------------------
drop policy if exists "slots_delete_poster" on public.job_slots;
create policy "slots_delete_poster" on public.job_slots for delete using (
  exists (select 1 from public.jobs j where j.id = job_slots.job_id and j.poster_id = auth.uid())
);

drop policy if exists "reqs_delete_poster" on public.job_requirements;
create policy "reqs_delete_poster" on public.job_requirements for delete using (
  exists (select 1 from public.jobs j where j.id = job_requirements.job_id and j.poster_id = auth.uid())
);
