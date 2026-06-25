-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 3 — database fixes (via `supabase db push`).
--   #2 HIGH: one verified booking authorized UNLIMITED review rows, so a
--      counterparty could flood reviews to inflate/destroy a rating. Enforce ONE
--      review per (job, reviewer, reviewed, role) with a unique index (dedupe
--      any existing duplicates first). Now the server recompute reflects truth.
--   #5 MEDIUM: the profiles guard owner-branch didn't pin earnings_*, so a user
--      could PATCH their own earnings_today/week/total (faking the dashboard + tax
--      totals). Pin them — only the service-role capture path may credit earnings.
-- ─────────────────────────────────────────────────────────────────────────────

-- #2 — dedupe then enforce one review per party per job/direction
delete from public.reviews r using public.reviews r2
where r.ctid > r2.ctid
  and r.job_id = r2.job_id
  and r.reviewer_id = r2.reviewer_id
  and r.reviewed_user_id = r2.reviewed_user_id
  and r.role = r2.role;

create unique index if not exists reviews_one_per_party_per_job
  on public.reviews (job_id, reviewer_id, reviewed_user_id, role);

-- #5 — pin earnings columns in the profiles guard owner-branch
create or replace function public.guard_profiles_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- the SECURITY DEFINER recompute RPC sets this transaction-local flag
  if current_setting('app.recompute', true) = 'on' then
    return new;
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() = old.id then
    -- owner may edit their own row, but cannot forge trust badges, self-rate,
    -- or fabricate earnings (those are credited only by the capture edge fn).
    new.verified               := old.verified;
    new.id_verification_status := old.id_verification_status;
    new.rating                 := old.rating;
    new.review_count           := old.review_count;
    new.poster_rating          := old.poster_rating;
    new.poster_review_count    := old.poster_review_count;
    new.earnings_today         := old.earnings_today;
    new.earnings_week          := old.earnings_week;
    new.earnings_total         := old.earnings_total;
    return new;
  end if;
  -- any non-owner direct write is fully reverted
  return old;
end;
$$;
