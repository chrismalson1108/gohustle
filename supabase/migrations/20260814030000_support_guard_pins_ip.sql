-- ─────────────────────────────────────────────────────────────────────────────
-- The ticket's author can rewrite the only forensic IP record on it.
--
-- guard_support_ticket_write's UPDATE branch pins fourteen columns back to OLD —
-- user_id, category, booking_id, job_id, priority, opened_by, assigned_to,
-- agent_read_at, created_at, last_message_at, last_author, email, name, subject — and
-- does not pin `ip`. UPDATE is granted to `authenticated` and the owner policy permits
-- it, so the person a support investigation is ABOUT can edit the one field that says
-- where their ticket came from. `user_read_at` is likewise unbounded, so a device clock
-- (or a deliberate value) can place it in the future.
--
-- Two related findings in the same function are NOT fixed here, because they are no
-- longer reachable and saying otherwise would overstate this migration:
--
--   • `last_message_at` / `created_at` unpinned on INSERT (queue eviction + SLA
--     invisibility)
--   • booking_id / job_id accepted on INSERT (stapling a stranger's booking to your
--     own ticket)
--
-- Both are INSERT-branch holes, and 20260813090000 revoked INSERT on support_tickets
-- from `authenticated` and `anon` outright — support-submit is now the only writer and
-- runs as service_role, which returns at the first line of this function. The pins are
-- added anyway as defence in depth, so that re-granting INSERT later cannot silently
-- reopen them. The revoke remains the actual control, and ctl_support_intake_writable
-- remains the thing that notices if it is undone.
--
-- ⚠️ THE `app.support_reopen` EXEMPTION MUST SURVIVE THIS REWRITE. It has been dropped
-- by two separate rewrites already. guard_support_message_write sets that GUC around
-- its rollup UPDATE, which re-enters this trigger; without the exemption every pin
-- below reverts the rollup, `last_author` stops moving, and the console queue and the
-- SLA control go blind to customer replies. __tests__/supportGuardDrift.test.js exists
-- for exactly this and will fail if it goes missing again.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── First, prove the hole is real on the CURRENTLY-LIVE function ────────────
do $$
declare
  uid uuid; tid bigint; got text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.support_tickets (user_id, email, subject, status, ip)
  values (uid, 'probe@example.com', 'ip pin probe', 'open', '1.2.3.4')
  returning id into tid;

  -- Become the ticket's own author.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.support_tickets set ip = '9.9.9.9' where id = tid;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select ip into got from public.support_tickets where id = tid;

  if got is distinct from '9.9.9.9' then
    raise exception
      'probe is not discriminating: ip was already pinned (got %), so this migration fixes nothing', got;
  end if;
  raise notice 'hole confirmed on the live function: author rewrote ip 1.2.3.4 -> %', got;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'pre-fix probe passed; staged ticket rolled back';
  else
    raise;
  end if;
end $$;

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
    -- Defence in depth (see header): INSERT is revoked from authenticated, so this
    -- branch is service-role-only today and never reached. Left pinned so re-granting
    -- INSERT cannot quietly restore the queue-eviction and booking-stapling holes.
    -- A client-supplied last_message_at sorts the queue and drives the SLA control;
    -- booking_id/job_id are verified against the caller's own bookings inside
    -- support-submit, which is the only writer that should ever set them.
    new.created_at      := now();
    new.last_message_at := now();
    new.booking_id      := null;
    new.job_id          := null;
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
  -- The forensic record of where this ticket came from. The author of a ticket is
  -- frequently the subject of the investigation it triggers; they do not get to edit
  -- the evidence.
  new.ip            := old.ip;
  -- "I read this" cannot be in the future. A skewed device clock is the innocent
  -- case; a deliberate future value would park the ticket's read state permanently
  -- ahead of every real message.
  if new.user_read_at is not null and new.user_read_at > now() then
    new.user_read_at := now();
  end if;
  if new.status is distinct from old.status and new.status <> 'closed' then
    new.status := old.status;
  end if;
  return new;
end;
$$;

-- ── Now prove the fix closes it, on the same staged shape ───────────────────
do $$
declare
  uid uuid; tid bigint; got text; got_read timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;

  insert into public.support_tickets (user_id, email, subject, status, ip)
  values (uid, 'probe@example.com', 'ip pin probe', 'open', '1.2.3.4')
  returning id into tid;

  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.support_tickets
     set ip = '9.9.9.9', user_read_at = now() + interval '10 years'
   where id = tid;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select ip, user_read_at into got, got_read from public.support_tickets where id = tid;

  if got is distinct from '1.2.3.4' then
    raise exception 'FIX FAILED: author still rewrote ip to %', got;
  end if;
  if got_read > now() then
    raise exception 'FIX FAILED: user_read_at accepted a future value (%)', got_read;
  end if;
  raise notice 'ip held at %, user_read_at clamped to %', got, got_read;

  -- The archive/close the user legitimately owns must STILL work, or this has
  -- traded a forensic hole for a broken feature.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);
  update public.support_tickets set archived_at = now(), status = 'closed' where id = tid;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if (select archived_at from public.support_tickets where id = tid) is null then
    raise exception 'OVER-CORRECTED: the user can no longer archive their own ticket';
  end if;
  if (select status from public.support_tickets where id = tid) <> 'closed' then
    raise exception 'OVER-CORRECTED: the user can no longer close their own ticket';
  end if;
  raise notice 'the user still owns archive and close';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'ip-pin probe passed; staged ticket rolled back';
  else
    raise;
  end if;
end $$;
