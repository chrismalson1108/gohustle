-- ============================================================
-- Migration: Fix Full Job Lifecycle + Messaging + Reviews
-- Safe to run multiple times (all statements are idempotent).
-- Run this in Supabase SQL Editor.
-- ============================================================

-- ── 1. Bookings: extra columns ──────────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_method   TEXT,
  ADD COLUMN IF NOT EXISTS earner_rating    NUMERIC(2,1),
  ADD COLUMN IF NOT EXISTS review_text      TEXT,
  ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS earner_done      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS poster_done      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS poster_rating    NUMERIC(2,1),
  ADD COLUMN IF NOT EXISTS poster_review    TEXT,
  ADD COLUMN IF NOT EXISTS amendment_note   TEXT,
  ADD COLUMN IF NOT EXISTS amendment_status TEXT DEFAULT 'none';

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_amendment_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_amendment_status_check
  CHECK (amendment_status IN ('none','pending','accepted','declined'));

-- Expand status enum (includes verified + declined)
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','confirmed','completed','verified','declined','cancelled'));

-- ── 2. Profiles: extra columns ──────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username            TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS bio                 TEXT,
  ADD COLUMN IF NOT EXISTS city                TEXT,
  ADD COLUMN IF NOT EXISTS skills              TEXT[],
  ADD COLUMN IF NOT EXISTS radius_miles        INTEGER DEFAULT 25,
  ADD COLUMN IF NOT EXISTS onboarding_done     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS poster_rating       NUMERIC(3,1) DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS poster_review_count INTEGER DEFAULT 0;

-- Expand role check to allow 'both'
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('earner','poster','both'));

-- ── 3. Reviews: add reviewed_user_id for profile display ───
-- Without this, there is no way to query "reviews about me"
ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS reviewed_user_id UUID REFERENCES public.profiles(id);

CREATE INDEX IF NOT EXISTS reviews_reviewed_user_idx
  ON public.reviews (reviewed_user_id);

-- ── 4. Bookings RLS: earner + poster can SELECT and UPDATE ─
DROP POLICY IF EXISTS "bookings_select_own"     ON public.bookings;
DROP POLICY IF EXISTS "bookings_poster_view"    ON public.bookings;
DROP POLICY IF EXISTS "bookings_update_own"     ON public.bookings;
DROP POLICY IF EXISTS "bookings_select_parties" ON public.bookings;
DROP POLICY IF EXISTS "bookings_update_parties" ON public.bookings;

CREATE POLICY "bookings_select_parties" ON public.bookings FOR SELECT USING (
  auth.uid() = earner_id
  OR EXISTS (SELECT 1 FROM public.jobs WHERE id = job_id AND poster_id = auth.uid())
);

CREATE POLICY "bookings_update_parties" ON public.bookings FOR UPDATE USING (
  auth.uid() = earner_id
  OR EXISTS (SELECT 1 FROM public.jobs WHERE id = job_id AND poster_id = auth.uid())
);

-- ── 5. Profiles RLS: both earner↔poster can update ratings ─
DROP POLICY IF EXISTS "profiles_update_own"              ON public.profiles;
DROP POLICY IF EXISTS "users can update own profile"     ON public.profiles;

CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (
  -- Own profile
  auth.uid() = id
  -- Earner can update poster's profile (ratePoster after verified)
  OR EXISTS (
    SELECT 1 FROM public.bookings b
    JOIN public.jobs j ON j.id = b.job_id
    WHERE b.earner_id = auth.uid()
      AND j.poster_id = profiles.id
      AND b.status = 'verified'
  )
  -- Poster can update earner's profile (verifyAndRate: rating + review_count)
  OR EXISTS (
    SELECT 1 FROM public.bookings b
    JOIN public.jobs j ON j.id = b.job_id
    WHERE j.poster_id = auth.uid()
      AND b.earner_id = profiles.id
      AND b.status = 'verified'
  )
);

-- ── 6. Messages table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID REFERENCES public.bookings(id) ON DELETE CASCADE NOT NULL,
  sender_id   UUID REFERENCES public.profiles(id) NOT NULL,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- SELECT: both parties can read messages on their booking
DROP POLICY IF EXISTS "messages_read" ON public.messages;
CREATE POLICY "messages_read" ON public.messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.bookings b
    JOIN public.jobs j ON j.id = b.job_id
    WHERE b.id = booking_id
      AND (b.earner_id = auth.uid() OR j.poster_id = auth.uid())
  )
);

-- INSERT: only require sender = authenticated user
-- (bookingId UUID is only obtainable by parties to the booking via the app)
DROP POLICY IF EXISTS "messages_insert" ON public.messages;
CREATE POLICY "messages_insert" ON public.messages FOR INSERT WITH CHECK (
  sender_id = auth.uid()
);

-- ── 7. Backfill: mark jobs as completed where a verified booking exists ─────
-- Fixes jobs that were completed before the status-update code was added.
UPDATE public.jobs
SET status = 'completed'
WHERE status = 'open'
  AND EXISTS (
    SELECT 1 FROM public.bookings
    WHERE job_id = jobs.id AND status = 'verified'
  );

-- ── 8. Backfill: set reviewed_user_id on reviews that predate the column ───
-- Matches reviews to verified bookings via job_id.
UPDATE public.reviews r
SET reviewed_user_id = (
  SELECT b.earner_id FROM public.bookings b
  WHERE b.job_id = r.job_id
    AND b.status = 'verified'
  LIMIT 1
)
WHERE r.reviewed_user_id IS NULL;

-- ── 9. Realtime: all tables that need live updates ──────────
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime
  FOR TABLE public.bookings, public.jobs, public.messages;
