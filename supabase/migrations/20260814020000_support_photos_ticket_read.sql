-- ─────────────────────────────────────────────────────────────────────────────
-- A user cannot read the attachment an agent sent them.
--
-- support-photos has exactly one SELECT policy:
--
--   support_photos_read_own:  (storage.foldername(name))[1] = auth.uid()::text
--
-- and the console writes agent attachments to `ticket-<id>/agent-<uuid>.<ext>`
-- (admin/app/(console)/support/actions.ts:66). That first segment is the literal string
-- "ticket-123", which can never equal a uuid — so the policy cannot be satisfied by
-- anyone, ever. SupportScreen renders those paths through <SignedImage>, whose
-- createSignedUrl runs as the USER and needs SELECT, so an agent's screenshot renders as
-- a broken image in the thread it was sent to.
--
-- The console itself is unaffected: it signs with the service role
-- (support/[id]/page.tsx:60), which bypasses RLS. So this is invisible from the staff
-- side, which is exactly why it survived — the person who attaches the file can always
-- see it, and the person it was sent to never can.
--
-- The path already names its own thread, deliberately ("the object path itself says
-- which thread it belongs to"). So authorize on that: the ticket named in the path must
-- be one this user owns. Scoped to the `ticket-` prefix, so it grants nothing over
-- another user's own `<uuid>/` uploads, and it reads the ticket's owner rather than
-- trusting the path — a user who guesses `ticket-999/agent-….jpg` for someone else's
-- thread still fails the EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists support_photos_read_ticket on storage.objects;
create policy support_photos_read_ticket on storage.objects
  for select to authenticated
  using (
    bucket_id = 'support-photos'
    and (storage.foldername(name))[1] like 'ticket-%'
    and exists (
      select 1
        from public.support_tickets t
       where t.id = nullif(
               substring((storage.foldername(name))[1] from '^ticket-([0-9]+)$'), ''
             )::bigint
         and t.user_id = auth.uid()
    )
  );

-- ── Prove it grants exactly what it should and nothing more ─────────────────
do $$
declare
  owner_id uuid; other_id uuid; tid bigint;
  can_owner boolean; can_other boolean;
  -- The console's real path shape.
  agent_path text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into owner_id from public.profiles where deleted_at is null limit 1;
  select id into other_id from public.profiles
   where deleted_at is null and id <> owner_id limit 1;
  if owner_id is null then
    raise exception 'no live profile to stage against';
  end if;

  insert into public.support_tickets (user_id, email, subject, status)
  values (owner_id, 'probe@example.com', 'storage policy probe', 'open')
  returning id into tid;
  agent_path := 'ticket-' || tid || '/agent-probe.jpg';

  -- Evaluate the policy's predicate directly for each viewer. (Inserting a storage
  -- object and re-authenticating is not available inside a migration; the predicate IS
  -- the thing under test.)
  select exists (
    select 1 from public.support_tickets t
     where t.id = nullif(substring((storage.foldername(agent_path))[1] from '^ticket-([0-9]+)$'), '')::bigint
       and t.user_id = owner_id
  ) into can_owner;

  select exists (
    select 1 from public.support_tickets t
     where t.id = nullif(substring((storage.foldername(agent_path))[1] from '^ticket-([0-9]+)$'), '')::bigint
       and t.user_id = other_id
  ) into can_other;

  if not can_owner then
    raise exception 'FIX FAILED: the ticket owner still cannot read %', agent_path;
  end if;
  -- Only meaningful when a second profile exists to test against.
  if other_id is not null and can_other then
    raise exception 'TOO BROAD: a non-owner can read % ', agent_path;
  end if;

  -- And the old owner-scoped policy could never have matched this path, which is the
  -- whole finding. If it could, this migration is fixing nothing.
  if (storage.foldername(agent_path))[1] = owner_id::text then
    raise exception 'probe is not discriminating: the existing policy already matched';
  end if;

  raise notice 'ticket-scoped read grants the owner and refuses others; the old policy matched neither';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'support-photos read probe passed; staged ticket rolled back';
  else
    raise;
  end if;
end $$;
