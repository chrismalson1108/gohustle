-- ID verification status tracking.
-- The existing profiles.verified boolean stays the source of truth for the
-- "Verified" badge rendered across the app. This adds a request/status field so
-- users can see where their verification stands (none → pending → verified).
--
-- NOTE: this only models the UX/state. Actually confirming a government ID
-- requires a real provider (Stripe Identity or Checkr). The "Request" flow sets
-- status to 'pending'; an admin/back-office or provider webhook is expected to
-- flip profiles.verified = true and id_verification_status = 'verified'.
-- Idempotent — safe to re-run.

alter table profiles add column if not exists id_verification_status text not null default 'none';
alter table profiles add column if not exists id_verification_requested_at timestamptz;

-- Allowed values: 'none' | 'pending' | 'verified' | 'rejected'
