-- Security hygiene: pin search_path on the remaining SECURITY DEFINER / trigger
-- functions so they can't be hijacked via a mutable search_path (Supabase
-- Security Advisor "function_search_path_mutable"). The guard_profiles_write /
-- guard_bookings_write / recompute_user_rating / my_profile functions already set it.
alter function public.guard_student_verified() set search_path = public;
alter function public.notify_saved_searches() set search_path = public;
alter function public.handle_new_user() set search_path = public;
alter function public.set_updated_at() set search_path = public;
