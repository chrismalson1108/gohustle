-- Application cover note: an optional short note an applicant includes when they
-- book/apply to a gig ("I'm a great fit because I've done lawn care for 5 years").
-- The poster sees it when reviewing applicants. Additive + safe for the live app
-- (existing code ignores the column; nullable keeps existing rows valid).
alter table public.bookings
  add column if not exists application_note text;
