import {
  workStatusMeta,
  parseTime,
  fmtTime,
  classOverlaps,
  isFreeAt,
  availabilitySummary,
} from '../src/lib/availability';

describe('availability.workStatusMeta', () => {
  test('known + fallback', () => {
    expect(workStatusMeta('busy').label).toBe('Busy');
    expect(workStatusMeta('nonsense').id).toBe('available'); // falls back to first
  });
});

describe('availability.parseTime / fmtTime', () => {
  test('parses valid times, rejects junk', () => {
    expect(parseTime('14:30')).toBe(14 * 60 + 30);
    expect(parseTime('9:05')).toBe(9 * 60 + 5);
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('nope')).toBeNull();
  });
  test('formats to am/pm', () => {
    expect(fmtTime('15:00')).toBe('3pm');
    expect(fmtTime('09:30')).toBe('9:30am');
    expect(fmtTime('00:00')).toBe('12am');
  });
});

describe('availability.classOverlaps', () => {
  const classes = [{ days: [1, 3], start_time: '10:00', end_time: '11:30', title: 'CS101' }];
  test('overlapping class on a matching day blocks', () => {
    expect(classOverlaps(classes, { day: 1, start: '11:00', end: '12:00' })).toBe(true);
  });
  test('same time, different day does not block', () => {
    expect(classOverlaps(classes, { day: 2, start: '11:00', end: '12:00' })).toBe(false);
  });
  test('non-overlapping time does not block', () => {
    expect(classOverlaps(classes, { day: 1, start: '12:00', end: '13:00' })).toBe(false);
  });
});

describe('availability.isFreeAt', () => {
  const windows = [
    { day: 6, start: '09:00', end: '17:00' }, // Sat 9-5
    { day: 1, start: '15:00', end: '20:00' }, // Mon 3-8
  ];
  const classes = [{ days: [1], start_time: '16:00', end_time: '17:00', title: 'Lab' }];

  test('inside a window and clear of class → free', () => {
    expect(isFreeAt(windows, classes, { day: 6, start: '10:00', end: '12:00' })).toBe(true);
  });
  test('inside a window but during class → not free', () => {
    expect(isFreeAt(windows, classes, { day: 1, start: '16:30', end: '17:00' })).toBe(false);
  });
  test('has windows but none on this day → not free', () => {
    expect(isFreeAt(windows, classes, { day: 3, start: '10:00', end: '11:00' })).toBe(false);
  });
  test('no windows declared at all → assume free (classes still block)', () => {
    expect(isFreeAt([], classes, { day: 1, start: '16:30', end: '17:00' })).toBe(false);
    expect(isFreeAt([], classes, { day: 4, start: '10:00', end: '11:00' })).toBe(true);
  });
});

describe('availability.availabilitySummary', () => {
  test('renders a readable schedule, sorted by day', () => {
    const s = availabilitySummary([
      { day: 6, start: '09:00', end: '17:00' },
      { day: 1, start: '15:00', end: '20:00' },
    ]);
    expect(s).toBe('Mon 3pm–8pm · Sat 9am–5pm');
  });
  test('empty', () => {
    expect(availabilitySummary([])).toBe('No availability set');
  });
});
