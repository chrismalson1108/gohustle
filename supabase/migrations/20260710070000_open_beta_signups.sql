-- ─────────────────────────────────────────────────────────────────────────────
-- Open beta signups (2026-07-10). The closed-beta gate from
-- 20260710000000_beta_invite_gate.sql treats a single '*' row in beta_allowlist as
-- "allow every email", so this re-opens public signup WITHOUT removing the gate
-- infrastructure.
--
-- To RE-CLOSE the beta later (back to invite-only), just delete this row:
--     delete from public.beta_allowlist where email = '*';
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.beta_allowlist (email, note)
values ('*', 'open signups — all emails allowed (delete this row to re-close the beta)')
on conflict (email) do nothing;
