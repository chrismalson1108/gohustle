-- ─────────────────────────────────────────────────────────────────────────────
-- A reply reopens the ticket. Archive is the user's, close is the team's.
--
-- ── THE TRAP ────────────────────────────────────────────────────────────────
--
-- support_messages_write_own refuses an insert when the ticket is closed, and
-- guard_support_ticket_write refuses to let a user move status off 'closed'. Together
-- those are a one-way door: an agent resolves something prematurely and the person it
-- happened to cannot say "this is not fixed". Their only route is a fresh ticket that
-- carries none of the history — at precisely the moment they are least willing to
-- re-explain it, because they already did once.
--
-- Every mature helpdesk resolves this the same way, and it is worth stating plainly
-- because it is not obvious from the schema: a customer reply REOPENS the conversation.
-- It matches what a person already believes — I am writing to you, so this is clearly
-- not done — and it makes "resolved" a safe thing for an agent to click, because being
-- wrong costs a reopen rather than a lost thread.
--
-- ── ARCHIVE IS NOT CLOSE ────────────────────────────────────────────────────
--
-- Closing is a support-workflow state that belongs to the team: it means "we consider
-- this handled" and it drives the queue and the SLA control. Archiving is an inbox
-- preference that belongs to the user: "stop showing me this row".
--
-- Conflating them means a user tidying their inbox silently changes the team's queue,
-- or a team resolving a ticket dictates what the user's inbox looks like. They are kept
-- separate here, and the mobile Messages tab already models exactly this distinction
-- for gig conversations, so support now behaves consistently with the rest of the app.
--
-- The user keeps a "mark resolved" ability, which is only safe BECAUSE replying
-- reopens: the worst case of a premature self-close is one more message.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.support_tickets
  add column if not exists archived_at timestamptz;

-- ── A user may write on their own ticket, closed or not ─────────────────────
drop policy if exists support_messages_write_own on public.support_ticket_messages;
create policy support_messages_write_own on public.support_ticket_messages
  for insert to authenticated with check (
    exists (select 1 from public.support_tickets t
             where t.id = ticket_id and t.user_id = auth.uid())
  );

-- ── …and that write is what reopens it ──────────────────────────────────────
-- Reproduced from the live body with the reopen rule added; the author/admin_id pinning
-- that stops a client posting as staff is unchanged and is still the trust boundary.
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

  update public.support_tickets
     set last_message_at = now(),
         updated_at = now(),
         status = case
           -- A USER writing on a closed ticket REOPENS it. This is the whole point:
           -- "resolved" must never be a door that locks behind the person it was
           -- resolved for.
           when new.author = 'user' then 'open'
           when status = 'closed' then status
           else 'pending' end,
         -- A reply also un-archives: the user has just shown it still matters to them,
         -- and a thread they are actively writing in must not be hidden from their inbox.
         archived_at = case when new.author = 'user' then null else archived_at end,
         user_read_at  = case when new.author = 'user'  then now() else user_read_at end,
         agent_read_at = case when new.author = 'admin' then now() else agent_read_at end
   where id = new.ticket_id;

  return new;
end;
$$;

revoke execute on function public.guard_support_message_write() from public, anon, authenticated;

-- ── The user owns archiving; the team owns closing ──────────────────────────
-- Reproduced from the live guard with archived_at added to what a user may set.
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

-- ── An archived thread must never hide something still waiting on the team ──
-- The SLA control reads status, not archived_at, precisely so a user hiding a row
-- cannot quietly remove it from the queue. Restated here as a control so the
-- separation is asserted rather than assumed.
create or replace function public.ctl_archived_ticket_still_open()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select t.id::text,
         jsonb_build_object(
           'category', t.category,
           'status', t.status,
           'archived_at', t.archived_at,
           'hours_waiting', round(extract(epoch from now() - t.last_message_at) / 3600.0, 1),
           'note', 'the user archived this from their inbox but the team has not '
                   'resolved it — archiving is a display preference and must not '
                   'silently drop work from the queue')
    from public.support_tickets t
   where t.archived_at is not null
     and t.status = 'open'
     and t.last_message_at < now() - interval '48 hours'
$$;

revoke execute on function public.ctl_archived_ticket_still_open() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('archived_ticket_still_open',
   'A user archived a ticket the team has not resolved',
   'medium', 'lifecycle',
   'Archiving hides a row from the user''s inbox; closing is the team saying it is '
   'handled. Keeping them separate is what stops a user tidying their list from '
   'silently emptying the support queue — but it also means an archived ticket can sit '
   'unanswered with nobody looking at it, which is what this catches.',
   'ctl_archived_ticket_still_open')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
