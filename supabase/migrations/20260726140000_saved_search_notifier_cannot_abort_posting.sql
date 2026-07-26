-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (CRITICAL, denial-of-service): one malformed saved search stopped EVERY
-- user posting a gig (2026-07-26).
--
-- notify_saved_searches() is a SECURITY DEFINER AFTER INSERT trigger on public.jobs.
-- On every gig post it loops over EVERY row in public.saved_searches — globally, not
-- just the poster's — and casts a free-form, user-authored jsonb value to numeric with
-- no validation and no exception handler:
--
--     for s in select * from public.saved_searches where notify loop
--       ...
--       minp := nullif(s.filters->>'minPay', '')::numeric;   -- 22P02 on any non-number
--
-- public.saved_searches is an ordinary PostgREST-exposed table. Its only RLS is
-- `saved_searches_owner ... using (auth.uid() = user_id)` — that pins OWNERSHIP but
-- places no constraint whatsoever on the CONTENTS of `filters`, and there is no CHECK
-- anywhere. So:
--
--   POST /rest/v1/saved_searches
--        {"user_id":"<self>","name":"x","filters":{"minPay":"abc"},"notify":true}
--
-- is accepted from any signed-in beta account, in one request, with no rate limit. From
-- that moment every OTHER user's INSERT INTO public.jobs reaches the poisoned row,
-- raises invalid_text_representation inside the AFTER trigger, and the exception aborts
-- the caller's transaction — so the gig is never created. Mobile PostJob, web GigForm
-- and the assistant's create_gig tool all fail identically.
--
-- Three things make this worse than a normal crash bug:
--   * the failure lands on everyone EXCEPT the attacker (the poster-skip runs before
--     the cast, so they can keep posting while nobody else can);
--   * saved_searches SELECT is owner-scoped, so the poisoned row is invisible to every
--     other user and to any admin list that reads as a user;
--   * the poster just sees a generic "couldn't post" error with nothing pointing at
--     saved searches, so time-to-diagnose is long.
--
-- The feature is live: the assistant writes these rows (assistant/index.ts watchForGigs
-- inserts {user_id, name, filters, notify:true}), which is why the ai_watches version —
-- the one carrying the minPay cast — is the applied definition.
--
-- Fix, in order of importance:
--   1. Wrap the per-row body in `begin ... exception when others then continue; end;`.
--      This is the load-bearing part: `filters` is free-form jsonb, minPay is merely the
--      only cast TODAY, and the next field added to this matcher would reintroduce the
--      same defect. One user's malformed saved search must never be able to abort a
--      third party's write, whatever it contains.
--   2. Make the cast total — only parse minPay when it actually looks numeric.
--   3. Escape LIKE metacharacters in the location/keyword patterns. `%` in a saved
--      search currently matches every gig; that is notification spam rather than a
--      crash, but it comes from the same "filters is trusted end to end" assumption.
--
-- Written as a TRACKED migration rather than by editing supabase/migration_ai_watches.sql
-- (a legacy hand-applied file), so this is the last definition and wins regardless of
-- which legacy file was applied last. Body otherwise reproduced verbatim.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.notify_saved_searches()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s    record;
  cat  text;
  kw   text;
  loc  text;
  minp numeric;
begin
  for s in select * from public.saved_searches where notify loop
    -- Per-row isolation. A malformed saved search belongs to ONE user; it must never
    -- abort the job insert of another. Anything this row raises is skipped, and the
    -- remaining watchers are still evaluated.
    begin
      -- never notify a poster about their own gig
      if s.user_id = new.poster_id then continue; end if;

      -- category (or 'all')
      cat := coalesce(s.filters->>'selectedCat', 'all');
      if cat <> 'all' and cat <> new.category then continue; end if;

      -- minimum pay. Total by construction: a value that is not a plain number is
      -- treated as "no minimum" rather than cast and raised.
      if s.filters->>'minPay' ~ '^[0-9]+(\.[0-9]+)?$' then
        minp := (s.filters->>'minPay')::numeric;
      else
        minp := null;
      end if;
      if minp is not null and new.pay < minp then continue; end if;

      -- location substring. `%` and `_` are escaped so a saved location cannot act as
      -- a wildcard that matches every gig.
      loc := s.filters->>'location';
      if loc is not null and loc <> ''
         and new.location not ilike '%' || replace(replace(loc, '%', '\%'), '_', '\_') || '%' then
        continue;
      end if;

      -- keyword across title / description / category (same escaping)
      kw := s.filters->>'keyword';
      if kw is not null and kw <> '' then
        kw := replace(replace(kw, '%', '\%'), '_', '\_');
        if new.title       not ilike '%' || kw || '%'
           and new.description not ilike '%' || kw || '%'
           and new.category    not ilike '%' || kw || '%' then
          continue;
        end if;
      end if;

      insert into public.notifications (user_id, type, title, body, job_id)
      values (
        s.user_id,
        'saved_search',
        coalesce(nullif(s.name, ''), 'New gig matches your watch'),
        new.title || ' · $' || new.pay::text,
        new.id
      );
    exception when others then
      -- Never let one watcher break someone else's post. Logged for the client_errors
      -- / Postgres log trail; the loop continues with the next watcher.
      raise warning 'notify_saved_searches: skipping saved_search % (%)', s.id, sqlerrm;
      continue;
    end;
  end loop;
  return new;
end;
$$;

revoke execute on function public.notify_saved_searches() from public, anon, authenticated;

-- Defence in depth: stop the bad shape being storable at all. Existing rows are not
-- retroactively validated by a CHECK, which is exactly why the trigger-side guards
-- above are the primary fix and this is secondary.
do $$
begin
  alter table public.saved_searches
    add constraint saved_searches_minpay_numeric
    check (
      filters->>'minPay' is null
      or filters->>'minPay' = ''
      or filters->>'minPay' ~ '^[0-9]+(\.[0-9]+)?$'
    ) not valid;   -- NOT VALID: do not fail the migration on pre-existing bad rows
exception when duplicate_object then
  raise notice 'saved_searches_minpay_numeric already present';
end $$;

-- Verify post-deploy:
--   1. insert a saved search with filters = '{"minPay":"abc"}' as a user
--      -> rejected by the CHECK; and if one already exists, posting a gig still works
--   2. post a gig from a DIFFERENT account -> succeeds, and matching watchers are
--      still notified
