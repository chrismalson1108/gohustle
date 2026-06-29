import { matchesForYou, applyJobFilters } from '../shared/filters.js';

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

  test('returns false with no skills, no match, or no job', () => {
    expect(matchesForYou(job(), [])).toBe(false);
    expect(matchesForYou(job({ category: 'Moving', title: 'Move couch', description: 'heavy' }), ['tutoring'])).toBe(false);
    expect(matchesForYou(null, ['anything'])).toBe(false);
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
