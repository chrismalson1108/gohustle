-- ─────────────────────────────────────────────────────────────────────────────
-- "Needs reply" must mean nobody replied — not "nobody looked".
--
-- The queue I shipped this morning derived its needs-reply filter from
-- agent_read_at < last_message_at. Rendering the ticket page stamps agent_read_at,
-- so opening a ticket and closing it again silently cleared it out of the queue.
-- Chris caught it within the hour by doing exactly that.
--
-- It is worth being precise about why this was wrong rather than just fixing it,
-- because the bug is attractive: a read receipt is a real signal and it was right
-- there. But it answers a DIFFERENT question. "Has anyone looked at this" and "does
-- this person have an answer yet" diverge at the exact moment support is failing —
-- a busy agent triaging a queue opens everything and answers some of it — and the
-- failure is silent and one-directional: it can only ever make the queue look
-- emptier than it is.
--
-- Status was already a closer proxy (a user message sets 'open', an agent reply sets
-- 'pending'), but it is not authoritative either, because an agent can hand-set
-- 'open' from the console. So this stores the fact itself.
--
-- LAST_AUTHOR is maintained by the trigger that already owns the ticket's rollup
-- columns, so it cannot drift from the messages it summarises.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.support_tickets
  add column if not exists last_author text;

-- The queue reads this on every page load, filtered by status.
create index if not exists support_tickets_last_author_idx
  on public.support_tickets (status, last_author, last_message_at);

-- ── Reproduced from the LIVE body (pg_proc), with last_author added ──────────
-- Reproducing these from a migration file has reverted live fixes twice in this
-- codebase; the authoritative source is the running function. The reopen GUC and the
-- author/admin_id pinning below are unchanged and are still the trust boundary.
create or replace function public.guard_support_message_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    -- THE TRUST BOUNDARY: a message rendered with a GoHustlr badge must have come from
    -- GoHustlr. A client can never post as staff.
    new.author     := 'user';
    new.admin_id   := null;
    new.created_at := now();
  end if;

  -- Tells the ticket guard that THIS update is the reply-reopen, not a client editing
  -- status directly. Transaction-local and unreachable over PostgREST.
  perform set_config('app.support_reopen', 'on', true);

  update public.support_tickets
     set last_message_at = now(),
         updated_at = now(),
         -- Who spoke last. The whole point: this changes when someone SAYS
         -- something, never when someone merely reads.
         last_author = new.author,
         status = case
           when new.author = 'user' then 'open'
           when status = 'closed' then status
           else 'pending' end,
         archived_at = case when new.author = 'user' then null else archived_at end,
         user_read_at  = case when new.author = 'user'  then now() else user_read_at end,
         agent_read_at = case when new.author = 'admin' then now() else agent_read_at end
   where id = new.ticket_id;

  perform set_config('app.support_reopen', '', true);
  return new;
end;
$$;

revoke execute on function public.guard_support_message_write() from public, anon, authenticated;

-- ── The ticket guard must not let a client forge it ─────────────────────────
-- Reproduced from the live body with last_author pinned on UPDATE. A user who could
-- set their own last_author to 'admin' could hide themselves from the support queue —
-- which is a strange thing to want, but "strange" is not an access control.
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
    new.archived_at   := null;
    new.last_author   := 'user';
    -- A safety ticket is urgent by definition. Self-declared urgency on anything else
    -- is a queue-jumping lever, so the client never sets priority.
    new.priority := case when new.category = 'safety' then 'urgent' else 'normal' end;
    return new;
  end if;

  -- UPDATE: a user owns "I have read this", "I consider this done", and "hide this from
  -- my inbox". Nothing that decides how the queue is worked.
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
  new.last_author   := old.last_author;
  new.email         := old.email;
  new.name          := old.name;
  new.subject       := old.subject;
  -- Marking your own ticket resolved is allowed, and is only safe because replying
  -- reopens it: the worst case of a premature self-close is one more message.
  if new.status is distinct from old.status and new.status <> 'closed' then
    new.status := old.status;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_support_ticket_write() from public, anon, authenticated;

-- ── Backfill from the messages themselves ───────────────────────────────────
update public.support_tickets t
   set last_author = m.author
  from (
    select distinct on (ticket_id) ticket_id, author
      from public.support_ticket_messages
     order by ticket_id, created_at desc
  ) m
 where m.ticket_id = t.id
   and t.last_author is distinct from m.author;

-- A ticket with no messages at all was opened by its subject line alone, so the
-- person who filed it is still the last one to have said anything.
update public.support_tickets
   set last_author = 'user'
 where last_author is null;

-- ── The SLA control gets the same correction ────────────────────────────────
-- It keyed on status = 'open', which an agent can set by hand from the console. Now
-- it asks the direct question: is the last thing in this thread from the customer,
-- and has it been sitting there past its window?
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
           'seen_by_an_agent', t.agent_read_at is not null,
           'booking_id', t.booking_id,
           'note', 'the last message on this ticket is from the customer and no one '
                   'has answered it — being READ is not being answered')
    from public.support_tickets t
   where t.status <> 'closed'
     and t.last_author = 'user'
     and t.last_message_at < now() - (case
           when t.priority = 'urgent' then interval '1 hour'
           when t.priority = 'high'   then interval '8 hours'
           else interval '48 hours' end)
$$;

revoke execute on function public.ctl_support_ticket_unanswered() from public, anon, authenticated;
