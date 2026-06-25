-- ─────────────────────────────────────────────────────────────────────────────
-- Deep-review round 2 — database fixes, part 2 (via `supabase db push`).
--   #10: ratings were computed CLIENT-side and a counterparty could PATCH any
--      rating/review_count value directly. Move the recompute into a SECURITY
--      DEFINER RPC that derives the values from the reviews table, and stop
--      letting non-owners write profile columns at all (the guard now reverts
--      every non-owner write; the RPC bypasses it via a transaction-local flag).
--   #6/#9: the earner earnings credit in stripe-capture-payment was lost forever
--      if its write failed (the alreadyCaptured retry short-circuits before it).
--      Add payments.earnings_credited so the credit is idempotent + recoverable.
-- ─────────────────────────────────────────────────────────────────────────────

-- #6/#9 — idempotent earnings credit flag
alter table public.payments add column if not exists earnings_credited boolean not null default false;

-- #10 — server-side, tamper-proof rating recompute (derives from reviews only)
create or replace function public.recompute_user_rating(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- transaction-local flag so guard_profiles_write permits THIS write only
  perform set_config('app.recompute', 'on', true);
  update public.profiles p set
    rating              = coalesce((select round(avg(rating)::numeric, 2) from public.reviews where reviewed_user_id = target), 5),
    review_count        = (select count(*) from public.reviews where reviewed_user_id = target),
    poster_rating       = coalesce((select round(avg(rating)::numeric, 2) from public.reviews where reviewed_user_id = target and role = 'poster'), 5),
    poster_review_count = (select count(*) from public.reviews where reviewed_user_id = target and role = 'poster')
  where p.id = target;
end;
$$;
revoke execute on function public.recompute_user_rating(uuid) from public;
grant execute on function public.recompute_user_rating(uuid) to authenticated;

-- #10 — profiles guard: non-owners can no longer write ANY column directly; only
-- the recompute RPC (which sets app.recompute) may touch the rating cache.
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
    -- owner may edit their own row, but cannot forge trust badges or self-rate
    new.verified               := old.verified;
    new.id_verification_status := old.id_verification_status;
    new.rating                 := old.rating;
    new.review_count           := old.review_count;
    new.poster_rating          := old.poster_rating;
    new.poster_review_count    := old.poster_review_count;
    return new;
  end if;
  -- any non-owner direct write is fully reverted
  return old;
end;
$$;
