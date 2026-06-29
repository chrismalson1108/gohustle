-- Before photos: a parallel array to bookings.completion_photos so a gig can carry
-- a "before & after" pair. The earner uploads optional "before" images (same public
-- "completion-photos" storage bucket as the after/completion photos) when marking the
-- job done; the poster sees the before group above the after group when verifying.
-- Additive + safe for the live app (existing code ignores the column; NOT NULL with a
-- default keeps existing rows valid).
alter table public.bookings
  add column if not exists before_photos text[] not null default '{}';

comment on column public.bookings.before_photos is
  'Optional "before" proof-of-work images (URLs in the public completion-photos bucket); paired with completion_photos as the "after" set.';
