// ─────────────────────────────────────────────────────────────────────────────
// The rate-the-poster sheet in JobDetailScreen asked "How was {job?.posterName}?"
// — and transformJob has never produced a `posterName`. The name lives at
// `job.poster.name`, so the `|| 'the poster'` fallback fired for every poster who
// has ever been rated from that screen: nobody was ever named.
//
// Two halves, both asserted here because the field is only wrong by being absent and
// a plain unit test on the helper cannot see a screen still reading the old path:
//
//   1. posterDisplayName reads the field that exists, and refuses the two PLACEHOLDER
//      names the transforms themselves write ('Anonymous' for a job row with no
//      profile embed, 'Poster' for the booking-fallback shape). Interpolating those
//      gives "How was Poster?", which is worse than the generic fallback.
//   2. No screen or component reads `job.posterName` any more. That scan is what
//      fails on the old code — JobDetailScreen:282 matched it.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
import { transformJob, posterDisplayName } from '../shared/transforms.js';

const row = (over = {}) => ({
  id: 'j1',
  poster_id: 'p1',
  title: 'Move a couch',
  category: 'Odd Jobs',
  pay: 40,
  pay_type: 'flat',
  ...over,
});

describe('the poster name transformJob actually produces', () => {
  test('there is no posterName — the field the sheet used to read does not exist', () => {
    const job = transformJob(row({ profiles: { name: 'Maya K.' } }));
    expect(job.posterName).toBeUndefined();
    expect(job.poster.name).toBe('Maya K.');
  });

  test('posterDisplayName returns the real name', () => {
    expect(posterDisplayName(transformJob(row({ profiles: { name: 'Maya K.' } })))).toBe('Maya K.');
  });

  test("'Anonymous' is a placeholder, not a name — the caller's own fallback wins", () => {
    // transformJob writes this when the row carries no profile embed.
    const job = transformJob(row({}));
    expect(job.poster.name).toBe('Anonymous');
    expect(posterDisplayName(job)).toBeNull();
  });

  test("'Poster' is a placeholder too — the booking-fallback shape writes it", () => {
    expect(posterDisplayName({ poster: { name: 'Poster' } })).toBeNull();
  });

  test('blank, whitespace and missing posters all fall back rather than render empty', () => {
    expect(posterDisplayName({ poster: { name: '   ' } })).toBeNull();
    expect(posterDisplayName({ poster: {} })).toBeNull();
    expect(posterDisplayName({})).toBeNull();
    expect(posterDisplayName(null)).toBeNull();
  });

  test('surrounding whitespace is trimmed, not rendered', () => {
    expect(posterDisplayName({ poster: { name: '  Maya K. ' } })).toBe('Maya K.');
  });
});

describe('nothing reads the field that never existed', () => {
  const roots = [
    path.join(__dirname, '..', 'src', 'screens'),
    path.join(__dirname, '..', 'src', 'components'),
  ];

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });

  test('no `job.posterName` / `job?.posterName` anywhere in src/screens or src/components', () => {
    // JobDetailScreen:282 was the only hit, and it made the rate sheet permanently
    // anonymous. A styles key named posterName (JobCard) is not a field read and is
    // excluded by requiring a `job` receiver.
    const offenders = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const src = fs.readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (/\bjob\s*\??\.\s*posterName\b/.test(line)) {
            offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
