// The taxonomy as this device sees it: the catalog compiled into the binary
// (shared/categories.js) merged with whatever public.categories holds right now.
// Mirrors web/lib/categories.ts — same names, same semantics.
//
// Cache-first like the rest of the app (src/lib/cache.js): a call paints from the
// last known rows immediately and a background read refreshes them. Every failure
// path bottoms out at the seed catalog and NEVER at an empty list — a poster on a
// dead connection still has to be able to pick a category and post, and the DB rows
// only ever ADD to what already shipped in the binary.

import { supabase } from './supabase';
import { cacheGet, cacheSet } from './cache';
import { findProhibited } from '../../shared/contentFilter.js';
import {
  CATEGORY_CATALOG,
  CATEGORY_GROUPS,
  categoryLabel,
  categorySlug,
  normalizeCategoryInput,
  resolveCategorySlug,
} from '../../shared/categories.js';

const CACHE_KEY = 'categories_v1';
// A day. The taxonomy is curated, not live data — a label a few hours stale costs
// nothing next to an empty picker on a cold start.
const CACHE_TTL = 24 * 60 * 60 * 1000;
// How long an in-memory index is served before the next caller quietly re-reads.
const REVALIDATE_AFTER = 5 * 60 * 1000;

const COLUMNS = 'slug, label, group_key, status, merged_into, base_rate, ion, usage_count';

const CATALOG_BY_SLUG = new Map(CATEGORY_CATALOG.map((c) => [c.slug, c]));
const GROUP_BY_KEY = new Map(CATEGORY_GROUPS.map((g) => [g.key, g]));

let memo = null;       // { index, ts } — the merged index, kept for the session
let inflight = null;   // dedupes the concurrent reads a screen mount fires off
let seedOnly = null;   // catalog-only index, built once, used when the DB is unreachable
let generation = 0;    // bumped by a write, so a read it overlapped can't win

// numeric columns come back as null for community rows (the DB guard nulls them),
// and Number(null) is 0 — which would silently price a category at $0/hr.
function rateOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function entryFromRow(slug, row) {
  const seed = CATALOG_BY_SLUG.get(slug);
  const group = GROUP_BY_KEY.get(row.group_key || (seed && seed.group)) || GROUP_BY_KEY.get('general');
  const status = row.status || 'community';
  return {
    slug,
    label: row.label || (seed ? seed.label : categoryLabel(slug)),
    group: group.key,
    groupLabel: group.label,
    // A community row carries no rate or icon of its own, so it inherits its
    // group's — categoryBaseRate()/categoryIcon() must never hand back undefined.
    rate: rateOrNull(row.base_rate) ?? (seed && Number.isFinite(seed.rate) ? seed.rate : group.rate),
    ion: row.ion || (seed && seed.ion) || group.ion,
    canonical: status === 'canonical',
    status,
    usageCount: Number(row.usage_count) || 0,
  };
}

// { list, aliases, bySlug } from raw DB rows. `list`/`bySlug` hold only SELECTABLE
// categories (contract: reserved and merged rows are never offered); `aliases` is
// the {fromSlug: toSlug} map to hand resolveCategorySlug() as extraAliases.
function buildIndex(rows) {
  const bySlug = {};
  for (const c of CATEGORY_CATALOG) bySlug[c.slug] = { ...c, status: 'canonical', usageCount: 0 };

  const aliases = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const slug = categorySlug(row.slug || row.label);
    if (!slug) continue;
    const status = row.status || 'community';

    // A merged spelling is a redirect, never a destination. Deleting rather than
    // skipping matters when curation merges away something the seed catalog still
    // lists — the DB is the authority on what is selectable.
    if (status === 'merged') {
      delete bySlug[slug];
      const target = categorySlug(row.merged_into);
      if (target && target !== slug) aliases[slug] = target;
      continue;
    }
    if (status === 'reserved') {
      delete bySlug[slug];
      continue;
    }
    bySlug[slug] = entryFromRow(slug, row);
  }

  const list = Object.values(bySlug).sort((a, b) => a.label.localeCompare(b.label));
  return { list, aliases, bySlug };
}

