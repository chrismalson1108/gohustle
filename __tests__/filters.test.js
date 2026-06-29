import { matchesForYou, applyJobFilters, skillFitScore } from '../shared/filters.js';

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

  test('matches loosely (skill contained in / containing category)', () => {
    expect(matchesForYou(job({ category: 'Lawncare', title: 'Mow lawn' }), ['lawn'])).toBe(true);
    expect(matchesForYou(job({ category: 'Tech Help' }), ['Tech'])).toBe(true);
  });

  test('matches when a skill appears in the title or description', () => {
    expect(matchesForYou(job({ category: 'Errands', title: 'Math help needed' }), ['math'])).toBe(true);
    expect(matchesForYou(job({ category: 'Errands', title: 'Help', description: 'plumbing repair' }), ['Plumbing'])).toBe(true);
  });

  test('is case-insensitive and trims', () => {
    expect(matchesForYou(job({ category: 'Moving' }), ['  MOVING  '])).toBe(true);
  });

  test('matches a skill against a gig tag', () => {
    const j = (tags) => job({ category: 'Odd Jobs', title: 'Help', description: 'misc', tags });
    expect(matchesForYou(j(['lawncare']), ['lawn'])).toBe(true);
    expect(matchesForYou(j(['assembly']), ['furniture assembly'])).toBe(true);
    expect(matchesForYou(j(['painting']), ['plumbing'])).toBe(false);
  });

  test('returns false with no skills, no match, or no job', () => {
    expect(matchesForYou(job(), [])).toBe(false);
    expect(matchesForYou(job({ category: 'Moving', title: 'Move couch', description: 'heavy' }), ['tutoring'])).toBe(false);
    expect(matchesForYou(null, ['anything'])).toBe(false);
  });
});

describe('skillFitScore', () => {
  test('counts each matching skill (category, tag, title, description)', () => {
    const j = job({ category: 'Tutoring', title: 'Calc II help', description: 'algebra too', tags: ['math'] });
    // 'tutoring' matches category, 'math' matches a tag, 'calc' matches the title,
    // 'algebra' matches the description, 'plumbing' matches nothing → 4.
    expect(skillFitScore(j, ['tutoring', 'math', 'calc', 'algebra', 'plumbing'])).toBe(4);
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
});

describe('applyJobFilters — For You', () => {
  const jobs = [
    job({ id: '1', category: 'Tutoring', title: 'Calc tutoring' }),
    job({ id: '2', category: 'Moving', title: 'Move a couch', description: 'heavy lifting' }),
    job({ id: '3', category: 'Tech Help', title: 'Fix my laptop' }),
  ];

  test('selectedCat "foryou" keeps only skill-matched gigs', () => {
    const out = applyJobFilters(jobs, { selectedCat: 'foryou', forYouSkills: ['tutoring', 'tech'] });
    expect(out.map(j => j.id).sort()).toEqual(['1', '3']);
  });

  test('selectedCat "foryou" with no skills returns nothing', () => {
    expect(applyJobFilters(jobs, { selectedCat: 'foryou', forYouSkills: [] })).toHaveLength(0);
  });

  test('regular category filtering still works', () => {
    const out = applyJobFilters(jobs, { selectedCat: 'Moving' });
    expect(out.map(j => j.id)).toEqual(['2']);
  });
});
