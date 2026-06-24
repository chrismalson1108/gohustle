-- ═══════════════════════════════════════════════════════════════════════════════
-- GoHustlr — consolidated security/privacy/compliance migration (2026-06-24)
-- Run the WHOLE file in the Supabase SQL editor. Every statement is idempotent,
-- so it is safe to run even if you have already applied some of these pieces.
-- Order does not matter between sections; they have no cross-dependencies.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ###############################################################################
-- ## SOURCE: supabase/migration_security_hardening.sql
-- ###############################################################################
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


-- ###############################################################################
-- ## SOURCE: supabase/migration_security_hardening_2.sql
-- ###############################################################################
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


-- ###############################################################################
-- ## SOURCE: supabase/migration_security_hardening_3.sql
-- ###############################################################################
-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 3 (idempotent). Run in the Supabase SQL editor.
--   1. job_slots — UPDATE policy was `using (true)`: any user could flip any
--      slot's `taken` flag (griefing / double-book). Now only the job's poster
--      or a user who has actually booked that job may update its slots.
--   2. jobs.lat/lng — backfill existing rows to a ~1km grid so previously-posted
--      gigs don't keep exposing a poster's exact coordinates publicly (new posts
--      are already coarsened on write).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. job_slots: only the poster or a booker of the job may change its slots -----
drop policy if exists "slots_update_any"   on public.job_slots;
drop policy if exists "slots_update_party" on public.job_slots;
create policy "slots_update_party" on public.job_slots for update using (
  exists (select 1 from public.jobs j     where j.id = job_slots.job_id and j.poster_id = auth.uid())
  or exists (select 1 from public.bookings b where b.job_id = job_slots.job_id and b.earner_id = auth.uid())
);

-- 2. Coarsen any precise coordinates already stored on public listings ---------
update public.jobs set lat = round(lat::numeric, 2) where lat is not null;
update public.jobs set lng = round(lng::numeric, 2) where lng is not null;


-- ###############################################################################
-- ## SOURCE: supabase/migration_security_hardening_4.sql
-- ###############################################################################
-- ─────────────────────────────────────────────────────────────────────────────
-- Security hardening — round 4 (idempotent). Run in the Supabase SQL editor.
-- Referrals: block self-referral (a user crediting themselves as their own
-- referrer). The insert policy already pins referred_id to the caller; this also
-- requires the referrer to be a different person. Low impact (no automatic
-- reward is attached to a referral) but closes the audit's referral-integrity note.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "referrals_insert_self" on public.referrals;
create policy "referrals_insert_self" on public.referrals for insert
  with check (auth.uid() = referred_id and referrer_id <> referred_id);


