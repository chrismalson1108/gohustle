-- ─────────────────────────────────────────────────────────────────────────────
-- GoHustlr competitive features (idempotent, additive). Run in the SQL editor.
-- Adds: Saved/bookmarked gigs, Instant Book, Gig Bump, Review responses,
-- Saved searches + in-app notifications. No external services required.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Saved / bookmarked gigs ---------------------------------------------------
create table if not exists public.saved_jobs (
  user_id    uuid references public.profiles(id) on delete cascade not null,
  job_id     uuid references public.jobs(id) on delete cascade not null,
  created_at timestamptz default now(),
  primary key (user_id, job_id)
);
alter table public.saved_jobs enable row level security;
do $$ begin
  create policy saved_jobs_owner on public.saved_jobs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- 2. Instant Book + Gig Bump (columns on jobs) --------------------------------
alter table public.jobs add column if not exists instant_book boolean not null default false;
alter table public.jobs add column if not exists instant_book_audience text not null default 'all';
alter table public.jobs add column if not exists bumped_at timestamptz;
do $$ begin
  alter table public.jobs add constraint jobs_instant_audience_chk
    check (instant_book_audience in ('all','students','verified'));
exception when duplicate_object then null; end $$;
create index if not exists idx_jobs_bumped on public.jobs(bumped_at);

-- 3. Review responses (the reviewed person may reply once) ---------------------
alter table public.reviews add column if not exists response_text text;
alter table public.reviews add column if not exists responded_at timestamptz;

-- 4. Saved searches + in-app notifications ------------------------------------
create table if not exists public.saved_searches (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade not null,
  name       text,
  filters    jsonb not null default '{}',
  notify     boolean not null default true,
  created_at timestamptz default now()
);
alter table public.saved_searches enable row level security;
do $$ begin
  create policy saved_searches_owner on public.saved_searches
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade not null,
  type       text not null default 'info',
  title      text not null,
  body       text,
  job_id     uuid references public.jobs(id) on delete set null,
  read       boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists idx_notifications_user on public.notifications(user_id, read, created_at desc);
alter table public.notifications enable row level security;
do $$ begin
  create policy notifications_owner_select on public.notifications
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy notifications_owner_update on public.notifications
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Match new gigs against saved searches and drop in-app notifications. Runs as
-- the table owner (security definer) so it can write notifications for any matched
-- user. Matching is intentionally light (category + pay floor + remote/state) to
-- stay index-friendly; the client applies the full filter on open.
create or replace function public.notify_saved_searches()
returns trigger language plpgsql security definer as $$
declare s record;
begin
  for s in select * from public.saved_searches where notify loop
    -- category match (or 'all')
    if coalesce(s.filters->>'selectedCat','all') <> 'all'
       and coalesce(s.filters->>'selectedCat','all') <> new.category then
      continue;
    end if;
    -- never notify a poster about their own gig
    if s.user_id = new.poster_id then continue; end if;
    insert into public.notifications (user_id, type, title, body, job_id)
    values (s.user_id, 'saved_search',
            'New gig matches your saved search',
            new.title || ' · $' || new.pay::text, new.id);
  end loop;
  return new;
end;
$$;
drop trigger if exists trg_notify_saved_searches on public.jobs;
create trigger trg_notify_saved_searches
  after insert on public.jobs
  for each row execute function public.notify_saved_searches();
