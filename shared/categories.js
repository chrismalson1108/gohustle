// ─────────────────────────────────────────────────────────────────────────────
// The gig taxonomy — ONE vocabulary shared by job categories, profile skills and
// job tags, on mobile, web, the admin console and the assistant edge function.
//
// Before this file the taxonomy was seven hardcoded labels in shared/constants.js
// (Tutoring / Delivery / Moving / Tech Help / Creative / Odd Jobs / Errands) — a
// college-campus vocabulary that could not describe snow removal, mobile
// mechanics, wedding staffing or bookkeeping. Posters worked around it by typing
// into the "Other" box, which stored raw text nothing else in the app could find.
//
// The model here is: a wide SEED CATALOG of canonical categories, plus categories
// users create themselves, all keyed by a normalized SLUG so that "Lawn Care",
// "lawn care" and "LAWNCARE " are one category rather than three.
//
//   slug   — the identity. Normalized, stable, what everything joins/filters on.
//   label  — the display string. Canonical casing for known slugs; whatever the
//            creator typed for brand-new ones.
//   group  — the bucket a category browses under.
//
// LOCKSTEP CONTRACT: categorySlug() below MUST produce byte-identical output to
// public.category_slug(text) in
// supabase/migrations/20260805000000_dynamic_categories.sql, and the CATEGORY_CATALOG
// slugs MUST match that migration's seed rows. Both are pinned by
// __tests__/categories.test.js, which parses the SQL — if you edit one, the test
// fails until you edit the other.
//
// This file is framework-agnostic on purpose (shared/package.json forbids react-native
// and react-dom imports here).
// ─────────────────────────────────────────────────────────────────────────────

// ── Slug normalization ───────────────────────────────────────────────────────

export const CATEGORY_LABEL_MIN = 2;
export const CATEGORY_LABEL_MAX = 32;
export const CATEGORY_SLUG_MAX = 48;

/**
 * The canonical identity of a category. Everything — filtering, saved-search
 * matching, badge counting, certification tallies, market stats — compares slugs,
 * never labels.
 *
 * Steps (mirrored exactly in SQL):
 *   1. NFKD-normalize, so "Café" and "Café" agree
 *   2. lowercase
 *   3. "&" → " and " (so "Deck & Patio" and "Deck and Patio" are one category)
 *   4. every run of non-[a-z0-9] → a single "-"  (this also drops the combining
 *      marks NFKD just split off, so "Café" → "cafe")
 *   5. trim leading/trailing "-", cap at CATEGORY_SLUG_MAX, trim again
 *
 * Returns '' for anything that normalizes away to nothing.
 */
export function categorySlug(input) {
  if (input == null) return '';
  return String(input)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CATEGORY_SLUG_MAX)
    .replace(/-+$/g, '');
}

/**
 * Slugs the app reserves for its own control values. `all` and `foryou` are the
 * two pseudo-categories the browse chip row uses, and they are compared against
 * the same variable that otherwise holds a real category — so a user category
 * that slugged to either would be unfilterable or would hijack the For You feed.
 * `other` was the old sentinel for "I'm about to type a custom one".
 */
export const RESERVED_CATEGORY_SLUGS = new Set([
  'all', 'foryou', 'for-you', 'other', 'none', 'null', 'undefined', 'uncategorized', 'n-a',
]);

// ── Groups ───────────────────────────────────────────────────────────────────
// `color` is used for map pins only. Per-category color on cards was removed in
// the 2026-07-21 design pass; grouping the map palette means related gigs read as
// related at a glance instead of as 200 unrelated hues.

