const fs = require('fs');
const path = require('path');

// The taxonomy exists in two places that MUST agree: shared/categories.js (which
// both apps import) and supabase/migrations/20260805000000_dynamic_categories.sql
// (which seeds the database). The SQL is generated from the JS by
// scripts/gen-categories-migration.js, and this file is what makes forgetting to
// re-run that a test failure instead of a half-seeded database where a category
// the picker offers does not exist server-side.
//
// It also pins the two invariants the whole design rests on:
//   1. categorySlug() and public.category_slug() produce the same identity, so a
//      client and the database never disagree about what "the same category" is.
//   2. no user-creatable category can collide with a control value ('all',
//      'foryou'), which would make it unfilterable or hijack the For You feed.
const {
  CATEGORY_CATALOG,
  CATEGORY_GROUPS,
  CATEGORY_ALIASES,
  RESERVED_CATEGORY_SLUGS,
  LEGACY_CATEGORY_LABELS,
  CATEGORY_LABEL_MAX,
  categorySlug,
  resolveCategorySlug,
  findCategory,
  categoryLabel,
  categoryColor,
  categoryBaseRate,
  categoryIcon,
  sameCategory,
  validateCategoryLabel,
  normalizeCategoryInput,
  searchCategories,
  categoriesByGroup,
  browseChipsFromJobs,
  NEUTRAL_BASE_RATE,
} = require('../shared/categories.js');
const { findProhibited } = require('../shared/contentFilter.js');

const MIGRATION = path.join(
  __dirname, '..', 'supabase', 'migrations', '20260805000000_dynamic_categories.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

// Pull the VALUES rows out of every insert block with this exact header. The
// reserved and canonical seeds share one column list, so this must collect ALL
// matching blocks — taking only the first silently compared against an empty set
// and passed no matter what the migration contained.
function valuesBlock(header) {
  const lines = sql.split('\n');
  const starts = lines.reduce((acc, l, i) => (l.startsWith(header) ? [...acc, i] : acc), []);
  if (starts.length === 0) throw new Error(`no insert block starting "${header}"`);

  const rows = [];
  for (const start of starts) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line.startsWith('on conflict')) break;
      if (!line.startsWith('(')) continue;
      // ('slug', 'label', 'group', 'status', 25, 'ion'),
      const inner = line.replace(/^\(/, '').replace(/\),?$/, '');
      const cells = inner
        .match(/'(?:[^']|'')*'|[^,]+/g)
        .map((c) => c.trim())
        .map((c) => (c.startsWith("'") ? c.slice(1, -1).replace(/''/g, "'") : c));
      rows.push(cells);
    }
  }
  return rows;
}

describe('categorySlug', () => {
  test('folds casing, spacing and punctuation to one identity', () => {
    const same = ['Lawn Care', 'lawn care', '  LAWN   CARE  ', 'Lawn-Care', 'lawn_care'];
    const slugs = new Set(same.map(categorySlug));
    expect(Array.from(slugs)).toEqual(['lawn-care']);
  });

  test('"&" and "and" agree', () => {
    expect(categorySlug('Deck & Patio')).toBe(categorySlug('Deck and Patio'));
    expect(categorySlug('Deck & Patio')).toBe('deck-and-patio');
  });

  test('strips accents via NFKD rather than inventing a character', () => {
    expect(categorySlug('Café Work')).toBe('cafe-work');
  });

  test('never leaves a leading or trailing hyphen, including after truncation', () => {
    expect(categorySlug('  --Hello--  ')).toBe('hello');
    const long = categorySlug(`${'a'.repeat(47)} bbbb`);
    expect(long).not.toMatch(/^-|-$/);
    expect(long.length).toBeLessThanOrEqual(48);
  });

  test('returns empty string (never null/undefined) for unusable input', () => {
    for (const v of ['', '   ', '!!!', '???', null, undefined]) {
      expect(categorySlug(v)).toBe('');
    }
  });
});

