-- ─────────────────────────────────────────────────────────────────────────────
-- profiles.avatar_url and jobs.photos accepted ANY external URL on a direct write, and
-- both clients render them to every signed-in user.
--
-- Image moderation only ever sees BUCKET OBJECTS: moderate-image takes a (bucket, path),
-- refuses anything outside the caller's own folder, and is invoked by uploadImage.js
-- after the object lands. The COLUMNS that point at those objects were plain
-- owner-writable text with nothing checking them:
--
--   * guard_profiles_write (final: 20260722020000) pins verified, id_verification_status,
--     ratings, earnings, suspension, created_at, member_since, date_of_birth,
--     onboarding_done — and never mentions avatar_url.
--   * guard_jobs_write (final: 20260726110000) pins bumped_at, pay, and the core terms
--     while booked — and never mentions photos.
--   * No CHECK on either column anywhere in supabase/ or supabase/migrations/.
--
-- So `PATCH /rest/v1/profiles?id=eq.<me> {"avatar_url":"https://attacker.tld/x.jpg"}`
-- passes profiles_update_own, stores an off-platform image, and Avatar renders it beside
-- every gig that user posts, in every chat row they send, and on their public profile —
-- to every user, including minors — with no Claude vision pass anywhere in the path.
-- `POST /rest/v1/jobs {"photos":["https://attacker.tld/y.jpg"]}` does the same for the
-- cover photo of a listing in the browse feed. A remote-hosted image also hands the
-- attacker's host the IP and user-agent of every viewer. moderation_flags and reports
-- stay empty, because the only scanner is bucket-scoped and nothing was uploaded.
--
-- This class is already recognised here and was closed for ONE surface:
-- src/lib/certifications.js:43 `safeCertUrl` — "image_url is attacker-controllable via a
-- direct API insert (RLS only checks ownership), so this blocks an off-platform phishing
-- link or tracking-pixel planted on a public profile" — plus the `certifications.image_url
-- ~ '^https://'` CHECK. The two far more visible columns were never given the same rule.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Enforce the ORIGIN at the data layer, the way guard_message_image_path
-- (chat-photos) and guard_booking_photo_paths (completion-photos) already enforce the
-- FOLDER for the private buckets. A value must be one of:
--
--   * null / empty,
--   * a bare `<owner uuid>/…` storage path, or
--   * `<storage origin>/storage/v1/object/public/<bucket>/<owner uuid>/…`
--
-- and nothing else. `<storage origin>` is the platform's own Supabase project, read from
-- app_flags rather than hardcoded in the function body — config in a table can be
-- ASSERTED on, which is this repo's standing rule after the 2026-07-10 GUC outage, and a
-- new project ref at cutover is then a row rather than a migration.
--
-- ⚠️ The host is pinned to the PROJECT, not to `*.supabase.co`. Anyone can create a
-- Supabase project, so an origin rule that accepted any supabase.co host would accept a
-- tracking pixel served from the attacker's own project and read as if it were closed.
--
-- Service role is exempt, as in both sibling guards — edge functions and the console are
-- trusted callers, and delete-account clears these columns.
--
-- The owner is resolved from OLD on UPDATE and NEW only on INSERT. That is the
-- 20260726060000 lesson, and it applies here for the same reason: trigger order on
-- public.jobs is alphabetical, `trg_guard_job_photo_urls` sorts before
-- `trg_guard_jobs_write`, so on UPDATE new.poster_id is still whatever the client sent.
-- Validating against it would let a caller PATCH poster_id to a victim and pass a path
-- under the victim's folder.
--
-- WHAT THIS DOES NOT CLOSE, stated plainly: a user can still upload an unmoderated image
-- to their OWN folder through the Storage API and never call moderate-image, which is a
-- client-invoked, fail-open check. This guard is about the ORIGIN — the image at least
-- lives in our bucket, under the writer's own id, deletable by us and attributable to
-- them. Making moderation mandatory is a separate change to the upload path.
--
-- Existing rows are untouched: both triggers are `update of <column>`, so a legacy value
-- is only ever re-validated when it is rewritten. The clients also drop anything that is
-- not an own-bucket URL at render time (shared/transforms.js safeStorageUrl), which is
-- what covers rows written before today.
--
-- Found by the rls-policies audit pass, 2026-09-05.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Where our storage lives, as data ────────────────────────────────────────
insert into public.app_flags (key, enabled, value, note) values
  ('storage_public_origin', true,
   jsonb_build_object('origin', 'https://nfioebqsgmmzhbksxozc.supabase.co'),
   'Origin of THIS project''s Storage. guard_profile_avatar_url and '
   'guard_job_photo_urls accept a public image URL only under this origin — pinned to '
   'the project, not to *.supabase.co, because anyone can create a Supabase project. '
   'Update it at a project cutover; `enabled` is not read.')
on conflict (key) do update set value = excluded.value, note = excluded.note;

-- ── The one definition of "this is our object, and it is theirs" ────────────
create or replace function public.is_own_public_image(p_value text, p_bucket text, p_owner uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_origin text;
  v_prefix text;
begin
  if p_value is null or p_value = '' then
    return true;                        -- clearing a photo is always allowed
  end if;
  if p_owner is null then
    return false;                       -- no owner ⇒ nothing to scope the path to
  end if;

  v_prefix := p_owner::text || '/';

  -- A bare storage path. The bucket's own INSERT policy already scopes writes to
  -- `<uid>/…`, so the only thing to check here is that the reference matches the writer.
  if position('://' in p_value) = 0 then
    return left(p_value, length(v_prefix)) = v_prefix and length(p_value) > length(v_prefix);
  end if;

  select coalesce(value->>'origin', 'https://nfioebqsgmmzhbksxozc.supabase.co')
    into v_origin
    from public.app_flags where key = 'storage_public_origin';
  v_origin := coalesce(v_origin, 'https://nfioebqsgmmzhbksxozc.supabase.co');

  -- Exact PREFIX, and compared with left() rather than LIKE: a `like
  -- '%/storage/v1/object/public/%'` contains-test matches
  -- https://attacker.tld/storage/v1/object/public/avatars/<uid>/x.jpg — precisely the URL
  -- this guard exists to refuse — and LIKE would additionally read any `_` or `%` in a
  -- future project ref or bucket name as a wildcard.
  v_prefix := v_origin || '/storage/v1/object/public/' || p_bucket || '/' || v_prefix;
  return left(p_value, length(v_prefix)) = v_prefix and length(p_value) > length(v_prefix);
end;
$fn$;

revoke execute on function public.is_own_public_image(text, text, uuid) from public, anon, authenticated;

-- ── profiles.avatar_url ─────────────────────────────────────────────────────
create or replace function public.guard_profile_avatar_url()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  -- OLD on UPDATE, NEW only on INSERT — see the header. profiles.id is the owner and is
  -- pinned by guard_profiles_write, but this trigger may run before it.
  if not public.is_own_public_image(new.avatar_url, 'avatars', coalesce(old.id, new.id)) then
    raise exception 'avatar_url must be an image in your own avatars folder on this platform'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.guard_profile_avatar_url() from public, anon, authenticated;

drop trigger if exists trg_guard_profile_avatar_url on public.profiles;
create trigger trg_guard_profile_avatar_url
  before insert or update of avatar_url on public.profiles
  for each row execute function public.guard_profile_avatar_url();

-- ── jobs.photos ─────────────────────────────────────────────────────────────
create or replace function public.guard_job_photo_urls()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owner uuid;
  entry   text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  v_owner := coalesce(old.poster_id, new.poster_id);

  foreach entry in array coalesce(new.photos, '{}'::text[]) loop
    if not public.is_own_public_image(entry, 'job-photos', v_owner) then
      raise exception 'job photos must be images in your own job-photos folder on this platform'
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$fn$;

revoke execute on function public.guard_job_photo_urls() from public, anon, authenticated;

drop trigger if exists trg_guard_job_photo_urls on public.jobs;
create trigger trg_guard_job_photo_urls
  before insert or update of photos on public.jobs
  for each row execute function public.guard_job_photo_urls();


-- ── And a control, because a guard only covers writes made AFTER it ─────────
-- Rows written before today, and anything service_role writes (the guards exempt it, as
-- both sibling path guards do), are still whatever they are. Nothing looked at them, and
-- the render-side filter makes a bad row INVISIBLE rather than reported — an image that
-- silently stops appearing is not something anyone investigates. This names them.
create or replace function public.ctl_foreign_image_url()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $ctl$
select p.id::text,
       jsonb_build_object(
         'kind', 'profile_avatar',
         'column', 'profiles.avatar_url',
         'value', left(p.avatar_url, 300),
         'note', 'this avatar is not an object in our own avatars bucket under this '
                 'user''s id, so it was never seen by image moderation — moderate-image '
                 'only ever looks at uploaded objects — and a remote host learns the IP '
                 'and user-agent of everyone who loads it. Both clients refuse to render '
                 'it (safeStorageUrl), so the user sees their initial circle instead.',
         'remedy', 'Look at the value. If it is an off-platform image, service_role: '
                   'update public.profiles set avatar_url = null where id = <this id>. '
                   'A row appearing here AFTER 20260906014100 means a service_role path '
                   'wrote it — the guards exempt service_role — so find that writer.'
       )
  from public.profiles p
 where p.avatar_url is not null and p.avatar_url <> ''
   and p.deleted_at is null
   and not public.is_own_public_image(p.avatar_url, 'avatars', p.id)
union all
select j.id::text,
       jsonb_build_object(
         'kind', 'job_photo',
         'column', 'jobs.photos',
         'poster_id', j.poster_id,
         'status', j.status,
         'value', left(bad.photo, 300),
         'note', 'this gig photo is not an object in our own job-photos bucket under the '
                 'poster''s id, so it bypassed image moderation and beacons every viewer '
                 'of the browse feed to a third-party host. Both clients drop it at '
                 'render time.',
         'remedy', 'service_role: update public.jobs set photos = '
                   'array_remove(photos, <the value>) where id = <this id>.'
       )
  from public.jobs j
  cross join lateral unnest(coalesce(j.photos, '{}'::text[])) as bad(photo)
 where bad.photo is not null and bad.photo <> ''
   and not public.is_own_public_image(bad.photo, 'job-photos', j.poster_id)
$ctl$;

revoke execute on function public.ctl_foreign_image_url() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('foreign_image_url',
   'An avatar or gig photo points off-platform',
   'medium', 'abuse',
   'profiles.avatar_url and jobs.photos were owner-writable free text until '
   '20260906014100, and image moderation only ever sees uploaded bucket objects — so a '
   'direct API write could put an unmoderated external image on a public profile or a '
   'browse card, and hand its host the IP and user-agent of every viewer. The guards '
   'added there refuse new writes and exempt service_role; this is what sees the rows '
   'that predate them, and anything a service-role path writes from now on.',
   'ctl_foreign_image_url')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it, broken vs fixed on the same staged row, rolled back ───────────
do $$
declare
  uid uuid; other uuid; jid uuid;
  origin text;
  good_job text; good_av text; evil text; lookalike text;
  before_av text;
  n integer;
  blocked boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;
  select id into other from public.profiles where deleted_at is null and id <> uid limit 1;

  select coalesce(value->>'origin', '') into origin
    from public.app_flags where key = 'storage_public_origin';
  if origin = '' then raise exception 'storage_public_origin was not seeded'; end if;

  good_job  := origin || '/storage/v1/object/public/job-photos/' || uid::text || '/1.jpg';
  good_av   := origin || '/storage/v1/object/public/avatars/'    || uid::text || '/1.jpg';
  evil      := 'https://attacker.tld/tracking-pixel.jpg';
  -- The URL a `contains` test would have accepted: our path shape, their host.
  lookalike := 'https://attacker.tld/storage/v1/object/public/avatars/' || uid::text || '/1.jpg';

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'image origin probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'cancelled')
  returning id into jid;

  select avatar_url into before_av from public.profiles where id = uid;

  -- Act as the owner over PostgREST, which is the attacker in this finding: their own
  -- row, their own token, one PATCH.
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', uid::text)::text, true);

  -- ══ 1. THE BUG, on the live tables: with the triggers off, the write lands ══
  drop trigger trg_guard_job_photo_urls on public.jobs;
  drop trigger trg_guard_profile_avatar_url on public.profiles;

  update public.jobs set photos = array[evil] where id = jid;
  select count(*) into n from public.jobs where id = jid and photos = array[evil];
  if n <> 1 then
    raise exception 'probe cannot discriminate: something else already refused the external photo';
  end if;
  update public.profiles set avatar_url = evil where id = uid;
  if (select avatar_url from public.profiles where id = uid) is distinct from evil then
    raise exception 'probe cannot discriminate: something else already refused the external avatar';
  end if;
  raise notice 'PRE-FIX: an authenticated owner stored % on both columns, unmoderated and rendered to everyone', evil;

  -- ══ 1b. The control sees exactly this shape — which is what covers the rows ══
  -- already in the table, since a trigger only ever guards writes made after it.
  select count(*) into n from public.ctl_foreign_image_url()
   where entity_id in (uid::text, jid::text);
  if n <> 2 then
    raise exception 'ctl_foreign_image_url reported % of the 2 planted rows', n;
  end if;
  raise notice 'the control names both planted rows, so a legacy value is reported rather than silently unrendered';

  -- Put the rows back before re-arming, or the fix would be judged on a dirty row.
  update public.jobs set photos = '{}'::text[] where id = jid;
  update public.profiles set avatar_url = before_av where id = uid;

  create trigger trg_guard_job_photo_urls
    before insert or update of photos on public.jobs
    for each row execute function public.guard_job_photo_urls();
  create trigger trg_guard_profile_avatar_url
    before insert or update of avatar_url on public.profiles
    for each row execute function public.guard_profile_avatar_url();

  -- ══ 2. THE FIX: the same two writes are refused ═══════════════════════════
  blocked := false;
  begin
    update public.jobs set photos = array[evil] where id = jid;
  exception when check_violation then blocked := true;
  end;
  if not blocked then raise exception 'FIX FAILED: an external job photo was still accepted'; end if;

  blocked := false;
  begin
    update public.profiles set avatar_url = evil where id = uid;
  exception when check_violation then blocked := true;
  end;
  if not blocked then raise exception 'FIX FAILED: an external avatar was still accepted'; end if;
  raise notice 'discriminates: the identical PATCH that landed a moment ago is now refused on both columns';

  -- ══ 3. The look-alike: our path shape on their host ═══════════════════════
  blocked := false;
  begin
    update public.profiles set avatar_url = lookalike where id = uid;
  exception when check_violation then blocked := true;
  end;
  if not blocked then
    raise exception 'FIX FAILED: % was accepted — the origin is not actually pinned', lookalike;
  end if;
  raise notice 'a URL carrying our storage path on another host is refused, which a contains-test would have allowed';

  -- ══ 4. Someone else's folder on OUR origin ════════════════════════════════
  if other is not null then
    blocked := false;
    begin
      update public.profiles set avatar_url =
        origin || '/storage/v1/object/public/avatars/' || other::text || '/1.jpg' where id = uid;
    exception when check_violation then blocked := true;
    end;
    if not blocked then raise exception 'FIX FAILED: another user''s avatar object was accepted'; end if;
    raise notice 'another user''s folder is refused, so an image stays attributable to whoever wrote it';
  end if;

  -- ══ 5. The REAL app writes still work ═════════════════════════════════════
  -- uploadImage.js / web uploadToBucket return exactly this shape. If this half fails,
  -- the fix has taken avatars and gig photos away from every user.
  update public.profiles set avatar_url = good_av where id = uid;
  if (select avatar_url from public.profiles where id = uid) is distinct from good_av then
    raise exception 'FIX BROKE THE APP: a genuine getPublicUrl avatar was refused';
  end if;
  update public.jobs set photos = array[good_job, good_job] where id = jid;
  if (select array_length(photos, 1) from public.jobs where id = jid) <> 2 then
    raise exception 'FIX BROKE THE APP: genuine getPublicUrl job photos were refused';
  end if;
  -- ...and a legitimate value is NOT reported by the control, or it would be permanent
  -- noise on every profile and every gig on the platform.
  select count(*) into n from public.ctl_foreign_image_url()
   where entity_id in (uid::text, jid::text);
  if n <> 0 then
    raise exception 'the control fires on genuine storage URLs (% rows) — that is permanent noise', n;
  end if;

  -- ...and clearing is always allowed.
  update public.profiles set avatar_url = null where id = uid;
  update public.jobs set photos = '{}'::text[] where id = jid;
  raise notice 'the shapes both uploaders actually produce still write, are silent to the control, and clearing still works';

  if not exists (select 1 from public.controls
                  where key = 'foreign_image_url' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'image origin probe passed; all staged rows and both trigger drops rolled back';
  else
    raise;
  end if;
end $$;
