-- ─────────────────────────────────────────────────────────────────────────────
-- Assert the invariant that two separate regressions broke, instead of trusting a
-- comment not to be dropped the next time.
--
-- guard_support_ticket_write has been re-created four times. Twice the
-- `app.support_reopen` exemption went with it — once by the migration whose own
-- header warned about reproducing from stale files. Both times the effect was the
-- same and completely silent: the message trigger's rollup UPDATE re-enters the
-- ticket guard, gets pinned back, and a user's reply stops moving last_message_at
-- and last_author. The console's needs-reply filter and ctl_support_ticket_unanswered
-- both read those, so the customer disappears from the queue while the queue looks
-- healthy — which is the failure mode controls exist for.
--
-- Prose did not hold. A jest test now guards the migration text
-- (__tests__/supportGuardDrift.test.js), and this guards the RUNNING DATABASE, which
-- is the only thing that actually matters: a message can never be newer than the
-- ticket that is supposed to summarise it.
--
-- It is deliberately an invariant about DATA, not about a function body. Any future
-- rewrite that breaks the rollup — GUC dropped, trigger renamed, ordering changed,
-- policy altered — trips this within the hour regardless of how it was broken.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── First, repair the rollup — including residue I left ─────────────────────
--
-- 20260812050000 verified its own fix by inserting a probe message as `authenticated`
-- and then cleaning up. The cleanup UPDATE was silently reverted by the guard it had
-- just repaired: the guard pins last_message_at (and last_author) for any writer that
-- is not service_role, and a migration is not service_role. So the DELETE removed the
-- probe row while the ticket kept the probe's rollup values.
--
-- That is the same class of mistake twice in one day — a write that reports success
-- and changes nothing — and it is exactly why the control below is being added. It is
-- also why this repair claims service_role first, the way the parity migration
-- learned to.
--
-- Recomputed from the messages themselves, which are the source of truth; a ticket
-- with no messages keeps its own timestamps.
do $$
declare n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  update public.support_tickets t
     set last_message_at = m.newest,
         last_author     = m.newest_author
    from (
      select ticket_id,
             max(created_at) newest,
             (array_agg(author order by created_at desc))[1] newest_author
        from public.support_ticket_messages
       group by ticket_id
    ) m
   where m.ticket_id = t.id
     and (t.last_message_at is distinct from m.newest
          or t.last_author is distinct from m.newest_author);
  get diagnostics n = row_count;

  perform set_config('request.jwt.claims', '', true);
  raise notice 'repaired rollup on % ticket(s)', n;
end $$;

create or replace function public.ctl_ticket_rollup_stale()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select t.id::text,
         jsonb_build_object(
           'ticket_last_message_at', t.last_message_at,
           'newest_message_at', m.newest,
           'ticket_last_author', t.last_author,
           'newest_message_author', m.newest_author,
           'lag_minutes', round(extract(epoch from m.newest - coalesce(t.last_message_at, m.newest)) / 60.0, 1),
           'note', 'a message is newer than the ticket summarising it — the rollup '
                   'trigger is not firing, so this conversation is invisible to the '
                   'support queue and to the SLA control')
    from public.support_tickets t
    join lateral (
      select max(created_at) newest,
             (array_agg(author order by created_at desc))[1] newest_author
        from public.support_ticket_messages sm
       where sm.ticket_id = t.id
    ) m on true
   where m.newest is not null
     and (
       -- The rollup did not move at all.
       t.last_message_at is null
       or m.newest > t.last_message_at + interval '1 minute'
       -- …or it moved but disagrees about who spoke, which is the half that decides
       -- whether the queue shows this conversation.
       or t.last_author is distinct from m.newest_author
     )
$$;

revoke execute on function public.ctl_ticket_rollup_stale() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('ticket_rollup_stale',
   'A support message is newer than the ticket that summarises it',
   'high', 'integrity',
   'support_tickets.last_message_at and last_author are what the console queue and '
   'the SLA control read. When the rollup trigger stops firing, a customer''s reply '
   'lands in the database and vanishes from both — the queue looks clean because the '
   'work is missing, not because it is done. This has happened twice, silently, from '
   'guard rewrites that dropped the app.support_reopen exemption.',
   'ctl_ticket_rollup_stale')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;

-- Prove it reports clean NOW (the exemption was restored in 20260812050000), so this
-- migration fails loudly if it is applied to a database still carrying the bug.
do $$
declare n int;
begin
  select count(*) into n from public.ctl_ticket_rollup_stale();
  if n > 0 then
    raise exception 'ticket rollup is broken for % ticket(s) — restore the app.support_reopen exemption first', n;
  end if;
  raise notice 'ticket rollup invariant holds across all tickets';
end $$;
