const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// App Store Connect rejects an over-length field at paste time, with an error that
// names the limit but not what actually blew it. On 2026-09-08 that error was hit on
// a Description that measures 2,692 — the real cause was extra text getting into the
// field, not the copy. So the copy lives in one plain file per field, and this test
// is the thing that says whether the copy itself is within Apple's limits.
//
// Counting: JS String.length is UTF-16 code units, which is what Apple counts too.
// An emoji outside the BMP costs 2, and that is the correct answer for both.
//
// A trailing newline counts. keywords.txt sits at 99/100, so one stray byte is the
// difference between accepted and rejected — hence the no-trailing-whitespace check.
// ─────────────────────────────────────────────────────────────────────────────
const DIR = path.join(__dirname, '..', 'docs', 'app-store', 'listing');

// Limits per Apple's App Store Connect help. Fields with no character limit are
// listed with null so the roster stays complete — a file nobody bounds is a file
// nobody notices growing.
const LIMITS = {
  'description.txt': 4000,
  'promotional-text.txt': 170,
  'keywords.txt': 100,
  'review-notes.txt': 4000,
  'subtitle.txt': 30,
  'copyright.txt': 200,
  'support-url.txt': null,
  'marketing-url.txt': null,
  'privacy-policy-url.txt': null,
};

describe('App Store listing copy fits Apple’s field limits', () => {
  it('every file on disk is accounted for here', () => {
    const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort();
    expect(onDisk).toEqual(Object.keys(LIMITS).sort());
  });

  Object.entries(LIMITS).forEach(([file, limit]) => {
    const body = () => fs.readFileSync(path.join(DIR, file), 'utf8');

    if (limit != null) {
      it(`${file} is within ${limit} characters`, () => {
        const n = body().length;
        expect(`${file}: ${n}/${limit}`).toBe(`${file}: ${n}/${limit}`);
        expect(n).toBeLessThanOrEqual(limit);
      });
    }

    it(`${file} carries no leading or trailing whitespace`, () => {
      const raw = body();
      expect(raw).toBe(raw.trim());
    });

    it(`${file} is not empty`, () => {
      expect(body().length).toBeGreaterThan(0);
    });
  });

  // The two that are one keystroke from the ceiling. Named individually so a failure
  // says which field is at risk rather than just "some file got longer".
  it('keywords has no spaces — Apple counts them and they buy nothing', () => {
    expect(fs.readFileSync(path.join(DIR, 'keywords.txt'), 'utf8')).not.toMatch(/\s/);
  });

  it('the description carries no beta framing (Guideline 2.2)', () => {
    const d = fs.readFileSync(path.join(DIR, 'description.txt'), 'utf8').toLowerCase();
    // A public listing may not present the app as a trial, beta or test.
    expect(d).not.toMatch(/\bbeta\b|\bearly access\b|\bfree trial\b/);
  });

  it('the review notes do not hand App Review a Stripe test card', () => {
    // 4242… only works on test keys. On live keys the reviewer cannot complete a
    // booking, which is a Guideline 2.1 rejection for incomplete functionality.
    const notes = fs.readFileSync(path.join(DIR, 'review-notes.txt'), 'utf8');
    expect(notes.replace(/\s/g, '')).not.toMatch(/4242424242424242/);
  });
});
