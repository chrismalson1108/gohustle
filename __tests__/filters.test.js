import { matchesForYou, applyJobFilters, skillFitScore, jobCategorySlugs, isBrowsable, browsableJobs } from '../shared/filters.js';
import { browseChipsFromJobs } from '../shared/categories.js';

const job = (over = {}) => ({
  status: 'open',
  category: 'Tutoring',
  title: 'Calc II tutoring',
  description: 'Need help with calculus',
  pay: 40,
  payType: 'flat',
  ...over,
});

describe('matchesForYou', () => {
  test('matches when a skill equals the category', () => {
    expect(matchesForYou(job({ category: 'Tutoring' }), ['Tutoring'])).toBe(true);
  });

  test('matches across casing and merge-alias spellings of one category', () => {
    // The whole point of slugs: these are one category, not four.
    expect(matchesForYou(job({ category: 'lawn care' }), ['Lawn Care'])).toBe(true);
    expect(matchesForYou(job({ category: 'LAWNCARE' }), ['Lawn Care'])).toBe(true);
    expect(matchesForYou(job({ category: 'Lawn Care' }), ['Mowing'])).toBe(true); // alias → lawn-care
  });

  test('matches when a skill appears in the title or description', () => {
    expect(matchesForYou(job({ category: 'Errands', title: 'Math help needed' }), ['math'])).toBe(true);
    expect(matchesForYou(job({ category: 'Errands', title: 'Help', description: 'plumbing repair' }), ['Plumbing'])).toBe(true);
  });

  test('is case-insensitive and trims', () => {
    expect(matchesForYou(job({ category: 'Moving' }), ['  MOVING  '])).toBe(true);
  });

  test('matches a skill against a gig tag, alias-aware', () => {
    const j = (tags) => job({ category: 'Odd Jobs', title: 'Help', description: 'misc', tags });
    expect(matchesForYou(j(['lawncare']), ['Lawn Care'])).toBe(true);
    expect(matchesForYou(j(['Assembly']), ['assembly'])).toBe(true);
    expect(matchesForYou(j(['painting']), ['plumbing'])).toBe(false);
  });

  test('a near-miss category is a different category', () => {
    // "Furniture Assembly" and "Assembly" are two catalog categories. Treating one
    // as the other is exactly the over-matching that put IT gigs in front of
    // fitness trainers.
    const j = job({ category: 'Odd Jobs', title: 'Help', description: 'misc', tags: ['assembly'] });
    expect(matchesForYou(j, ['Furniture Assembly'])).toBe(false);
  });

  // Regression: the old rule matched a skill to a category when EITHER string
  // contained the other, which is unbounded on the category side now that anyone
  // can create a category. Both directions below matched under it.
  test('a category that is merely a substring of a skill does NOT match', () => {
    // The live hazard: someone creates the category "IT", and "it" is inside the
    // preset skill "Fitness" — so every fitness-skilled user got IT gigs in For You.
    const j = job({ category: 'IT', title: 'Fix the office printer', description: 'network is down' });
    expect(matchesForYou(j, ['Fitness'])).toBe(false);
    expect(skillFitScore(j, ['Fitness'])).toBe(0);
  });

  test('a skill that is merely a substring of a category does NOT match', () => {
    const j = job({ category: 'Personal Training', title: 'Weekly sessions', description: 'gym work' });
    expect(matchesForYou(j, ['Train'])).toBe(false);
  });

  test('a short skill never matches on free text alone', () => {
    // Raw substring matching let a two-letter skill fire on any word containing it.
    const j = job({ category: 'Moving', title: 'Waiting on the truck', description: 'digital scale' });
    expect(matchesForYou(j, ['IT'])).toBe(false);
    // …but the same skill still matches the gig it actually names.
    expect(matchesForYou(job({ category: 'IT Support' }), ['IT Support'])).toBe(true);
  });

  test('free text matches whole words, not fragments', () => {
    expect(matchesForYou(job({ category: 'Errands', title: 'Lawncare quote', description: '' }), ['lawn'])).toBe(false);
    expect(matchesForYou(job({ category: 'Errands', title: 'Mow the lawn', description: '' }), ['lawn'])).toBe(true);
  });

  test('the stored slug is the identity, ahead of the display label', () => {
    // jobs.category_slug is what the DB trigger canonicalizes and everything joins
    // on; a stale or hand-typed label must not override it.
    const j = job({ category: 'snow', categorySlug: 'snow-removal' });
    expect(matchesForYou(j, ['Snow Removal'])).toBe(true);
  });

  test('returns false with no skills, no match, or no job', () => {
    expect(matchesForYou(job(), [])).toBe(false);
    expect(matchesForYou(job({ category: 'Moving', title: 'Move couch', description: 'heavy' }), ['tutoring'])).toBe(false);
    expect(matchesForYou(null, ['anything'])).toBe(false);
  });
});

