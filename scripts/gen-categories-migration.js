#!/usr/bin/env node
// Regenerates supabase/migrations/20260805000000_dynamic_categories.sql from
// shared/categories.js, so the seeded taxonomy exists in exactly one place.
//
//   node scripts/gen-categories-migration.js
//
// __tests__/categories.test.js parses the emitted SQL and asserts it still matches
// the JS catalog, so an edit to shared/categories.js that forgets to re-run this
// fails the test suite rather than shipping a half-seeded database.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CATEGORY_CATALOG, CATEGORY_GROUPS, CATEGORY_ALIASES, RESERVED_CATEGORY_SLUGS,
  CATEGORY_LABEL_MAX, CATEGORY_SLUG_MAX,
} from '../shared/categories.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'supabase', 'migrations', '20260805000000_dynamic_categories.sql');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const canonicalRows = CATEGORY_CATALOG
  .map((c) => `  (${q(c.slug)}, ${q(c.label)}, ${q(c.group)}, 'canonical', ${c.rate}, ${q(c.ion)})`)
  .join(',\n');

const reservedRows = Array.from(RESERVED_CATEGORY_SLUGS)
  .map((s) => `  (${q(s)}, ${q(s)}, 'general', 'reserved', null, null)`)
  .join(',\n');

const aliasRows = Object.entries(CATEGORY_ALIASES)
  .map(([from, to]) => `  (${q(from)}, ${q(from)}, 'general', 'merged', ${q(to)})`)
  .join(',\n');

const groupRows = CATEGORY_GROUPS
  .map((g) => `  (${q(g.key)}, ${q(g.label)}, ${q(g.ion)}, ${q(g.color)}, ${g.rate})`)
  .join(',\n');

