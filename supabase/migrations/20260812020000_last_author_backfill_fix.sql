-- ─────────────────────────────────────────────────────────────────────────────
-- The backfill in 20260812010000 silently did nothing. My own guard ate it.
--
-- guard_support_ticket_write exempts service_role and then, for everyone else, pins
-- the columns a user must not control — including, as of that migration,
-- last_author. It decides via auth.role(), which reads the request's JWT claims.
--
-- A migration has no JWT. auth.role() is therefore empty, the guard takes the
-- not-service_role branch, and every UPDATE in the backfill had its last_author
-- reset to old.last_author, which was null. Both statements reported success and
-- changed nothing, which is the worst shape a data fix can have.
--
-- The consequence was not cosmetic: the queue filters needs-reply on
-- last_author = 'user', so an all-null column means the support queue renders EMPTY
-- and the SLA control returns zero findings. A queue that looks clean because the
-- data is missing is precisely the failure the controls exist to prevent, and it
-- would have been indistinguishable from "no tickets" — which is why this is caught
-- by an assertion below rather than by eye.
--
-- Fix: claim service_role for the transaction the same way the guard checks for it,
-- so the exemption applies to the migration doing the sanctioned thing. Transaction-
-- local, so it cannot leak past this file.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  n_null int;
begin
  -- Present as service_role for this transaction only — the guard's own exemption.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  update public.support_tickets t
     set last_author = m.author
    from (
      select distinct on (ticket_id) ticket_id, author
        from public.support_ticket_messages
       order by ticket_id, created_at desc
    ) m
   where m.ticket_id = t.id
     and t.last_author is distinct from m.author;

  -- A ticket with no messages was opened by its subject line alone, so the person
  -- who filed it is still the last one to have said anything.
  update public.support_tickets
     set last_author = 'user'
   where last_author is null;

  perform set_config('request.jwt.claims', '', true);

  -- ASSERT IT ACTUALLY LANDED. The first attempt "succeeded" while changing nothing;
  -- a silent no-op must not be possible twice.
  select count(*) into n_null from public.support_tickets where last_author is null;
  if n_null > 0 then
    raise exception 'last_author backfill failed: % ticket(s) still null', n_null;
  end if;
  raise notice 'last_author backfilled; 0 null';
end $$;
