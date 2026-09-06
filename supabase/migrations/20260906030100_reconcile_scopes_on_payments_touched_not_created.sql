-- ─────────────────────────────────────────────────────────────────────────────
-- The reconciler said "payments touched in the last N days" and asked for payments
-- CREATED in the last N days. Those are not the same set, and the difference is
-- exactly the case it is the only backstop for.
--
-- reconcile-stripe/index.ts:20 promises "payments touched in the last N days (default
-- 14) … the failures that matter are recent". The query underneath filtered
-- `.gte("created_at", since)`. On this table created_at is the timestamp of the FIRST
-- hold ever placed — stripe-create-payment-intent upserts on booking_id and a recovery
-- re-hold deliberately moves authorized_at and leaves created_at alone
-- (stripe-create-payment-intent/index.ts:544-548) — and there is no updated_at column
-- at all.
--
-- The reversals this control exists to catch happen on STRIPE's clock, long after the
-- row was created: its own registry text names "a refund issued from the dashboard that
-- never clawed back earnings", and RUNBOOK_MONEY says a chargeback lands 30-90 days
-- after the charge. So a booking accepted on day 0 and refunded on day 20 was outside
-- the window on the very sweep that should have caught it.
--
-- That matters because for one specific failure this IS the only backstop. When an
-- admin refund succeeds at Stripe and record_refund then fails, stripe-webhook skips
-- filing anything (the refund_source='admin' in-flight marker is still fresh,
-- stripe-webhook/index.ts:157-176) and answers 200, so Stripe never retries and
-- ctl_external_reversal_not_ledgered has no disputes row to read. refunded_cents stays
-- 0, earnings_total still counts money that has gone back, and every board stays green.
--
-- ── WHY A FUNCTION AND NOT A FILTER ─────────────────────────────────────────
-- The honest scope is "the latest timestamp on the row", i.e.
--   greatest(created_at, authorized_at, captured_at, refunded_at, cancelled_at)
-- PostgREST can express an OR across those columns but cannot ORDER BY the greatest of
-- them, and ordering is load-bearing: the caller takes the newest `limit` rows, so an
-- old-but-just-refunded row would be sorted behind 200 fresh authorizations and dropped
-- again. One function, one definition, ordered by the thing it filters on.
--
-- This does NOT close the whole hole on its own — a refund clicked in the Stripe
-- Dashboard changes none of our columns, so nothing here can see it. The edge function
-- pairs this with a Stripe-side pass (refunds.list + disputes.list since the window
-- start) that pulls those payment_intents back in by id regardless of age. Our
-- timestamps catch what we touched; Stripe's listing catches what only Stripe touched.
--
-- Found by the 2026-09-05 money/edge audit (money-edge-webhook#4).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.payments_touched_since(
  p_since timestamptz,
  p_limit integer default 200
)
returns table (
  id                  uuid,
  booking_id          uuid,
  payment_intent_id   text,
  amount_cents        integer,
  fee_cents           integer,
  earner_amount_cents integer,
  refunded_cents      integer,
  status              text,
  captured_at         timestamptz,
  created_at          timestamptz,
  touched_at          timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- Computed in a subquery and read back through the alias `t`. Every reference is
  -- qualified on purpose: in a RETURNS TABLE function the output column names are in
  -- scope in the body, so a bare `touched_at` in ORDER BY is ambiguous against the
  -- output parameter of the same name.
  select t.id,
         t.booking_id,
         t.payment_intent_id,
         t.amount_cents,
         t.fee_cents,
         t.earner_amount_cents,
         t.refunded_cents,
         t.status,
         t.captured_at,
         t.created_at,
         t.touched_at
    from (
      select p.id,
             p.booking_id,
             p.payment_intent_id,
             p.amount_cents,
             p.fee_cents,
             p.earner_amount_cents,
             coalesce(p.refunded_cents, 0) as refunded_cents,
             p.status,
             p.captured_at,
             p.created_at,
             greatest(
               p.created_at,
               coalesce(p.authorized_at, p.created_at),
               coalesce(p.captured_at,   p.created_at),
               coalesce(p.refunded_at,   p.created_at),
               coalesce(p.cancelled_at,  p.created_at)
             ) as touched_at
        from public.payments p
    ) t
   where t.touched_at >= p_since
   -- Newest ACTIVITY first, not newest creation. This is the half a PostgREST `or`
   -- filter could not have done, and it is what stops the cap from silently
   -- re-excluding the rows the filter just let in.
   order by t.touched_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

-- Service role only. This returns every payment on the platform; nothing signed in as a
-- person has any business calling it.
revoke execute on function public.payments_touched_since(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.payments_touched_since(timestamptz, integer)
  to service_role;


-- ── Prove it sees the row the created_at filter could not ───────────────────
do $$
declare
  uid uuid; jid uuid; bid uuid; pid uuid;
  jid2 uuid; bid2 uuid; pid2 uuid;
  n_new int; n_old int; v_touched timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  -- THE ROW THE OLD SCOPE MISSED: created 20 days ago, refunded 10 minutes ago.
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'touched-scope probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into bid;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, refunded_at, created_at)
  values (bid, 'pi_touched_scope_probe', 10000, 700, 9300,
          10000, 'captured', now() - interval '13 days', now() - interval '10 minutes',
          now() - interval '20 days')
  returning id into pid;

  -- A row that is genuinely old and genuinely untouched. If this comes back the new
  -- scope is not a scope at all, it is "everything".
  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'touched-scope quiet probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid2;
  insert into public.bookings (job_id, earner_id, status) values (jid2, uid, 'verified')
  returning id into bid2;
  insert into public.payments
    (booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents,
     refunded_cents, status, captured_at, created_at)
  values (bid2, 'pi_touched_scope_quiet_probe', 10000, 700, 9300,
          0, 'captured', now() - interval '40 days', now() - interval '45 days')
  returning id into pid2;

  -- THE DISCRIMINATION. This is the exact predicate the edge function used to send.
  select count(*) into n_old
    from public.payments
   where created_at >= now() - interval '14 days'
     and id = pid;
  if n_old <> 0 then
    raise exception 'staging wrong: the created_at filter already sees this row, so it proves nothing';
  end if;
  raise notice 'the old created_at scope does NOT see a payment refunded ten minutes ago — that is the finding';

  select count(*) into n_new
    from public.payments_touched_since(now() - interval '14 days', 1000)
   where id = pid;
  if n_new <> 1 then
    raise exception 'FIX FAILED: a payment refunded ten minutes ago returned % rows from the touched scope', n_new;
  end if;
  raise notice 'the touched scope sees it';

  -- ORDER matters as much as the filter: the row must sort by its ACTIVITY, or the
  -- caller's limit throws it away again.
  select touched_at into v_touched
    from public.payments_touched_since(now() - interval '14 days', 1000)
   where id = pid;
  if v_touched < now() - interval '1 hour' then
    raise exception 'touched_at came back as % — it is not tracking the refund', v_touched;
  end if;
  raise notice 'touched_at reports the refund, not the creation, so the cap keeps the row';

  -- And the quiet old row stays out.
  select count(*) into n_new
    from public.payments_touched_since(now() - interval '14 days', 1000)
   where id = pid2;
  if n_new <> 0 then
    raise exception 'the touched scope returned a payment nothing has touched in 40 days — this is not a window';
  end if;
  raise notice 'a genuinely untouched 40-day-old payment stays out, so this is still a window';

  -- A fresh authorization is in scope exactly as before; nothing regressed.
  update public.payments set created_at = now() - interval '1 day', refunded_at = null,
         refunded_cents = 0, captured_at = null, status = 'authorized'
   where id = pid;
  select count(*) into n_new
    from public.payments_touched_since(now() - interval '14 days', 1000)
   where id = pid;
  if n_new <> 1 then
    raise exception 'a one-day-old authorization fell out of scope — the window got narrower, not wider';
  end if;
  raise notice 'a fresh authorization is still in scope; the change only ADDS rows';

  if not exists (
    select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'payments_touched_since'
  ) then
    raise exception 'function is not present in pg_proc';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'touched-scope probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