const sql = `-- ─────────────────────────────────────────────────────────────────────────────
-- Dynamic categories (2026-08-05).
--
-- GENERATED FILE — edit shared/categories.js and re-run:
--     node scripts/gen-categories-migration.js
-- __tests__/categories.test.js parses this file and fails if it drifts from the JS.
--
-- WHY
-- ───
-- jobs.category has always been a bare \`text not null\` with no CHECK, no enum, no
-- FK and no index. The seven categories the app offered (Tutoring / Delivery /
-- Moving / Tech Help / Creative / Odd Jobs / Errands) were a hardcoded array in
-- shared/constants.js — a campus vocabulary that could not describe snow removal,
-- a mobile mechanic, wedding staffing or bookkeeping. Posters already worked
-- around it through the "Other" free-text box, whose value was stored verbatim,
-- so production already contains off-vocabulary categories today.
--
-- The problem was never storage. It was that nothing could FIND those gigs:
--   * browse chips were computed at import time from the fixed array
--   * every comparison was byte-exact and case-sensitive, so "Lawn Care",
--     "lawn care" and "LAWNCARE " were three separate, mutually invisible categories
--   * notify_saved_searches matched \`cat <> new.category\`, so a category-scoped
--     gig alert could never fire for a custom category
--   * area_market_stats took mode() over the raw text, so near-duplicate spellings
--     split the vote and the reported "top category" for an area was meaningless
--
-- WHAT THIS DOES
-- ──────────────
--  1. public.category_slug(text) — the identity function, IMMUTABLE, byte-identical
--     to categorySlug() in shared/categories.js. Everything joins and filters on it.
--  2. public.categories — the taxonomy. ${CATEGORY_CATALOG.length} canonical rows seeded across
--     ${CATEGORY_GROUPS.length} groups, plus ${Object.keys(CATEGORY_ALIASES).length} merge aliases so common spellings fold into an
--     existing category instead of minting a near-duplicate.
--  3. jobs.category_slug — the join key, indexed, maintained by trigger.
--  4. trg_y_normalize_job_category — snaps every write to the canonical label and
--     slug, and mints a 'community' category when the value is genuinely new. This
--     runs for EVERY writer (both apps, the assistant edge function, admin) so a
--     client that predates this migration still lands on canonical values.
--  5. profiles.recent_category_slugs — the poster's own recent categories, so the
--     picker can offer what they actually use. Maintained by trigger, which is why
--     it works on web, mobile and the assistant without any client change.
--  6. notify_saved_searches + area_market_stats moved onto slugs.
--  7. trg_guard_content_profiles rebound to the columns guard_prohibited_content
--     actually checks — it has been checking skills/city/school/major since
--     20260730160000 while the trigger was still bound only to
--     (bio, work_status_note, name, username) from 20260726010000, so a skills-only
--     PATCH never fired the moderation backstop. Now that profile skills draw from
--     this same user-extensible taxonomy, that gap had to close.
--
-- Idempotent; safe to re-run. No destructive statements.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The identity function ─────────────────────────────────────────────────
-- LOCKSTEP with categorySlug() in shared/categories.js. Steps, in order:
--   NFKD-normalize → lowercase → "&" to " and " → every non-[a-z0-9] run to "-"
--   → trim "-" → cap at ${CATEGORY_SLUG_MAX} → trim trailing "-"
-- NFKD is what makes "Café" and "Café" agree; the combining marks it splits off are
-- non-alphanumeric, so the character-class step removes them and "Café" → "cafe".
-- Returns '' (never null) for input that normalizes away to nothing, matching JS.
create or replace function public.category_slug(input text)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
           left(
             regexp_replace(
               regexp_replace(
                 replace(lower(normalize(coalesce(input, ''), NFKD)), '&', ' and '),
                 '[^a-z0-9]+', '-', 'g'
               ),
               '^-+|-+$', '', 'g'
             ),
             ${CATEGORY_SLUG_MAX}
           ),
           '-+$', '', 'g'
         )
$$;

comment on function public.category_slug(text) is
  'Canonical category identity. Mirrors categorySlug() in shared/categories.js — change both together.';

-- ── 2. Group reference table ─────────────────────────────────────────────────
create table if not exists public.category_groups (
  key       text primary key,
  label     text not null,
  ion       text,
  color     text,
  base_rate numeric(8,2)
);

insert into public.category_groups (key, label, ion, color, base_rate) values
${groupRows}
on conflict (key) do update
  set label = excluded.label, ion = excluded.ion,
      color = excluded.color, base_rate = excluded.base_rate;

-- ── 3. The taxonomy ──────────────────────────────────────────────────────────
--   canonical — seeded by us, curated
--   community — created by a user posting a gig or setting a skill; live immediately
--   merged    — a spelling that folds into merged_into (never selectable itself)
--   reserved  — a slug the app uses as a control value ('all', 'foryou'), so a user
--               category can never collide with one and become unfilterable
create table if not exists public.categories (
  slug        text primary key,
  label       text not null,
  group_key   text not null default 'general' references public.category_groups(key),
  status      text not null default 'community'
              check (status in ('canonical', 'community', 'merged', 'reserved')),
  merged_into text references public.categories(slug) on delete set null,
  base_rate   numeric(8,2),
  ion         text,
  usage_count integer not null default 0,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint categories_slug_is_normalized check (slug = public.category_slug(slug)),
  constraint categories_label_len         check (char_length(label) between 1 and ${CATEGORY_LABEL_MAX}),
  constraint categories_no_self_merge     check (merged_into is distinct from slug),
  constraint categories_merged_has_target check (status <> 'merged' or merged_into is not null)
);

create index if not exists idx_categories_status    on public.categories(status);
create index if not exists idx_categories_group     on public.categories(group_key);
create index if not exists idx_categories_usage     on public.categories(usage_count desc);

alter table public.categories      enable row level security;
alter table public.category_groups enable row level security;

-- Read: any signed-in user (the picker and browse chips need the whole list).
-- Matches public.jobs, where anon select is revoked.
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated using (true);

drop policy if exists category_groups_select on public.category_groups;
create policy category_groups_select on public.category_groups
  for select to authenticated using (true);

-- Insert: a signed-in user may create a COMMUNITY category and nothing else.
-- status/merged_into/usage_count are pinned by the guard trigger below rather than
-- trusted from the client, because a WITH CHECK alone cannot stop a client from
-- claiming 'canonical' on a column it is allowed to write.
drop policy if exists categories_insert_community on public.categories;
create policy categories_insert_community on public.categories
  for insert to authenticated
  with check (created_by = auth.uid());

-- No update/delete policy: curation (promote, rename, merge) is service-role only,
-- i.e. the admin console. Users create; moderators shape.
revoke select on public.categories, public.category_groups from anon;
grant select on public.categories, public.category_groups to authenticated;
grant insert on public.categories to authenticated;

-- ── 4. Guard user-created categories ─────────────────────────────────────────
-- A community category is public text: it becomes a browse chip, renders on job
-- cards, and can surface as a "Hustlr Certified · X" claim on a stranger's profile.
-- So it gets the same keyword backstop as every other user string, plus the
-- structural rules the client already enforces (length, has-a-letter, not reserved).
--
-- The TRIGGER is bound at the very end of this migration, not here: it would
-- otherwise fire on this file's own seed inserts and rewrite every canonical row to
-- status 'community' (auth.role() is not 'service_role' during a migration), and it
-- would abort the whole push if any single legacy category value in production
-- failed a structural check.
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

  -- A client may only ever mint a plain community category.
  new.status      := 'community';
  new.merged_into := null;
  new.usage_count := 0;
  new.base_rate   := null;
  new.ion         := null;
  new.created_by  := auth.uid();

  new.label := btrim(regexp_replace(coalesce(new.label, ''), '\\s+', ' ', 'g'));
  new.label := left(new.label, ${CATEGORY_LABEL_MAX});
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

-- ── 5. Seed ──────────────────────────────────────────────────────────────────
-- Reserved control values first, so nothing can later occupy them.
insert into public.categories (slug, label, group_key, status, base_rate, ion) values
${reservedRows}
on conflict (slug) do update set status = 'reserved';

insert into public.categories (slug, label, group_key, status, base_rate, ion) values
${canonicalRows}
on conflict (slug) do update
  set label     = excluded.label,
      group_key = excluded.group_key,
      status    = 'canonical',
      base_rate = excluded.base_rate,
      ion       = excluded.ion,
      updated_at = now();

-- Merge aliases: spellings people actually type that should fold into an existing
-- category rather than mint a near-duplicate ("moving help" → Moving, "lawncare" →
-- Lawn Care, "snow plowing" → Snow Removal).
insert into public.categories (slug, label, group_key, status, merged_into) values
${aliasRows}
on conflict (slug) do update
  set status = 'merged', merged_into = excluded.merged_into, updated_at = now();

-- ── 6. Alias resolution ──────────────────────────────────────────────────────
-- Bounded loop: a bad merge cycle must never hang a gig insert.
create or replace function public.resolve_category_slug(input text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s text;
  t text;
begin
  s := public.category_slug(input);
  if s = '' then return null; end if;
  for _i in 1..4 loop
    select c.merged_into into t from public.categories c where c.slug = s;
    if t is null then exit; end if;
    s := t;
  end loop;
  return s;
end;
$$;

grant execute on function public.resolve_category_slug(text) to authenticated;

-- ── 7. jobs.category_slug ────────────────────────────────────────────────────
alter table public.jobs add column if not exists category_slug text;
create index if not exists idx_jobs_category_slug on public.jobs(category_slug);

-- Mint community categories for the off-vocabulary values already in production
-- (everything posters typed into the old "Other" box). First-seen casing wins.
insert into public.categories (slug, label, group_key, status)
select distinct on (public.category_slug(j.category))
       public.category_slug(j.category),
       left(btrim(regexp_replace(j.category, '\\s+', ' ', 'g')), ${CATEGORY_LABEL_MAX}),
       'general',
       'community'
from public.jobs j
where public.category_slug(j.category) <> ''
  and not exists (
    select 1 from public.categories c where c.slug = public.category_slug(j.category)
  )
order by public.category_slug(j.category), j.created_at
on conflict (slug) do nothing;

-- Backfill the join key, following merges.
update public.jobs
set category_slug = public.resolve_category_slug(category)
where category_slug is null;

-- Snap display labels to canonical casing, so "lawn care" and "Lawn Care" stop
-- rendering as two different things.
--
-- trg_guard_content_jobs is disabled for exactly this statement. It fires on any
-- UPDATE touching \`category\` and re-runs contains_prohibited over the WHOLE row —
-- title, description, location, tags, hazards. A single pre-existing row that would
-- now fail that check (posted before a term was added to the blocklist, or written
-- by a service-role path that bypasses it) would raise and abort the entire push,
-- for a cosmetic casing fix. auth.role() is null in a migration, so the function's
-- own service_role bypass does not apply here. The whole migration runs in one
-- transaction, so a failure anywhere rolls the disable back with it.
--
-- guard_jobs_write is deliberately LEFT ENABLED: it silently declines the change for
-- gigs with a live booking, which is the correct outcome — a booked gig's terms are
-- pinned, and category_slug (what discovery actually uses) is already set either way.
do $$
begin
  if exists (select 1 from pg_trigger
             where tgname = 'trg_guard_content_jobs'
               and tgrelid = 'public.jobs'::regclass) then
    execute 'alter table public.jobs disable trigger trg_guard_content_jobs';
  end if;
end $$;

update public.jobs j
set category = c.label
from public.categories c
where c.slug = j.category_slug
  and c.status in ('canonical', 'community')
  and j.category is distinct from c.label;

do $$
begin
  if exists (select 1 from pg_trigger
             where tgname = 'trg_guard_content_jobs'
               and tgrelid = 'public.jobs'::regclass) then
    execute 'alter table public.jobs enable trigger trg_guard_content_jobs';
  end if;
end $$;

update public.categories c
set usage_count = sub.n
from (select category_slug as slug, count(*) as n from public.jobs
      where category_slug is not null group by category_slug) sub
where c.slug = sub.slug;

-- ── 8. Normalize on every write ──────────────────────────────────────────────
-- Named trg_y_* deliberately. Postgres fires same-timing triggers in ALPHABETICAL
-- order, and this must run AFTER:
--   trg_guard_content_jobs  — so a prohibited category is rejected before we mint
--                             a categories row for it
--   trg_guard_jobs_write    — which pins new.category := old.category on a booked
--                             gig; we then normalize the pinned (already canonical)
--                             value, a no-op, instead of fighting it
-- and BEFORE trg_z_guard_jobs_bump_not_future, which is unrelated.
create or replace function public.normalize_job_category()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_label text;
  s         text;
  t         text;
  cat       public.categories%rowtype;
begin
  -- Truncate BEFORE slugging. Slugging the full string and storing a truncated
  -- label would produce a category_slug pointing at a categories row that does not
  -- exist, because the row's own slug is derived from the truncated label.
  raw_label := left(btrim(regexp_replace(coalesce(new.category, ''), '\\s+', ' ', 'g')), ${CATEGORY_LABEL_MAX});
  s := public.category_slug(raw_label);

  -- Unusable, or one of the app's control values. Degrade to uncategorised and let
  -- the post through: a category we cannot make sense of is not a reason to reject
  -- someone's gig, and the client validates with a far better message first.
  if s = ''
     or char_length(raw_label) < 2
     or raw_label !~ '[a-zA-Z]'
     or exists (select 1 from public.categories c where c.slug = s and c.status = 'reserved')
  then
    new.category_slug := null;
    return new;
  end if;

  for _i in 1..4 loop
    select c.merged_into into t from public.categories c where c.slug = s;
    if t is null then exit; end if;
    s := t;
  end loop;

  select * into cat from public.categories c where c.slug = s;
  if found then
    new.category      := cat.label;
    new.category_slug := cat.slug;
  else
    insert into public.categories (slug, label, group_key, status, created_by)
    values (s, left(raw_label, ${CATEGORY_LABEL_MAX}), 'general', 'community', auth.uid())
    on conflict (slug) do nothing;
    new.category      := left(raw_label, ${CATEGORY_LABEL_MAX});
    new.category_slug := s;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_y_normalize_job_category on public.jobs;
create trigger trg_y_normalize_job_category
  before insert or update of category on public.jobs
  for each row execute function public.normalize_job_category();

-- ── 9. Usage counts + the poster's own recent categories ─────────────────────
-- profiles.recent_category_slugs is what makes "the category is saved for them":
-- maintained server-side, so mobile, web and the assistant all get it for free.
-- Owner-private — read through my_profile() (SECURITY DEFINER), so it deliberately
-- does NOT join the cross-user column grant in 20260624221000.
alter table public.profiles
  add column if not exists recent_category_slugs text[] not null default '{}';

create or replace function public.record_job_category_use()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.category_slug is null then return new; end if;

  update public.categories
  set usage_count = usage_count + 1, updated_at = now()
  where slug = new.category_slug;

  update public.profiles p
  set recent_category_slugs =
        (array[new.category_slug] || array_remove(p.recent_category_slugs, new.category_slug))[1:8]
  where p.id = new.poster_id;

  return new;
end;
$$;

drop trigger if exists trg_record_job_category_use on public.jobs;
create trigger trg_record_job_category_use
  after insert on public.jobs
  for each row execute function public.record_job_category_use();

-- ── 10. Saved-search / gig-alert matching on the slug ────────────────────────
-- Reproduced from 20260726140000 (the latest definition); the ONLY change is the
-- category comparison. It was \`cat <> new.category\` — byte-exact and
-- case-sensitive against a free-text jsonb value — so a watch saved as "Lawn Care"
-- never fired for a gig posted as "lawn care", and no category-scoped watch could
-- ever fire for a custom category. Silent on both sides: no notification is not an
-- error, so it read as the feature simply not working.
--
-- 'foryou' deliberately still matches nothing: it is a client-only pseudo-category,
-- and treating it as 'all' would start firing alerts nobody asked for.
create or replace function public.notify_saved_searches()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s        record;
  cat      text;
  cat_slug text;
  job_slug text;
  kw       text;
  loc      text;
  minp     numeric;
begin
  job_slug := coalesce(new.category_slug, public.resolve_category_slug(new.category));

  for s in select * from public.saved_searches where notify loop
    -- Per-row isolation. A malformed saved search belongs to ONE user; it must never
    -- abort the job insert of another. Anything this row raises is skipped, and the
    -- remaining watchers are still evaluated.
    begin
      -- never notify a poster about their own gig
      if s.user_id = new.poster_id then continue; end if;

      -- category (or 'all') — compared on the resolved slug, so casing, spacing and
      -- merged spellings all match.
      cat := coalesce(s.filters->>'selectedCat', 'all');
      if cat <> 'all' then
        cat_slug := public.resolve_category_slug(cat);
        if cat_slug is null or job_slug is null or cat_slug <> job_slug then continue; end if;
      end if;

      -- minimum pay. Total by construction: a value that is not a plain number is
      -- treated as "no minimum" rather than cast and raised.
      if s.filters->>'minPay' ~ '^[0-9]+(\\.[0-9]+)?$' then
        minp := (s.filters->>'minPay')::numeric;
      else
        minp := null;
      end if;
      if minp is not null and new.pay < minp then continue; end if;

      -- location substring. \`%\` and \`_\` are escaped so a saved location cannot act as
      -- a wildcard that matches every gig.
      loc := s.filters->>'location';
      if loc is not null and loc <> ''
         and new.location not ilike '%' || replace(replace(loc, '%', '\\%'), '_', '\\_') || '%' then
        continue;
      end if;

      -- keyword across title / description / category (same escaping)
      kw := s.filters->>'keyword';
      if kw is not null and kw <> '' then
        kw := replace(replace(kw, '%', '\\%'), '_', '\\_');
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

-- notify_saved_searches must see category_slug, which trg_y_normalize_job_category
-- sets in a BEFORE trigger — AFTER triggers observe the final row, so ordering here
-- is already correct. Rebound only to guarantee it exists on a fresh database.
drop trigger if exists trg_notify_saved_searches on public.jobs;
create trigger trg_notify_saved_searches
  after insert on public.jobs
  for each row execute function public.notify_saved_searches();

-- ── 11. Market stats on the slug ─────────────────────────────────────────────
-- Reproduced from 20260630000000 (the latest definition), including the >= 3
-- privacy thresholds. The ONLY change: mode() now runs over category_slug and the
-- canonical label is looked up for display. Over raw text, "Cleaning", "cleaning"
-- and "House Cleaning" were three buckets that split the vote, so the "mostly X"
-- line an area showed was decided by whichever spelling happened to win.
create or replace function public.area_market_stats()
returns table (
  area         text,
  job_count    bigint,
  avg_pay      numeric,
  top_category text,
  avg_tip      numeric,
  worker_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with j as (
    select location as area, pay, category_slug
    from public.jobs
    where status = 'open'
      and coalesce(location, '') <> ''
  ),
  agg as (
    select
      area,
      count(*)                                       as job_count,
      round(avg(pay), 2)                             as avg_pay,
      mode() within group (order by category_slug)   as top_slug
    from j
    group by area
  ),
  tips as (
    select jb.location as area, round(avg(b.tip_amount), 2) as avg_tip
    from public.bookings b
    join public.jobs jb on jb.id = b.job_id
    where b.tip_amount > 0
      and coalesce(jb.location, '') <> ''
    group by jb.location
    having count(*) >= 3
  ),
  workers as (
    select city as area, count(*) as worker_count
    from public.profiles
    where coalesce(city, '') <> ''
    group by city
    having count(*) >= 3
  )
  select
    a.area,
    a.job_count,
    a.avg_pay,
    c.label as top_category,
    t.avg_tip,
    w.worker_count
  from agg a
  left join public.categories c on c.slug = a.top_slug
  left join tips t    on t.area = a.area
  left join workers w on w.area = a.area
  where a.job_count >= 3
  order by a.job_count desc;
$$;

revoke execute on function public.area_market_stats() from public, anon;
grant execute on function public.area_market_stats() to authenticated;

-- ── 12. Close the profiles moderation gap ────────────────────────────────────
-- guard_prohibited_content has checked skills/city/school/major since 20260730160000,
-- but trg_guard_content_profiles was last bound in 20260726010000 to
-- (bio, work_status_note, name, username) — so an UPDATE touching only skills never
-- fired it. Profile skills now come from this same user-extensible taxonomy, so the
-- column list is brought in line with what the function actually inspects.
drop trigger if exists trg_guard_content_profiles on public.profiles;
create trigger trg_guard_content_profiles
  before insert or update of bio, work_status_note, name, username, city, school, major, skills
  on public.profiles
  for each row execute function public.guard_prohibited_content();

-- ── 13. Arm the category guard ───────────────────────────────────────────────
-- Bound LAST, deliberately. Everything above (the canonical seed, the merge
-- aliases, and the community rows minted from categories already present in
-- production) is trusted system data written with no auth.uid(); binding the guard
-- earlier would have rewritten the canonical seed to 'community' and could have
-- aborted the entire push on one malformed legacy value. From here on, every
-- user-originated category insert — direct, or via normalize_job_category — is
-- keyword-moderated and structurally checked.
drop trigger if exists trg_guard_category_write on public.categories;
create trigger trg_guard_category_write
  before insert on public.categories
  for each row execute function public.guard_category_write();
`;

writeFileSync(OUT, sql);
console.log(
  `wrote ${OUT}\n  ${CATEGORY_CATALOG.length} canonical · ${Object.keys(CATEGORY_ALIASES).length} aliases · ` +
  `${RESERVED_CATEGORY_SLUGS.size} reserved · ${CATEGORY_GROUPS.length} groups`,
);
