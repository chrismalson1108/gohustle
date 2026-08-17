-- ─────────────────────────────────────────────────────────────────────────────
-- The Team page asks a cache whether someone has an authenticator, and the cache is
-- only written by ONE of the two ways a factor can appear.
--
-- Reported 2026-08-17: an invited admin (pending) signed in at admin.gohustlr.com and
-- was taken straight to the 6-digit prompt, having never been shown a QR code — while
-- /team displayed "no authenticator enrolled yet" for the same account. Both surfaces
-- were reporting honestly about different sources, and they disagreed.
--
-- app/mfa/page.tsx renders `challenge` if and only if listFactors() returns a VERIFIED
-- totp factor, so that state is proof a factor exists. admin_users.mfa_enrolled_at is
-- written by admin_record_mfa_enrollment, which is called from exactly one place: that
-- same page's verify(). The console and the mobile app share one Supabase auth project,
-- so a factor enrolled in the APP (SecurityScreen → src/lib/mfa.js) is the very same
-- auth.mfa_factors row the console will challenge against — and nothing ever writes the
-- cache for it. 20260806100000 backfilled the column once, as a one-time UPDATE, and
-- named the column "only a cache of it [that] can lag" while leaving admin_team_list
-- reading it.
--
-- ── WHY THIS IS NOT COSMETIC ────────────────────────────────────────────────
-- The pending→active step is the control that closes the trust-on-first-use window
-- 20260804030000 was written to close: /mfa will enroll a factor for whoever presents
-- valid credentials, so the human confirmation of WHEN the factor appeared is the
-- actual check. TeamControls.tsx picks its confirmation copy off this field:
--
--   enrolled  → "They enrolled an authenticator at <time>. Confirm that time with them
--                directly — if it wasn't them, someone else now holds the factor."
--   not       → "They have NOT enrolled an authenticator yet."
--
-- So on a lagging cache the dialog does not merely omit a date — it asserts the opposite
-- of the truth and DROPS the confirmation instruction entirely, in the one dialog whose
-- whole job is to make a human perform it. The reviewer is told there is nothing to
-- check at the exact moment there is.
--
-- It fails the other way too: redeeming an MFA recovery code REMOVES the factor
-- (src/lib/mfa.js), and nothing clears the cache — so a since-removed authenticator
-- keeps reporting a reassuring enrolment date forever.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Read auth.mfa_factors, which is what requireAdmin's AAL2 claim actually derives from.
-- ctl_admin_without_mfa was moved onto that source by 20260806100000 for precisely this
-- reason; the console display was left behind. This is the same one-line lesson as the
-- payments work: never re-derive from a copy when the authority is one join away.
--
-- MAX, not MIN: the question the dialog asks is "did a factor appear that wasn't yours?"
-- With two factors, min() surfaces the older legitimate one and the reviewer confirms it
-- happily while an attacker's newer factor stays invisible. max() surfaces the newest,
-- which is the one nobody has vouched for yet.
--
-- admin_users.mfa_enrolled_at / mfa_factor_id are left in place and still written: they
-- remain a useful record of enrolment via the CONSOLE specifically. They are simply no
-- longer trusted to answer "does this person have an authenticator".
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_team_list()
returns table (
  user_id         uuid,
  email           text,
  name            text,
  role            text,
  status          text,
  mfa_enrolled_at timestamptz,
  created_at      timestamptz,
  disabled_at     timestamptz,
  note            text
)
language sql
security definer
stable
set search_path = public
as $$
  select a.user_id, u.email::text, p.name, a.role, a.status,
         -- Authoritative. A lateral aggregate always yields one row, so max() over zero
         -- verified factors is NULL and the join never drops a member from the list.
         f.enrolled_at,
         a.created_at, a.disabled_at, a.note
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
    left join lateral (
      select max(mf.created_at) as enrolled_at
        from auth.mfa_factors mf
       where mf.user_id = a.user_id
         and mf.status = 'verified'
    ) f on true
   order by (a.status = 'active') desc, a.created_at
$$;

revoke execute on function public.admin_team_list() from public, anon, authenticated;
grant execute on function public.admin_team_list() to service_role;