export const CATEGORY_GROUPS = [
  { key: 'home-yard',        label: 'Home & Yard',          ion: 'leaf',            color: '#16A34A', rate: 26 },
  { key: 'cleaning',         label: 'Cleaning',             ion: 'sparkles',        color: '#06B6D4', rate: 25 },
  { key: 'moving-labor',     label: 'Moving & Labor',       ion: 'cube',            color: '#F59E0B', rate: 24 },
  { key: 'trades',           label: 'Skilled Trades',       ion: 'hammer',          color: '#EA580C', rate: 45 },
  { key: 'auto',             label: 'Auto & Transport',     ion: 'car',             color: '#0EA5E9', rate: 30 },
  { key: 'delivery-errands', label: 'Delivery & Errands',   ion: 'bicycle',         color: '#10B981', rate: 19 },
  { key: 'pets',             label: 'Pets',                 ion: 'paw',             color: '#A855F7', rate: 22 },
  { key: 'care',             label: 'Care & Family',        ion: 'heart',           color: '#EC4899', rate: 23 },
  { key: 'health-fitness',   label: 'Health & Fitness',     ion: 'fitness',         color: '#EF4444', rate: 42 },
  { key: 'beauty',           label: 'Beauty & Grooming',    ion: 'cut',             color: '#F472B6', rate: 38 },
  { key: 'events',           label: 'Events & Hospitality', ion: 'calendar',        color: '#8B5CF6', rate: 24 },
  { key: 'food',             label: 'Food & Kitchen',       ion: 'restaurant',      color: '#F97316', rate: 22 },
  { key: 'creative',         label: 'Creative & Media',     ion: 'color-palette',   color: '#D946EF', rate: 40 },
  { key: 'tech',             label: 'Tech & Digital',       ion: 'laptop',          color: '#3B82F6', rate: 42 },
  { key: 'business',         label: 'Business & Admin',     ion: 'briefcase',       color: '#6366F1', rate: 29 },
  { key: 'education',        label: 'Education & Tutoring', ion: 'book',            color: '#4F46E5', rate: 31 },
  { key: 'retail-promo',     label: 'Retail & Promo',       ion: 'storefront',      color: '#14B8A6', rate: 19 },
  { key: 'outdoors',         label: 'Outdoors & Seasonal',  ion: 'snow',            color: '#0891B2', rate: 24 },
  { key: 'general',          label: 'General & Odd Jobs',   ion: 'construct',       color: '#64748B', rate: 20 },
];

const GROUP_BY_KEY = new Map(CATEGORY_GROUPS.map((g) => [g.key, g]));

// ── The seed catalog ─────────────────────────────────────────────────────────
// Entries are [label, group, baseRate?, ion?]. The slug is DERIVED from the label
// via categorySlug() — there is no hand-written slug to drift out of sync.
// `baseRate` is a per-hour starting point for the pricing coach; omit it to
// inherit the group's rate. Legacy categories (the original seven) are marked so
// the migration's backfill is provably total.

