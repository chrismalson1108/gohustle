-- ─────────────────────────────────────────────────────────────────────────────
-- Both parties to a dispute could read the staff ids on it.
--
-- OPEN_WORK carries this as an audit-2026-09-05 finding: 20260705060000 deliberately
-- hid `reports.resolved_by` and `reports.resolution` from clients as "internal to the
-- console", and the same class of column was later added to `disputes` (20260804010000)
-- with no lockdown. `disputes_select_parties` scopes ROWS to the two parties; nothing
-- scoped COLUMNS, and `profiles_select_all` resolves a staff uuid to a real name.
--
-- 20260909010000 built the earner's dispute screen on a whitelisted definer RPC
-- (`my_dispute`) rather than on that policy, and its header claims this closes the leak.
-- IT DOES NOT, and the overclaim is the reason this migration exists: the RPC changes
-- what the SCREEN reads, while `GET /rest/v1/disputes?select=assigned_to` with the same
-- session still answers. A screen is not a permission.
--
-- So: revoke the table-wide SELECT and grant the columns back by name. This is the
-- 20260705060000 pattern, applied to the table it was skipped on.
--
-- `resolution_note` IS granted, deliberately. It is the explanation of an outcome that
-- moved somebody's money, both new dispute screens already render it, and an unexplained
-- adjustment is exactly the complaint this whole change set exists to answer. The console
-- says so where the note is written, so nobody types an internal aside into it.
--
-- ⚠️ A column added to `disputes` after this is NOT granted, and PostgREST answers 403 —
-- which passes every local check and fails only in production. `__tests__/disputeTwoParty.test.js`
-- holds the three client selects to this list.
--
-- Idempotent. Ends with an assertion block that reads the grant back out of the catalog,
-- column by column — this migration's whole effect IS the grant, so there is nothing to
-- stage and nothing to roll back; what it has to prove is that the catalog agrees.
-- ─────────────────────────────────────────────────────────────────────────────

revoke select on public.disputes from anon, authenticated;

grant select (
  id, booking_id, raised_by, reason, photos, pct_paid, status, created_at,
  resolved_at, resolution_note,
  proposed_pct, respondent_id, settle_after,
  responded_at, response_stance, response_note, response_photos,
  resolution_pct, settled_at
) on public.disputes to authenticated;

comment on column public.disputes.assigned_to is
  'Staff user id. NOT granted to authenticated — see 20260909030000. Read it through the '
  'console (service_role) or my_dispute(), never by widening this grant.';

do $$
declare
  granted text[] := array[
    'id','booking_id','raised_by','reason','photos','pct_paid','status','created_at',
    'resolved_at','resolution_note','proposed_pct','respondent_id','settle_after',
    'responded_at','response_stance','response_note','response_photos',
    'resolution_pct','settled_at'
  ];
  hidden  text[] := array['assigned_to','resolved_by'];
  c text;
begin
  -- Every column the clients and the RPC need must still be readable...
  foreach c in array granted loop
    if not has_column_privilege('authenticated', 'public.disputes', c, 'select') then
      raise exception 'probe: authenticated lost SELECT on disputes.% — a client select will 403', c;
    end if;
  end loop;

  -- ...and the staff attribution must not be.
  foreach c in array hidden loop
    if has_column_privilege('authenticated', 'public.disputes', c, 'select') then
      raise exception 'probe: authenticated can still read disputes.% — the revoke did not take', c;
    end if;
  end loop;

  -- anon has no business here at all. The row policy already returns nothing for it,
  -- but a policy that returns no rows is not a grant that returns no columns, and the
  -- next policy edit is what turns that distinction into a disclosure.
  foreach c in array granted || hidden loop
    if has_column_privilege('anon', 'public.disputes', c, 'select') then
      raise exception 'probe: anon can read disputes.%', c;
    end if;
  end loop;

  -- The definer RPC must be unaffected: it runs as its owner, not as the caller.
  if not has_column_privilege('postgres', 'public.disputes', 'assigned_to', 'select') then
    raise exception 'probe: the owner lost SELECT — my_dispute and every control would break';
  end if;

  raise notice 'verified: % columns granted to authenticated, % withheld, anon holds none',
    array_length(granted, 1), array_length(hidden, 1);
end $$;
