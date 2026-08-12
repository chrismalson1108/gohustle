-- ─────────────────────────────────────────────────────────────────────────────
-- Support can start the conversation now. Two things that assumed it never would.
--
-- ── 1. AN AGENT MESSAGE MUST UN-ARCHIVE ─────────────────────────────────────
--
-- 20260806380000 un-archived a thread only when the USER wrote in, which was right
-- for the case it was written for: archiving is the user's "I am done with this",
-- and their own reply obviously means they are not.
--
-- It is wrong the moment WE can write first. Archived is hidden behind a toggle in
-- the app, so a thread support opens — or replies on — about a flag, a dispute, or a
-- payout would land somewhere the user has already put away and has no reason to
-- look. The push would say "support replied" and the thread would not be there.
--
-- The rule that covers both directions: A THREAD WITH SOMETHING NEW IN IT IS NOT
-- ARCHIVED. Archiving is not muting. This does not let support nag — support only
-- writes when it has something to say, and a message the user must act on is
-- precisely what should come back out of the drawer.
--
-- ── 2. opened_by MUST SURVIVE THE USER TOUCHING THE TICKET ──────────────────
--
-- guard_support_ticket_write pins opened_by on INSERT but never re-pinned it on
-- UPDATE. It did not matter while every ticket was user-opened. Now the column is
-- load-bearing provenance — it is how every surface knows whether the user asked us
-- or we approached them — so a client marking their own ticket resolved must not be
-- able to rewrite who started it.
-- ─────────────────────────────────────────────────────────────────────────────

-- Provenance, so an agent-opened thread is identifiable in queries and controls.
create index if not exists support_tickets_opened_by_idx
  on public.support_tickets (opened_by, status);

-- ── Reproduced from the LIVE body (pg_proc) with the un-archive rule widened ──
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
         last_author = new.author,
         status = case
           when new.author = 'user' then 'open'
           when status = 'closed' then status
           else 'pending' end,
         -- ANY new message un-archives. Archiving is a "put this away" for a finished
         -- conversation, not a mute — and a thread support has just written in is, by
         -- definition, not finished.
         archived_at = null,
         user_read_at  = case when new.author = 'user'  then now() else user_read_at end,
         agent_read_at = case when new.author = 'admin' then now() else agent_read_at end
   where id = new.ticket_id;

  perform set_config('app.support_reopen', '', true);
  return new;
end;
$$;

revoke execute on function public.guard_support_message_write() from public, anon, authenticated;

-- ── Pin opened_by on UPDATE too ─────────────────────────────────────────────
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
  -- my inbox". Nothing that decides how the queue is worked, and nothing about where
  -- the conversation came from.
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
  if new.status is distinct from old.status and new.status <> 'closed' then
    new.status := old.status;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_support_ticket_write() from public, anon, authenticated;

-- ── A thread WE started that the user never answered ────────────────────────
-- Different from ctl_support_ticket_unanswered, which catches us ignoring a customer.
-- This catches the opposite and more consequential case: we approached someone about a
-- flag, a dispute or a payout, and heard nothing back. Acting on silence we never
-- confirmed they saw — a ban, a withheld payout — is how a wrong outcome becomes
-- permanent, so it should be visible before that happens rather than after.
create or replace function public.ctl_agent_thread_unanswered()
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
           'user_id', t.user_id,
           'opened_by_agent', t.assigned_to,
           'days_silent', round(extract(epoch from now() - t.last_message_at) / 86400.0, 1),
           'user_has_seen_it', t.user_read_at is not null
             and t.user_read_at >= t.last_message_at,
           'note', 'support started this conversation and the user has not replied — '
                   'do not act on silence without confirming they saw it')
    from public.support_tickets t
   where t.opened_by = 'agent'
     and t.status <> 'closed'
     and t.last_author = 'admin'
     and t.last_message_at < now() - interval '5 days'
$$;

revoke execute on function public.ctl_agent_thread_unanswered() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('agent_thread_unanswered',
   'Support opened a thread the user never answered',
   'low', 'lifecycle',
   'When WE start the conversation — about a flag, a dispute, a payout — silence is '
   'not agreement. It usually means they never saw it. This surfaces those before '
   'someone acts on the silence, because the actions that follow (a ban, a withheld '
   'payout) are the expensive ones to reverse.',
   'ctl_agent_thread_unanswered')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
