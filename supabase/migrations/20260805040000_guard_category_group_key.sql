-- ─────────────────────────────────────────────────────────────────────────────
-- guard_category_write: pin group_key too (2026-08-05).
--
-- The guard already pins status, merged_into, usage_count, base_rate, ion and
-- created_by on a user-created category — everything that decides how a category
-- behaves. It left group_key client-controlled, which is the same forgery one
-- indirection away: group_key selects the group, and the group carries the map-pin
-- colour and the fallback base_rate. A user minting "Alpaca Shearing" could file it
-- under 'trades' and inherit the trades rate and palette.
--
-- The FK to category_groups meant only a REAL group could be named, so this was
-- never arbitrary — but "pick any of our 19 groups" is still the client choosing
-- presentation for a row curation is supposed to own. Everything else about a
-- community category is already assigned by us; this closes the last field.
--
-- 'general' is the right default: it is what the jobs-path minter already uses
-- (normalize_job_category inserts with group_key 'general'), so a category created
-- by posting a gig and one created directly now land identically. Moving it into a
-- real group is a curation decision, which is exactly what the admin console's
-- Categories page is for.
--
-- Function body otherwise reproduced verbatim from 20260805000000. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_category_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- System contexts bypass: the service role (admin console, edge functions) and
  -- anything with no JWT at all (migrations, psql, scheduled jobs). Users cannot
  -- reach the null-uid branch — the insert policy is "to authenticated".
  if coalesce(auth.role(), '') = 'service_role' or auth.uid() is null then
    return new;
  end if;

  -- A client may only ever mint a plain community category, in the default group.
  new.status      := 'community';
  new.merged_into := null;
  new.usage_count := 0;
  new.base_rate   := null;
  new.ion         := null;
  new.group_key   := 'general';
  new.created_by  := auth.uid();

  new.label := btrim(regexp_replace(coalesce(new.label, ''), '\s+', ' ', 'g'));
  new.label := left(new.label, 32);
  new.slug  := public.category_slug(new.label);

  if new.slug = '' or char_length(new.label) < 2 or new.label !~ '[a-zA-Z]' then
    raise exception 'That category name is not usable.' using errcode = 'check_violation';
  end if;

  if public.contains_prohibited(new.label) then
    raise exception 'That category contains content that is not allowed on GoHustlr.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
