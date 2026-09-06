const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A captured fee must be re-derivable from the inputs it was pinned at, and SOME
// registered control must be the thing that checks it.
//
// The fee is pinned per booking — fee_bps, fee_credit_cents, poster_discount_cents —
// precisely so capture is idempotent and the fee can be recomputed at any later moment.
// Until 20260906090000, nothing recomputed it. ctl_payment_ledger_impossible reads
// payments.fee_cents only as an ADDEND (captured <= authorized, refunded <= captured,
// signs), and every one of those tests is satisfied by a fee that is simply the wrong
// number: the earner's side absorbs the difference and the two halves still sum to what
// Stripe collected.
//
// The first block below is the drift guard — it fails on the tree as it stood before that
// migration, because no ctl_* body mentioned payments.fee_bps at all.
//
// The second block mirrors the band in JS and runs the same scenarios the migration's own
// DO-block probe asserts against live Postgres. It is here for the case the SQL probe
// cannot cover: `db push` runs once, while this runs on every push, so an edit that
// widens the band until it stops discriminating (or narrows it until a discounted capture
// cries wolf) fails the gate rather than waiting for a sweep nobody reads.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');

const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const sql = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');

// Split the whole tree into ctl_* function bodies, so "which control reads what" is a
// question about a body rather than about a file.
//
// Cut at the CLOSING dollar-quote, not at the next `create or replace`. Cutting at the
// next definition swallows the probe DO block that follows most of these — and those
// blocks stage payments rows carrying fee_bps, so every control that happens to be
// declared before one would look like it reads the pin. The first draft of this file did
// exactly that and the headline assertion passed on a tree where no control checked
// anything.
function ctlBodies(text) {
  const out = {};
  const re = /create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = /\bas\s+(\$[a-z_]*\$)/.exec(text.slice(m.index, m.index + 4000));
    if (!tag) continue;
    const bodyStart = m.index + tag.index + tag[0].length;
    const end = text.indexOf(tag[1], bodyStart);
    out[m[1]] = text.slice(m.index, end === -1 ? text.length : end);
  }
  return out;
}
const bodies = ctlBodies(sql);
const registered = new Set([...sql.matchAll(/'(ctl_[a-z0-9_]+)'\s*\)/g)].map((m) => m[1]));

describe('a registered control re-derives the captured fee from its pin', () => {
  it('parses the control library', () => {
    expect(Object.keys(bodies).length).toBeGreaterThan(40);
    expect(registered.size).toBeGreaterThan(40);
  });

  it('some control reads payments.fee_bps together with payments.fee_cents', () => {
    // The claim CLAUDE.md makes about money features: "a control asserting the invariant
    // against data rather than against the formula". Before 20260906090000 this list was
    // empty — every fee_bps reference in the library was against bookings, fee_tiers or
    // promo grants, never against the captured split.
    const checkers = Object.entries(bodies)
      .filter(([, body]) => /from public\.payments\b/.test(body)
        && /\bfee_bps\b/.test(body)
        && /\bfee_cents\b/.test(body))
      .map(([fn]) => fn);
    expect(`controls comparing a captured fee to its pin: ${checkers.join(', ') || 'NONE'}`)
      .not.toBe('controls comparing a captured fee to its pin: NONE');
    // and it has to actually run — run_all_controls iterates the registry.
    checkers.forEach((fn) => expect(registered.has(fn)).toBe(true));
  });

  it('it derives the fee through the one definition, not a reimplementation', () => {
    // platform_fee_cents is "the ONE definition of the fee". A control that recomputed the
    // arithmetic inline would drift from the money paths it is meant to police, and would
    // then be wrong in the same direction as whatever it failed to catch.
    const body = bodies.ctl_captured_fee_off_pin;
    expect(typeof body).toBe('string');
    expect(body).toContain('public.platform_fee_after_credit(');
    expect(body).toContain('public.platform_fee_cents(');
    expect(body).toContain('public.safe_fee_bps(');
    expect(body).not.toMatch(/10000\s*\)?\s*$/m); // no hand-rolled bps division
  });

  it('it only looks at rows that were actually captured', () => {
    // An authorized row has no captured split to check, and firing on one would put every
    // live escrow hold on the board.
    expect(bodies.ctl_captured_fee_off_pin).toMatch(/where\s+p\.status\s*=\s*'captured'/);
  });
});

