-- ─────────────────────────────────────────────────────────────────────────────
-- Support is write-only, and a poster in a dispute has no evidence.
--
-- ── 1. NOBODY CAN READ THEIR OWN SUPPORT TICKET ─────────────────────────────
--
-- support_tickets and support_ticket_messages both have RLS ENABLED and ZERO POLICIES,
-- and no grants to `authenticated` at all. RLS with no policy is deny-all, so a user
-- cannot read the ticket they just filed, let alone the reply.
--
-- The intake works: SupportSheet -> support-submit -> a ticket the console triages, with
-- categories, statuses, admin replies and AI draft assistance. But the answer reaches
-- the user only by email, outside the app, with no thread and no history. That is what
-- makes a product feel like it has no support even when someone is answering: you file
-- into a void.
--
-- This is the fix. Everything else here is additive on top of it.
--
-- ── 2. A POSTER REPORTING A PROBLEM CAN ONLY TYPE ───────────────────────────
--
-- guard_bookings_write pins completion_photos and before_photos in the poster's branch,
-- so only the EARNER can attach images to a booking. When a poster ticks "there was a
-- problem — pay a reduced amount", their case is prose. The person claiming the work was
-- done has photographs; the person claiming it was not has an assertion.
--
-- Evidence goes on the DISPUTE row rather than the booking, because that is the moment
-- it exists and the moment it matters. Sending a poster to open a support ticket
-- mid-verification is friction they will not take, and the evidence would then live
-- somewhere the dispute record does not point at.
--
-- NO NEW BUCKET. completion-photos is already private, already written owner-scoped
-- under <userId>/, and completion_party_read already lets EITHER booking party read it —
-- so the earner can see what they are accused of, which they must be able to do.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Ticket context, priority, and two-sided read state ──────────────────────
alter table public.support_tickets
  -- Optional context. Deliberately NOT foreign keys: a ticket about a gig that was later
  -- deleted is exactly the ticket you most need to keep.
  add column if not exists booking_id    uuid,
  add column if not exists job_id        uuid,
  add column if not exists priority      text not null default 'normal',
  add column if not exists opened_by     text not null default 'user',
  add column if not exists assigned_to   uuid,
  add column if not exists user_read_at  timestamptz,
  add column if not exists agent_read_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_priority_check') then
    alter table public.support_tickets add constraint support_tickets_priority_check
      check (priority in ('low', 'normal', 'high', 'urgent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_opened_by_check') then
    alter table public.support_tickets add constraint support_tickets_opened_by_check
      check (opened_by in ('user', 'agent'));
  end if;
end $$;

alter table public.support_ticket_messages
  -- Paths into the PRIVATE support-photos bucket, rendered with signed URLs exactly as
  -- completion-photos and chat-photos are.
  add column if not exists images text[] not null default '{}';

create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, last_message_at desc) where user_id is not null;
create index if not exists support_tickets_queue_idx
  on public.support_tickets (priority, last_message_at) where status <> 'closed';

-- ── Let a user see their own support conversation ───────────────────────────
grant select, insert, update on public.support_tickets to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select, insert on public.support_ticket_messages to authenticated;

drop policy if exists support_tickets_own on public.support_tickets;
create policy support_tickets_own on public.support_tickets
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists support_tickets_open_own on public.support_tickets;
create policy support_tickets_open_own on public.support_tickets
  for insert to authenticated with check (auth.uid() = user_id);

-- Marking your own thread read, and closing it. Everything that decides how the queue is
-- worked is pinned by the guard below, so this policy can stay simple.
drop policy if exists support_tickets_update_own on public.support_tickets;
create policy support_tickets_update_own on public.support_tickets
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists support_messages_own on public.support_ticket_messages;
create policy support_messages_own on public.support_ticket_messages
  for select to authenticated using (
    exists (select 1 from public.support_tickets t
             where t.id = ticket_id and t.user_id = auth.uid())
  );

drop policy if exists support_messages_write_own on public.support_ticket_messages;
create policy support_messages_write_own on public.support_ticket_messages
  for insert to authenticated with check (
    exists (select 1 from public.support_tickets t
             where t.id = ticket_id and t.user_id = auth.uid() and t.status <> 'closed')
  );

