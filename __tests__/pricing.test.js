// Drift guard between shared/pricing.js (what the apps DISPLAY) and
// public.platform_fee_cents in supabase/migrations/20260806050000_platform_rate.sql
// (what the server actually CHARGES).
//
// Same job as categories.test.js does for category_slug: the two implementations must
// agree, and the only way to be sure is to read the SQL off disk rather than trust a
// comment saying they match. A fee the app quotes and a fee the server takes that
// differ by a cent is a disclosure failure — the Terms commit to the amount being
// "disclosed before you confirm".
//
// This test cannot execute Postgres, so it does two things instead:
//   1. asserts the CONSTANTS in the SQL are the ones the JS uses (parsed, not assumed)
//   2. re-implements the SQL's arithmetic literally, from those parsed constants, and
//      compares it to the JS across a wide range including every rounding edge
// A test that compared two JS constants to each other could never fail; parsing the
// migration is what gives it teeth.
const fs = require('fs');
const path = require('path');
const { platformFeeCents, earnerNetCents, feeLabel, DEFAULT_FEE_BPS, feeBreakdown
} = require('../shared/pricing.js');

const MIGRATION = path.join(
  __dirname, '..', 'supabase', 'migrations', '20260806050000_platform_rate.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

describe('platform_fee_cents SQL/JS parity', () => {
  test('the migration still defines the function this test is guarding', () => {
    expect(sql).toMatch(/create or replace function public\.platform_fee_cents/);
  });

  test('the percentage multiply is widened to bigint — int4 overflows above ~21.47%', () => {
    // THIS ASSERTION EXISTS BECAUSE THE MATRIX BELOW CANNOT CATCH IT.
    //
    // (amount * bps) is int4 * int4 in Postgres and raises 22003 whenever the product
    // exceeds 2^31-1 — at 3000 bps (which platform_rates.fee_bps explicitly permits and
    // the /pricing page lets an admin set) that is every booking over ~$7,158, well
    // inside the $10,000 pay ceiling. Reproduced live before the fix:
    //   platform_fee_cents(1000000, 2147) -> 214700
    //   platform_fee_cents(1000000, 2148) -> ERROR 22003
    //
    // sqlFee() below is JavaScript, which has no 32-bit overflow, so the parity matrix
    // passes on amount=1000000/bps=3000 — the exact pair that raised in Postgres. A
    // behavioural mirror cannot detect an arithmetic-WIDTH defect; only reading the
    // cast out of the migration can. Fixed in 20260806140000.
    const fix = fs.readFileSync(
      path.join(__dirname, '..', 'supabase', 'migrations', '20260806140000_fee_overflow_fix.sql'),
      'utf8',
    );
    expect(fix).toMatch(/coalesce\(p_amount_cents,\s*0\)::bigint\s*\*\s*coalesce\(p_fee_bps,\s*1000\)/);
  });

  test('SQL rounds half up (+ 5000) — not truncating division', () => {
    // If someone "simplifies" this back to (amount * bps) / 10000 the JS would
    // silently over-quote by a cent on odd amounts. Pin the exact expression.
    expect(sql).toMatch(/\+\s*5000\s*\)\s*\/\s*10000/);
  });

  test('SQL floor constants match the JS constants', () => {
    const pct = sql.match(/\*\s*0\.029\s*\)/);
    expect(pct).not.toBeNull();
    // 30c Stripe fixed + 25c platform margin
    expect(sql).toMatch(/::integer\s*\+\s*30\s*\+\s*25/);
  });

  test('rate is clamped to [500, 3000] and defaults to 1000 in fee_bps_at', () => {
    expect(sql).toMatch(/greatest\(500,\s*least\(3000,/);
    expect(sql).toMatch(/1000\)\)\)/);
  });

  test('DEFAULT_FEE_BPS matches the seeded founding rate', () => {
    expect(DEFAULT_FEE_BPS).toBe(1000);
    expect(sql).toMatch(/insert into public\.platform_rates[\s\S]*?select 1000,/);
  });

  // A literal transcription of the SQL body, built from the parsed constants above.
  const sqlFee = (amount, bps) => {
    const amt = Math.max(0, Math.trunc(amount));
    const pct = Math.trunc((amt * bps + 5000) / 10000);
    const floor = Math.ceil(amt * 0.029) + 30 + 25;
    return Math.max(0, Math.min(amt, Math.max(pct, floor)));
  };

  test('agrees with the SQL across amounts and rates, including rounding edges', () => {
    const amounts = [
      0, 1, 50, 99, 100, 999, 1000, 1004, 1005, 1006, 1050, 1499, 1500,
      2500, 4999, 5000, 9999, 10000, 10001, 12345, 99999, 100000, 1000000,
    ];
    const rates = [0, 250, 500, 750, 1000, 1250, 1500, 2000, 3000];
    const mismatches = [];
    for (const a of amounts) {
      for (const r of rates) {
        const js = platformFeeCents(a, r);
        const pg = sqlFee(a, r);
        if (js !== pg) mismatches.push(`amount=${a} bps=${r}: js=${js} sql=${pg}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('half-up rounding specifically — the bug this was written for', () => {
    // $10.05 at 10% is exactly 100.5c. Truncation gives 100; every shipped client
    // says 101 because they use Math.round.
    expect(platformFeeCents(1005, 1000)).toBe(101);
    expect(platformFeeCents(1004, 1000)).toBe(100);
    expect(platformFeeCents(1015, 1000)).toBe(102);
  });

  test('a 0% promotion still covers processing cost — never a loss', () => {
    for (const amt of [1000, 2500, 5000, 20000]) {
      const fee = platformFeeCents(amt, 0);
      expect(fee).toBeGreaterThanOrEqual(Math.ceil(amt * 0.029) + 30);
      expect(fee).toBeLessThan(amt);
    }
  });

  test('fee never exceeds the amount, so the earner can never go negative', () => {
    for (const amt of [0, 1, 25, 50, 99, 100]) {
      expect(platformFeeCents(amt, 3000)).toBeLessThanOrEqual(amt);
      expect(earnerNetCents(amt, 3000)).toBeGreaterThanOrEqual(0);
    }
  });

  test('garbage in does not produce a zero fee', () => {
    // Fail closed: a null/NaN rate must fall back to the default, not to free.
    expect(platformFeeCents(10000, null)).toBe(1000);
    expect(platformFeeCents(10000, undefined)).toBe(1000);
    expect(platformFeeCents(10000, NaN)).toBe(1000);
  });

  test('earnerNet + fee reconstructs the amount exactly', () => {
    for (const amt of [1000, 1005, 12345, 800000]) {
      for (const r of [0, 500, 1000, 1500]) {
        expect(earnerNetCents(amt, r) + platformFeeCents(amt, r)).toBe(amt);
      }
    }
  });

  test('feeLabel renders rates without trailing noise', () => {
    expect(feeLabel(1000)).toBe('10%');
    expect(feeLabel(500)).toBe('5%');
    expect(feeLabel(0)).toBe('0%');
    expect(feeLabel(1250)).toBe('12.5%');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The promo budget counterfactual, pinned textually.
//
// consume_promo_grant measures "what this discount costs" as (what they would have
// paid) − (what they will pay). The first term was a hardcoded 1000 bps while the
// standing rate is configurable via fee_bps_at — so raising the platform rate to 15%
// made every 0%-fee promo cost 15% while charging the budget 10%. A 50% undercount,
// in the unsafe direction, silently.
//
// This cannot be caught by exercising the JS mirror: the defect is which SQL function
// supplies one operand. So assert on the migration text, the same way the bigint
// overflow cast is pinned above.
// ─────────────────────────────────────────────────────────────────────────────
describe('promo budget counterfactual', () => {
  const lifecycle = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260806220000_benefit_lifecycle.sql'),
    'utf8',
  );

  test('promo_benefit_cents measures against the standing rate, not a literal', () => {
    const fn = lifecycle.match(
      /create or replace function public\.promo_benefit_cents[\s\S]*?\$\$;/,
    );
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/fee_bps_at\(/);
    // The literal that was the bug. Any bare 1000 as a bps operand is a regression.
    expect(fn[0]).not.toMatch(/platform_fee_cents\(\s*p_amount_cents\s*,\s*1000\s*\)/);
  });

  test('consume_promo_grant uses the helper rather than recomputing the counterfactual', () => {
    const fn = lifecycle.match(
      /create or replace function public\.consume_promo_grant[\s\S]*?\$\$;/,
    );
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/promo_benefit_cents\(/);
    expect(fn[0]).not.toMatch(/platform_fee_cents\(\s*p_amount_cents\s*,\s*1000\s*\)/);
  });

  test('the replacement preserves the guards the live function had gained', () => {
    // Reproducing a function from a stale migration file silently reverts everything
    // added since. These three were added after consume_promo_grant was first written
    // and MUST survive any future replacement.
    const fn = lifecycle.match(
      /create or replace function public\.consume_promo_grant[\s\S]*?\$\$;/,
    )[0];
    expect(fn).toMatch(/promotions_enabled/);      // the kill switch
    expect(fn).toMatch(/revoked_at is null/);      // revoked grants cannot be spent
    expect(fn).toMatch(/kind = 'fee_override'/);   // only fee promos apply here
  });

  test('release refuses to touch bookings (an AFTER-trigger write would roll back the decline)', () => {
    const fn = lifecycle.match(
      /create or replace function public\.release_booking_benefits[\s\S]*?\$\$;/,
    )[0];
    expect(fn).not.toMatch(/update public\.bookings/);
  });
  test('the redemption index stays inferrable by a bare ON CONFLICT (booking_id)', () => {
    // consume_poster_discount inserts with `on conflict (booking_id) do nothing`, and
    // ON CONFLICT inference cannot match a PARTIAL unique index. A previous version of
    // this migration made the index partial and every poster-discount consumption began
    // failing with 42P10 in production. If the index ever grows a WHERE clause again,
    // that writer has to change in the same commit.
    const idx = lifecycle.match(
      /create unique index[^;]*promo_redemptions_one_per_booking[^;]*;/,
    );
    expect(idx).not.toBeNull();
    expect(idx[0]).not.toMatch(/\bwhere\b/i);
    // And the migration must not resurrect the partial one.
    expect(lifecycle).not.toMatch(/create unique index[^;]*promo_redemptions_one_live_per_booking/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The honest 0% breakdown.
//
// At 0 bps the deduction does not vanish — platform_fee_cents floors at Stripe's cost
// so a free gig never settles at a loss. Showing "0%" while the earner watches money
// come off is the small dishonesty this split exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
describe('feeBreakdown', () => {
  test('the parts always reconstruct the whole', () => {
    for (const amt of [500, 1005, 5000, 10000, 123456]) {
      for (const bps of [0, 200, 500, 1000, 3000]) {
        const b = feeBreakdown(amt, bps);
        expect(b.processingCents + b.platformCents).toBe(b.totalCents);
        expect(b.netCents + b.totalCents).toBe(amt);
        // And it must agree with the function the server mirrors.
        expect(b.totalCents).toBe(platformFeeCents(amt, bps));
      }
    }
  });

  test('a 0% rate still collects processing, and says so', () => {
    const b = feeBreakdown(10000, 0);
    expect(b.totalCents).toBe(345);        // the floor
    expect(b.processingCents).toBe(320);   // ceil(10000*0.029) + 30 — Stripe's
    expect(b.platformCents).toBe(25);      // the floor margin — ours, not hidden
    expect(b.isFloored).toBe(true);
  });

  test('a rate below the floor behaves exactly like 0%', () => {
    // 2% of $100 is $2.00, under the $3.45 floor — so 2% and 0% are the same charge.
    // Worth pinning: it is the reason a "2% platform fee" would not mean what it says.
    expect(feeBreakdown(10000, 200)).toEqual(feeBreakdown(10000, 0));
  });

  test('above the floor, the platform keeps the difference and nothing is floored', () => {
    const b = feeBreakdown(10000, 1000);
    expect(b.totalCents).toBe(1000);
    expect(b.processingCents).toBe(320);
    expect(b.platformCents).toBe(680);
    expect(b.isFloored).toBe(false);
  });

  test('processing is never reported as more than was actually taken', () => {
    // On a tiny amount platform_fee_cents clamps to the amount itself.
    const b = feeBreakdown(50, 0);
    expect(b.processingCents).toBeLessThanOrEqual(b.totalCents);
    expect(b.platformCents).toBeGreaterThanOrEqual(0);
    expect(b.netCents).toBeGreaterThanOrEqual(0);
  });

  test('a null rate does not become a free gig', () => {
    expect(feeBreakdown(10000, null).totalCents).toBe(platformFeeCents(10000, 1000));
  });
});