-- ###############################################################################
-- ## SOURCE: supabase/migration_assistant_rate_limit.sql
-- ###############################################################################
-- ─────────────────────────────────────────────────────────────────────────────
-- Hustlr AI rate-limit table (idempotent). Run in the Supabase SQL editor.
-- Backs a per-user request cap in the `assistant` edge function so a scripted
-- loop can't run up unbounded Anthropic API cost (deep-audit high finding).
-- RLS is enabled with NO client policies → only the service-role edge function
-- can read/write it; the anon/user client cannot see or tamper with counts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.assistant_rate (
  id         bigserial primary key,
  user_id    uuid        not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_rate_user_time
  on public.assistant_rate (user_id, created_at);

alter table public.assistant_rate enable row level security;


-- ###############################################################################
-- ## SOURCE: supabase/migration_account_deletion.sql
-- ###############################################################################
-- ─────────────────────────────────────────────────────────────────────────────
-- Account deletion support (idempotent). Run in the Supabase SQL editor.
--
-- Apple Guideline 5.1.1(v) + Google Play + GDPR/CCPA require in-app, user-
-- initiated account deletion. Deleting the auth user cascades to the profile
-- (profiles.id → auth.users ON DELETE CASCADE), and from the profile to all
-- user-scoped tables — EXCEPT six foreign keys that were declared with no ON
-- DELETE action and would block the delete. This migration fixes those so a
-- single `auth.admin.deleteUser()` (from the delete-account edge function)
-- cleanly erases the user and their data.
--
-- Choices (common marketplace practice):
--   • bookings (earner_id, job_id), messages (sender_id), reviews (reviewed_user_id,
--     job_id) → CASCADE: the user's own bookings/messages and reviews ABOUT them
--     are removed with the account.
--   • reviews.reviewer_id → SET NULL: reviews the user WROTE about OTHER people are
--     kept (so the reviewed person's rating history stays intact) but de-identified.
--   • Financial records of record live in Stripe; local payment rows cascade away
--     with the booking. Retain anything you're legally required to keep in Stripe.
-- ─────────────────────────────────────────────────────────────────────────────

-- bookings.earner_id → cascade
alter table public.bookings drop constraint if exists bookings_earner_id_fkey;
alter table public.bookings add constraint bookings_earner_id_fkey
  foreign key (earner_id) references public.profiles(id) on delete cascade;

-- bookings.job_id → cascade (so deleting the poster's jobs removes their bookings)
alter table public.bookings drop constraint if exists bookings_job_id_fkey;
alter table public.bookings add constraint bookings_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete cascade;

-- messages.sender_id → cascade
alter table public.messages drop constraint if exists messages_sender_id_fkey;
alter table public.messages add constraint messages_sender_id_fkey
  foreign key (sender_id) references public.profiles(id) on delete cascade;

-- reviews.reviewer_id → set null (keep the review, anonymize the author)
alter table public.reviews drop constraint if exists reviews_reviewer_id_fkey;
alter table public.reviews add constraint reviews_reviewer_id_fkey
  foreign key (reviewer_id) references public.profiles(id) on delete set null;

-- reviews.reviewed_user_id → cascade (remove reviews about the deleted user)
alter table public.reviews drop constraint if exists reviews_reviewed_user_id_fkey;
alter table public.reviews add constraint reviews_reviewed_user_id_fkey
  foreign key (reviewed_user_id) references public.profiles(id) on delete cascade;

-- reviews.job_id → cascade (so deleting the poster's jobs removes their reviews)
alter table public.reviews drop constraint if exists reviews_job_id_fkey;
alter table public.reviews add constraint reviews_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete cascade;


-- ###############################################################################
-- ## SOURCE: supabase/migration_privacy_update.sql
-- ###############################################################################
-- ─────────────────────────────────────────────────────────────────────────────
-- Privacy Policy v2026-06-24 (idempotent). Run in the Supabase SQL editor.
-- Publishing a new (slug='privacy', version) row makes it the current doc; the
-- consent gate then re-prompts every user to accept it (no app release needed).
-- Adds: precise/GPS location disclosure, in-app account deletion, data-retention
-- statement, and GDPR/CCPA rights — closing the audit's privacy-disclosure gap.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.legal_documents (slug, version, title, body) values
('privacy', '2026-06-24', 'Privacy Policy', $doc$Last updated: 2026-06-24

This Privacy Policy explains what we collect, how we use it, and your rights.

1. Information we collect. Account details (name, email, username, photo), profile info (bio, city, school, skills), gig and booking activity, messages, reviews, photos you upload, expense/income records you enter, device push tokens, and payment information processed by Stripe. With your permission, we also collect your device's precise location (GPS) to sort nearby gigs by distance and show them on a map. Precise location is collected only while you are using the app, is optional, and you can turn it off anytime in your device settings.

2. How we use it. To operate the marketplace, match Posters and Earners, sort and map gigs by distance, process payments and payouts, send notifications, verify identity, prevent fraud and abuse, and improve the product.

3. Sharing. We share information between the Poster and Earner of a booking as needed to coordinate work. We use service providers (Supabase for data and storage, Stripe for payments and identity verification, Expo for push notifications, and Anthropic for the in-app AI assistant) who process data on our behalf. We do not sell your personal information.

4. Payments. Card, payout, and identity-verification data is handled by Stripe under its own terms and privacy policy. We do not store full card numbers.

5. Your choices and account deletion. You can edit your profile and delete content you created at any time. You can permanently delete your account and personal data from within the app at Profile > Settings > Delete account. You can disable push notifications and location access in your device settings.

6. Data retention. We keep your information while your account is active. When you delete your account we delete your personal data and de-identify reviews you wrote about other people. Records we are legally required to retain — for example payment and tax records — are kept by our payment processor (Stripe) for the period required by law.

7. Your rights. Depending on where you live (including under the GDPR and the CCPA), you may have the right to access, correct, delete, or export your personal data, and to object to or restrict certain processing. We do not sell personal information or use it for cross-context behavioral advertising. To exercise these rights, use the in-app controls above or contact us.

8. Security. We use access controls, row-level security, and encryption in transit. No system is perfectly secure.

9. Children. GoHustlr is for users 18 and older. We do not knowingly collect personal information from anyone under 18.

10. Contact. Questions or data requests: mainmail@gohustlr.com$doc$)
on conflict (slug, version) do nothing;

