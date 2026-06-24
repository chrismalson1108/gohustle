-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening (idempotent — safe to re-run). Run in the Supabase SQL editor.
--
-- Closes pre-beta audit findings on cross-user / unauthorized writes:
--   1. profiles  — a verified-booking counterparty (or the row owner) could write
--                  ANY column: forge `verified` / `id_verification_status`, alter
--                  earnings/name/bio, or self-assign ratings. Postgres RLS cannot
--                  scope columns, so a BEFORE UPDATE trigger reverts protected
--                  columns for every non-service-role writer.
--   2. messages  — INSERT only checked sender_id = auth.uid(); now also requires
--                  the sender to be a party (earner or poster) of the booking.
--   3. reviews   — INSERT allowed fabricated reviews about arbitrary users; now
--                  requires a 'verified' booking between reviewer and reviewed_user.
--
-- The rating recompute (JobsContext.recomputeRatings / web jobs.tsx) writes ONLY
-- rating/review_count/poster_rating/poster_review_count, exactly the columns the
-- trigger still permits a counterparty to set — so the legitimate flow is intact.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Profiles: protect identity / trust / rating columns ----------------------
create or replace function public.guard_profiles_write()
returns trigger
language plpgsql
security definer
as $$
declare
  locked public.profiles;
begin
  -- Backend / edge functions (service role) are trusted (Stripe webhooks set
  -- `verified`, recompute could be moved here later, etc.).
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if auth.uid() = old.id then
    -- Owner may edit their own row, but cannot forge identity/trust badges or
    -- self-assign ratings (those come from Stripe Identity + peer reviews).
    new.verified               := old.verified;
    new.id_verification_status := old.id_verification_status;
    new.rating                 := old.rating;
    new.review_count           := old.review_count;
    new.poster_rating          := old.poster_rating;
    new.poster_review_count    := old.poster_review_count;
    return new;
  end if;

  -- A counterparty (permitted by the cross-user rating UPDATE policy) may change
  -- ONLY the rating cache columns; every other column reverts to its prior value.
  locked := old;
  locked.rating              := new.rating;
  locked.review_count        := new.review_count;
  locked.poster_rating       := new.poster_rating;
  locked.poster_review_count := new.poster_review_count;
  return locked;
end;
$$;

drop trigger if exists trg_guard_profiles_write on public.profiles;
create trigger trg_guard_profiles_write
  before update on public.profiles
  for each row execute function public.guard_profiles_write();

-- 2. Messages: sender must be a party to the booking --------------------------
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

-- 3. Reviews: require a real verified booking between the two parties ----------
drop policy if exists "reviews_insert_auth" on public.reviews;
create policy "reviews_insert_auth" on public.reviews for insert with check (
  auth.uid() = reviewer_id
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.status = 'verified'
      and (
        (j.poster_id = auth.uid() and b.earner_id = reviewed_user_id)   -- poster → earner
        or (b.earner_id = auth.uid() and j.poster_id = reviewed_user_id) -- earner → poster
      )
  )
);
