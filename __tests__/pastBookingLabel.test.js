const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Hire › Past renders PAST_STATUSES — verified | declined | cancelled — through one
// card. That card branched only on `declined`, so a CANCELLED booking took the same
// path as a verified one: it rendered the rating row, and since a cancelled booking
// can never carry an earnerRating (only verifyAndRate writes that column), it always
// fell through to the literal string "Completed".
//
// The result, in the poster's own history: a grey "Cancelled" badge with the word
// "Completed" underneath it. A gig they called off, and the hold released, reading as
// paid and finished work.
//
// The fix keys the row on `verified` rather than on "not declined", so a past status
// added later cannot inherit the "Completed" label by default.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'GigsScreen.js'), 'utf8');

function componentBody(name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  // The parameter list is itself destructured, so the body brace is the one after `) {`.
  const open = src.indexOf('{', src.indexOf(') {', start));
  let depth = 1;
  let i = open + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(start, i);
}

describe('Hire > Past does not call a cancelled booking completed', () => {
  const body = componentBody('PastBookingCard');

  it('cancelled is still one of the past statuses this card renders', () => {
    expect(src).toMatch(/PAST_STATUSES\s*=\s*new Set\(\['verified', 'declined', 'cancelled'\]\)/);
  });

  it('the "Completed" fallback still exists — for verified rows with no rating', () => {
    expect(body).toMatch(/<Text style=\{styles\.pastRatingText\} numberOfLines=\{1\}>Completed<\/Text>/);
  });

  it('the rating row is gated on verified, not on "not declined"', () => {
    expect(body).toMatch(/const settled\s*=\s*booking\.status === 'verified';/);
    expect(body).toMatch(/\{settled && \(\s*<View style=\{styles\.pastRatingRow\}>/);
    // The old shape. If this comes back, a cancelled booking says "Completed" again.
    expect(body).not.toMatch(/\{!declined && \(\s*<View style=\{styles\.pastRatingRow\}>/);
  });

  it('a cancelled booking is muted like a declined one, not styled as live work', () => {
    expect(body).toMatch(/const didntHappen\s*=\s*declined \|\| booking\.status === 'cancelled';/);
    expect(body).toMatch(/bg=\{didntHappen \? colors\.textMuted : colors\.primary\}/);
  });

  it('only verifyAndRate can produce the rating the row reads', () => {
    // Why the fallback always fired for cancelled rows: earnerRating comes from
    // bookings.earner_rating, written nowhere but the verify path.
    //
    // TWO writes since 2026-09-09, both inside verifyAndRate: a reduction is now a
    // proposal, so that branch holds the rating on the booking WITHOUT flipping the
    // status (the public review is published by settle-disputes when the money moves).
    // The property this guards is unchanged — nothing outside verifyAndRate writes it —
    // so the test asserts that rather than a count, which was only ever a proxy.
    const ctx = fs.readFileSync(path.join(ROOT, 'src', 'context', 'JobsContext.js'), 'utf8');
    const verifyAt = ctx.indexOf('const verifyAndRate = async');
    const nextFn = ctx.indexOf('\n  const ', verifyAt + 40);
    const verifyBody = ctx.slice(verifyAt, nextFn > -1 ? nextFn : ctx.length);
    const all = ctx.match(/earner_rating:/g) || [];
    const inVerify = verifyBody.match(/earner_rating:/g) || [];
    expect(`${inVerify.length} of ${all.length} writes are inside verifyAndRate`)
      .toBe(`${all.length} of ${all.length} writes are inside verifyAndRate`);
    expect(all.length).toBeGreaterThan(0);
  });
});