const SEED = [
  // ── Home & Yard ────────────────────────────────────────────────────────────
  ['Lawn Care',                 'home-yard', 25],
  ['Landscaping',               'home-yard', 30],
  ['Yard Cleanup',              'home-yard', 22],
  ['Leaf Removal',              'home-yard', 22],
  ['Tree Trimming',             'home-yard', 35],
  ['Gardening',                 'home-yard', 24, 'flower'],
  ['Pressure Washing',          'home-yard', 30, 'water'],
  ['Gutter Cleaning',           'home-yard', 28],
  ['Window Cleaning',           'home-yard', 25],
  ['Fence Repair',              'home-yard', 30],
  ['Deck & Patio',              'home-yard', 30],
  ['Pool Care',                 'home-yard', 28, 'water'],
  ['Sprinkler Repair',          'home-yard', 30],
  ['Pest Control',              'home-yard', 32],
  ['Junk Removal',              'home-yard', 28, 'trash'],
  ['Garage Cleanout',           'home-yard', 24, 'trash'],

  // ── Cleaning ───────────────────────────────────────────────────────────────
  ['House Cleaning',            'cleaning', 25],
  ['Deep Cleaning',             'cleaning', 30],
  ['Move-Out Cleaning',         'cleaning', 30],
  ['Office Cleaning',           'cleaning', 24],
  ['Carpet Cleaning',           'cleaning', 30],
  ['Laundry & Ironing',         'cleaning', 20, 'shirt'],
  ['Organizing & Decluttering', 'cleaning', 28],
  ['Post-Construction Cleanup', 'cleaning', 28],
  ['Disinfecting',              'cleaning', 26],

  // ── Moving & Labor ─────────────────────────────────────────────────────────
  ['Moving',                    'moving-labor', 25],   // legacy
  ['Furniture Assembly',        'moving-labor', 28, 'build'],
  ['Heavy Lifting',             'moving-labor', 25],
  ['Loading & Unloading',       'moving-labor', 24],
  ['Packing Help',              'moving-labor', 22],
  ['Storage Help',              'moving-labor', 22],
  ['General Labor',             'moving-labor', 20],
  ['Warehouse Help',            'moving-labor', 20],
  ['Demolition Help',           'moving-labor', 26],

  // ── Skilled Trades ─────────────────────────────────────────────────────────
  ['Handyman',                  'trades', 35, 'build'],
  ['Plumbing',                  'trades', 55, 'water'],
  ['Electrical',                'trades', 60, 'flash'],
  ['HVAC',                      'trades', 60],
  ['Carpentry',                 'trades', 45],
  ['Painting',                  'trades', 30, 'brush'],
  ['Drywall',                   'trades', 38],
  ['Flooring',                  'trades', 40],
  ['Tiling',                    'trades', 42],
  ['Roofing',                   'trades', 45],
  ['Masonry',                   'trades', 45],
  ['Welding',                   'trades', 50, 'flash'],
  ['Appliance Repair',          'trades', 45],
  ['Locksmith',                 'trades', 50],
  ['Glass & Window Repair',     'trades', 42],
  ['Construction Help',         'trades', 25],
  ['Concrete Work',             'trades', 40],

  // ── Auto & Transport ───────────────────────────────────────────────────────
  ['Auto Detailing',            'auto', 30],
  ['Car Wash',                  'auto', 20],
  ['Mobile Mechanic',           'auto', 55],
  ['Oil Change',                'auto', 30],
  ['Tire Change',               'auto', 28],
  ['Vehicle Transport',         'auto', 30],
  ['Bike Repair',               'auto', 28, 'bicycle'],
  ['Roadside Help',             'auto', 30],

  // ── Delivery & Errands ─────────────────────────────────────────────────────
  ['Delivery',                  'delivery-errands', 18],  // legacy
  ['Errands',                   'delivery-errands', 18, 'cart'],  // legacy
  ['Courier',                   'delivery-errands', 20],
  ['Grocery Shopping',          'delivery-errands', 20, 'cart'],
  ['Food Delivery',             'delivery-errands', 18],
  ['Furniture Delivery',        'delivery-errands', 24],
  ['Pickup & Dropoff',          'delivery-errands', 20],
  ['Package Handling',          'delivery-errands', 18],
  ['Line Sitting',              'delivery-errands', 18, 'time'],
  ['Shopping Assistance',       'delivery-errands', 20, 'bag-handle'],

  // ── Pets ───────────────────────────────────────────────────────────────────
  ['Dog Walking',               'pets', 20, 'walk'],
  ['Pet Sitting',               'pets', 20],
  ['Pet Grooming',              'pets', 30],
  ['Pet Boarding',              'pets', 25],
  ['Pet Waste Removal',         'pets', 20],
  ['Pet Transport',             'pets', 22],
  ['Dog Training',              'pets', 40],

  // ── Care & Family ──────────────────────────────────────────────────────────
  ['Childcare',                 'care', 22, 'people'],
  ['Babysitting',               'care', 20, 'people'],
  ['Nannying',                  'care', 25, 'people'],
  ['Senior Care',               'care', 25, 'medkit'],
  ['Companion Care',            'care', 22],
  ['Respite Care',              'care', 24, 'medkit'],
  ['Housesitting',              'care', 20, 'home'],
  ['Personal Assistant',        'care', 28, 'person'],

  // ── Health & Fitness ───────────────────────────────────────────────────────
  ['Personal Training',         'health-fitness', 45],
  ['Yoga Instruction',          'health-fitness', 40],
  ['Sports Coaching',           'health-fitness', 35],
  ['Massage Therapy',           'health-fitness', 60],
  ['Nutrition Coaching',        'health-fitness', 45, 'nutrition'],
  ['Swim Instruction',          'health-fitness', 35, 'water'],

  // ── Beauty & Grooming ──────────────────────────────────────────────────────
  ['Hair Styling',              'beauty', 40],
  ['Barbering',                 'beauty', 35],
  ['Makeup Artistry',           'beauty', 45],
  ['Nail Tech',                 'beauty', 35],
  ['Braiding',                  'beauty', 40],
  ['Esthetics',                 'beauty', 45],
  ['Brows & Lashes',            'beauty', 40],

  // ── Events & Hospitality ───────────────────────────────────────────────────
  ['Event Setup',               'events', 22],
  ['Event Staff',               'events', 22, 'people'],
  ['Bartending',                'events', 30, 'wine'],
  ['Catering Help',             'events', 22, 'restaurant'],
  ['Serving & Waitstaff',       'events', 20],
  ['Event Cleanup',             'events', 20],
  ['DJ',                        'events', 60, 'musical-notes'],
  ['Live Music',                'events', 60, 'musical-notes'],
  ['Party Help',                'events', 20, 'balloon'],
  ['Wedding Help',              'events', 25],
  ['Check-In & Ticketing',      'events', 20],
  ['Event Planning',            'events', 40],

  // ── Food & Kitchen ─────────────────────────────────────────────────────────
  ['Cooking',                   'food', 25],
  ['Meal Prep',                 'food', 25],
  ['Baking',                    'food', 25],
  ['Food Prep',                 'food', 18],
  ['Dishwashing',               'food', 17],
  ['Kitchen Help',              'food', 18],
  ['Barista',                   'food', 18, 'cafe'],
  ['Personal Chef',             'food', 50],

  // ── Creative & Media ───────────────────────────────────────────────────────
  ['Creative',                  'creative', 35],  // legacy umbrella
  ['Photography',               'creative', 50, 'camera'],
  ['Videography',               'creative', 55, 'videocam'],
  ['Photo Editing',             'creative', 35, 'camera'],
  ['Video Editing',             'creative', 40, 'videocam'],
  ['Graphic Design',            'creative', 45],
  ['Illustration',              'creative', 45, 'brush'],
  ['Animation',                 'creative', 50],
  ['Web Design',                'creative', 50],
  ['UI/UX Design',              'creative', 60],
  ['Voice Over',                'creative', 45, 'mic'],
  ['Audio Editing',             'creative', 40, 'musical-notes'],
  ['Music Production',          'creative', 45, 'musical-notes'],
  ['Content Creation',          'creative', 35],
  ['Social Media Management',   'creative', 30],
  ['Copywriting',               'creative', 40, 'document-text'],
  ['Writing & Editing',         'creative', 35, 'document-text'],
  ['Proofreading',              'creative', 30, 'document-text'],
  ['Translation',               'creative', 35, 'language'],
  ['Transcription',             'creative', 25, 'document-text'],

  // ── Tech & Digital ─────────────────────────────────────────────────────────
  ['Tech Help',                 'tech', 30],  // legacy
  ['Computer Repair',           'tech', 40, 'desktop'],
  ['Phone Repair',              'tech', 40, 'phone-portrait'],
  ['TV Mounting',               'tech', 35],
  ['Smart Home Setup',          'tech', 40, 'home'],
  ['Network Setup',             'tech', 45, 'wifi'],
  ['IT Support',                'tech', 45, 'headset'],
  ['Software Development',      'tech', 75, 'code-slash'],
  ['Web Development',           'tech', 65, 'code-slash'],
  ['App Development',           'tech', 70, 'code-slash'],
  ['Device Setup',              'tech', 30],
  ['Printer Setup',             'tech', 30],
  ['Data Recovery',             'tech', 50],

  // ── Business & Admin ───────────────────────────────────────────────────────
  ['Administrative Support',    'business', 25, 'clipboard'],
  ['Bookkeeping',               'business', 40, 'calculator'],
  ['Data Entry',                'business', 20, 'clipboard'],
  ['Customer Service',          'business', 22, 'headset'],
  ['Virtual Assistant',         'business', 28],
  ['Research',                  'business', 30, 'search'],
  ['Scheduling',                'business', 22, 'calendar'],
  ['Sales Support',             'business', 28],
  ['Lead Generation',           'business', 30],
  ['Market Research',           'business', 35, 'search'],
  ['Notary',                    'business', 40, 'document-text'],
  ['Resume Help',               'business', 35, 'document-text'],

  // ── Education & Tutoring ───────────────────────────────────────────────────
  ['Tutoring',                  'education', 25],  // legacy
  ['Math Tutoring',             'education', 30, 'calculator'],
  ['Science Tutoring',          'education', 30],
  ['Language Tutoring',         'education', 30, 'language'],
  ['Test Prep',                 'education', 40],
  ['Music Lessons',             'education', 40, 'musical-notes'],
  ['Art Lessons',               'education', 35, 'brush'],
  ['Coding Lessons',            'education', 45, 'code-slash'],
  ['Reading Help',              'education', 25],
  ['Homework Help',             'education', 25],
  ['College Prep',              'education', 40, 'school'],
  ['Driving Lessons',           'education', 40, 'car'],

  // ── Retail & Promo ─────────────────────────────────────────────────────────
  ['Retail Help',               'retail-promo', 18],
  ['Cashier',                   'retail-promo', 17],
  ['Stocking',                  'retail-promo', 18],
  ['Inventory',                 'retail-promo', 20, 'clipboard'],
  ['Merchandising',             'retail-promo', 20],
  ['Brand Ambassador',          'retail-promo', 25, 'megaphone'],
  ['Product Sampling',          'retail-promo', 20],
  ['Flyering',                  'retail-promo', 18, 'megaphone'],
  ['Mystery Shopping',          'retail-promo', 20],
  ['Market Stall Help',         'retail-promo', 18],

  // ── Outdoors & Seasonal ────────────────────────────────────────────────────
  ['Snow Removal',              'outdoors', 28],
  ['Snow Shoveling',            'outdoors', 22],
  ['Holiday Decorating',        'outdoors', 25, 'gift'],
  ['Holiday Lights',            'outdoors', 28, 'bulb'],
  ['Firewood Hauling',          'outdoors', 25],
  ['Farm Help',                 'outdoors', 20],
  ['Ranch Help',                'outdoors', 22],
  ['Trail Work',                'outdoors', 22, 'walk'],
  ['Camp Help',                 'outdoors', 20],

  // ── General & Odd Jobs ─────────────────────────────────────────────────────
  ['Odd Jobs',                  'general', 20],  // legacy
  ['General Help',              'general', 18],
  ['Assembly',                  'general', 25, 'build'],
  ['Repairs',                   'general', 30, 'build'],
  ['Setup & Teardown',          'general', 20],
  ['Waiting Service',           'general', 18, 'time'],
];

