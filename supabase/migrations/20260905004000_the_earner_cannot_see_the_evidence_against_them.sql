-- ─────────────────────────────────────────────────────────────────────────────
-- The accused party has no read path to the evidence used to halve their pay.
--
-- 20260806360000 gave the poster a way to attach photographs when they report a
-- problem during verification (`disputes.photos`, written by stripe-capture-payment
-- under the POSTER's own `<posterId>/…` prefix in the private completion-photos
-- bucket). Its header justified reusing that bucket in one sentence:
--
--     "NO NEW BUCKET. completion-photos is already private, already written
--      owner-scoped under <userId>/, and completion_party_read already lets EITHER
--      booking party read it — so the earner can see what they are accused of,
--      which they must be able to do."
--
-- That is not what completion_party_read does. Its non-owner branch authorises a
-- read only when the object's name appears in `bookings.completion_photos ||
-- bookings.before_photos` (20260707010000:25-45) — it has never looked at
-- `disputes.photos`. So for a poster's dispute photo the earner fails BOTH branches:
-- the owner branch (the folder is the poster's) and the party branch (the path is
-- referenced from the dispute row, not from either bookings array). The signed-URL
-- request is refused.
--
-- The result is the shape this project treats as a defect on its own: the only
-- person who cannot see the evidence is the person it is being used against. The
-- console does not render `disputes.photos` either, so today the poster who wrote
-- the photos is the only party who can open them at all.
--
-- ── WHY A THIRD BRANCH RATHER THAN A NEW BUCKET ─────────────────────────────
-- The migration's reasoning for reusing the bucket was sound; only its premise about
-- this policy was wrong. Dispute photos are already written owner-scoped, already
-- private, and already deleted with the account. Adding the missing branch makes the
-- stated guarantee true; a new bucket would duplicate four policies and the deletion
-- list to say the same thing.
--
-- The branch mirrors the existing one exactly, including the legacy full-URL form,
-- and is symmetric: EITHER booking party may read a photo attached to a dispute on
-- their own booking. The poster keeps their read through the owner branch regardless.
-- Nobody outside the booking gains anything — `disputes` is joined through
-- `bookings`/`jobs` and filtered on the caller being the earner or the poster, the
-- same test the existing branch applies.
--
-- Idempotent: the policy is dropped and recreated whole, so this file is the complete
-- definition rather than a patch on top of one.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "completion_party_read" on storage.objects;
create policy "completion_party_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'completion-photos'
    and (
      -- The uploader owns their "<uid>/…" folder.
      (storage.foldername(name))[1] = auth.uid()::text
      -- Either party of a booking that references this object as proof of work.
      or exists (
        select 1
        from public.bookings b
        join public.jobs j on j.id = b.job_id
        cross join lateral unnest(
          coalesce(b.completion_photos, '{}'::text[]) || coalesce(b.before_photos, '{}'::text[])
        ) as photo(val)
        where (b.earner_id = auth.uid() or j.poster_id = auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
      -- NEW: either party of a booking whose DISPUTE references this object. This is
      -- the poster's evidence, and the earner is the person it is used against.
      or exists (
        select 1
        from public.disputes d
        join public.bookings b on b.id = d.booking_id
        join public.jobs j on j.id = b.job_id
        cross join lateral unnest(coalesce(d.photos, '{}'::text[])) as photo(val)
        where (b.earner_id = auth.uid() or j.poster_id = auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
    )
  );

-- ── Prove the fix is present and that it discriminates ──────────────────────
--
-- Two legs. The first asserts the live policy definition actually carries the new
-- branch, and runs unconditionally. The second stages a real booking and a real
-- dispute and evaluates the OLD authorisation test and the NEW one against the same
-- object path as the same earner: old says no, new says yes. That difference IS the
-- finding. A stranger is checked too, so the branch is not proved by being permissive.
do $$
declare
  qual_text  text;
  earner     uuid;
  poster     uuid;
  jid        uuid;
  bid        uuid;
  obj        text;
  old_ok     boolean;
  new_ok     boolean;
  outsider   boolean;
begin
  select qual into qual_text
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'completion_party_read';

  if qual_text is null then
    raise exception 'completion_party_read is missing — the read policy was dropped and not recreated';
  end if;
  if qual_text !~* 'disputes' then
    raise exception 'FIX ABSENT: completion_party_read still never looks at disputes.photos';
  end if;
  if qual_text !~* 'completion_photos' then
    raise exception 'REGRESSION: the proof-of-work branch was lost while adding the dispute branch';
  end if;
  raise notice 'completion_party_read now authorises through disputes.photos as well as the booking arrays';

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Two DIFFERENT people, or the probe proves nothing: the whole point is that the
  -- reader is not the uploader.
  select id into earner from public.profiles where deleted_at is null order by created_at limit 1;
  select id into poster from public.profiles where deleted_at is null and id <> earner
    order by created_at limit 1;
  if earner is null or poster is null then
    raise notice 'fewer than two live profiles — data leg skipped; the policy assertion above still ran';
    raise exception 'probe complete — rolling back';
  end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (poster, 'dispute evidence probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  insert into public.bookings (job_id, earner_id, status) values (jid, earner, 'completed')
  returning id into bid;

  -- The poster's evidence, under the POSTER's folder — exactly what
  -- stripe-capture-payment writes (it filters disputePhotos to `${user.id}/`).
  obj := poster::text || '/dispute-probe.jpg';
  insert into public.disputes (booking_id, raised_by, reason, pct_paid, photos)
  values (bid, poster, 'probe', 50, array[obj]);

  -- THE OLD TEST, as the earner: the object is not in either bookings array, and the
  -- folder is not theirs, so the policy refused.
  select exists (
    select 1
    from public.bookings b
    join public.jobs j on j.id = b.job_id
    cross join lateral unnest(
      coalesce(b.completion_photos, '{}'::text[]) || coalesce(b.before_photos, '{}'::text[])
    ) as photo(val)
    where (b.earner_id = earner or j.poster_id = earner)
      and (photo.val = obj or photo.val like '%/completion-photos/' || obj)
  ) into old_ok;

  -- THE NEW BRANCH, same earner, same object.
  select exists (
    select 1
    from public.disputes d
    join public.bookings b on b.id = d.booking_id
    join public.jobs j on j.id = b.job_id
    cross join lateral unnest(coalesce(d.photos, '{}'::text[])) as photo(val)
    where (b.earner_id = earner or j.poster_id = earner)
      and (photo.val = obj or photo.val like '%/completion-photos/' || obj)
  ) into new_ok;

  if old_ok then
    raise exception 'the old policy already authorised this read; the finding is not real';
  end if;
  if not new_ok then
    raise exception 'FIX FAILED: the earner still cannot read the dispute photo against them';
  end if;
  raise notice 'discriminates: old branches say % for the accused earner, the dispute branch says %', old_ok, new_ok;

  -- And it grants nothing to someone outside the booking.
  select exists (
    select 1
    from public.disputes d
    join public.bookings b on b.id = d.booking_id
    join public.jobs j on j.id = b.job_id
    cross join lateral unnest(coalesce(d.photos, '{}'::text[])) as photo(val)
    where (b.earner_id = gen_random_uuid() or j.poster_id = gen_random_uuid())
      and (photo.val = obj or photo.val like '%/completion-photos/' || obj)
  ) into outsider;
  if outsider then
    raise exception 'the new branch authorises a non-party — it widens the bucket instead of the booking';
  end if;
  raise notice 'a non-party still reads nothing, so the branch widens the booking and not the bucket';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'dispute-evidence probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
