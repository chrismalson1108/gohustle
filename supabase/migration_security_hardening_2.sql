-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SUPERSEDED — DO NOT RUN.                                                 ║
-- ║  These guard functions / RLS policies were rewritten and HARDENED in the ║
-- ║  tracked migrations supabase/migrations/2026062419xxxx..2406240000.       ║
-- ║  Re-running this file would REVERT the live DB to a weaker guard/policy   ║
-- ║  (e.g. the poster-path status check, slot ownership, column pins).        ║
-- ║  The tracked supabase/migrations/ files are the source of truth; apply    ║
-- ║  them with `supabase db push`. Kept only for historical reference.        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 2 (idempotent). Run in the Supabase SQL editor.
-- From the deep data-flow audit. Closes:
--   1. bookings (HIGH) — a user could INSERT a booking with status='verified' on
--      any poster's job (no status constraint), which then satisfied the round-1
--      reviews policy and let them fabricate reviews / tank a poster's rating.
--      Also: an earner could UPDATE their own booking to self-advance status
--      (pending→confirmed/verified) and write poster-only fields. Fixed with a
--      BEFORE INSERT/UPDATE guard trigger (mirrors guard_profiles_write):
--        • INSERT  → status forced to 'pending', flags cleared, self-booking blocked.
--        • UPDATE  → the earner may only set earner_done / amendment response /
--          'cancelled' (and 'completed' once the poster is already done); status
--          jumps and poster-only columns (rating/review/payment/poster_done/
--          counter_offer) revert. The poster still drives the lifecycle.
--   2. stripe_accounts / stripe_customers (LOW) — were client-writable (FOR ALL),
--      letting an earner self-set onboarded / payout account_id. Now SELECT-only;
--      all writes go through the service-role edge functions / Stripe webhook.
--   3. storage buckets (MEDIUM) — public image buckets accepted any MIME (incl.
--      image/svg+xml / text/html → stored content executable on the storage
--      origin). Now restricted to a safe raster allow-list + a size cap.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Bookings: status / column integrity guard --------------------------------
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
    -- An earner books: force a clean initial state and block booking your own gig.
    new.status      := 'pending';
    new.earner_done := false;
    new.poster_done := false;
    new.earner_rating := null;
    if new.earner_id = poster then
      raise exception 'You cannot book your own gig';
    end if;
    return new;
  end if;

  -- UPDATE. The poster owns the job and drives the lifecycle (RLS already scopes
  -- the row to this job's poster), so allow their writes.
  if auth.uid() = poster then
    return new;
  end if;

  -- The earner may update only their own side. Revert poster/settlement columns…
  if auth.uid() = old.earner_id then
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;     -- locked after booking
    new.amendment_note := old.amendment_note;     -- only the poster proposes the note
    -- …and constrain status: the earner may finish a mutually-done job or cancel,
    -- but cannot self-confirm/decline/verify (those are the poster's, or fraud).
    if new.status is distinct from old.status
       and not (new.status = 'completed' and old.poster_done)
       and new.status <> 'cancelled' then
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

-- 2. Stripe accounts/customers: client read-only (writes via service role) -----
drop policy if exists "stripe_accounts_own"        on public.stripe_accounts;
drop policy if exists "stripe_accounts_select_own" on public.stripe_accounts;
create policy "stripe_accounts_select_own" on public.stripe_accounts
  for select using (auth.uid() = user_id);

drop policy if exists "stripe_customers_own"        on public.stripe_customers;
drop policy if exists "stripe_customers_select_own" on public.stripe_customers;
create policy "stripe_customers_select_own" on public.stripe_customers
  for select using (auth.uid() = user_id);

-- 3. Storage: restrict public image buckets to safe raster types + size cap ----
-- (Excludes image/svg+xml and text/html, which execute on the storage origin.)
update storage.buckets
set allowed_mime_types = array['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','image/gif'],
    file_size_limit    = 10485760  -- 10 MB
where id in ('avatars', 'job-photos', 'chat-photos', 'completion-photos');
