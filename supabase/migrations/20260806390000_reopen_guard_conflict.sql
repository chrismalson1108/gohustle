-- The message guard reopens the ticket by UPDATE, which re-enters the TICKET guard —
-- and that guard reverts any user-driven move off 'closed'. It cannot tell "the user is
-- editing this row" from "the reply trigger is reopening it", so it correctly refused
-- both and the reopen silently did nothing.
--
-- Same shape as the SOS exemption: prove provenance with a transaction-local GUC that
-- only the trigger sets and a client cannot reach, rather than trusting a column.
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
    new.priority := case when new.category = 'safety' then 'urgent' else 'normal' end;
    return new;
  end if;

  new.user_id       := old.user_id;
  new.category      := old.category;
  new.booking_id    := old.booking_id;
  new.job_id        := old.job_id;
  new.priority      := old.priority;
  new.opened_by     := old.opened_by;
  new.assigned_to   := old.assigned_to;
  new.agent_read_at := old.agent_read_at;
  new.created_at    := old.created_at;
  new.email         := old.email;
  new.name          := old.name;
  new.subject       := old.subject;

  -- A user may close their own ticket. They may NOT reopen it by editing status —
  -- unless this update is the reply trigger, which is the sanctioned way back.
  if new.status is distinct from old.status
     and new.status <> 'closed'
     and coalesce(current_setting('app.support_reopen', true), '') <> 'on' then
    new.status := old.status;
  end if;
  -- last_message_at is the queue's ordering key, so only the reply path moves it.
  if coalesce(current_setting('app.support_reopen', true), '') <> 'on' then
    new.last_message_at := old.last_message_at;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_support_message_write() from public, anon, authenticated;
revoke execute on function public.guard_support_ticket_write()  from public, anon, authenticated;
