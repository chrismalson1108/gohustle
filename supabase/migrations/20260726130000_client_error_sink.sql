-- ─────────────────────────────────────────────────────────────────────────────
-- OPERATIONAL (beta-readiness): give production crashes somewhere to land
-- (2026-07-26).
--
-- src/lib/analytics.js ships with SENTRY_DSN = null, and captureError() currently
-- does nothing outside dev: it pushes the error into a 100-entry in-memory ring
-- buffer that dies with the process, and console.warn's it only when __DEV__. There
-- are 15 captureError call sites covering the paths that matter most — accept
-- booking, verify + capture, tip, complete job, post gig — plus a root ErrorBoundary
-- for render crashes. In production every one of those is a no-op.
--
-- The practical consequence for an open beta: the only way the team learns that
-- capture is failing, or that a screen is crash-looping, is a tester bothering to say
-- so. KNOWN_RISKS §1.1 records this as a stubbed area; it is the one remaining item
-- that is purely about being able to SEE what is happening once real users arrive.
--
-- Wiring real Sentry is the eventual answer but needs a native SDK and therefore a
-- dev-client rebuild, which is exactly why it has stayed stubbed. This is the
-- zero-new-dependency version that works with the binary already in TestFlight: a
-- table the clients can post to through an edge function, readable in the admin
-- console alongside everything else.
--
-- Security shape, deliberately conservative because this is a write endpoint fed by
-- untrusted clients:
--   * RLS on, NO client policies at all — only the service-role edge function writes,
--     and only the admin console (service role) reads. A user cannot read anyone's
--     errors, including their own, and cannot tamper with the log.
--   * message/context are capped in the edge function, and context is a jsonb blob the
--     client controls, so the admin UI must render it as TEXT, never as markup.
--   * A per-user cap lives in the edge function against this same table (it is its own
--     ledger, like reports).
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.client_errors (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete set null,
  platform    text,                       -- 'ios' | 'android' | 'web'
  app_version text,
  message     text not null,
  context     jsonb,                      -- { op, bookingId, ... } from captureError
  fatal       boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
create index if not exists client_errors_user_idx    on public.client_errors (user_id, created_at desc);

alter table public.client_errors enable row level security;

-- No policies on purpose: RLS with zero policies denies every non-service-role read
-- and write. The edge function and the admin console both use the service role, which
-- bypasses RLS. Belt and braces, revoke the default grants too — this is exactly the
-- gap 20260726080000 found, where a default privilege survived a `revoke from public`.
revoke all on public.client_errors from anon, authenticated;
grant all on public.client_errors to service_role;
