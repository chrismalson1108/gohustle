-- Audit log of images the moderate-image edge function rejected. One row per
-- blocked upload — the object is already deleted from Storage by the function.
-- Used for admin review and repeat-offender detection. Written by the service
-- role only (the edge function); no client policies.
create table if not exists public.moderation_flags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade,
  bucket     text not null,
  path       text,
  categories text[] not null default '{}',
  reason     text,
  created_at timestamptz not null default now()
);

create index if not exists idx_moderation_flags_user on public.moderation_flags(user_id, created_at desc);

alter table public.moderation_flags enable row level security;
-- No client policies: RLS-enabled with no grants means only the service role
-- (edge function / admin console) can read or write. Mirrors push_send_rate.