/**
 * The seed catalog, as { slug, label, group, groupLabel, rate, ion, canonical }.
 * `canonical: true` distinguishes seeded categories from ones users created.
 */
export const CATEGORY_CATALOG = SEED.map(([label, group, rate, ion]) => {
  const g = GROUP_BY_KEY.get(group);
  if (!g) throw new Error(`Unknown category group "${group}" for "${label}"`);
  return {
    slug: categorySlug(label),
    label,
    group,
    groupLabel: g.label,
    rate: rate ?? g.rate,
    ion: ion || g.ion,
    canonical: true,
  };
});

const CATALOG_BY_SLUG = new Map(CATEGORY_CATALOG.map((c) => [c.slug, c]));

/**
 * Spellings that should fold into an existing category instead of creating a new
 * one. Keys are slugs of what people actually type; values are canonical slugs.
 * The DB carries the same mapping as `categories.merged_into` rows, so folding
 * happens server-side too — a client that has not shipped this table still writes
 * the canonical value.
 */
export const CATEGORY_ALIASES = {
  'moving-help': 'moving',
  'movers': 'moving',
  'mover': 'moving',
  'lawncare': 'lawn-care',
  'lawn-mowing': 'lawn-care',
  'mowing': 'lawn-care',
  'yard-work': 'yard-cleanup',
  'yardwork': 'yard-cleanup',
  'landscape': 'landscaping',
  'cleaning': 'house-cleaning',
  'housekeeping': 'house-cleaning',
  'maid-service': 'house-cleaning',
  'tech-support': 'tech-help',
  'computer-help': 'computer-repair',
  'pc-repair': 'computer-repair',
  'dog-sitting': 'pet-sitting',
  'cat-sitting': 'pet-sitting',
  'baby-sitting': 'babysitting',
  'house-sitting': 'housesitting',
  'photo': 'photography',
  'photos': 'photography',
  'video': 'videography',
  'design': 'graphic-design',
  'writing': 'writing-and-editing',
  'editing': 'writing-and-editing',
  'coding': 'software-development',
  'programming': 'software-development',
  'developer': 'software-development',
  'tutor': 'tutoring',
  'tutors': 'tutoring',
  'teaching': 'tutoring',
  'errand': 'errands',
  'delivery-driver': 'delivery',
  'driving': 'delivery',
  'handyman-services': 'handyman',
  'handywoman': 'handyman',
  'odd-job': 'odd-jobs',
  'miscellaneous': 'odd-jobs',
  'misc': 'odd-jobs',
  'snow-plowing': 'snow-removal',
  'shoveling': 'snow-shoveling',
  'waitress': 'serving-and-waitstaff',
  'waiter': 'serving-and-waitstaff',
  'server': 'serving-and-waitstaff',
  'bartender': 'bartending',
  'chef': 'personal-chef',
  'cook': 'cooking',
  'nanny': 'nannying',
  'babysitter': 'babysitting',
  'dog-walker': 'dog-walking',
  'painter': 'painting',
  'plumber': 'plumbing',
  'electrician': 'electrical',
  'carpenter': 'carpentry',
  'welder': 'welding',
  'mechanic': 'mobile-mechanic',
  'photographer': 'photography',
  'videographer': 'videography',
  'dj-services': 'dj',
  'social-media': 'social-media-management',
  'va': 'virtual-assistant',
  'admin': 'administrative-support',
  'accounting': 'bookkeeping',
};