function seedIndex() {
  if (!seedOnly) seedOnly = buildIndex([]);
  return seedOnly;
}

function refresh() {
  if (!inflight) {
    const gen = generation;
    inflight = (async () => {
      const { data, error } = await supabase.from('categories').select(COLUMNS);
      if (error) throw error;
      const index = buildIndex(data);
      // A category minted while this read was in flight is newer than what came
      // back, so the read doesn't get to persist its snapshot over the invalidation.
      if (gen === generation) {
        await cacheSet(CACHE_KEY, data || []);
        memo = { index, ts: Date.now() };
      }
      return index;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * The whole selectable taxonomy: { list, aliases, bySlug }.
 *
 * `list` items have the CATEGORY_CATALOG shape plus `usageCount` and `status`, and
 * ALREADY include the seed catalog. The shared helpers pool CATEGORY_CATALOG with
 * whatever they are handed as `extra`, so passing `list` hands them every seeded
 * category twice — resolve their output through `bySlug` and drop the repeats, the
 * way both pickers do. `bySlug` is also the authority on what is selectable:
 * merged and reserved rows are not in it.
 *
 * Never rejects — a network failure resolves to the seed catalog.
 */
export async function fetchCategories({ force = false } = {}) {
  if (force) {
    memo = null;
    try {
      return await refresh();
    } catch (_) {
      return seedIndex();
    }
  }

  if (memo) {
    // Stale-while-revalidate: the caller gets what we have now, the DB read lands
    // for the next open.
    if (Date.now() - memo.ts > REVALIDATE_AFTER) refresh().catch(() => {});
    return memo.index;
  }

  const cached = await cacheGet(CACHE_KEY, CACHE_TTL);
  if (cached) {
    memo = { index: buildIndex(cached), ts: Date.now() };
    refresh().catch(() => {});
    return memo.index;
  }

  try {
    return await refresh();
  } catch (_) {
    return seedIndex();
  }
}

// PostgREST surfaces a primary-key collision as 23505; the message check covers
// the older shapes supabase-js has returned for the same failure.
function isDuplicate(error) {
  if (!error) return false;
  if (error.code === '23505') return true;
  return /duplicate key|already exists/i.test(String(error.message || ''));
}

/**
 * Resolve a typed or tapped category to the { slug, label } pair we store,
 * creating a community category when it is genuinely new.
 *
 * Throws an Error whose message is ready to show the user — validation is done
 * here so the field can say what is wrong instead of the whole post failing on the
 * DB guard.
 */
export async function ensureCategory(label) {
  const { list, aliases, bySlug } = await fetchCategories();

  const norm = normalizeCategoryInput(label, { findProhibited, extra: list });
  if (!norm.ok) throw new Error(norm.error);

  // Follow the DB's merge aliases too, not just the ones compiled into the shared
  // module: merging a duplicate spelling is how curation works, and someone typing
  // the merged spelling has to land on the category that survived.
  const slug = resolveCategorySlug(norm.slug, aliases);
  const known = bySlug[slug];
  if (known) return { slug: known.slug, label: known.label };

  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Sign in to add a new category.');

  const { data, error } = await supabase
    .from('categories')
    .insert({ slug: norm.slug, label: norm.label, created_by: userId })
    .select('slug, label')
    .maybeSingle();

  if (error && !isDuplicate(error)) {
    throw new Error(error.message || "Couldn't add that category.");
  }

  // The new row has to be visible to the next picker open, and to the browse chips.
  generation += 1;
  memo = null;
  await cacheSet(CACHE_KEY, null);
  if (data) return { slug: data.slug, label: data.label };

  // Duplicate: two people minting the same category at once collide on the primary
  // key, because the trigger normalizes both writes to the same slug. Whoever lost
  // the race adopts the row that exists rather than failing the post.
  const { data: existing } = await supabase
    .from('categories')
    .select('slug, label')
    .eq('slug', norm.slug)
    .maybeSingle();
  return existing
    ? { slug: existing.slug, label: existing.label }
    : { slug: norm.slug, label: norm.label };
}
