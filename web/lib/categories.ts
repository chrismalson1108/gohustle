// The gig taxonomy as the web app sees it: the seed catalog from
// @gohustlr/shared merged with whatever rows live in public.categories, so a
// category someone created five minutes ago is pickable here without a deploy.
// Mirrors src/lib/categories.js on mobile — same function names, same semantics.
//
// The seed catalog is the offline fallback, not a second source of truth: a
// failed fetch still returns a full, usable list rather than an empty picker.
import {
  CATEGORY_CATALOG,
  CATEGORY_GROUPS,
  findProhibited,
  normalizeCategoryInput,
  resolveCategorySlug,
} from "@gohustlr/shared";
import { supabase } from "./supabaseClient";
import { cacheGet, cacheSet } from "./cache";

export type CategoryStatus = "canonical" | "community" | "merged" | "reserved";

/** A selectable category. Same shape as a CATEGORY_CATALOG entry + usage/status. */
export interface Category {
  slug: string;
  label: string;
  group: string;
  groupLabel: string;
  rate: number;
  ion: string;
  canonical: boolean;
  usageCount: number;
  status: CategoryStatus;
}

export interface CategoryIndex {
  /** Selectable categories, most-used first. Never contains 'merged' or 'reserved' rows. */
  list: Category[];
  /** { fromSlug: toSlug } for every merged row — pass as `extraAliases` to resolveCategorySlug. */
  aliases: Record<string, string>;
  bySlug: Record<string, Category>;
}

interface CategoryRow {
  slug: string;
  label: string;
  group_key: string;
  status: CategoryStatus;
  merged_into: string | null;
  base_rate: number | null;
  ion: string | null;
  usage_count: number | null;
}

const CACHE_KEY = "categories_v1";
// Longer than the 5-minute default: the taxonomy is curated, not live data, and a
// picker that refetches 270 rows on every mount is the more visible cost.
const CACHE_TTL = 30 * 60 * 1000;
const COLUMNS = "slug, label, group_key, status, merged_into, base_rate, ion, usage_count";

const GROUP_BY_KEY = new Map(CATEGORY_GROUPS.map((g) => [g.key, g] as const));
const GENERAL_GROUP = GROUP_BY_KEY.get("general")!;

function groupFor(key: string) {
  return GROUP_BY_KEY.get(key) || GENERAL_GROUP;
}

// A community row carries no rate or icon (guard_category_write nulls both, so a
// user cannot claim a rate), which is why those fall through to the group.
function fromRow(row: CategoryRow, seeded?: Category): Category {
  const group = groupFor(row.group_key);
  return {
    slug: row.slug,
    label: row.label,
    group: group.key,
    groupLabel: group.label,
    rate: row.base_rate != null ? Number(row.base_rate) : (seeded?.rate ?? group.rate),
    ion: row.ion || seeded?.ion || group.ion,
    canonical: row.status === "canonical",
    usageCount: Number(row.usage_count) || 0,
    status: row.status,
  };
}

function buildIndex(rows: CategoryRow[]): CategoryIndex {
  const seeded = new Map<string, Category>();
  for (const c of CATEGORY_CATALOG) seeded.set(c.slug, { ...c, usageCount: 0, status: "canonical" });

  // Start from the seed so an empty or failed fetch still yields the full catalog;
  // DB rows then win on label, group, rate and status.
  const selectable = new Map<string, Category>(seeded);
  const aliases: Record<string, string> = {};

  for (const row of rows) {
    if (!row || !row.slug) continue;
    if (row.status === "merged") {
      if (row.merged_into) aliases[row.slug] = row.merged_into;
      // Curation can merge away a category that this build still ships in its seed.
      selectable.delete(row.slug);
      continue;
    }
    if (row.status === "reserved") {
      selectable.delete(row.slug);
      continue;
    }
    selectable.set(row.slug, fromRow(row, seeded.get(row.slug)));
  }

  const list = [...selectable.values()].sort(
    (a, b) => b.usageCount - a.usageCount || a.label.localeCompare(b.label),
  );
  const bySlug: Record<string, Category> = {};
  for (const c of list) bySlug[c.slug] = c;

  return { list, aliases, bySlug };
}

let memo: CategoryIndex | null = null;
let inflight: Promise<CategoryIndex> | null = null;

async function load(force: boolean): Promise<CategoryIndex> {
  if (!force) {
    const cached = await cacheGet<CategoryRow[]>(CACHE_KEY, CACHE_TTL);
    if (cached) {
      memo = buildIndex(cached);
      return memo;
    }
  }

  // public.categories is readable by `authenticated` only, so a signed-out visitor
  // lands in the fallback below rather than getting rows — by design, same as jobs.
  const { data, error } = await supabase
    .from("categories")
    .select(COLUMNS)
    .order("usage_count", { ascending: false });

  if (error || !data) {
    // Last good cache regardless of age, then the seed. Deliberately NOT memoized:
    // a degraded list must not stick for the rest of the session.
    const stale = await cacheGet<CategoryRow[]>(CACHE_KEY, Number.MAX_SAFE_INTEGER);
    return buildIndex(stale || []);
  }

  const rows = data as CategoryRow[];
  await cacheSet(CACHE_KEY, rows);
  memo = buildIndex(rows);
  return memo;
}

/**
 * The taxonomy, cached in memory and localStorage. Concurrent callers share one
 * request — several pickers mounting on the same page must not each fetch.
 */
export function fetchCategories({ force = false }: { force?: boolean } = {}): Promise<CategoryIndex> {
  if (!force && memo) return Promise.resolve(memo);
  if (!force && inflight) return inflight;
  inflight = load(force).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Resolve a typed label to the category it belongs to, creating a community row
 * when it is genuinely new. Throws with a ready-to-show message when the label is
 * unusable; tolerates the row already existing (someone else just created it).
 */
export async function ensureCategory(label: string): Promise<{ slug: string; label: string }> {
  const index = await fetchCategories();

  const norm = normalizeCategoryInput(label, { findProhibited, extra: index.list });
  if (!norm.ok) throw new Error(norm.error || "Pick or type a category.");

  // Resolve a second time WITH the DB alias map: a merge curated after this build
  // shipped exists only in `categories`, not in shared's CATEGORY_ALIASES.
  const slug = resolveCategorySlug(norm.slug, index.aliases);
  const known = index.bySlug[slug];
  if (known) return { slug: known.slug, label: known.label };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in to add a new category.");

  // created_by is what the insert policy checks. Everything else about the row
  // (status, usage, rate, icon) is pinned server-side by guard_category_write, so
  // there is nothing to gain by sending it.
  const { error } = await supabase
    .from("categories")
    .insert({ slug: norm.slug, label: norm.label, created_by: user.id });
  // 23505: someone created the same category between our fetch and this insert —
  // that is the outcome we wanted, not a failure.
  if (error && error.code !== "23505") throw new Error(error.message || "Couldn't add that category.");

  // Drop the cached list rather than patching it: the trigger normalizes the label
  // it stored, and that row is the authority on casing from here on.
  memo = null;
  await cacheSet(CACHE_KEY, null);

  const { data: row } = await supabase
    .from("categories")
    .select("slug, label")
    .eq("slug", norm.slug)
    .maybeSingle();

  return { slug: row?.slug || norm.slug, label: row?.label || norm.label };
}