/** The seven labels the app shipped with, so migrations can prove a total backfill. */
export const LEGACY_CATEGORY_LABELS = [
  'Tutoring', 'Delivery', 'Moving', 'Tech Help', 'Creative', 'Odd Jobs', 'Errands',
];

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Follow the alias chain to the slug a category actually lives under.
 * Bounded so a bad alias cycle can never hang a render.
 */
export function resolveCategorySlug(slugish, extraAliases) {
  let slug = categorySlug(slugish);
  for (let i = 0; i < 4; i += 1) {
    const next = (extraAliases && extraAliases[slug]) || CATEGORY_ALIASES[slug];
    if (!next || next === slug) break;
    slug = next;
  }
  return slug;
}

/**
 * Look up a category by slug OR label, following aliases. `extra` is the list of
 * user-created categories loaded from the DB (see fetchCategories in the app's
 * lib/categories module) — pass it so community categories resolve too, and
 * `aliases` (the {fromSlug: toSlug} map fetchCategories builds from the merged
 * rows) so merges curated after this build shipped are followed as well.
 * Returns null when nothing matches.
 */
export function findCategory(input, extra, aliases) {
  const slug = resolveCategorySlug(input, aliases);
  if (!slug) return null;
  const seeded = CATALOG_BY_SLUG.get(slug);
  if (seeded) return seeded;
  if (Array.isArray(extra)) {
    const hit = extra.find((c) => c && c.slug === slug);
    if (hit) return hit;
  }
  return null;
}

