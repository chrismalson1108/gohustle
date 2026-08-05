-- ─────────────────────────────────────────────────────────────────────────────
-- Dynamic categories (2026-08-05).
--
-- GENERATED FILE — edit shared/categories.js and re-run:
--     node scripts/gen-categories-migration.js
-- __tests__/categories.test.js parses this file and fails if it drifts from the JS.
--
-- WHY
-- ───
-- jobs.category has always been a bare `text not null` with no CHECK, no enum, no
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
--   * notify_saved_searches matched `cat <> new.category`, so a category-scoped
--     gig alert could never fire for a custom category
--   * area_market_stats took mode() over the raw text, so near-duplicate spellings
--     split the vote and the reported "top category" for an area was meaningless
--
-- WHAT THIS DOES
-- ──────────────
--  1. public.category_slug(text) — the identity function, IMMUTABLE, byte-identical
--     to categorySlug() in shared/categories.js. Everything joins and filters on it.
--  2. public.categories — the taxonomy. 199 canonical rows seeded across
--     19 groups, plus 63 merge aliases so common spellings fold into an
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
--   → trim "-" → cap at 48 → trim trailing "-"
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
             48
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
  ('home-yard', 'Home & Yard', 'leaf', '#16A34A', 26),
  ('cleaning', 'Cleaning', 'sparkles', '#06B6D4', 25),
  ('moving-labor', 'Moving & Labor', 'cube', '#F59E0B', 24),
  ('trades', 'Skilled Trades', 'hammer', '#EA580C', 45),
  ('auto', 'Auto & Transport', 'car', '#0EA5E9', 30),
  ('delivery-errands', 'Delivery & Errands', 'bicycle', '#10B981', 19),
  ('pets', 'Pets', 'paw', '#A855F7', 22),
  ('care', 'Care & Family', 'heart', '#EC4899', 23),
  ('health-fitness', 'Health & Fitness', 'fitness', '#EF4444', 42),
  ('beauty', 'Beauty & Grooming', 'cut', '#F472B6', 38),
  ('events', 'Events & Hospitality', 'calendar', '#8B5CF6', 24),
  ('food', 'Food & Kitchen', 'restaurant', '#F97316', 22),
  ('creative', 'Creative & Media', 'color-palette', '#D946EF', 40),
  ('tech', 'Tech & Digital', 'laptop', '#3B82F6', 42),
  ('business', 'Business & Admin', 'briefcase', '#6366F1', 29),
  ('education', 'Education & Tutoring', 'book', '#4F46E5', 31),
  ('retail-promo', 'Retail & Promo', 'storefront', '#14B8A6', 19),
  ('outdoors', 'Outdoors & Seasonal', 'snow', '#0891B2', 24),
  ('general', 'General & Odd Jobs', 'construct', '#64748B', 20)
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
  constraint categories_label_len         check (char_length(label) between 1 and 32),
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

-- ── 5. Seed ──────────────────────────────────────────────────────────────────
-- Reserved control values first, so nothing can later occupy them.
insert into public.categories (slug, label, group_key, status, base_rate, ion) values
  ('all', 'all', 'general', 'reserved', null, null),
  ('foryou', 'foryou', 'general', 'reserved', null, null),
  ('for-you', 'for-you', 'general', 'reserved', null, null),
  ('other', 'other', 'general', 'reserved', null, null),
  ('none', 'none', 'general', 'reserved', null, null),
  ('null', 'null', 'general', 'reserved', null, null),
  ('undefined', 'undefined', 'general', 'reserved', null, null),
  ('uncategorized', 'uncategorized', 'general', 'reserved', null, null),
  ('n-a', 'n-a', 'general', 'reserved', null, null)
on conflict (slug) do update set status = 'reserved';

