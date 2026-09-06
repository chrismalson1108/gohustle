import { parseDob, computeAge, isAdult, MIN_AGE } from '../src/lib/age';

describe('age helpers (H7 age floor)', () => {
  const NOW = new Date('2026-07-10T12:00:00Z');

  describe('parseDob', () => {
    test('parses MM/DD/YYYY and ISO to canonical ISO', () => {
      expect(parseDob('07/10/2008')).toBe('2008-07-10');
      expect(parseDob('2008-7-1')).toBe('2008-07-01');
      expect(parseDob('12/31/2000')).toBe('2000-12-31');
    });
    test('rejects impossible / malformed dates', () => {
      expect(parseDob('02/30/2005')).toBeNull();
      expect(parseDob('13/01/2005')).toBeNull();
      expect(parseDob('not a date')).toBeNull();
      expect(parseDob('')).toBeNull();
      expect(parseDob(null)).toBeNull();
      expect(parseDob('2008/07/10')).toBeNull(); // wrong separator/order
    });
  });

  describe('computeAge', () => {
    test('counts whole years, respecting the birthday boundary', () => {
      expect(computeAge('2008-07-10', NOW)).toBe(18); // exactly 18 today
      expect(computeAge('2008-07-11', NOW)).toBe(17); // birthday tomorrow → still 17
      expect(computeAge('2008-07-09', NOW)).toBe(18); // birthday was yesterday
      expect(computeAge('2000-01-01', NOW)).toBe(26);
    });
    test('accepts a Date and rejects unparseable/future DOBs', () => {
      expect(computeAge(new Date('2004-07-10'), NOW)).toBe(22);
      expect(computeAge('2030-01-01', NOW)).toBeNull(); // future
      expect(computeAge('garbage', NOW)).toBeNull();
      expect(computeAge(new Date('garbage'), NOW)).toBeNull();
    });
  });

  // A Date input is an instant, not a day, and the two ways one gets built denote their
  // day in different zones: `new Date('YYYY-MM-DD')` is UTC midnight, while a native date
  // picker's `new Date(y, m, d)` is LOCAL midnight. Reading either with the wrong getters
  // moves the DOB a day and, on the eve of a birthday, a whole year — which is the H7 age
  // floor letting a 17-year-old through.
  //
  // The zone has to be forced for this to mean anything, and jest sandboxes process.env
  // so assigning TZ there never reaches V8 (see the same note in ledger.test.js). So the
  // module is exercised in a child process per zone, which is real for every machine
  // instead of only for one that happens to sit west of UTC.
  describe('reads a Date as the day it denotes, in every timezone', () => {
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { pathToFileURL } = require('url');

    const ageUrl = pathToFileURL(path.join(__dirname, '..', 'shared', 'age.js')).href;
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gohustlr-age-'));
    const probe = path.join(probeDir, 'probe.mjs');
    afterAll(() => fs.rmSync(probeDir, { recursive: true, force: true }));
    fs.writeFileSync(
      probe,
      `import { computeAge, isAdult } from ${JSON.stringify(ageUrl)};\n` +
        // Noon on 2026-07-10, local — the day before this DOB's 18th birthday.
        'const now = new Date(2026, 6, 10, 12);\n' +
        'console.log(JSON.stringify({\n' +
        "  dateOnly: computeAge(new Date('2008-07-11'), now),\n" +
        '  utcBuilt: computeAge(new Date(Date.UTC(2008, 6, 11)), now),\n' +
        '  localBuilt: computeAge(new Date(2008, 6, 11), now),\n' +
        "  string: computeAge('2008-07-11', now),\n" +
        "  adultDateOnly: isAdult(new Date('2008-07-11'), now),\n" +
        '  adultLocalBuilt: isAdult(new Date(2008, 6, 11), now),\n' +
        '}));\n',
    );
    const under = (tz) =>
      JSON.parse(
        execFileSync(process.execPath, [probe], {
          env: { ...process.env, TZ: tz },
          encoding: 'utf8',
          // Surface the child's own stderr instead of failing on JSON.parse('') if it
          // ever dies, and bound the wait well under the per-test timeout below.
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: 20000,
        }),
      );

    // Chicago is west of UTC (where local getters break the ISO-string Date), Tokyo is
    // east (where UTC getters break the picker's Date), and UTC is the one zone in which
    // both naive readings happen to agree — so a fix that only moved the bug fails here.
    // The generous timeout is for the node cold start, not the work: the whole suite runs
    // in ~2s, and three interpreter launches on a machine running the other 130 suites in
    // parallel can brush jest's 5s default.
    test.each(['America/Chicago', 'UTC', 'Asia/Tokyo'])('%s', (tz) => {
      const got = under(tz);
      // Born 2008-07-11, evaluated 2026-07-10: 17, one day short of 18, however written.
      expect(got).toEqual({
        dateOnly: 17,
        utcBuilt: 17,
        localBuilt: 17,
        string: 17,
        adultDateOnly: false,
        adultLocalBuilt: false,
      });
    }, 30000);
  });

  describe('isAdult', () => {
    test('blocks under-18 and admits 18+', () => {
      expect(isAdult('2008-07-11', NOW)).toBe(false); // 17
      expect(isAdult('2008-07-10', NOW)).toBe(true); // exactly 18
      expect(isAdult('2010-01-01', NOW)).toBe(false); // 16
      expect(isAdult(null, NOW)).toBe(false); // unknown → not proven adult
    });
    test('MIN_AGE is 18', () => {
      expect(MIN_AGE).toBe(18);
    });
  });
});
