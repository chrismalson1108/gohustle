-- ─────────────────────────────────────────────────────────────────────────────
-- Any signed-in user could switch off support for everybody, for an hour, with 60
-- rows.
--
-- support-submit enforces layered anti-abuse — 5/hr per email, 8/hr per IP, and a
-- GLOBAL 60/hr backstop so that rotating both still cannot flood the queue. All three
-- are counted with `select count(*) from support_tickets where created_at > now()-1h`.
--
-- But `support_tickets_open_own` grants INSERT on that table straight to
-- `authenticated`. So the counter can be filled without going through the function
-- that reads it:
--
--   1. Attacker posts 60 rows directly to PostgREST. Cheap, one JWT, no email, no IP
--      rotation, seconds.
--   2. overLimit(null, null, 60) is now true for EVERY caller.
--   3. For the next hour every genuine submission gets a 429 — including the
--      "someone showed up at my door" safety report and the "I cannot get to my
--      money" ticket. Then they do it again.
--
-- The rate limiter's own state was writable by the people it rate-limits.
--
-- ── WHY REVOKING IS SAFE ────────────────────────────────────────────────────
--
-- Nothing legitimate uses this policy. Every client — SupportScreen, src/lib/support.js,
-- the web /contact form — files through the support-submit edge function, which holds
-- service_role and is unaffected by RLS. A repo-wide search for an INSERT into
-- support_tickets returns no client code, on this build or the shipped one.
--
-- The SELECT and UPDATE policies stay exactly as they are: people must still read and
-- close their own tickets.
--
-- ── WHY THE TRIGGER WAS NOT ENOUGH ──────────────────────────────────────────
--
-- guard_support_ticket_write already pins opened_by/status/priority/assigned_to on a
-- client INSERT, so a direct row cannot jump the queue or forge provenance. That was
-- the right guard for the threat it was written for — content. It cannot help here,
-- because this attack does not care what is IN the row. It only needs the row to
-- exist. A guard on the shape of a write does not bound the NUMBER of writes.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists support_tickets_open_own on public.support_tickets;
revoke insert on public.support_tickets from authenticated, anon;

-- ── Prove it ────────────────────────────────────────────────────────────────
do $$
declare
  n int;
  ins boolean;
begin
  select count(*) into n
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'support_tickets' and p.polcmd = 'a';
  if n <> 0 then
    raise exception 'support_tickets still has % INSERT policy(ies)', n;
  end if;

  select has_table_privilege('authenticated', 'public.support_tickets', 'INSERT') into ins;
  if ins then
    raise exception 'authenticated can still INSERT into support_tickets';
  end if;

  -- The two that must survive, or we have broken support instead of protecting it.
  select count(*) into n
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'support_tickets' and p.polcmd in ('r', 'w');
  if n < 2 then
    raise exception 'lost the read/update policies — users can no longer see their own tickets';
  end if;

  raise notice 'support intake now has exactly one writer (support-submit)';
end $$;

-- ── Notice if it ever comes back ────────────────────────────────────────────
-- A later migration re-running an older file could restore the policy, which is
-- exactly how the app.support_reopen exemption was lost twice. This control makes the
-- regression visible within the hour instead of at the next audit.
create or replace function public.ctl_support_intake_writable()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select 'support_tickets'::text,
         jsonb_build_object(
           'insert_policies', (select coalesce(array_agg(p.polname::text), '{}')
                                 from pg_policy p join pg_class c on c.oid = p.polrelid
                                where c.relname = 'support_tickets' and p.polcmd = 'a'),
           'authenticated_can_insert',
             has_table_privilege('authenticated', 'public.support_tickets', 'INSERT'),
           'note', 'a client that can insert support tickets can fill the global '
                   'rate-limit counter and deny the support channel to everyone else')
   where has_table_privilege('authenticated', 'public.support_tickets', 'INSERT')
      or exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
                  where c.relname = 'support_tickets' and p.polcmd = 'a')
$$;

revoke execute on function public.ctl_support_intake_writable() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('support_intake_writable',
   'Clients can insert support tickets directly, bypassing support-submit',
   'high', 'abuse',
   'support-submit rate-limits on a count of support_tickets rows. If clients can '
   'write that table directly they control the limiter''s input: 60 rows denies the '
   'support channel to every user for an hour, safety reports included. Intake must '
   'have exactly one writer.',
   'ctl_support_intake_writable')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;
