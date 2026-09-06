-- ─────────────────────────────────────────────────────────────────────────────
-- The support queue decided "needs reply" in JavaScript, AFTER a 200-row window — so
-- the people waiting longest were the ones it dropped.
--
-- admin/app/(console)/support/page.tsx asked PostgREST for the 200 most recent
-- open+pending tickets ordered `last_message_at desc`, then applied the actual queue
-- predicate (`last_author = 'user'`) to that array in the browser. The rows the limit
-- cuts are the OLDEST — which on a "who has been waiting longest" queue is precisely
-- the work it exists to surface. The "N waiting" badge counted the same truncated
-- array, so it under-reported at the same moment. Past 200 open tickets the page can
-- say "Nothing waiting on us. 🎉" while sixty people wait.
--
-- This is the same predicate-in-JavaScript false negative /bookings already fixed —
-- "the stuck bookings — old by definition … were never in the page-0 window" — and the
-- fix is the same: put the predicate, the ordering and the count in the query, and add
-- a pager.
--
-- ── WHY THAT NEEDS A MIGRATION ──────────────────────────────────────────────
-- Only the ordering does. The queue's rule is: unanswered first, then urgent before
-- routine, then longest-waiting first. `priority` is TEXT ('low','normal','high',
-- 'urgent'), and PostgREST can only order by a column — so ordering on it server-side
-- sorts ALPHABETICALLY: high, low, normal, urgent. That is not merely a different
-- order, it is close enough to look right on one page and puts 'low' above 'normal'
-- and 'urgent' last. Sorting in JavaScript instead is what forced the whole result set
-- into memory and produced the bug above; a page that sorts only the rows it happened
-- to fetch cannot be paged coherently either, because row 51 of the real order may be
-- on page 0 or page 3 depending on what the window caught.
--
-- So the rank becomes data. `priority_rank` is GENERATED ALWAYS … STORED, which means
-- it cannot drift from `priority` and no writer has to remember it — the same argument
-- `last_author` was given: store the fact, do not re-derive a proxy for it at read time.
--
-- The existing `support_tickets_queue_idx (priority, last_message_at) where status <>
-- 'closed'` was built for exactly this ordering and cannot serve it, for the
-- alphabetical reason above. It is left alone (other filters use it) and a ranked
-- partial index is added alongside for the queue's real shape.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prove the ordering is wrong TODAY, on the live column ───────────────────
do $$
declare
  uid uuid; t_urgent bigint; t_high bigint; first_by_text text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.support_tickets (user_id, email, subject, status, priority, last_author, last_message_at)
  values (uid, 'probe@example.com', 'rank probe urgent', 'open', 'urgent', 'user', now() - interval '1 hour')
  returning id into t_urgent;
  insert into public.support_tickets (user_id, email, subject, status, priority, last_author, last_message_at)
  values (uid, 'probe@example.com', 'rank probe high', 'open', 'high', 'user', now() - interval '2 hours')
  returning id into t_high;

  -- What ordering by the TEXT column actually returns: 'high' sorts before 'urgent'.
  select priority into first_by_text
    from public.support_tickets
   where id in (t_urgent, t_high)
   order by priority asc, last_message_at asc
   limit 1;

  if first_by_text = 'urgent' then
    raise exception
      'probe is not discriminating: ordering by the text column already put urgent first (got %)', first_by_text;
  end if;
  raise notice 'confirmed: ordering by priority TEXT puts % first, ahead of the urgent ticket', first_by_text;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'pre-fix probe passed; staged tickets rolled back';
  else
    raise;
  end if;
end $$;

-- ── The rank, as data ───────────────────────────────────────────────────────
-- Matches PRIORITY_RANK in the console page exactly. Anything outside the CHECK
-- constraint's four values ranks last rather than NULL, so an unknown value can never
-- sort itself to the top of the queue.
alter table public.support_tickets
  add column if not exists priority_rank smallint
    generated always as (
      case priority
        when 'urgent' then 0
        when 'high'   then 1
        when 'normal' then 2
        when 'low'    then 3
        else 4
      end
    ) stored;