/**
 * The string to SHOW for a category. Known slugs get their canonical casing, so a
 * gig posted as "lawn care" and one posted as "Lawn Care" both display "Lawn Care".
 * Unknown values fall back to the caller's own text, tidied — never to a made-up
 * label, and never to another real category (the old `|| 'Odd Jobs'` default
 * invented work history that did not happen).
 */
export function categoryLabel(input, extra) {
  const hit = findCategory(input, extra);
  if (hit) return hit.label;
  const raw = String(input ?? '').trim().replace(/\s+/g, ' ');
  // A bare slug reaching here means we only have the identity, not the creator's
  // casing. Title-case it: "snow-removal" → "Snow Removal", "golf" → "Golf". The
  // single-word case matters as much as the hyphenated one — a recents chip for a
  // community category rendered a lowercase "golf" next to a canonical "Delivery".
  // Anything containing a space is a real label someone typed, so it is left alone.
  const text = (raw && !/\s/.test(raw))
    ? raw.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : raw;
  return text.slice(0, CATEGORY_LABEL_MAX);
}

/** The group meta for a category, or the General group when unknown. */
export function categoryGroup(input, extra) {
  const hit = findCategory(input, extra);
  const key = hit ? hit.group : 'general';
  return GROUP_BY_KEY.get(key) || GROUP_BY_KEY.get('general');
}

/**
 * Map-pin color. Known categories take their group's color; community categories
 * get a stable color derived from the slug, so the same category is always the
 * same color for every viewer without needing a stored value.
 */
const FALLBACK_PIN_COLORS = [
  '#16A34A', '#06B6D4', '#F59E0B', '#EA580C', '#0EA5E9', '#10B981',
  '#A855F7', '#EC4899', '#EF4444', '#8B5CF6', '#F97316', '#3B82F6',
  '#6366F1', '#4F46E5', '#14B8A6', '#0891B2', '#64748B', '#D946EF',
];

