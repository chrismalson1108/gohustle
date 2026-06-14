-- Location (job coords + slot/booking times), tips, and disputes. Idempotent.

alter table public.jobs        add column if not exists lat double precision;
alter table public.jobs        add column if not exists lng double precision;
alter table public.job_slots   add column if not exists starts_at timestamptz;
alter table public.bookings    add column if not exists starts_at timestamptz;
alter table public.bookings    add column if not exists tip_amount numeric(10,2) default 0;

-- Disputes raised when a poster reports a problem and pays a reduced amount.
create table if not exists public.disputes (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  raised_by   uuid not null references public.profiles(id) on delete cascade,
  reason      text,
  pct_paid    numeric(5,2),
  created_at  timestamptz default now()
);
alter table public.disputes enable row level security;

-- Both parties of the booking can read the dispute; only a party can raise one.
drop policy if exists "disputes_select_parties" on public.disputes;
create policy "disputes_select_parties" on public.disputes for select using (
  auth.uid() = raised_by
  or exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
  )
);
drop policy if exists "disputes_insert_party" on public.disputes;
create policy "disputes_insert_party" on public.disputes for insert with check (
  auth.uid() = raised_by
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.id = booking_id and (b.earner_id = auth.uid() or j.poster_id = auth.uid())
  )
);