// ── The band, mirrored ───────────────────────────────────────────────────────
// public.platform_fee_cents: half-up percentage, floored at Stripe cost + 25c margin,
// capped at the amount. public.platform_fee_after_credit: the credit lowers it, never
// below that floor.
const floorCents = (amount) => Math.ceil(amount * 0.029) + 30 + 25;
const platformFeeCents = (amount, bps) =>
  Math.max(0, Math.min(amount, Math.max(Math.floor((amount * bps + 5000) / 10000), floorCents(amount))));
const feeAfterCredit = (amount, bps, credit) =>
  Math.max(floorCents(amount), platformFeeCents(amount, bps) - Math.max(0, credit));

function band({ authorized, captured, bps, credit = 0, discount = 0 }) {
  const fullFee = Math.max(0, feeAfterCredit(authorized + discount, bps, credit) - discount);
  const candCapture = captured >= authorized
    ? fullFee
    : Math.min(captured, Math.max(Math.round((fullFee * captured) / authorized),
                                  platformFeeCents(captured, 0)));
  const candClaim = Math.min(captured, feeAfterCredit(captured + discount, bps, credit));
  return { lo: Math.min(candCapture, candClaim), hi: Math.max(candCapture, candClaim) };
}
const fires = (row, fee) => {
  const { lo, hi } = band(row);
  return fee < lo - 2 || fee > hi + 2;
};

describe('the band catches both fee bugs this platform has shipped', () => {
  // $100 gig at 700 bps, captured in full.
  const plain = { authorized: 10000, captured: 10000, bps: 700 };

  it('a correct full capture is silent', () => {
    expect(band(plain)).toEqual({ lo: 700, hi: 700 });
    expect(fires(plain, 700)).toBe(false);
  });

  it('the NULL-rate bug — a real capture at zero fee — fires', () => {
    expect(fires({ ...plain, captured: 10000 }, 0)).toBe(true);
  });

  it('a doubled fee fires, so the earner is watched as well as the platform', () => {
    expect(fires(plain, 1400)).toBe(true);
  });

  // $200 gig at 700 bps settled at 50%: 10000c captured, correct fee 700c.
  const partial = { authorized: 20000, captured: 10000, bps: 700 };

  it('a correct partial capture is silent', () => {
    expect(band(partial)).toEqual({ lo: 700, hi: 700 });
    expect(fires(partial, 700)).toBe(false);
  });

  it('the fee x pct^2 retry fires — and the processing floor alone would not', () => {
    expect(fires(partial, 350)).toBe(true);
    // 350c clears the 345c floor on a 10000c capture, which is why a floor-only lower
    // bound (the obvious shape) misses the exact bug the capture code warns about.
    expect(platformFeeCents(10000, 0)).toBe(345);
    expect(350).toBeGreaterThan(platformFeeCents(10000, 0));
  });
});

describe('the band does not cry wolf on the derivations that are live today', () => {
  // $100 gig at 700 bps with a 355c poster discount: the poster is charged 9645c and the
  // discount is funded out of the fee AFTER the floor.
  const discounted = { authorized: 9645, captured: 9645, bps: 700, discount: 355 };

  it('the capture path writes 345c on a discounted booking and stays silent', () => {
    expect(fires(discounted, 345)).toBe(false);
  });

  it('earner-claim writes 700c on the same booking and stays silent too', () => {
    // earner-claim-payment's recompute fallback does not subtract the discount a second
    // time. Both are live, so both are inside the band.
    expect(fires(discounted, 700)).toBe(false);
    // The naive ceiling would have fired on it — this is why the control spans two
    // candidates rather than testing one formula.
    expect(700).toBeGreaterThan(platformFeeCents(9645, 700));
  });

  it('a floor-dominated partial with a big fee credit stays silent', () => {
    // The row 20260906023000's own probe stages: $200 gig, 765c credit, settled at 50%,
    // fee 345c — the Stripe floor on the captured amount, well under the scaled 318c…635c
    // arithmetic a naive percentage check would expect.
    const floored = { authorized: 20000, captured: 10000, bps: 700, credit: 765 };
    expect(fires(floored, 345)).toBe(false);
  });
});
