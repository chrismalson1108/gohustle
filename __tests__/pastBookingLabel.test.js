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
    const ctx = fs.readFileSync(path.join(ROOT, 'src', 'context', 'JobsContext.js'), 'utf8');
    const writes = ctx.match(/earner_rating:/g) || [];
    expect(writes.length).toBe(1);
  });
});