describe('jobCategorySlugs', () => {
  test('collects the category and every tag as canonical slugs', () => {
    const slugs = jobCategorySlugs({ category: 'Lawncare', tags: ['Yard Work', 'mowing'] });
    expect([...slugs].sort()).toEqual(['lawn-care', 'yard-cleanup']);
  });

  test('is empty and safe for a missing or blank job', () => {
    expect(jobCategorySlugs(null).size).toBe(0);
    expect(jobCategorySlugs({ category: '  ', tags: null }).size).toBe(0);
  });
});

describe('skillFitScore', () => {
  test('weights a category/tag identity hit above a title/description word', () => {
    const j = job({ category: 'Tutoring', title: 'Calc II help', description: 'algebra too', tags: ['math'] });
    // 'tutoring' is the category (1), 'math' is a tag (1), 'calc' and 'algebra' are
    // only words in the text (0.5 each), 'plumbing' is unrelated (0).
    expect(skillFitScore(j, ['tutoring', 'math', 'calc', 'algebra', 'plumbing'])).toBe(3);
  });

  test('an exact-category applicant outranks one who only shares a word', () => {
    // This ordering IS the poster's "Fit" sort.
    const j = job({ category: 'House Cleaning', title: 'Deep clean before a move', description: 'two floors' });
    expect(skillFitScore(j, ['House Cleaning'])).toBeGreaterThan(skillFitScore(j, ['Moving']));
  });

  test('is case-insensitive, trims, and ignores blanks', () => {
    expect(skillFitScore(job({ category: 'Moving' }), ['  MOVING  ', ''])).toBe(1);
  });

  test('returns 0 for no skills, no match, or no job', () => {
    expect(skillFitScore(job(), [])).toBe(0);
    expect(skillFitScore(job({ category: 'Moving', title: 'Move couch', description: 'heavy' }), ['tutoring'])).toBe(0);
    expect(skillFitScore(null, ['anything'])).toBe(0);
  });

  test('a better-matching applicant scores higher (drives the Fit sort)', () => {
    const j = job({ category: 'Tutoring', title: 'Calc tutoring', tags: ['math'] });
    expect(skillFitScore(j, ['tutoring', 'math'])).toBeGreaterThan(skillFitScore(j, ['tutoring']));
  });

  test('a skill matching both the category and the text still counts once', () => {
    const j = job({ category: 'Moving', title: 'Moving day', description: 'moving boxes' });
    expect(skillFitScore(j, ['Moving'])).toBe(1);
  });
});

