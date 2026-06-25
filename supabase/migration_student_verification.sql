-- ─────────────────────────────────────────────────────────────────────────────
-- College Identity & Verified Student
-- Idempotent — safe to run multiple times in the Supabase SQL editor.
--
-- Adds self-reported college fields to profiles, a separate "Verified Student"
-- trust signal (distinct from Stripe-Identity `verified`), a verifications table
-- for the .edu email one-time-code flow, and a trigger that prevents users from
-- self-setting the verified flag (only the edge functions, running as the service
-- role, may flip it). Architected so an authoritative provider (SheerID / VerifyPass)
-- can later set student_verify_method='sheerid' via webhook.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Profile columns ----------------------------------------------------------
alter table public.profiles add column if not exists school                text;
alter table public.profiles add column if not exists school_domain         text;
alter table public.profiles add column if not exists major                 text;
alter table public.profiles add column if not exists degree_type           text;
alter table public.profiles add column if not exists class_standing        text;
alter table public.profiles add column if not exists grad_year             integer;
alter table public.profiles add column if not exists student_status        text default 'none';
alter table public.profiles add column if not exists student_verified      boolean not null default false;
alter table public.profiles add column if not exists student_verified_at   timestamptz;
alter table public.profiles add column if not exists student_verify_method text;

-- student_status: 'none' | 'student' | 'alumni'
do $$ begin
  alter table public.profiles
    add constraint profiles_student_status_chk
    check (student_status in ('none','student','alumni'));
exception when duplicate_object then null; end $$;

-- Helps the "verified students only" / campus filters.
create index if not exists idx_profiles_student_verified on public.profiles(student_verified) where student_verified;
create index if not exists idx_profiles_school on public.profiles(school);

-- 2. Verification attempts table (codes stored hashed) ------------------------
create table if not exists public.student_email_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  email       text not null,
  domain      text,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  consumed    boolean not null default false,
  created_at  timestamptz default now()
);
create index if not exists idx_student_verif_user on public.student_email_verifications(user_id, created_at desc);

-- Locked down: only the service role (edge functions) touches this table. No
-- policies → with RLS enabled, authenticated/anon clients get nothing; the
-- service role bypasses RLS.
alter table public.student_email_verifications enable row level security;

-- 3. Anti-spoof trigger -------------------------------------------------------
-- Users may freely edit school/major/etc., but NOT the verified flag/method.
-- Any non-service-role UPDATE has those columns reverted to their prior values.
create or replace function public.guard_student_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.student_verified      := old.student_verified;
    new.student_verified_at   := old.student_verified_at;
    new.student_verify_method := old.student_verify_method;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_student_verified on public.profiles;
create trigger trg_guard_student_verified
  before update on public.profiles
  for each row execute function public.guard_student_verified();