-- ── Prove it discriminates, in both directions ──────────────────────────────
do $$
declare
  uid uuid;
  has_secret boolean;
  reported timestamptz;
  cached   timestamptz;
  t_old timestamptz := now() - interval '30 days';
  t_new timestamptz := now() - interval '2 hours';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A real account that is NOT already a console member and has no verified factor, so
  -- the baseline is genuinely clean rather than accidentally passing.
  select u.id into uid
    from auth.users u
    join public.profiles p on p.id = u.id and p.deleted_at is null
   where not exists (select 1 from public.admin_users a where a.user_id = u.id)
     and not exists (
       select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')
   limit 1;
  if uid is null then
    raise exception 'no unenrolled non-admin account to stage against';
  end if;

  -- gotrue's factor table has gained and lost columns across versions; only require the
  -- ones every version has, and fill `secret` when it is present.
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'mfa_factors' and column_name = 'secret'
  ) into has_secret;

  insert into public.admin_users (user_id, role, status, mfa_enrolled_at, mfa_factor_id)
  values (uid, 'support', 'pending', null, null);

  -- 1. No factor anywhere ⇒ the page correctly says "not enrolled".
  select t.mfa_enrolled_at into reported from public.admin_team_list() t where t.user_id = uid;
  if reported is not null then
    raise exception 'baseline wrong: reported % with no factor staged', reported;
  end if;
  raise notice 'baseline: no verified factor, nothing reported';

  -- 2. A factor enrolled the way the APP enrolls one — a real auth.mfa_factors row, with
  --    admin_record_mfa_enrollment never called, so the cache stays null.
  if has_secret then
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values (gen_random_uuid(), uid, 'probe app factor', 'totp', 'verified', 'PROBEONLYNOTASECRET', t_old, t_old);
  else
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), uid, 'probe app factor', 'totp', 'verified', t_old, t_old);
  end if;

  select t.mfa_enrolled_at into reported from public.admin_team_list() t where t.user_id = uid;
  select a.mfa_enrolled_at into cached from public.admin_users a where a.user_id = uid;

  -- The discrimination, stated as the two values on the SAME row: what the old function
  -- returned (the cache) versus what this one returns.
  if cached is not null then
    raise exception 'staging wrong: the cache was written, so this proves nothing';
  end if;
  if reported is null then
    raise exception 'FIX FAILED: a verified factor exists and the page still reports none';
  end if;
  if reported <> t_old then
    raise exception 'reported % but the factor was created %', reported, t_old;
  end if;
  raise notice 'discriminates: cache is NULL (what /team showed before — "no authenticator enrolled yet"), auth.mfa_factors says %', reported;

  -- 3. A SECOND, newer factor must win. min() would keep showing the vouched-for one and
  --    hide the factor nobody has confirmed — which is the only thing the dialog asks about.
  if has_secret then
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
    values (gen_random_uuid(), uid, 'probe second factor', 'totp', 'verified', 'PROBEONLYNOTASECRET2', t_new, t_new);
  else
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), uid, 'probe second factor', 'totp', 'verified', t_new, t_new);
  end if;
  select t.mfa_enrolled_at into reported from public.admin_team_list() t where t.user_id = uid;
  if reported <> t_new then
    raise exception 'a newer factor did not win: reported %, newest is %', reported, t_new;
  end if;
  raise notice 'the newest factor is the one surfaced (%), not the older vouched-for one', reported;

  -- 4. An UNVERIFIED factor is not an authenticator. /mfa unenrolls these on sight.
  update auth.mfa_factors set status = 'unverified' where user_id = uid;
  select t.mfa_enrolled_at into reported from public.admin_team_list() t where t.user_id = uid;
  if reported is not null then
    raise exception 'an unverified factor was reported as enrolled (%)', reported;
  end if;
  raise notice 'unverified factors are not counted';

  -- 5. The other direction: redeeming a recovery code REMOVES the factor, and nothing
  --    clears the cache. The old function kept reporting a reassuring date forever.
  delete from auth.mfa_factors where user_id = uid;
  update public.admin_users set mfa_enrolled_at = t_old, mfa_factor_id = 'stale' where user_id = uid;
  select t.mfa_enrolled_at into reported from public.admin_team_list() t where t.user_id = uid;
  select a.mfa_enrolled_at into cached from public.admin_users a where a.user_id = uid;
  if cached is null then
    raise exception 'staging wrong: the stale cache did not take';
  end if;
  if reported is not null then
    raise exception 'FIX FAILED: a removed authenticator still reports enrolled at %', reported;
  end if;
  raise notice 'discriminates the other way: cache still says % (what /team would have shown), factor is gone so nothing is reported', cached;

  -- 6. And no member fell out of the list because of the join.
  if not exists (select 1 from public.admin_team_list() t where t.user_id = uid) then
    raise exception 'the lateral join dropped a member with no factors';
  end if;
  raise notice 'members with no factor are still listed';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'team-page factor-source probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