export function categoryColor(input, extra) {
  const hit = findCategory(input, extra);
  if (hit) return (GROUP_BY_KEY.get(hit.group) || {}).color || FALLBACK_PIN_COLORS[0];
  const slug = resolveCategorySlug(input);
  if (!slug) return FALLBACK_PIN_COLORS[FALLBACK_PIN_COLORS.length - 1];
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return FALLBACK_PIN_COLORS[h % FALLBACK_PIN_COLORS.length];
}

/** Ionicons name for a category — group icon for unknowns, never undefined. */
export function categoryIcon(input, extra) {
  const hit = findCategory(input, extra);
  if (hit && hit.ion) return hit.ion;
  return (GROUP_BY_KEY.get('general') || {}).ion || 'construct';
}

/**
 * Per-hour starting rate for the pricing coach. Unknown categories inherit their
 * group's rate when we can place them, else a neutral default — and the caller is
 * told which, so the UI can stop claiming "category default" precision it doesn't
 * have.
 */
export const NEUTRAL_BASE_RATE = 20;

export function categoryBaseRate(input, extra) {
  const hit = findCategory(input, extra);
  if (hit && Number.isFinite(hit.rate)) return hit.rate;
  return NEUTRAL_BASE_RATE;
}

/** Do two category values refer to the same category? Slug-level, alias-aware. */
export function sameCategory(a, b, aliases) {
  const sa = resolveCategorySlug(a, aliases);
  const sb = resolveCategorySlug(b, aliases);
  return !!sa && sa === sb;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a label a user typed for a brand-new category. Returns null when it is
 * fine, or a ready-to-show message.
 *
 * `findProhibited` is injected rather than imported so this module stays free of
 * a dependency cycle with contentFilter.js; callers pass it in. The DB runs the
 * same keyword check as a backstop (guard_prohibited_content covers jobs.category),
 * but catching it here is what lets the UI point at the right field instead of
 * failing the whole post with an unexplained error.
 */
export function validateCategoryLabel(raw, findProhibited) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return 'Pick or type a category.';
  if (text.length < CATEGORY_LABEL_MIN) return 'That category is too short.';
  if (text.length > CATEGORY_LABEL_MAX) return `Keep the category under ${CATEGORY_LABEL_MAX} characters.`;
  if (!/[a-zA-Z]/.test(text)) return 'Categories need at least one letter.';
  if (/https?:\/\/|www\.|@|\d{7,}/i.test(text)) return "Categories can't contain links, emails or phone numbers.";

  const slug = categorySlug(text);
  if (!slug) return 'Use letters and numbers for a category name.';
  if (RESERVED_CATEGORY_SLUGS.has(slug)) return `"${text}" is reserved — try something more specific.`;

  if (typeof findProhibited === 'function') {
    const term = findProhibited(text);
    if (term) return "That category isn't allowed on GoHustlr.";
  }
  return null;
}

/**
 * Turn whatever a user typed or tapped into the pair we store.
 * Returns { ok, slug, label, isNew, error }.
 *
 *   ok:false  → show `error`, don't submit
 *   isNew     → this will create a community category, so the UI can say so
 *
 * When the input resolves to a known category, `label` is the CANONICAL label —
 * this is the single step that stops "lawn care"/"Lawn Care"/"LAWNCARE" becoming
 * three categories. The DB trigger applies the same snap, so clients that skip
 * this (or predate it) still land on the canonical value.
 */
export function normalizeCategoryInput(raw, { findProhibited, extra, aliases } = {}) {
  const error = validateCategoryLabel(raw, findProhibited);
  if (error) return { ok: false, slug: '', label: '', isNew: false, error };

  const slug = resolveCategorySlug(raw, aliases);
  const known = findCategory(slug, extra, aliases);
  if (known) return { ok: true, slug: known.slug, label: known.label, isNew: false, error: null };

  const label = String(raw).trim().replace(/\s+/g, ' ').slice(0, CATEGORY_LABEL_MAX);
  return { ok: true, slug, label, isNew: true, error: null };
}

// ── Search / browse ──────────────────────────────────────────────────────────

/**
 * Type-ahead over the catalog plus any community categories. This is the control
 * that actually prevents duplicates: people create near-duplicates because
 * retyping is easier than finding what exists, so the picker has to make finding
 * easier than typing.
 *
 * Ranking: exact slug > label starts-with > word starts-with > substring >
 * group-name match. Ties break toward canonical categories, then by usage.
 */
