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
