-- Per-user notification preferences: per-category (bookings / messages /
-- payments / marketing) x per-channel (push / email). The send-push edge
-- function reads this row with the service role before delivering: it gates the
-- OS push on *_push and sends a Resend email on *_email. The in-app Alerts inbox
-- is always written regardless (it's the passive notification center, not an
-- interruptive channel).
--
-- Missing row => code-side defaults kick in (see DEFAULT_NOTIF_PREFS in
-- src/lib/notifications.js and the defaults below): every category pushes;
-- only the high-value categories (bookings, payments) email by default, so the
-- out-of-the-box email posture is "high-value only". Users can opt into more.
create table if not exists public.notification_preferences (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  bookings_push   boolean not null default true,
  bookings_email  boolean not null default true,
  messages_push   boolean not null default true,
  messages_email  boolean not null default false,
  payments_push   boolean not null default true,
  payments_email  boolean not null default true,
  marketing_push  boolean not null default true,
  marketing_email boolean not null default false,
  updated_at      timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

-- Owner-only: a user may read and write exactly their own preferences row.
do $$ begin
  create policy notif_prefs_owner_select on public.notification_preferences
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy notif_prefs_owner_insert on public.notification_preferences
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy notif_prefs_owner_update on public.notification_preferences
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
