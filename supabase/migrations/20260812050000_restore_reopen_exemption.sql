-- ─────────────────────────────────────────────────────────────────────────────
-- CRITICAL, LIVE: the ticket guard has been eating every user reply.
--
-- 20260812010000 re-created guard_support_ticket_write to pin last_author. Its own
-- header says to reproduce from the live pg_proc body because reproducing from
-- migration files has reverted live fixes twice here. I fetched the live body of the
-- MESSAGE guard and did exactly that — and then reproduced the TICKET guard from
-- 20260806380000 on disk, which predates 20260806390000. So the `app.support_reopen`
-- exemption that 20260806390000 existed solely to add was silently dropped. Third
-- time, same mistake, this time by the file that warns about it.
--
-- ── WHAT IT BROKE ───────────────────────────────────────────────────────────
--
-- guard_support_message_write updates support_tickets to roll up last_message_at,
-- last_author, status and archived_at. That UPDATE re-enters guard_support_ticket_write,
-- which — for any caller that is not service_role, i.e. every real user replying from
-- the app — pins those columns back to their old values. So:
--
--   • a user's reply did not move last_message_at (the thread looked stale),
--   • a reply to a CLOSED ticket no longer reopened it (the one-way door is back),
--   • and last_author never flipped back to 'user' after an agent replied — which
--     means the console's needs-reply filter and ctl_support_ticket_unanswered both
--     stop seeing the conversation. The queue loses the customer silently, in the
--     direction that always looks like everything is fine.
--
-- ── WHY MY OWN TEST PASSED ──────────────────────────────────────────────────
--
-- I verified with `set_config('request.jwt.claims','{"role":"service_role"}')`, and
-- the guard's FIRST line returns early for service_role. The test proved the path
-- nobody uses. The check at the bottom of this file runs as `authenticated`, which is
-- the only role the assertion is worth anything under.
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- ── THE EXEMPTION. Do not remove it when re-creating this function. ────────
  -- guard_support_message_write sets this transaction-local GUC around its rollup
  -- UPDATE, which re-enters this trigger. Without the exemption every pin below
  -- reverts that rollup and the message trigger becomes a no-op.
  --
  -- It proves PROVENANCE rather than trusting a column: the GUC is set inside a
  -- SECURITY DEFINER trigger and is unreachable over PostgREST, so a client editing
  -- the ticket directly still hits every pin.
  if coalesce(current_setting('app.support_reopen', true), '') = 'on' then
    return new;
  end if;

  -- UPDATE by a client: they own "I have read this", "I consider this done", and
  -- "hide this from my inbox". Nothing that decides how the queue is worked, and
  -- nothing about where the conversation came from.
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

-- ── Prove it as `authenticated`, the role that was actually broken ──────────
do $$
declare
  t_id  bigint;
  u_id  uuid;
  before_at timestamptz;
  after_at  timestamptz;
  after_author text;
begin
  select id, user_id, last_message_at into t_id, u_id, before_at
    from public.support_tickets where user_id is not null order by id limit 1;
  if t_id is null then
    raise notice 'no ticket to verify against; skipping';
    return;
  end if;

  -- Present as the ticket's owner over PostgREST, not as service_role.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_id::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.support_ticket_messages (ticket_id, body)
  values (t_id, '[migration self-check] verifying the rollup fires');

  select last_message_at, last_author into after_at, after_author
    from public.support_tickets where id = t_id;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  if after_at <= before_at then
    raise exception 'reopen exemption still broken: a user reply did not move last_message_at';
  end if;
  if after_author is distinct from 'user' then
    raise exception 'reopen exemption still broken: last_author did not become user (got %)', after_author;
  end if;
  raise notice 'verified as authenticated: rollup moved, last_author=user';

  -- Undo the probe row; this is production.
  delete from public.support_ticket_messages
   where ticket_id = t_id and body = '[migration self-check] verifying the rollup fires';
  update public.support_tickets set last_message_at = before_at where id = t_id;
end $$;
