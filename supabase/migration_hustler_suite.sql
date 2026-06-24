-- ─────────────────────────────────────────────────────────────────────────────
-- Hustler Power Suite — foundation (idempotent, additive). Run in the SQL editor.
--
-- Adds the data model for: a monthly earning goal (Finance Coach), work status +
-- weekly availability windows + a class schedule (Availability), and persistent
-- AI assistant conversations (chat history). All additive — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Finance — monthly earning goal -------------------------------------------
alter table public.profiles
  add column if not exists monthly_earning_goal numeric(10,2) not null default 1000;

-- 2. Availability & work status -----------------------------------------------
-- work_status: a quick "ready to work / busy / away / offline" signal.
-- availability: weekly free windows, a jsonb array of { day:0-6 (0=Sun), start:'HH:MM', end:'HH:MM' }.
alter table public.profiles add column if not exists work_status      text not null default 'available';
alter table public.profiles add column if not exists work_status_note text;
alter table public.profiles add column if not exists availability     jsonb not null default '[]';
do $$ begin
  alter table public.profiles add constraint profiles_work_status_chk
    check (work_status in ('available','busy','away','offline'));
exception when duplicate_object then null; end $$;

-- 3. Class schedule (owner-private) -------------------------------------------
-- The student's classes carve out the time they CAN'T work. days = int[] of 0-6.
create table if not exists public.class_schedule (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade not null,
  title      text not null,
  days       int[] not null default '{}',
  start_time text not null,   -- 'HH:MM'
  end_time   text not null,   -- 'HH:MM'
  location   text,
  term       text,
  created_at timestamptz default now()
);
create index if not exists idx_class_schedule_user on public.class_schedule(user_id);
alter table public.class_schedule enable row level security;
do $$ begin
  create policy class_schedule_owner on public.class_schedule
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- 4. Persistent AI assistant conversations ------------------------------------
-- One thread per conversation; messages are the user/assistant text turns. Owner
-- RLS only — nobody else can read a user's chats.
create table if not exists public.assistant_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade not null,
  title      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_assistant_threads_user on public.assistant_threads(user_id, updated_at desc);
alter table public.assistant_threads enable row level security;
do $$ begin
  create policy assistant_threads_owner on public.assistant_threads
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

create table if not exists public.assistant_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid references public.assistant_threads(id) on delete cascade not null,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  created_at timestamptz default now()
);
create index if not exists idx_assistant_messages_thread on public.assistant_messages(thread_id, created_at);
alter table public.assistant_messages enable row level security;
do $$ begin
  create policy assistant_messages_owner on public.assistant_messages
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
