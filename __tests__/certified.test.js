import { computeCertifications } from '../src/lib/insights';

// Build N earner review rows for a given category (and optional tags) at a fixed rating.
function reviews(n, { category = null, tags = null, rating = 5 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    rating,
    role: 'earner',
    job: { title: 'Gig', category, tags },
  }));
}

describe('analytics.computeCertifications', () => {
  test('empty / non-array input is defensive', () => {
    expect(computeCertifications([])).toEqual({ certified: [], progress: [] });
    expect(computeCertifications(null)).toEqual({ certified: [], progress: [] });
    expect(computeCertifications(undefined)).toEqual({ certified: [], progress: [] });
  });

  test('>= 50 jobs at avg >= 4.0 certifies the label', () => {
    const { certified, progress } = computeCertifications(reviews(50, { category: 'Lawncare', rating: 4.5 }));
    expect(certified).toHaveLength(1);
    expect(certified[0]).toEqual({ label: 'Lawncare', count: 50, avg: 4.5 });
    expect(progress).toEqual([]);
  });

  test('< 50 jobs does NOT certify (shows up as progress instead)', () => {
    const { certified, progress } = computeCertifications(reviews(49, { category: 'Lawncare', rating: 5 }));
    expect(certified).toEqual([]);
    expect(progress).toEqual([{ label: 'Lawncare', count: 49, needed: 50 }]);
  });

  test('avg < 4.0 does NOT certify even with >= 50 jobs', () => {
    // 50 jobs all rated 3 → avg 3.0 < 4.0
    const { certified, progress } = computeCertifications(reviews(50, { category: 'Cleaning', rating: 3 }));
    expect(certified).toEqual([]);
    expect(progress).toEqual([{ label: 'Cleaning', count: 50, needed: 50 }]);
  });

  test('a label is counted via both job.category and job.tags', () => {
    // 30 jobs where category=Moving, 25 jobs where tags include "moving" → 55 total for "moving"
    const data = [
      ...reviews(30, { category: 'Moving', rating: 4.2 }),
      ...reviews(25, { category: 'Errands', tags: ['Moving'], rating: 4.8 }),
    ];
    const { certified } = computeCertifications(data);
    const moving = certified.find((c) => c.label.toLowerCase() === 'moving');
    expect(moving).toBeTruthy();
    expect(moving.count).toBe(55);
    // Errands only has 25 → not certified
    expect(certified.find((c) => c.label.toLowerCase() === 'errands')).toBeUndefined();
  });

  test('multiple certified labels are sorted by count desc', () => {
    const data = [
      ...reviews(60, { category: 'Tutoring', rating: 5 }),
      ...reviews(52, { category: 'Lawncare', rating: 4.1 }),
    ];
    const { certified } = computeCertifications(data);
    expect(certified.map((c) => c.label)).toEqual(['Tutoring', 'Lawncare']);
    expect(certified.map((c) => c.count)).toEqual([60, 52]);
  });

  test('progress caps at 3 not-yet-certified labels, sorted by count desc', () => {
    const data = [
      ...reviews(40, { category: 'A', rating: 5 }),
      ...reviews(30, { category: 'B', rating: 5 }),
      ...reviews(20, { category: 'C', rating: 5 }),
      ...reviews(10, { category: 'D', rating: 5 }),
    ];
    const { certified, progress } = computeCertifications(data);
    expect(certified).toEqual([]);
    expect(progress).toEqual([
      { label: 'A', count: 40, needed: 50 },
      { label: 'B', count: 30, needed: 50 },
      { label: 'C', count: 20, needed: 50 },
    ]);
  });

  test('blank / missing labels are skipped; casing of first-seen label is preserved', () => {
    const data = [
      ...reviews(50, { category: '  Lawncare  ', rating: 4.5 }), // trimmed
      ...reviews(5, { category: 'lawncare', rating: 4.5 }), // same label, lowercased → merges
      ...reviews(3, { category: '   ', rating: 5 }), // blank → skipped
      ...reviews(2, { category: null, rating: 5 }), // null → skipped
    ];
    const { certified } = computeCertifications(data);
    expect(certified).toHaveLength(1);
    expect(certified[0].label).toBe('Lawncare'); // first-seen (trimmed) original casing
    expect(certified[0].count).toBe(55);
  });

  test('respects custom threshold/minRating opts', () => {
    const { certified } = computeCertifications(reviews(5, { category: 'Pets', rating: 4.5 }), {
      threshold: 5,
      minRating: 4.0,
    });
    expect(certified).toEqual([{ label: 'Pets', count: 5, avg: 4.5 }]);
  });
});
