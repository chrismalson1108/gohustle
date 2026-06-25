-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 4 — database fixes (via `supabase db push`).
--   #4 (the real review-flooding fix): the reviews INSERT policy only required
--      SOME verified booking between the two parties — not one on the review's
--      job. So an attacker with a single verified booking could insert reviews
--      with arbitrary OTHER job_ids (each distinct, so the round-3 unique index
--      didn't stop them). Bind the review to a verified booking on THE SAME job.
--   #3: the .edu one-account rule was an app-level TOCTOU race. Back it with a
--      partial unique index so a concurrent second consume fails atomically.
--   #6: mutual-completion had no server arbiter — a concurrent mark-done could
--      leave both done-flags true but status stuck at 'confirmed'. Add a trigger
--      that advances to 'completed' when both flags are set.
-- ─────────────────────────────────────────────────────────────────────────────

-- #4 — bind the review to a real verified booking ON THE SAME job
drop policy if exists "reviews_insert_auth" on public.reviews;
create policy "reviews_insert_auth" on public.reviews for insert with check (
  auth.uid() = reviewer_id
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.status = 'verified'
      and b.job_id = reviews.job_id
      and (
        (j.poster_id = auth.uid() and b.earner_id = reviewed_user_id)   -- poster -> earner
        or (b.earner_id = auth.uid() and j.poster_id = reviewed_user_id) -- earner -> poster
      )
  )
);

-- #3 — one consumed .edu verification per email (atomic at the DB)
create unique index if not exists uniq_consumed_student_email
  on public.student_email_verifications (email) where consumed;

-- #6 — server arbiter: advance to completed once BOTH sides are done
create or replace function public.advance_mutual_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.earner_done and new.poster_done and new.status = 'confirmed' then
    new.status := 'completed';
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_advance_mutual_completion on public.bookings;
create trigger trg_advance_mutual_completion
  before update on public.bookings
  for each row execute function public.advance_mutual_completion();