describe('catalog integrity', () => {
  test('every slug is unique', () => {
    const seen = new Map();
    const dupes = [];
    for (const c of CATEGORY_CATALOG) {
      if (seen.has(c.slug)) dupes.push(`${c.slug}: "${seen.get(c.slug)}" vs "${c.label}"`);
      seen.set(c.slug, c.label);
    }
    expect(dupes).toEqual([]);
  });

  test('every slug is already normalized (slugging it again is a no-op)', () => {
    const bad = CATEGORY_CATALOG.filter((c) => categorySlug(c.slug) !== c.slug);
    expect(bad.map((c) => c.slug)).toEqual([]);
  });

  test('no category collides with a reserved control value', () => {
    const clashes = CATEGORY_CATALOG.filter((c) => RESERVED_CATEGORY_SLUGS.has(c.slug));
    expect(clashes.map((c) => c.label)).toEqual([]);
  });

  test('every label fits the storage limit and the DB CHECK', () => {
    const tooLong = CATEGORY_CATALOG.filter((c) => c.label.length > CATEGORY_LABEL_MAX);
    expect(tooLong.map((c) => c.label)).toEqual([]);
  });

  test('no seeded label trips the content filter', () => {
    // The migration seeds these with the moderation trigger disarmed, so a dirty
    // label would ship as an unmoderated public browse chip.
    const dirty = CATEGORY_CATALOG
      .filter((c) => findProhibited(c.label))
      .map((c) => `${c.label} -> ${findProhibited(c.label)}`);
    expect(dirty).toEqual([]);
  });

  test('every category belongs to a declared group', () => {
    const keys = new Set(CATEGORY_GROUPS.map((g) => g.key));
    const orphans = CATEGORY_CATALOG.filter((c) => !keys.has(c.group));
    expect(orphans.map((c) => c.label)).toEqual([]);
  });

  test('aliases point at real categories and never shadow one', () => {
    const slugs = new Set(CATEGORY_CATALOG.map((c) => c.slug));
    const problems = [];
    for (const [from, to] of Object.entries(CATEGORY_ALIASES)) {
      if (categorySlug(from) !== from) problems.push(`alias key "${from}" is not a slug`);
      if (slugs.has(from)) problems.push(`alias "${from}" shadows a real category`);
      if (!slugs.has(to)) problems.push(`alias "${from}" points at missing "${to}"`);
    }
    expect(problems).toEqual([]);
  });

  test('alias chains terminate', () => {
    for (const from of Object.keys(CATEGORY_ALIASES)) {
      const end = resolveCategorySlug(from);
      expect(CATEGORY_ALIASES[end]).toBeUndefined();
    }
  });

  test('all seven legacy categories survive, so the backfill is total', () => {
    for (const label of LEGACY_CATEGORY_LABELS) {
      const hit = findCategory(label);
      expect(hit && hit.label).toBe(label);
    }
  });
});