insert into public.categories (slug, label, group_key, status, base_rate, ion) values
  ('lawn-care', 'Lawn Care', 'home-yard', 'canonical', 25, 'leaf'),
  ('landscaping', 'Landscaping', 'home-yard', 'canonical', 30, 'leaf'),
  ('yard-cleanup', 'Yard Cleanup', 'home-yard', 'canonical', 22, 'leaf'),
  ('leaf-removal', 'Leaf Removal', 'home-yard', 'canonical', 22, 'leaf'),
  ('tree-trimming', 'Tree Trimming', 'home-yard', 'canonical', 35, 'leaf'),
  ('gardening', 'Gardening', 'home-yard', 'canonical', 24, 'flower'),
  ('pressure-washing', 'Pressure Washing', 'home-yard', 'canonical', 30, 'water'),
  ('gutter-cleaning', 'Gutter Cleaning', 'home-yard', 'canonical', 28, 'leaf'),
  ('window-cleaning', 'Window Cleaning', 'home-yard', 'canonical', 25, 'leaf'),
  ('fence-repair', 'Fence Repair', 'home-yard', 'canonical', 30, 'leaf'),
  ('deck-and-patio', 'Deck & Patio', 'home-yard', 'canonical', 30, 'leaf'),
  ('pool-care', 'Pool Care', 'home-yard', 'canonical', 28, 'water'),
  ('sprinkler-repair', 'Sprinkler Repair', 'home-yard', 'canonical', 30, 'leaf'),
  ('pest-control', 'Pest Control', 'home-yard', 'canonical', 32, 'leaf'),
  ('junk-removal', 'Junk Removal', 'home-yard', 'canonical', 28, 'trash'),
  ('garage-cleanout', 'Garage Cleanout', 'home-yard', 'canonical', 24, 'trash'),
  ('house-cleaning', 'House Cleaning', 'cleaning', 'canonical', 25, 'sparkles'),
  ('deep-cleaning', 'Deep Cleaning', 'cleaning', 'canonical', 30, 'sparkles'),
  ('move-out-cleaning', 'Move-Out Cleaning', 'cleaning', 'canonical', 30, 'sparkles'),
  ('office-cleaning', 'Office Cleaning', 'cleaning', 'canonical', 24, 'sparkles'),
  ('carpet-cleaning', 'Carpet Cleaning', 'cleaning', 'canonical', 30, 'sparkles'),
  ('laundry-and-ironing', 'Laundry & Ironing', 'cleaning', 'canonical', 20, 'shirt'),
  ('organizing-and-decluttering', 'Organizing & Decluttering', 'cleaning', 'canonical', 28, 'sparkles'),
  ('post-construction-cleanup', 'Post-Construction Cleanup', 'cleaning', 'canonical', 28, 'sparkles'),
  ('disinfecting', 'Disinfecting', 'cleaning', 'canonical', 26, 'sparkles'),
  ('moving', 'Moving', 'moving-labor', 'canonical', 25, 'cube'),
  ('furniture-assembly', 'Furniture Assembly', 'moving-labor', 'canonical', 28, 'build'),
  ('heavy-lifting', 'Heavy Lifting', 'moving-labor', 'canonical', 25, 'cube'),
  ('loading-and-unloading', 'Loading & Unloading', 'moving-labor', 'canonical', 24, 'cube'),
  ('packing-help', 'Packing Help', 'moving-labor', 'canonical', 22, 'cube'),
  ('storage-help', 'Storage Help', 'moving-labor', 'canonical', 22, 'cube'),
  ('general-labor', 'General Labor', 'moving-labor', 'canonical', 20, 'cube'),
  ('warehouse-help', 'Warehouse Help', 'moving-labor', 'canonical', 20, 'cube'),
  ('demolition-help', 'Demolition Help', 'moving-labor', 'canonical', 26, 'cube'),
  ('handyman', 'Handyman', 'trades', 'canonical', 35, 'build'),
  ('plumbing', 'Plumbing', 'trades', 'canonical', 55, 'water'),
  ('electrical', 'Electrical', 'trades', 'canonical', 60, 'flash'),
  ('hvac', 'HVAC', 'trades', 'canonical', 60, 'hammer'),
  ('carpentry', 'Carpentry', 'trades', 'canonical', 45, 'hammer'),
  ('painting', 'Painting', 'trades', 'canonical', 30, 'brush'),
  ('drywall', 'Drywall', 'trades', 'canonical', 38, 'hammer'),
  ('flooring', 'Flooring', 'trades', 'canonical', 40, 'hammer'),
  ('tiling', 'Tiling', 'trades', 'canonical', 42, 'hammer'),
  ('roofing', 'Roofing', 'trades', 'canonical', 45, 'hammer'),
  ('masonry', 'Masonry', 'trades', 'canonical', 45, 'hammer'),
  ('welding', 'Welding', 'trades', 'canonical', 50, 'flash'),
  ('appliance-repair', 'Appliance Repair', 'trades', 'canonical', 45, 'hammer'),
  ('locksmith', 'Locksmith', 'trades', 'canonical', 50, 'hammer'),
  ('glass-and-window-repair', 'Glass & Window Repair', 'trades', 'canonical', 42, 'hammer'),
  ('construction-help', 'Construction Help', 'trades', 'canonical', 25, 'hammer'),
  ('concrete-work', 'Concrete Work', 'trades', 'canonical', 40, 'hammer'),
  ('auto-detailing', 'Auto Detailing', 'auto', 'canonical', 30, 'car'),
  ('car-wash', 'Car Wash', 'auto', 'canonical', 20, 'car'),
  ('mobile-mechanic', 'Mobile Mechanic', 'auto', 'canonical', 55, 'car'),
  ('oil-change', 'Oil Change', 'auto', 'canonical', 30, 'car'),
  ('tire-change', 'Tire Change', 'auto', 'canonical', 28, 'car'),
  ('vehicle-transport', 'Vehicle Transport', 'auto', 'canonical', 30, 'car'),
  ('bike-repair', 'Bike Repair', 'auto', 'canonical', 28, 'bicycle'),
  ('roadside-help', 'Roadside Help', 'auto', 'canonical', 30, 'car'),
  ('delivery', 'Delivery', 'delivery-errands', 'canonical', 18, 'bicycle'),
  ('errands', 'Errands', 'delivery-errands', 'canonical', 18, 'cart'),
  ('courier', 'Courier', 'delivery-errands', 'canonical', 20, 'bicycle'),
  ('grocery-shopping', 'Grocery Shopping', 'delivery-errands', 'canonical', 20, 'cart'),
  ('food-delivery', 'Food Delivery', 'delivery-errands', 'canonical', 18, 'bicycle'),
  ('furniture-delivery', 'Furniture Delivery', 'delivery-errands', 'canonical', 24, 'bicycle'),
  ('pickup-and-dropoff', 'Pickup & Dropoff', 'delivery-errands', 'canonical', 20, 'bicycle'),
  ('package-handling', 'Package Handling', 'delivery-errands', 'canonical', 18, 'bicycle'),
  ('line-sitting', 'Line Sitting', 'delivery-errands', 'canonical', 18, 'time'),
  ('shopping-assistance', 'Shopping Assistance', 'delivery-errands', 'canonical', 20, 'bag-handle'),
  ('dog-walking', 'Dog Walking', 'pets', 'canonical', 20, 'walk'),
  ('pet-sitting', 'Pet Sitting', 'pets', 'canonical', 20, 'paw'),
  ('pet-grooming', 'Pet Grooming', 'pets', 'canonical', 30, 'paw'),
  ('pet-boarding', 'Pet Boarding', 'pets', 'canonical', 25, 'paw'),
  ('pet-waste-removal', 'Pet Waste Removal', 'pets', 'canonical', 20, 'paw'),
  ('pet-transport', 'Pet Transport', 'pets', 'canonical', 22, 'paw'),
  ('dog-training', 'Dog Training', 'pets', 'canonical', 40, 'paw'),
  ('childcare', 'Childcare', 'care', 'canonical', 22, 'people'),
  ('babysitting', 'Babysitting', 'care', 'canonical', 20, 'people'),
  ('nannying', 'Nannying', 'care', 'canonical', 25, 'people'),
  ('senior-care', 'Senior Care', 'care', 'canonical', 25, 'medkit'),
  ('companion-care', 'Companion Care', 'care', 'canonical', 22, 'heart'),
  ('respite-care', 'Respite Care', 'care', 'canonical', 24, 'medkit'),
  ('housesitting', 'Housesitting', 'care', 'canonical', 20, 'home'),
  ('personal-assistant', 'Personal Assistant', 'care', 'canonical', 28, 'person'),
  ('personal-training', 'Personal Training', 'health-fitness', 'canonical', 45, 'fitness'),
  ('yoga-instruction', 'Yoga Instruction', 'health-fitness', 'canonical', 40, 'fitness'),
  ('sports-coaching', 'Sports Coaching', 'health-fitness', 'canonical', 35, 'fitness'),
  ('massage-therapy', 'Massage Therapy', 'health-fitness', 'canonical', 60, 'fitness'),
  ('nutrition-coaching', 'Nutrition Coaching', 'health-fitness', 'canonical', 45, 'nutrition'),
  ('swim-instruction', 'Swim Instruction', 'health-fitness', 'canonical', 35, 'water'),
  ('hair-styling', 'Hair Styling', 'beauty', 'canonical', 40, 'cut'),
  ('barbering', 'Barbering', 'beauty', 'canonical', 35, 'cut'),
  ('makeup-artistry', 'Makeup Artistry', 'beauty', 'canonical', 45, 'cut'),
  ('nail-tech', 'Nail Tech', 'beauty', 'canonical', 35, 'cut'),
  ('braiding', 'Braiding', 'beauty', 'canonical', 40, 'cut'),
  ('esthetics', 'Esthetics', 'beauty', 'canonical', 45, 'cut'),
  ('brows-and-lashes', 'Brows & Lashes', 'beauty', 'canonical', 40, 'cut'),
  ('event-setup', 'Event Setup', 'events', 'canonical', 22, 'calendar'),
  ('event-staff', 'Event Staff', 'events', 'canonical', 22, 'people'),
  ('bartending', 'Bartending', 'events', 'canonical', 30, 'wine'),
  ('catering-help', 'Catering Help', 'events', 'canonical', 22, 'restaurant'),
  ('serving-and-waitstaff', 'Serving & Waitstaff', 'events', 'canonical', 20, 'calendar'),
  ('event-cleanup', 'Event Cleanup', 'events', 'canonical', 20, 'calendar'),
  ('dj', 'DJ', 'events', 'canonical', 60, 'musical-notes'),
  ('live-music', 'Live Music', 'events', 'canonical', 60, 'musical-notes'),
  ('party-help', 'Party Help', 'events', 'canonical', 20, 'balloon'),
  ('wedding-help', 'Wedding Help', 'events', 'canonical', 25, 'calendar'),
  ('check-in-and-ticketing', 'Check-In & Ticketing', 'events', 'canonical', 20, 'calendar'),
  ('event-planning', 'Event Planning', 'events', 'canonical', 40, 'calendar'),
  ('cooking', 'Cooking', 'food', 'canonical', 25, 'restaurant'),
  ('meal-prep', 'Meal Prep', 'food', 'canonical', 25, 'restaurant'),
  ('baking', 'Baking', 'food', 'canonical', 25, 'restaurant'),
  ('food-prep', 'Food Prep', 'food', 'canonical', 18, 'restaurant'),
  ('dishwashing', 'Dishwashing', 'food', 'canonical', 17, 'restaurant'),
  ('kitchen-help', 'Kitchen Help', 'food', 'canonical', 18, 'restaurant'),
  ('barista', 'Barista', 'food', 'canonical', 18, 'cafe'),
  ('personal-chef', 'Personal Chef', 'food', 'canonical', 50, 'restaurant'),
  ('creative', 'Creative', 'creative', 'canonical', 35, 'color-palette'),
  ('photography', 'Photography', 'creative', 'canonical', 50, 'camera'),
  ('videography', 'Videography', 'creative', 'canonical', 55, 'videocam'),
  ('photo-editing', 'Photo Editing', 'creative', 'canonical', 35, 'camera'),
  ('video-editing', 'Video Editing', 'creative', 'canonical', 40, 'videocam'),
  ('graphic-design', 'Graphic Design', 'creative', 'canonical', 45, 'color-palette'),
  ('illustration', 'Illustration', 'creative', 'canonical', 45, 'brush'),
  ('animation', 'Animation', 'creative', 'canonical', 50, 'color-palette'),
  ('web-design', 'Web Design', 'creative', 'canonical', 50, 'color-palette'),
  ('ui-ux-design', 'UI/UX Design', 'creative', 'canonical', 60, 'color-palette'),
  ('voice-over', 'Voice Over', 'creative', 'canonical', 45, 'mic'),
  ('audio-editing', 'Audio Editing', 'creative', 'canonical', 40, 'musical-notes'),
  ('music-production', 'Music Production', 'creative', 'canonical', 45, 'musical-notes'),
  ('content-creation', 'Content Creation', 'creative', 'canonical', 35, 'color-palette'),
  ('social-media-management', 'Social Media Management', 'creative', 'canonical', 30, 'color-palette'),
  ('copywriting', 'Copywriting', 'creative', 'canonical', 40, 'document-text'),
  ('writing-and-editing', 'Writing & Editing', 'creative', 'canonical', 35, 'document-text'),
  ('proofreading', 'Proofreading', 'creative', 'canonical', 30, 'document-text'),
  ('translation', 'Translation', 'creative', 'canonical', 35, 'language'),
  ('transcription', 'Transcription', 'creative', 'canonical', 25, 'document-text'),
  ('tech-help', 'Tech Help', 'tech', 'canonical', 30, 'laptop'),
  ('computer-repair', 'Computer Repair', 'tech', 'canonical', 40, 'desktop'),
  ('phone-repair', 'Phone Repair', 'tech', 'canonical', 40, 'phone-portrait'),
  ('tv-mounting', 'TV Mounting', 'tech', 'canonical', 35, 'laptop'),
  ('smart-home-setup', 'Smart Home Setup', 'tech', 'canonical', 40, 'home'),
  ('network-setup', 'Network Setup', 'tech', 'canonical', 45, 'wifi'),
  ('it-support', 'IT Support', 'tech', 'canonical', 45, 'headset'),
  ('software-development', 'Software Development', 'tech', 'canonical', 75, 'code-slash'),
  ('web-development', 'Web Development', 'tech', 'canonical', 65, 'code-slash'),
  ('app-development', 'App Development', 'tech', 'canonical', 70, 'code-slash'),
  ('device-setup', 'Device Setup', 'tech', 'canonical', 30, 'laptop'),
  ('printer-setup', 'Printer Setup', 'tech', 'canonical', 30, 'laptop'),
  ('data-recovery', 'Data Recovery', 'tech', 'canonical', 50, 'laptop'),
  ('administrative-support', 'Administrative Support', 'business', 'canonical', 25, 'clipboard'),
  ('bookkeeping', 'Bookkeeping', 'business', 'canonical', 40, 'calculator'),
  ('data-entry', 'Data Entry', 'business', 'canonical', 20, 'clipboard'),
  ('customer-service', 'Customer Service', 'business', 'canonical', 22, 'headset'),
  ('virtual-assistant', 'Virtual Assistant', 'business', 'canonical', 28, 'briefcase'),
  ('research', 'Research', 'business', 'canonical', 30, 'search'),
  ('scheduling', 'Scheduling', 'business', 'canonical', 22, 'calendar'),
  ('sales-support', 'Sales Support', 'business', 'canonical', 28, 'briefcase'),
  ('lead-generation', 'Lead Generation', 'business', 'canonical', 30, 'briefcase'),
  ('market-research', 'Market Research', 'business', 'canonical', 35, 'search'),
  ('notary', 'Notary', 'business', 'canonical', 40, 'document-text'),
  ('resume-help', 'Resume Help', 'business', 'canonical', 35, 'document-text'),
  ('tutoring', 'Tutoring', 'education', 'canonical', 25, 'book'),
  ('math-tutoring', 'Math Tutoring', 'education', 'canonical', 30, 'calculator'),
  ('science-tutoring', 'Science Tutoring', 'education', 'canonical', 30, 'book'),
  ('language-tutoring', 'Language Tutoring', 'education', 'canonical', 30, 'language'),
  ('test-prep', 'Test Prep', 'education', 'canonical', 40, 'book'),
  ('music-lessons', 'Music Lessons', 'education', 'canonical', 40, 'musical-notes'),
  ('art-lessons', 'Art Lessons', 'education', 'canonical', 35, 'brush'),
  ('coding-lessons', 'Coding Lessons', 'education', 'canonical', 45, 'code-slash'),
  ('reading-help', 'Reading Help', 'education', 'canonical', 25, 'book'),
  ('homework-help', 'Homework Help', 'education', 'canonical', 25, 'book'),
  ('college-prep', 'College Prep', 'education', 'canonical', 40, 'school'),
  ('driving-lessons', 'Driving Lessons', 'education', 'canonical', 40, 'car'),
  ('retail-help', 'Retail Help', 'retail-promo', 'canonical', 18, 'storefront'),
  ('cashier', 'Cashier', 'retail-promo', 'canonical', 17, 'storefront'),
  ('stocking', 'Stocking', 'retail-promo', 'canonical', 18, 'storefront'),
  ('inventory', 'Inventory', 'retail-promo', 'canonical', 20, 'clipboard'),
  ('merchandising', 'Merchandising', 'retail-promo', 'canonical', 20, 'storefront'),
  ('brand-ambassador', 'Brand Ambassador', 'retail-promo', 'canonical', 25, 'megaphone'),
  ('product-sampling', 'Product Sampling', 'retail-promo', 'canonical', 20, 'storefront'),
  ('flyering', 'Flyering', 'retail-promo', 'canonical', 18, 'megaphone'),
  ('mystery-shopping', 'Mystery Shopping', 'retail-promo', 'canonical', 20, 'storefront'),
  ('market-stall-help', 'Market Stall Help', 'retail-promo', 'canonical', 18, 'storefront'),
  ('snow-removal', 'Snow Removal', 'outdoors', 'canonical', 28, 'snow'),
  ('snow-shoveling', 'Snow Shoveling', 'outdoors', 'canonical', 22, 'snow'),
  ('holiday-decorating', 'Holiday Decorating', 'outdoors', 'canonical', 25, 'gift'),
  ('holiday-lights', 'Holiday Lights', 'outdoors', 'canonical', 28, 'bulb'),
  ('firewood-hauling', 'Firewood Hauling', 'outdoors', 'canonical', 25, 'snow'),
  ('farm-help', 'Farm Help', 'outdoors', 'canonical', 20, 'snow'),
  ('ranch-help', 'Ranch Help', 'outdoors', 'canonical', 22, 'snow'),
  ('trail-work', 'Trail Work', 'outdoors', 'canonical', 22, 'walk'),
  ('camp-help', 'Camp Help', 'outdoors', 'canonical', 20, 'snow'),
  ('odd-jobs', 'Odd Jobs', 'general', 'canonical', 20, 'construct'),
  ('general-help', 'General Help', 'general', 'canonical', 18, 'construct'),
  ('assembly', 'Assembly', 'general', 'canonical', 25, 'build'),
  ('repairs', 'Repairs', 'general', 'canonical', 30, 'build'),
  ('setup-and-teardown', 'Setup & Teardown', 'general', 'canonical', 20, 'construct'),
  ('waiting-service', 'Waiting Service', 'general', 'canonical', 18, 'time')
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
  ('moving-help', 'moving-help', 'general', 'merged', 'moving'),
  ('movers', 'movers', 'general', 'merged', 'moving'),
  ('mover', 'mover', 'general', 'merged', 'moving'),
  ('lawncare', 'lawncare', 'general', 'merged', 'lawn-care'),
  ('lawn-mowing', 'lawn-mowing', 'general', 'merged', 'lawn-care'),
  ('mowing', 'mowing', 'general', 'merged', 'lawn-care'),
  ('yard-work', 'yard-work', 'general', 'merged', 'yard-cleanup'),
  ('yardwork', 'yardwork', 'general', 'merged', 'yard-cleanup'),
  ('landscape', 'landscape', 'general', 'merged', 'landscaping'),
  ('cleaning', 'cleaning', 'general', 'merged', 'house-cleaning'),
  ('housekeeping', 'housekeeping', 'general', 'merged', 'house-cleaning'),
  ('maid-service', 'maid-service', 'general', 'merged', 'house-cleaning'),
  ('tech-support', 'tech-support', 'general', 'merged', 'tech-help'),
  ('computer-help', 'computer-help', 'general', 'merged', 'computer-repair'),
  ('pc-repair', 'pc-repair', 'general', 'merged', 'computer-repair'),
  ('dog-sitting', 'dog-sitting', 'general', 'merged', 'pet-sitting'),
  ('cat-sitting', 'cat-sitting', 'general', 'merged', 'pet-sitting'),
  ('baby-sitting', 'baby-sitting', 'general', 'merged', 'babysitting'),
  ('house-sitting', 'house-sitting', 'general', 'merged', 'housesitting'),
  ('photo', 'photo', 'general', 'merged', 'photography'),
  ('photos', 'photos', 'general', 'merged', 'photography'),
  ('video', 'video', 'general', 'merged', 'videography'),
  ('design', 'design', 'general', 'merged', 'graphic-design'),
  ('writing', 'writing', 'general', 'merged', 'writing-and-editing'),
  ('editing', 'editing', 'general', 'merged', 'writing-and-editing'),
  ('coding', 'coding', 'general', 'merged', 'software-development'),
  ('programming', 'programming', 'general', 'merged', 'software-development'),
  ('developer', 'developer', 'general', 'merged', 'software-development'),
  ('tutor', 'tutor', 'general', 'merged', 'tutoring'),
  ('tutors', 'tutors', 'general', 'merged', 'tutoring'),
  ('teaching', 'teaching', 'general', 'merged', 'tutoring'),
  ('errand', 'errand', 'general', 'merged', 'errands'),
  ('delivery-driver', 'delivery-driver', 'general', 'merged', 'delivery'),
  ('driving', 'driving', 'general', 'merged', 'delivery'),
  ('handyman-services', 'handyman-services', 'general', 'merged', 'handyman'),
  ('handywoman', 'handywoman', 'general', 'merged', 'handyman'),
  ('odd-job', 'odd-job', 'general', 'merged', 'odd-jobs'),
  ('miscellaneous', 'miscellaneous', 'general', 'merged', 'odd-jobs'),
  ('misc', 'misc', 'general', 'merged', 'odd-jobs'),
  ('snow-plowing', 'snow-plowing', 'general', 'merged', 'snow-removal'),
  ('shoveling', 'shoveling', 'general', 'merged', 'snow-shoveling'),
  ('waitress', 'waitress', 'general', 'merged', 'serving-and-waitstaff'),
  ('waiter', 'waiter', 'general', 'merged', 'serving-and-waitstaff'),
  ('server', 'server', 'general', 'merged', 'serving-and-waitstaff'),
  ('bartender', 'bartender', 'general', 'merged', 'bartending'),
  ('chef', 'chef', 'general', 'merged', 'personal-chef'),
  ('cook', 'cook', 'general', 'merged', 'cooking'),
  ('nanny', 'nanny', 'general', 'merged', 'nannying'),
  ('babysitter', 'babysitter', 'general', 'merged', 'babysitting'),
  ('dog-walker', 'dog-walker', 'general', 'merged', 'dog-walking'),
  ('painter', 'painter', 'general', 'merged', 'painting'),
  ('plumber', 'plumber', 'general', 'merged', 'plumbing'),
  ('electrician', 'electrician', 'general', 'merged', 'electrical'),
  ('carpenter', 'carpenter', 'general', 'merged', 'carpentry'),
  ('welder', 'welder', 'general', 'merged', 'welding'),
  ('mechanic', 'mechanic', 'general', 'merged', 'mobile-mechanic'),
  ('photographer', 'photographer', 'general', 'merged', 'photography'),
  ('videographer', 'videographer', 'general', 'merged', 'videography'),
  ('dj-services', 'dj-services', 'general', 'merged', 'dj'),
  ('social-media', 'social-media', 'general', 'merged', 'social-media-management'),
  ('va', 'va', 'general', 'merged', 'virtual-assistant'),
  ('admin', 'admin', 'general', 'merged', 'administrative-support'),
  ('accounting', 'accounting', 'general', 'merged', 'bookkeeping')
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
       left(btrim(regexp_replace(j.category, '\s+', ' ', 'g')), 32),
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
-- UPDATE touching `category` and re-runs contains_prohibited over the WHOLE row —
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
  raw_label := left(btrim(regexp_replace(coalesce(new.category, ''), '\s+', ' ', 'g')), 32);
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
    values (s, left(raw_label, 32), 'general', 'community', auth.uid())
    on conflict (slug) do nothing;
    new.category      := left(raw_label, 32);
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
-- category comparison. It was `cat <> new.category` — byte-exact and
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