describe('applyJobFilters — category chip', () => {
  const jobs = [
    job({ id: '1', category: 'Tutoring', title: 'Calc tutoring' }),
    job({ id: '2', category: 'Moving', title: 'Move a couch', description: 'heavy lifting' }),
    job({ id: '3', category: 'Tech Help', title: 'Fix my laptop' }),
  ];

  test('selectedCat "foryou" keeps only skill-matched gigs', () => {
    const out = applyJobFilters(jobs, { selectedCat: 'foryou', forYouSkills: ['Tutoring', 'Tech Help'] });
    expect(out.map(j => j.id).sort()).toEqual(['1', '3']);
  });

  test('selectedCat "foryou" with no skills returns nothing', () => {
    expect(applyJobFilters(jobs, { selectedCat: 'foryou', forYouSkills: [] })).toHaveLength(0);
  });

  test('a slug chip selects the gigs in that category', () => {
    expect(applyJobFilters(jobs, { selectedCat: 'tech-help' }).map(j => j.id)).toEqual(['3']);
  });

  test('a label chip still works, and matching is not byte-exact', () => {
    // Regression: the comparison was `j.category !== selectedCat`, so a chip built
    // from one gig's spelling silently dropped every gig spelled differently.
    expect(applyJobFilters(jobs, { selectedCat: 'Moving' }).map(j => j.id)).toEqual(['2']);
    const mixed = [
      job({ id: 'a', category: 'lawn care' }),
      job({ id: 'b', category: 'Lawn Care' }),
      job({ id: 'c', category: 'LAWNCARE' }),
      job({ id: 'd', category: 'Moving' }),
    ];
    expect(applyJobFilters(mixed, { selectedCat: 'lawn-care' }).map(j => j.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('the chip follows merge aliases on both sides', () => {
    const mixed = [job({ id: 'a', category: 'Mowing' }), job({ id: 'b', category: 'Moving' })];
    expect(applyJobFilters(mixed, { selectedCat: 'Lawn Care' }).map(j => j.id)).toEqual(['a']);
  });
});

describe('applyJobFilters — search', () => {
  const jobs = [
    job({ id: '1', category: 'Plumbing', title: 'Leak under the sink', description: 'drips overnight' }),
    job({ id: '2', category: 'Moving', title: 'Move a couch', description: 'heavy lifting' }),
  ];

  test('finds a gig by its category name, not just title and description', () => {
    // Nobody titles a gig with its category, so category-less search made whole
    // categories unsearchable.
    expect(applyJobFilters(jobs, { search: 'plumbing' }).map(j => j.id)).toEqual(['1']);
  });

  test('search by category is case-insensitive and canonicalized', () => {
    const odd = [job({ id: 'x', category: 'lawncare', title: 'Front yard', description: 'weekly' })];
    expect(applyJobFilters(odd, { search: 'Lawn Care' }).map(j => j.id)).toEqual(['x']);
  });

  test('title and description search still works', () => {
    expect(applyJobFilters(jobs, { search: 'couch' }).map(j => j.id)).toEqual(['2']);
    expect(applyJobFilters(jobs, { search: 'drips' }).map(j => j.id)).toEqual(['1']);
  });

  test('a gig with no description or title does not crash the feed', () => {
    const thin = [{ id: 't', status: 'open', category: 'Moving', pay: 20, payType: 'flat' }];
    expect(applyJobFilters(thin, { search: 'moving' }).map(j => j.id)).toEqual(['t']);
  });
});

// A browse chip that filters to "No gigs match your filters" reads as a broken
// control. It happened because the chip row was derived from the RAW job list while
// the feed drops gigs that are already booked, already this viewer's, or from a
// blocked poster — so a category whose only gig was spoken for still got a chip.
// isBrowsable is the single definition both sides now use.
describe('isBrowsable / browsableJobs', () => {
  const open = { id: 'a', posterId: 'p1', status: 'open', slots: [{ taken: false }] };
  const allTaken = { id: 'b', posterId: 'p2', status: 'open', slots: [{ taken: true }] };
  const cancelled = { id: 'c', posterId: 'p3', status: 'cancelled', slots: [{ taken: false }] };
  const mine = { id: 'd', posterId: 'p4', status: 'open', slots: [{ taken: false }] };
  const blocked = { id: 'e', posterId: 'blockme', status: 'open', slots: [{ taken: false }] };

  const opts = {
    blockedIds: new Set(['blockme']),
    myBookings: [{ jobId: 'd', status: 'confirmed' }],
  };

  test('keeps a gig anyone can still book', () => {
    expect(isBrowsable(open, opts)).toBe(true);
  });

  test('drops the three cases the feed also drops', () => {
    expect(isBrowsable(allTaken, opts)).toBe(false);
    expect(isBrowsable(cancelled, opts)).toBe(false);
    expect(isBrowsable(mine, opts)).toBe(false);
    expect(isBrowsable(blocked, opts)).toBe(false);
  });

  test('browsableJobs agrees exactly with what applyJobFilters keeps', () => {
    const all = [open, allTaken, cancelled, mine, blocked];
    const chipSource = browsableJobs(all, opts).map((j) => j.id);
    const feed = applyJobFilters(all, { selectedCat: 'all', ...opts }).map((j) => j.id);
    expect(chipSource).toEqual(feed);
  });

  test('a category whose only gig is unbookable produces no chip', () => {
    const jobs = [
      { ...open, category: 'Lawn Care' },
      { ...allTaken, category: 'Nails' },
    ];
    const chips = browseChipsFromJobs(browsableJobs(jobs, opts)).map((c) => c.slug);
    expect(chips).toEqual(['lawn-care']);
    // …and deriving from the raw list is what produced the dead chip.
    expect(browseChipsFromJobs(jobs).map((c) => c.slug)).toContain('nails');
  });

  test('tolerates missing options', () => {
    expect(isBrowsable(open)).toBe(true);
    expect(browsableJobs(null)).toEqual([]);
  });
});
