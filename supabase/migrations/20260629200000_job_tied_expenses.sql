-- Feature 14a — tie expenses to a specific gig (booking) + per-job view in the
-- Tax Center, plus a `miles` column laid down now as the foundation for an
-- upcoming auto-mileage feature (unused by this change).
--
-- Additive + idempotent. The `expenses` table is owner-scoped via row-level RLS
-- (expenses_select/insert/update/delete_own — see migration_expenses.sql); it has
-- NO column-level grant lockdown like `profiles`, so the existing policies already
-- cover the new columns and no GRANT changes are needed.

alter table public.expenses add column if not exists booking_id uuid references public.bookings(id) on delete set null;
alter table public.expenses add column if not exists miles numeric(10,2);
create index if not exists expenses_booking_id_idx on public.expenses(booking_id);