describe('SQL/JS parity — regenerate with scripts/gen-categories-migration.js', () => {
  test('the SQL slug function mirrors the JS steps', () => {
    const fn = sql.slice(
      sql.indexOf('create or replace function public.category_slug'),
      sql.indexOf('comment on function public.category_slug'),
    );
    expect(fn).toContain('immutable');
    expect(fn).toContain('NFKD');
    expect(fn).toContain("'&', ' and '");
    expect(fn).toContain("'[^a-z0-9]+', '-', 'g'");
    expect(fn).toContain("'^-+|-+$', '', 'g'");
    expect(fn).toContain("'-+$', '', 'g'");
    expect(fn).toContain('left(');
  });

  test('canonical seed rows match the JS catalog exactly', () => {
    const rows = valuesBlock(
      "insert into public.categories (slug, label, group_key, status, base_rate, ion) values",
    ).filter((r) => r[3] === 'canonical');

    const fromSql = rows
      .map((r) => `${r[0]}|${r[1]}|${r[2]}|${Number(r[4])}|${r[5]}`)
      .sort();
    const fromJs = CATEGORY_CATALOG
      .map((c) => `${c.slug}|${c.label}|${c.group}|${Number(c.rate)}|${c.ion}`)
      .sort();

    expect(fromSql).toEqual(fromJs);
  });

  test('merge aliases match', () => {
    const rows = valuesBlock(
      'insert into public.categories (slug, label, group_key, status, merged_into) values',
    );
    const fromSql = rows.map((r) => `${r[0]}->${r[4]}`).sort();
    const fromJs = Object.entries(CATEGORY_ALIASES).map(([f, t]) => `${f}->${t}`).sort();
    expect(fromSql).toEqual(fromJs);
  });

  test('reserved slugs match', () => {
    const rows = valuesBlock(
      "insert into public.categories (slug, label, group_key, status, base_rate, ion) values",
    ).filter((r) => r[3] === 'reserved');
    expect(rows.map((r) => r[0]).sort()).toEqual(Array.from(RESERVED_CATEGORY_SLUGS).sort());
  });

  test('groups match', () => {
    const rows = valuesBlock('insert into public.category_groups (key, label, ion, color, base_rate) values');
    const fromSql = rows.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[3]}|${Number(r[4])}`).sort();
    const fromJs = CATEGORY_GROUPS
      .map((g) => `${g.key}|${g.label}|${g.ion}|${g.color}|${Number(g.rate)}`)
      .sort();
    expect(fromSql).toEqual(fromJs);
  });

  test('the guard trigger is armed only after every seed insert', () => {
    // Bound early it would rewrite the canonical seed to status 'community' (a
    // migration has no auth.role() = 'service_role') and could abort the whole
    // push on one malformed legacy value.
    const armed = sql.indexOf('create trigger trg_guard_category_write');
    const lastSeed = sql.lastIndexOf('insert into public.categories');
    expect(armed).toBeGreaterThan(lastSeed);
  });

  test('the normalizer fires after the write guard that pins a booked gig', () => {
    // Postgres runs same-timing triggers alphabetically. trg_y_* must sort after
    // trg_guard_jobs_write (which pins new.category := old.category) and after
    // trg_guard_content_jobs (which can reject the value).
    expect(sql).toContain('create trigger trg_y_normalize_job_category');
    expect('trg_y_normalize_job_category' > 'trg_guard_jobs_write').toBe(true);
    expect('trg_y_normalize_job_category' > 'trg_guard_content_jobs').toBe(true);
    expect('trg_y_normalize_job_category' < 'trg_z_guard_jobs_bump_not_future').toBe(true);
  });

  test('the profiles content guard now covers every field its function checks', () => {
    const bind = sql.slice(sql.indexOf('create trigger trg_guard_content_profiles'));
    for (const col of ['bio', 'work_status_note', 'name', 'username', 'city', 'school', 'major', 'skills']) {
      expect(bind).toContain(col);
    }
  });
});

describe('validation', () => {
  test('rejects empty, too short, too long and letterless names', () => {
    expect(validateCategoryLabel('')).toBeTruthy();
    expect(validateCategoryLabel('   ')).toBeTruthy();
    expect(validateCategoryLabel('a')).toBeTruthy();
    expect(validateCategoryLabel('12345')).toBeTruthy();
    expect(validateCategoryLabel('x'.repeat(CATEGORY_LABEL_MAX + 1))).toBeTruthy();
  });

  test('rejects contact details smuggled into a category name', () => {
    expect(validateCategoryLabel('text me 5551234567')).toBeTruthy();
    expect(validateCategoryLabel('see myjob.com/x www.a')).toBeTruthy();
    expect(validateCategoryLabel('a@b.com')).toBeTruthy();
  });

  test('rejects the control values so they can never be stored as a category', () => {
    for (const s of ['all', 'All', 'for you', 'ForYou', 'other', 'Other', 'uncategorized']) {
      expect(validateCategoryLabel(s)).toBeTruthy();
    }
  });

  test('runs the injected content filter — the field the clients used to skip', () => {
    expect(validateCategoryLabel('Escort work', findProhibited)).toBeTruthy();
    expect(validateCategoryLabel('Snow Removal', findProhibited)).toBeNull();
  });

  test('accepts a plain new category', () => {
    expect(validateCategoryLabel('Alpaca Shearing', findProhibited)).toBeNull();
  });
});

describe('normalizeCategoryInput', () => {
  test('near-duplicates collapse onto one canonical label', () => {
    for (const v of ['lawn care', 'Lawn Care', 'LAWNCARE', '  lawn-care ', 'Lawncare']) {
      const r = normalizeCategoryInput(v);
      expect(r.ok).toBe(true);
      expect(r.slug).toBe('lawn-care');
      expect(r.label).toBe('Lawn Care');
      expect(r.isNew).toBe(false);
    }
  });

  test('known aliases fold instead of minting a near-duplicate', () => {
    expect(normalizeCategoryInput('moving help').slug).toBe('moving');
    expect(normalizeCategoryInput('Snow Plowing').label).toBe('Snow Removal');
    expect(normalizeCategoryInput('plumber').label).toBe('Plumbing');
  });

  test('a genuinely new category is flagged as new and keeps the typed casing', () => {
    const r = normalizeCategoryInput('Alpaca Shearing');
    expect(r).toMatchObject({ ok: true, slug: 'alpaca-shearing', label: 'Alpaca Shearing', isNew: true });
  });

  test('community categories loaded from the DB are recognised, not re-created', () => {
    const extra = [{ slug: 'alpaca-shearing', label: 'Alpaca Shearing', group: 'general' }];
    expect(normalizeCategoryInput('alpaca shearing', { extra }).isNew).toBe(false);
  });

  test('an invalid label never yields a storable value', () => {
    const r = normalizeCategoryInput('!!!');
    expect(r.ok).toBe(false);
    expect(r.slug).toBe('');
  });
});

describe('accessors never return undefined', () => {
  test('color, icon and rate all fall back for an unknown category', () => {
    for (const v of ['Alpaca Shearing', '', null, undefined, 'zzz']) {
      expect(typeof categoryColor(v)).toBe('string');
      expect(categoryColor(v)).toMatch(/^#[0-9A-F]{6}$/i);
      expect(typeof categoryIcon(v)).toBe('string');
      expect(categoryIcon(v).length).toBeGreaterThan(0);
      expect(Number.isFinite(categoryBaseRate(v))).toBe(true);
    }
  });

  test('an unknown category gets the neutral rate, a known one gets its own', () => {
    expect(categoryBaseRate('Alpaca Shearing')).toBe(NEUTRAL_BASE_RATE);
    expect(categoryBaseRate('Plumbing')).toBe(55);
    expect(categoryBaseRate('plumber')).toBe(55); // via alias
  });

  test('the same category is always the same colour for every viewer', () => {
    expect(categoryColor('Alpaca Shearing')).toBe(categoryColor('alpaca shearing'));
  });

  test('categoryLabel never invents a different real category', () => {
    // The old fallback was `j.category || 'Odd Jobs'`, which put real work history
    // into a category the job was never posted under.
    expect(categoryLabel('')).toBe('');
    expect(categoryLabel(null)).toBe('');
    expect(categoryLabel('Alpaca Shearing')).toBe('Alpaca Shearing');
  });

  test('a bare slug renders as words, not hyphens', () => {
    expect(categoryLabel('alpaca-shearing')).toBe('Alpaca Shearing');
  });
});

describe('sameCategory', () => {
  test('is casing-, spacing- and alias-insensitive', () => {
    expect(sameCategory('Lawn Care', 'lawn care')).toBe(true);
    expect(sameCategory('Moving', 'moving help')).toBe(true);
    expect(sameCategory('Moving', 'Delivery')).toBe(false);
  });

  test('two empty values are not "the same category"', () => {
    expect(sameCategory('', '')).toBe(false);
    expect(sameCategory(null, undefined)).toBe(false);
  });
});

describe('searchCategories', () => {
  test('exact match ranks first', () => {
    expect(searchCategories('plumbing')[0].label).toBe('Plumbing');
  });

  test('finds by word prefix, not just string prefix', () => {
    expect(searchCategories('removal').map((c) => c.label)).toContain('Snow Removal');
    expect(searchCategories('removal').map((c) => c.label)).toContain('Junk Removal');
  });

  test('finds by group name so a vague query still lands somewhere', () => {
    expect(searchCategories('trades').length).toBeGreaterThan(0);
  });

  test('includes community categories passed in', () => {
    const extra = [{ slug: 'alpaca-shearing', label: 'Alpaca Shearing', group: 'general', groupLabel: 'General & Odd Jobs' }];
    expect(searchCategories('alpaca', { extra }).map((c) => c.label)).toEqual(['Alpaca Shearing']);
  });

  test('canonical outranks community on an equal score', () => {
    const extra = [{ slug: 'plumbing-x', label: 'Plumbing', group: 'general', canonical: false }];
    expect(searchCategories('plumbing', { extra })[0].canonical).toBe(true);
  });

  test('an empty query returns a usable list rather than nothing', () => {
    expect(searchCategories('').length).toBeGreaterThan(0);
  });

  test('a query that matches nothing returns an empty list, not everything', () => {
    expect(searchCategories('qqqqzzzz')).toEqual([]);
  });
});

describe('DB-curated merges (aliases loaded at runtime, not compiled in)', () => {
  // fetchCategories() builds this from the status='merged' rows. A merge an admin
  // curates after a build ships exists ONLY there, so every resolver has to accept
  // it — otherwise the app keeps minting duplicates of a spelling that was already
  // folded away, and the two clients disagree with the database.
  const aliases = { 'garden-work': 'gardening' };
  const extra = [{ slug: 'alpaca-shearing', label: 'Alpaca Shearing', group: 'general', groupLabel: 'General & Odd Jobs' }];

  test('resolveCategorySlug follows a runtime alias', () => {
    expect(resolveCategorySlug('Garden Work', aliases)).toBe('gardening');
  });

  test('findCategory follows a runtime alias', () => {
    expect(findCategory('Garden Work', extra, aliases).label).toBe('Gardening');
  });

  test('normalizeCategoryInput folds instead of minting a duplicate', () => {
    const r = normalizeCategoryInput('garden work', { extra, aliases });
    expect(r).toMatchObject({ ok: true, slug: 'gardening', label: 'Gardening', isNew: false });
  });

  test('without the alias map it would have created a duplicate', () => {
    expect(normalizeCategoryInput('garden work', { extra }).isNew).toBe(true);
  });

  test('sameCategory honours a runtime alias', () => {
    expect(sameCategory('Garden Work', 'Gardening', aliases)).toBe(true);
    expect(sameCategory('Garden Work', 'Gardening')).toBe(false);
  });
});

describe('categoriesByGroup', () => {
  test('does not double-list a category when handed the merged runtime list', () => {
    // Callers pass fetchCategories().list, which ALREADY contains the seed catalog.
    // Concatenating blindly listed all 199 seeded categories twice.
    const runtimeList = [...CATEGORY_CATALOG, { slug: 'alpaca-shearing', label: 'Alpaca Shearing', group: 'general' }];
    const groups = categoriesByGroup(runtimeList);
    const slugs = groups.flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs.length).toBe(new Set(slugs).size);
    expect(slugs).toContain('alpaca-shearing');
  });

  test('the runtime row wins over the seeded one, so curation is reflected', () => {
    const groups = categoriesByGroup([{ ...findCategory('Plumbing'), label: 'Plumbing & Pipes' }]);
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Plumbing & Pipes');
    expect(labels).not.toContain('Plumbing');
  });

  test('every seeded category appears exactly once with no argument', () => {
    const slugs = categoriesByGroup().flatMap((g) => g.items.map((i) => i.slug));
    expect(slugs.length).toBe(CATEGORY_CATALOG.length);
  });
});

describe('browseChipsFromJobs', () => {
  const jobs = [
    { category: 'Lawn Care' }, { category: 'lawn care' }, { category: 'Lawn Care' },
    { category: 'Plumbing' },
    { category: 'Alpaca Shearing' },
  ];

  test('chips come from the feed, so a user-created category is reachable', () => {
    const labels = browseChipsFromJobs(jobs).map((c) => c.label);
    expect(labels).toContain('Alpaca Shearing');
  });

  test('casing variants count as one chip', () => {
    const chips = browseChipsFromJobs(jobs);
    const lawn = chips.filter((c) => c.slug === 'lawn-care');
    expect(lawn).toHaveLength(1);
    expect(lawn[0].count).toBe(3);
  });

  test('most common first', () => {
    expect(browseChipsFromJobs(jobs)[0].slug).toBe('lawn-care');
  });

  test("the viewer's own recent categories float to the top when present", () => {
    const chips = browseChipsFromJobs(jobs, { recentSlugs: ['plumbing'] });
    expect(chips[0].slug).toBe('plumbing');
  });

  test('a recent category that has no live gigs does not produce a dead chip', () => {
    const chips = browseChipsFromJobs(jobs, { recentSlugs: ['welding'] });
    expect(chips.map((c) => c.slug)).not.toContain('welding');
  });

  test('control values can never become a chip', () => {
    const chips = browseChipsFromJobs([{ category: 'all' }, { category: 'For You' }, { category: 'Other' }]);
    expect(chips).toEqual([]);
  });

  test('every chip carries a renderable label and icon', () => {
    for (const c of browseChipsFromJobs(jobs)) {
      expect(c.label).toBeTruthy();
      expect(c.ion).toBeTruthy();
    }
  });

  test('prefers the stored categorySlug over re-slugging the label', () => {
    // The label is the display string and can be edited by curation; the slug is
    // the identity the database maintains. Where both exist, the slug wins.
    const chips = browseChipsFromJobs([
      { category: 'Plumbing & Pipes', categorySlug: 'plumbing' },
      { category: 'Plumbing' },
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ slug: 'plumbing', count: 2 });
  });
});
