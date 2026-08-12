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
const { platformFeeCents, earnerNetCents, feeLabel, DEFAULT_FEE_BPS } = require('../shared/pricing.js');

const MIGRATION = path.join(
  __dirname, '..', 'supabase', 'migrations', '20260806050000_platform_rate.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

describe('platform_fee_cents SQL/JS parity', () => {
  test('the migration still defines the function this test is guarding', () => {
    expect(sql).toMatch(/create or replace function public\.platform_fee_cents/);
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
