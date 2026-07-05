-- Corrective to 20260705010000: admin_audit_log.admin_id and
-- admin_user_notes.admin_id referenced auth.users, which makes a former
-- admin's account UNDELETABLE — their audit rows hold an FK (and the log
-- revokes DELETE from everyone, so the rows can never be cleared either).
-- An audit trail must outlive its actors: keep the uuid, drop the FKs.
-- (admin_users.user_id keeps its ON DELETE CASCADE FK — membership rows
-- SHOULD vanish with the account; attribution rows should not.)

alter table public.admin_audit_log drop constraint if exists admin_audit_log_admin_id_fkey;
alter table public.admin_user_notes drop constraint if exists admin_user_notes_admin_id_fkey;
