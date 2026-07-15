-- ─────────────────────────────────────────────────────────────────────────────
-- DB backstop: jobs.pay must be positive (2026-07-15).
--
-- jobs.pay is numeric(10,2) NOT NULL with no CHECK, and the client validated only
-- truthiness (!form.pay), so a poster could publish a $0 / negative-pay gig that
-- renders in Browse, can be booked, then dead-ends at accept when the escrow
-- PaymentIntent amount is non-positive. The client-side fix is owned by another
-- agent; this is the DB backstop so no direct-PostgREST write can persist pay <= 0.
--
-- Added NOT VALID so it enforces every new INSERT/UPDATE immediately without a full-
-- table validation lock and without failing the migration on any legacy row. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'jobs_pay_positive' and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_pay_positive check (pay > 0) not valid;
  end if;
end;
$$;
