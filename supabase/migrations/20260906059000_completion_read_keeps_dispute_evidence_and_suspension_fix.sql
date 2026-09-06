-- ─────────────────────────────────────────────────────────────────────────────
-- Two fixes rewrote completion_party_read, and the later one won.
--
-- Both were right on their own, and both were written against the same base, so
-- neither could see the other:
--
--   · 20260905004000 added a DISPUTE branch. A poster reports a problem, uploads
--     photos into disputes.photos, and the earner's pay is halved on that evidence.
--     The policy only ever unnested bookings.completion_photos / before_photos, so
--     the one person who could not open the evidence was the person it was used
--     against.
--   · 20260906041000 replaced the inline party test with private.is_booking_party(),
--     because suspending a poster hid their confirmed earner's photos, chat and
--     disputes — every party-scoped policy joined `jobs`, and jobs_select_all now
--     filters suspended posters for everyone else.
--
-- `drop policy` + `create policy` keeps only the last definition, so applying them in
-- timestamp order silently dropped the dispute branch: the earner could not see the
-- evidence again. __tests__/storagePolicies.test.js caught it by asserting the LIVE
-- policy body still reaches public.disputes.
--
-- This is the union: the dispute branch, both branches routed through
-- is_booking_party so neither is re-broken by a suspension.
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
        cross join lateral unnest(
          coalesce(b.completion_photos, '{}'::text[]) || coalesce(b.before_photos, '{}'::text[])
        ) as photo(val)
        where private.is_booking_party(b.id, auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
      -- Either party of a booking whose DISPUTE references this object. Same
      -- is_booking_party route, so suspending the poster cannot hide the evidence
      -- from the earner it is being used against.
      or exists (
        select 1
        from public.disputes d
        join public.bookings b on b.id = d.booking_id
        cross join lateral unnest(coalesce(d.photos, '{}'::text[])) as photo(val)
        where private.is_booking_party(b.id, auth.uid())
          and (
            photo.val = storage.objects.name
            or photo.val like '%/completion-photos/' || storage.objects.name
          )
      )
    )
  );


-- ── Prove BOTH properties hold on the one surviving policy ─────────────────
do $$
declare
  body text;
begin
  select pg_get_expr(pol.polqual, pol.polrelid)
    into body
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'storage' and c.relname = 'objects' and pol.polname = 'completion_party_read';

  if body is null then
    raise exception 'completion_party_read does not exist after this migration';
  end if;

  -- PROPERTY 1 (20260905004000): dispute evidence is reachable.
  if body not ilike '%disputes%' then
    raise exception 'FIX FAILED: the live policy has no disputes branch — the accused earner cannot open the evidence again';
  end if;

  -- PROPERTY 2 (20260906041000): party membership is decided by the helper, which
  -- does not consult jobs_select_all and so survives a suspended counterparty.
  if body not ilike '%is_booking_party%' then
    raise exception 'FIX FAILED: the live policy does not route through is_booking_party — a suspension will hide the counterparty''s photos again';
  end if;

  -- And it must not have regressed to joining jobs directly, which is the shape that
  -- made a suspension hide the row.
  if body ~* 'join\s+public\.jobs' then
    raise exception 'REGRESSION: the policy joins public.jobs again, which is what the suspension fix removed';
  end if;

  -- The uploader's own folder still works, or every upload preview breaks.
  if body not ilike '%foldername%' then
    raise exception 'REGRESSION: the uploader can no longer read their own folder';
  end if;

  raise notice 'completion_party_read carries the dispute branch AND the suspension-safe party test';
end $$;
