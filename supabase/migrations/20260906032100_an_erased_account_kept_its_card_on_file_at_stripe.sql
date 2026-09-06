-- ─────────────────────────────────────────────────────────────────────────────
-- An erased account kept a live card on file at Stripe, and nothing could see it.
--
-- Both delete paths (supabase/functions/delete-account, admin/lib/deleteUser.ts) only
-- ever cancelled open PaymentIntents. Neither called `customers.del` or `accounts.del`,
-- so the Stripe CUSTOMER — created by stripe-create-setup-intent with the person's real
-- email and name, with their card attached and off-session charging enabled — survived
-- the deletion. There was no route back afterwards either: the auth row is banned, and
-- `stripe-detach-payment-method` (the only caller of paymentMethods.detach in the repo)
-- is a user-JWT function they can never reach again.
--
-- 20260813150000 made it worse without meaning to. Before it, deleting the auth user
-- cascaded the profile away and took `stripe_customers` / `stripe_accounts` with it —
-- which never removed anything AT Stripe, but at least dropped our pointer. Now the
-- profile is TOMBSTONED rather than deleted, so those rows survive too: a departed
-- uuid stays mapped to a live payment method, indefinitely.
--
-- The privacy policy (20260702020000:90) retains only what "must be retained by us or by
-- our processors (notably Stripe) to meet legal, tax, accounting, and fraud-prevention
-- obligations". Stripe's charge history is such a record. A saved card held for future
-- charges is not.
--
-- ── WHY A CONTROL AND NOT ONLY THE CODE FIX ─────────────────────────────────
-- The code fix (same commit) deletes both objects on the way out, so this stops
-- accruing. It does nothing for the accounts already erased — every one of them still
-- has a Customer object at Stripe carrying a name, an email and a card, and there is no
-- list of them anywhere. This control IS that list: a tombstoned profile that still owns
-- a stripe_customers / stripe_accounts row is a person whose data is still at the
-- processor. It also catches the code fix silently failing later (a Stripe outage
-- mid-deletion, a key rotated out, the block being reordered behind the tombstone), and
-- it auto-resolves the moment the mapping row goes, which is exactly when the object at
-- Stripe has been removed.
--
-- Deliberately NOT a `deleted_at` age filter: the deletion either removed the object or
-- it did not, and a row that has been wrong for one hour is as wrong as one that has been
-- wrong for a year. The remedy is manual — deleting a Customer at Stripe is not something
-- a control should do on its own.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.ctl_stripe_object_after_erasure()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text,
         jsonb_build_object(
           'deleted_at', p.deleted_at,
           'stripe_customer_id', c.customer_id,
           'stripe_account_id', a.account_id,
           'note', 'this account was erased, but the platform still holds a Stripe '
                   'mapping for it. A Customer object carries the person''s name and '
                   'email and keeps their saved card attached and chargeable off-session; '
                   'the profile is tombstoned rather than deleted, so nothing cascades '
                   'these rows away any more, and the banned account can never reach '
                   'stripe-detach-payment-method itself.',
           'remedy', 'Delete the Customer at Stripe (which detaches every saved card; the '
                     'charge history Stripe is obliged to keep is unaffected) and remove '
                     'the stripe_customers row. For a Connect account, delete it only if '
                     'Stripe permits — it refuses while a positive balance is owed, and '
                     'that refusal is correct: leave the row so payout webhooks stay '
                     'attributable and revisit once the balance clears.'
         )
    from public.profiles p
    left join public.stripe_customers c on c.user_id = p.id
    left join public.stripe_accounts  a on a.user_id = p.id
   where p.deleted_at is not null
     and (c.user_id is not null or a.user_id is not null)
$$;

revoke execute on function public.ctl_stripe_object_after_erasure() from public, anon, authenticated;