comment on column public.support_tickets.priority_rank is
  'Sort rank for `priority` (urgent 0 … low 3, unknown 4). Generated: the console queue '
  'orders by this because PostgREST can only order by a column and the text values sort '
  'alphabetically — high, low, normal, urgent. Mirrors PRIORITY_RANK in '
  'admin/app/(console)/support/page.tsx.';

-- The queue's actual shape: not closed, last word was the customer's, ranked then oldest.
create index if not exists support_tickets_needs_reply_idx
  on public.support_tickets (priority_rank, last_message_at)
  where status <> 'closed' and last_author = 'user';

-- ── Assert the fix, and that it discriminates ───────────────────────────────
do $$
declare
  uid uuid; t_urgent bigint; t_high bigint; t_old_normal bigint;
  first_id bigint; is_generated text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select attgenerated into is_generated
    from pg_attribute
   where attrelid = 'public.support_tickets'::regclass
     and attname = 'priority_rank' and not attisdropped;
  if is_generated is distinct from 's' then
    raise exception 'FIX FAILED: priority_rank is not a stored generated column (attgenerated=%)',
      coalesce(is_generated, '<missing>');
  end if;
  raise notice 'priority_rank is generated, so it cannot drift from priority';

  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.support_tickets (user_id, email, subject, status, priority, last_author, last_message_at)
  values (uid, 'probe@example.com', 'rank probe urgent', 'open', 'urgent', 'user', now() - interval '1 hour')
  returning id into t_urgent;
  insert into public.support_tickets (user_id, email, subject, status, priority, last_author, last_message_at)
  values (uid, 'probe@example.com', 'rank probe high', 'open', 'high', 'user', now() - interval '2 hours')
  returning id into t_high;
  -- The row the old page dropped: routine, and waiting far longer than either.
  insert into public.support_tickets (user_id, email, subject, status, priority, last_author, last_message_at)
  values (uid, 'probe@example.com', 'rank probe old normal', 'open', 'normal', 'user', now() - interval '20 days')
  returning id into t_old_normal;

  if (select priority_rank from public.support_tickets where id = t_urgent) <> 0
     or (select priority_rank from public.support_tickets where id = t_high) <> 1
     or (select priority_rank from public.support_tickets where id = t_old_normal) <> 2 then
    raise exception 'FIX FAILED: ranks are not urgent 0 / high 1 / normal 2';
  end if;

  -- Urgent leads under the ranked ordering — the thing the text column got wrong.
  select id into first_id
    from public.support_tickets
   where id in (t_urgent, t_high, t_old_normal)
   order by priority_rank asc, last_message_at asc
   limit 1;
  if first_id <> t_urgent then
    raise exception 'FIX FAILED: ranked ordering did not lead with the urgent ticket';
  end if;
  raise notice 'ranked ordering leads with urgent, which the text ordering did not';

  -- And within a rank the person waiting longest is first, which is the whole queue.
  select id into first_id
    from public.support_tickets
   where id in (t_old_normal, t_high) and priority_rank = 2
   order by priority_rank asc, last_message_at asc
   limit 1;
  if first_id <> t_old_normal then
    raise exception 'FIX FAILED: the longest-waiting ticket in a rank is not first';
  end if;

  -- THE DISCRIMINATION: rank ordering and text ordering disagree on the same rows, and
  -- the text one is what a server-side order without this column would have produced.
  select id into first_id
    from public.support_tickets
   where id in (t_urgent, t_high, t_old_normal)
   order by priority asc, last_message_at asc
   limit 1;
  if first_id = t_urgent then
    raise exception 'text ordering already agreed; priority_rank would be redundant';
  end if;
  raise notice 'discriminates: text ordering leads with the HIGH ticket, rank ordering with the URGENT one';

  -- A value outside the CHECK ranks last rather than NULL. Asserted against the
  -- expression itself, since the constraint (correctly) refuses to store one.
  if (case 'wat' when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 when 'low' then 3 else 4 end) <> 4 then
    raise exception 'FIX FAILED: an unknown priority would not rank last';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'support_tickets_needs_reply_idx'
  ) then
    raise exception 'FIX FAILED: the ranked queue index is missing';
  end if;
  raise notice 'ranked partial index present for the queue''s real shape';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'support queue rank probe passed; all staged tickets rolled back';
  else
    raise;
  end if;
end $$;
