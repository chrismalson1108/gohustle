import { haversineMiles, milesLabel } from '../src/lib/geo';

describe('geo', () => {
  test('haversine returns null without full coords', () => {
    expect(haversineMiles(null, { lat: 1, lng: 2 })).toBeNull();
    expect(haversineMiles({ lat: 1, lng: null }, { lat: 1, lng: 2 })).toBeNull();
  });

  test('distance is ~0 for same point', () => {
    expect(haversineMiles({ lat: 30, lng: -97 }, { lat: 30, lng: -97 })).toBeCloseTo(0, 3);
  });

  test('NYC → LA is roughly 2400–2500 miles', () => {
    const d = haversineMiles({ lat: 40.7128, lng: -74.006 }, { lat: 34.0522, lng: -118.2437 });
    expect(d).toBeGreaterThan(2400);
    expect(d).toBeLessThan(2500);
  });

  test('milesLabel formats sensibly', () => {
    expect(milesLabel(null)).toBeNull();
    expect(milesLabel(0.05)).toBe('nearby');
    expect(milesLabel(2.345)).toBe('2.3 mi');
    expect(milesLabel(42.6)).toBe('43 mi');
  });
});
