-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 2 — database fixes. Applied via `supabase db push`.
--   #1 CRITICAL: instant_book_confirm auto-confirmed bookings WITHOUT creating
--      escrow (earner worked for free). Drop the trigger so instant-book gigs go
--      through the normal poster-accept → escrow flow. (Also fixes #11 audience.)
--   #2 HIGH: reviews.job_id → jobs CASCADE deleted earners' WORK reviews when a
--      poster deleted their account. Make it SET NULL (drop the NOT NULL first so
--      the cascade can null it) — reviews ABOUT the deleted user still cascade via
--      reviewed_user_id; third-party earners keep their earned ratings.
--   #4 HIGH: guard_bookings_write let the POSTER re-point earner_id/job_id on a
--      booking (then forge a 'verified' review of any victim). Pin both on the
--      poster path too. (#12: also pin tip_amount on the earner path.)
--   #5 MEDIUM: earnings_* were world-readable after the round-6 column grant.
--      Revoke them (owner reads via my_profile()).
--   #13 LOW: add `set search_path` to the SECURITY DEFINER guard functions.
-- ─────────────────────────────────────────────────────────────────────────────

-- #1 — remove the un-escrowed instant-confirm path -----------------------------
drop trigger if exists trg_instant_book_confirm on public.bookings;
drop function if exists public.instant_book_confirm();

-- #2 — reviews.job_id must survive a job/poster deletion -----------------------
alter table public.reviews alter column job_id drop not null;
alter table public.reviews drop constraint if exists reviews_job_id_fkey;
alter table public.reviews add constraint reviews_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete set null;

-- #4 + #12 + #13 — bookings guard: pin immutable cols on BOTH party paths -------
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

  -- Poster drives the lifecycle, but may NOT change who the earner is or re-point
  -- the gig (that would let them forge a verified review of an arbitrary victim).
  if auth.uid() = poster then
    new.earner_id := old.earner_id;
    new.job_id    := old.job_id;
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

-- #13 — same hardening on the profiles guard ----------------------------------
create or replace function public.guard_profiles_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  locked public.profiles;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if auth.uid() = old.id then
    new.verified               := old.verified;
    new.id_verification_status := old.id_verification_status;
    new.rating                 := old.rating;
    new.review_count           := old.review_count;
    new.poster_rating          := old.poster_rating;
    new.poster_review_count    := old.poster_review_count;
    return new;
  end if;

  locked := old;
  locked.rating              := new.rating;
  locked.review_count        := new.review_count;
  locked.poster_rating       := new.poster_rating;
  locked.poster_review_count := new.poster_review_count;
  return locked;
end;
$$;

-- #5 — earnings columns must not be world-readable -----------------------------
revoke select (earnings_today, earnings_week, earnings_total) on public.profiles from anon, authenticated;
