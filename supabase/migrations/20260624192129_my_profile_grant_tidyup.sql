-- Tidy-up: drop the default PUBLIC execute on my_profile(); only authenticated.
revoke execute on function public.my_profile() from public;
grant execute on function public.my_profile() to authenticated;
