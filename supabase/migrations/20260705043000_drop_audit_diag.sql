-- Remove the temporary diagnostic function used to inspect auth.audit_log_entries.
-- Finding: that table is empty on this project (hosted Supabase does not populate
-- it here), so there is no user login-IP data to surface today — consistent with
-- not collecting user IPs anywhere. admin_user_login_history() stays (harmless;
-- returns data only if Supabase begins recording auth events).
drop function if exists public.admin_debug_audit();
