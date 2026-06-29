-- Job hazards: safety notes / hazards a poster lists on a gig so applicants are
-- warned (e.g. "dog on site", "uneven ground", "fragile items"). Shown as a
-- prominent safety warning on job detail + a subtle indicator on job cards.
-- Additive + safe for the live app (existing code ignores the column; default
-- keeps existing rows valid).
alter table public.jobs
  add column if not exists hazards text[] not null default '{}';