export function searchCategories(query, { extra = [], aliases, limit = 20, includeGroups = true } = {}) {
  const pool = [...CATEGORY_CATALOG, ...(Array.isArray(extra) ? extra.filter(Boolean) : [])];
  const seen = new Set();
  const unique = pool.filter((c) => {
    if (!c || !c.slug || seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });

  const q = String(query ?? '').trim().toLowerCase();
  if (!q) {
    return unique
      .slice()
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0) || a.label.localeCompare(b.label))
      .slice(0, limit);
  }

  const qSlug = categorySlug(q);
  // Aliases have to be searchable, not just resolvable. Someone typing "lawncare"
  // — the most natural spelling of the commonest gig there is — was getting "No
  // categories match that search" AND no create option, because the merge table
  // knew it meant Lawn Care while the search never consulted it. That dead-ended
  // the picker on exactly the words people actually type.
  const aliasSlug = resolveCategorySlug(q, aliases);
  const scored = [];
  for (const c of unique) {
    const label = c.label.toLowerCase();
    const words = label.split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    if (c.slug === qSlug || (aliasSlug && c.slug === aliasSlug)) score = 100;
    else if (label.startsWith(q)) score = 80;
    else if (words.some((w) => w.startsWith(q))) score = 60;
    else if (label.includes(q)) score = 40;
    else if (includeGroups && String(c.groupLabel || '').toLowerCase().includes(q)) score = 20;
    else if (c.slug.includes(qSlug) && qSlug) score = 15;
    if (score > 0) scored.push({ c, score });
  }

  scored.sort((a, b) =>
    b.score - a.score ||
    (b.c.canonical ? 1 : 0) - (a.c.canonical ? 1 : 0) ||
    (b.c.usageCount || 0) - (a.c.usageCount || 0) ||
    a.c.label.localeCompare(b.c.label));

  return scored.slice(0, limit).map((s) => s.c);
}

/**
 * Catalog grouped for a browse sheet: [{ ...group, items: [...] }].
 *
 * Deduped by slug with `extra` winning, because callers pass the merged list from
 * fetchCategories() — which already contains the seed catalog — and every seeded
 * category would otherwise appear twice in the grouped view.
 */
export function categoriesByGroup(extra = []) {
  const bySlug = new Map(CATEGORY_CATALOG.map((c) => [c.slug, c]));
  for (const c of Array.isArray(extra) ? extra : []) {
    if (c && c.slug) bySlug.set(c.slug, c);
  }
  const pool = Array.from(bySlug.values());
  return CATEGORY_GROUPS.map((g) => ({
    ...g,
    items: pool
      .filter((c) => c.group === g.key)
      .sort((a, b) => a.label.localeCompare(b.label)),
  })).filter((g) => g.items.length > 0);
}

/**
 * The chips to show above the browse feed. Data-driven rather than a constant, so
 * a category someone created is reachable the moment a gig carries it — the old
 * chip row was computed at module import from a fixed array, which is why custom
 * categories were only findable under "All".
 *
 * Order: the viewer's own recent categories first (they post the same kind of work
 * repeatedly), then whatever is most common in the feed right now.
 */
export function browseChipsFromJobs(jobs, { recentSlugs = [], extra = [], aliases, limit = 12 } = {}) {
  const counts = new Map();
  for (const j of jobs || []) {
    // categorySlug is the stored identity; fall back to slugging the label for a
    // job that predates the column or came from a cached payload.
    const slug = resolveCategorySlug((j && (j.categorySlug || j.category)) || '', aliases);
    if (!slug || RESERVED_CATEGORY_SLUGS.has(slug)) continue;
    counts.set(slug, (counts.get(slug) || 0) + 1);
  }

  const out = [];
  const pushed = new Set();
  const push = (slug) => {
    if (!slug || pushed.has(slug) || RESERVED_CATEGORY_SLUGS.has(slug)) return;
    pushed.add(slug);
    const meta = findCategory(slug, extra, aliases);
    out.push({
      id: slug,
      slug,
      label: meta ? meta.label : categoryLabel(slug, extra),
      ion: meta ? meta.ion : categoryIcon(slug, extra),
      count: counts.get(slug) || 0,
    });
  };

  for (const s of recentSlugs || []) {
    const slug = resolveCategorySlug(s, aliases);
    if (counts.has(slug)) push(slug);
  }
  Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([slug]) => push(slug));

  return out.slice(0, limit);
}