-- Registered, or run_all_controls never reaches it and the board stays green.
insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('stripe_object_after_erasure',
   'An erased account still has a Stripe customer or Connect account',
   'medium', 'integrity',
   'Both delete paths cancelled open PaymentIntents and stopped there — neither deleted '
   'the Stripe Customer, so a departed user''s name, email and saved card stayed at the '
   'processor with off-session charging still possible. Since the profile is tombstoned '
   'rather than deleted the local mapping row survives too, and the banned account can '
   'never reach stripe-detach-payment-method. A row here is a person who asked to be '
   'erased and whose payment method is still on file.',
   'ctl_stripe_object_after_erasure')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it fires on the erased account and stays silent on the live one ───
--
-- The probe tombstones a REAL profile, so it restores the captured values explicitly
-- BEFORE asserting anything, and the whole block sits behind an exception handler (a
-- savepoint in PL/pgSQL) that rolls every staged write back regardless.
do $$
declare
  erased uuid; live uuid;
  o_name text; o_user text; o_deleted timestamptz;
  n_erased int; n_live int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  if not exists (select 1 from public.controls
                  where key = 'stripe_object_after_erasure' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;
  raise notice 'registered in the roster run_all_controls actually iterates';

  select p.id, p.name, p.username, p.deleted_at into erased, o_name, o_user, o_deleted
    from public.profiles p
    left join public.stripe_customers c on c.user_id = p.id
    left join public.stripe_accounts a on a.user_id = p.id
   where p.deleted_at is null and c.user_id is null and a.user_id is null
   limit 1;

  select p.id into live
    from public.profiles p
    left join public.stripe_customers c on c.user_id = p.id
    left join public.stripe_accounts a on a.user_id = p.id
   where p.deleted_at is null and c.user_id is null and a.user_id is null
     and p.id <> erased
   limit 1;

  if erased is null or live is null then
    -- A brand-new database has nothing to stage against. Registration is asserted above,
    -- which is the part that cannot be checked any other way.
    raise notice 'skipping the staged probe: fewer than two unmapped live profiles exist';
    raise exception 'probe complete — rolling back';
  end if;

  -- The LIVE account: a card on file is completely normal and must never appear.
  insert into public.stripe_customers (user_id, customer_id) values (live, 'cus_probe_live');
  select count(*) into n_live from public.ctl_stripe_object_after_erasure()
   where entity_id = live::text;
  if n_live <> 0 then
    raise exception 'fired on a LIVE account with a saved card — that is normal use, % rows', n_live;
  end if;
  raise notice 'a live account with a card on file is silent, so this is not noise';

  -- The ERASED account, same shape. This is the state nothing watched.
  insert into public.stripe_customers (user_id, customer_id) values (erased, 'cus_probe_erased');
  perform public.tombstone_profile(erased);

  select count(*) into n_erased from public.ctl_stripe_object_after_erasure()
   where entity_id = erased::text;

  -- Restore the real profile FIRST, so an assertion failure below still leaves it intact.
  update public.profiles set name = o_name, username = o_user, deleted_at = o_deleted
   where id = erased;

  if n_erased <> 1 then
    raise exception 'FIX FAILED: an erased account holding a stripe_customers row reported % rows', n_erased;
  end if;
  raise notice 'discriminates: erased+mapped fires (% row), live+mapped does not (% rows)', n_erased, n_live;

  -- And removing the mapping — what the code fix now does on the way out — closes it,
  -- so the finding auto-resolves rather than sitting open forever.
  delete from public.stripe_customers where user_id = erased;
  perform public.tombstone_profile(erased);
  select count(*) into n_erased from public.ctl_stripe_object_after_erasure()
   where entity_id = erased::text;
  update public.profiles set name = o_name, username = o_user, deleted_at = o_deleted
   where id = erased;
  if n_erased <> 0 then
    raise exception 'still open after the mapping row was removed — it could never auto-resolve';
  end if;
  raise notice 'dropping the mapping row closes the finding, so it resolves rather than accumulating';

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'stripe-object-after-erasure probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