-- ── Pin everything a client must not decide ─────────────────────────────────
create or replace function public.guard_support_ticket_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;

  if tg_op = 'INSERT' then
    new.opened_by     := 'user';
    new.assigned_to   := null;
    new.agent_read_at := null;
    new.status        := 'open';
    -- A safety ticket is urgent by definition. Self-declared urgency on anything else is
    -- a queue-jumping lever, so the client never sets priority.
    new.priority := case when new.category = 'safety' then 'urgent' else 'normal' end;
    return new;
  end if;

  -- UPDATE: a user owns "I have read this" and "I consider this done", nothing else.
  new.user_id       := old.user_id;
  new.category      := old.category;
  new.booking_id    := old.booking_id;
  new.job_id        := old.job_id;
  new.priority      := old.priority;
  new.opened_by     := old.opened_by;
  new.assigned_to   := old.assigned_to;
  new.agent_read_at := old.agent_read_at;
  new.created_at    := old.created_at;
  new.last_message_at := old.last_message_at;
  new.email         := old.email;
  new.name          := old.name;
  new.subject       := old.subject;
  if new.status is distinct from old.status and new.status <> 'closed' then
    new.status := old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_z_guard_support_ticket on public.support_tickets;
create trigger trg_z_guard_support_ticket
  before insert or update on public.support_tickets
  for each row execute function public.guard_support_ticket_write();

create or replace function public.guard_support_message_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    -- THE TRUST BOUNDARY OF THE WHOLE FEATURE: a message that renders with a GoHustlr
    -- badge must have come from GoHustlr. A client can never post as staff.
    new.author     := 'user';
    new.admin_id   := null;
    new.created_at := now();
  end if;

  update public.support_tickets
     set last_message_at = now(),
         updated_at = now(),
         status = case
           when status = 'closed' then status
           when new.author = 'user' then 'open'
           else 'pending' end,
         -- Whoever just wrote has by definition read it.
         user_read_at  = case when new.author = 'user'  then now() else user_read_at end,
         agent_read_at = case when new.author = 'admin' then now() else agent_read_at end
   where id = new.ticket_id;

  return new;
end;
$$;

drop trigger if exists trg_z_guard_support_message on public.support_ticket_messages;
create trigger trg_z_guard_support_message
  before insert on public.support_ticket_messages
  for each row execute function public.guard_support_message_write();

revoke execute on function public.guard_support_ticket_write()  from public, anon, authenticated;
revoke execute on function public.guard_support_message_write() from public, anon, authenticated;

-- ── Support attachments: private, owner-scoped ──────────────────────────────
insert into storage.buckets (id, name, public)
values ('support-photos', 'support-photos', false)
on conflict (id) do nothing;

drop policy if exists support_photos_write_own on storage.objects;
create policy support_photos_write_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'support-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists support_photos_read_own on storage.objects;
create policy support_photos_read_own on storage.objects
  for select to authenticated
  using (bucket_id = 'support-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── 2. Dispute evidence from the poster ─────────────────────────────────────
alter table public.disputes
  add column if not exists photos text[] not null default '{}';

-- The poster raising the dispute may attach; nobody may rewrite an existing record.
create or replace function public.guard_disputes_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if tg_op = 'UPDATE' then
    -- A dispute is a record of what was claimed at the time. Only staff resolve it.
    new.booking_id := old.booking_id;
    new.raised_by  := old.raised_by;
    new.reason     := old.reason;
    new.pct_paid   := old.pct_paid;
    new.photos     := old.photos;
    new.created_at := old.created_at;
    new.status     := old.status;
    new.assigned_to := old.assigned_to;
    new.resolved_at := old.resolved_at;
    new.resolved_by := old.resolved_by;
    new.resolution_note := old.resolution_note;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_z_guard_disputes on public.disputes;
create trigger trg_z_guard_disputes
  before insert or update on public.disputes
  for each row execute function public.guard_disputes_write();

revoke execute on function public.guard_disputes_write() from public, anon, authenticated;

-- ── A ticket nobody answers is the failure that matters ─────────────────────
create or replace function public.ctl_support_ticket_unanswered()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select t.id::text,
         jsonb_build_object(
           'category', t.category,
           'priority', t.priority,
           'status', t.status,
           'hours_waiting', round(extract(epoch from now() - t.last_message_at) / 3600.0, 1),
           'assigned', t.assigned_to is not null,
           'booking_id', t.booking_id)
    from public.support_tickets t
   where t.status = 'open'
     and t.last_message_at < now() - (case
           when t.priority = 'urgent' then interval '1 hour'
           when t.priority = 'high'   then interval '8 hours'
           else interval '48 hours' end)
$$;

revoke execute on function public.ctl_support_ticket_unanswered() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('support_ticket_unanswered',
   'A support ticket has gone unanswered past its priority window',
   'high', 'lifecycle',
   'Support is the route someone takes when the product has already failed them — stuck '
   'escrow, a gig that went wrong, feeling unsafe. A ticket nobody answers turns a '
   'fixable problem into a lost user, and a SAFETY ticket left an hour is materially '
   'worse than that. Urgent 1h, high 8h, everything else 48h.',
   'ctl_support_ticket_unanswered')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
