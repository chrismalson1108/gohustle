// The promo counterfactual must be the rate the booking was ACTUALLY pinned at.
//
// pin_booking_amount composes standing rate -> loyalty tier -> promo by lowest-wins.
// consume_promo_grant charges the campaign the difference between "what they would
// have paid" and the grant's rate. If "would have paid" is read as the standing rate
// while a loyalty tier has already lowered it, the campaign is billed for the tier's
// giveaway as well as its own — or for nothing at all, when the tier already beat the
// grant — and the earner's grant use is destroyed for a booking it did not change.
//
// Same discipline as pricing.test.js and categories.test.js: the SQL is READ OFF DISK.
// A test comparing two JavaScript constants to each other could never fail. The
// arithmetic half leans on shared/pricing.js:platformFeeCents, which pricing.test.js
// already pins to public.platform_fee_cents in the migration.
const fs = require('fs');
const path = require('path');
const { platformFeeCents } = require('../shared/pricing.js');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const FIX = path.join(MIGRATIONS, '20260812070000_promo_counterfactual_is_the_pinned_baseline.sql');
const sql = fs.readFileSync(FIX, 'utf8');

const body = (name) => {
  const m = sql.match(
    new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\$\\$;`),
  );
  expect(m).not.toBeNull();
  return m[0];
};

describe('the promo is priced against the pinned baseline, not the standing rate', () => {
  test('the pin hands consume_promo_grant the rate it has already pinned', () => {
    const pin = body('pin_booking_amount');
    expect(pin).toMatch(
      /consume_promo_grant\(\s*new\.earner_id,\s*new\.id,\s*new\.amount_cents_quoted,\s*new\.fee_bps_quoted\s*\)/,
    );
    // The three-argument call is the bug. Any survivor is a regression.
    expect(pin).not.toMatch(
      /consume_promo_grant\(\s*new\.earner_id,\s*new\.id,\s*new\.amount_cents_quoted\s*\)/,
    );
  });

  test('the tier is applied BEFORE the promo, so the baseline includes it', () => {
    // If these ever swap, the baseline passed in is the bare standing rate again and
    // the fix silently evaporates while every assertion above still passes.
    const pin = body('pin_booking_amount');
    const tierAt = pin.indexOf('tier_fee_bps(');
    const promoAt = pin.indexOf('consume_promo_grant(');
    expect(tierAt).toBeGreaterThan(-1);
    expect(promoAt).toBeGreaterThan(-1);
    expect(tierAt).toBeLessThan(promoAt);
  });

  test('the baseline-blind 3-argument overload is dropped, not left callable', () => {
    // Leaving it means a stale caller silently gets the old behaviour — the exact
    // mistake 20260806320000 refused to make with consume_poster_discount.
    expect(sql).toMatch(
      /drop function if exists public\.consume_promo_grant\(uuid,\s*uuid,\s*integer\)\s*;/,
    );
  });

  test('a grant that cannot beat the baseline charges nothing and burns nothing', () => {
    const fn = body('consume_promo_grant');
    expect(fn).toMatch(/if\s+g\.fee_bps\s*>=\s*baseline\s+then\s+return null;/);
    // DECIDE BEFORE CHARGING: the short-circuit has to precede every write.
    const guardAt = fn.search(/g\.fee_bps\s*>=\s*baseline/);
    expect(guardAt).toBeGreaterThan(-1);
    for (const write of [
      /update public\.promotions/,
      /update public\.promo_grants/,
      /insert into public\.promo_redemptions/,
    ]) {
      expect(fn.search(write)).toBeGreaterThan(guardAt);
    }
    // A zero-value hit (both fees floored at Stripe cost) must not burn a use either.
    expect(fn).toMatch(/if\s+hit\s*<=\s*0\s+then\s+return null;/);
  });

  test('the charge is measured against the baseline and recorded on the redemption', () => {
    const fn = body('consume_promo_grant');
    expect(fn).toMatch(/promo_benefit_cents\(p_amount_cents,\s*g\.fee_bps,\s*baseline\)/);
    expect(fn).toMatch(/insert into public\.promo_redemptions[\s\S]*baseline_bps/);
    expect(sql).toMatch(/add column if not exists baseline_bps integer/);
  });

  test('the guards the live function had gained all survive the replacement', () => {
    // Reproducing a function from a stale file silently reverts everything added since.
    const fn = body('consume_promo_grant');
    expect(fn).toMatch(/promotions_enabled/);        // the kill switch
    expect(fn).toMatch(/revoked_at is null/);        // revoked grants cannot be spent
    expect(fn).toMatch(/kind = 'fee_override'/);     // only fee promos apply here
    expect(fn).toMatch(/for update of g2/);          // the grant row is locked
    // The increment IS the check: ONE conditional UPDATE carrying BOTH ceilings.
    expect(fn).toMatch(
      /update public\.promotions[\s\S]*redemptions_used\s*<\s*max_redemptions[\s\S]*spent_cents\s*\+\s*hit\s*<=\s*budget_cents/,
    );
    expect(fn).not.toMatch(/select[^\n]*budget_cents[^\n]*into/i); // never read-then-decide
  });

  test('settle re-derives the same baseline instead of re-reading the standing rate', () => {
    const fn = body('settle_booking_benefits');
    expect(fn).toMatch(/r\.baseline_bps/);
    expect(fn).toMatch(/promo_benefit_cents\(p_amount_cents,\s*r\.fee_bps,/);
  });

  test('settle stops recomputing a flat poster discount as a rate difference', () => {
    // A poster_discount redemption stores fee_bps = the booking's pinned rate, so the
    // fee counterfactual evaluates to 0 on a normal booking and settle handed the whole
    // reserve back — budget_cents stopped bounding poster-discount spend entirely.
    const fn = body('settle_booking_benefits');
    expect(fn).toMatch(/kind = 'poster_discount'/);
    expect(fn).toMatch(/poster_discount_cents/);
  });

  test('the control covers the fee_override half the existing one excludes', () => {
    const existing = fs.readFileSync(
      path.join(MIGRATIONS, '20260806320000_discount_headroom_after_credit.sql'), 'utf8',
    );
    // The existing control is explicitly scoped to the OTHER kind. That scoping is why
    // this bug had no detector at all.
    expect(existing).toMatch(/ctl_discount_charged_not_delivered[\s\S]*p\.kind = 'poster_discount'/);

    const ctl = body('ctl_promo_charged_not_delivered');
    expect(ctl).toMatch(/p\.kind = 'fee_override'/);
    expect(ctl).toMatch(/b\.fee_bps_quoted <> r\.fee_bps/);
    expect(ctl).toMatch(/r\.baseline_bps is null and r\.created_at >/);
    expect(sql).toMatch(/'promo_charged_not_delivered'[\s\S]*'ctl_promo_charged_not_delivered'/);
    // Registered against the function by name, never as stored SQL text.
    expect(sql).not.toMatch(/insert into public\.controls[^;]*\$\$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The arithmetic, in cents. These are the numbers in the migration header; if either
// implementation moves, one of these breaks.
// ─────────────────────────────────────────────────────────────────────────────
describe('what the campaign is charged, before and after', () => {
  // What the OLD code did: counterfactual against the standing rate, blind to the tier.
  const chargedBlind = (amount, grantBps, standingBps) =>
    Math.max(0, platformFeeCents(amount, standingBps) - platformFeeCents(amount, grantBps));

  // What the fix does: counterfactual against the rate this booking is pinned at, and
  // nothing at all when the grant cannot improve on it.
  const chargedFixed = (amount, grantBps, baselineBps) =>
    grantBps >= baselineBps
      ? 0
      : Math.max(0, platformFeeCents(amount, baselineBps) - platformFeeCents(amount, grantBps));

  // The rate the earner is pinned at is always the best of the three — nobody is ever
  // overcharged by this bug. Only the campaign's books are wrong.
  const pinned = (standing, tier, grant) => Math.min(standing, tier ?? standing, grant ?? standing);

  test('Case A — the tier already beat the grant: charged 200c for a 0c benefit', () => {
    const [amount, standing, tier, grant] = [10000, 1000, 700, 800];
    expect(pinned(standing, tier, grant)).toBe(700);
    expect(pinned(standing, tier, null)).toBe(700);       // the promo changed nothing
    expect(chargedBlind(amount, grant, standing)).toBe(200);
    expect(chargedFixed(amount, grant, tier)).toBe(0);
  });

  test('Case B — the grant wins, but the tier is billed to the campaign too', () => {
    const [amount, standing, tier, grant] = [10000, 1000, 700, 500];
    expect(pinned(standing, tier, grant)).toBe(500);
    // Real marginal benefit of the promo: 700c fee -> 500c fee.
    const real = platformFeeCents(amount, tier) - platformFeeCents(amount, grant);
    expect(real).toBe(200);
    expect(chargedBlind(amount, grant, standing)).toBe(500);   // 300c of it is the tier's
    expect(chargedFixed(amount, grant, tier)).toBe(real);
  });

  test('with no tier enabled the fix changes nothing — the baseline IS the standing rate', () => {
    for (const amount of [500, 2500, 10000, 123456]) {
      for (const grant of [0, 200, 500, 800]) {
        expect(chargedFixed(amount, grant, 1000)).toBe(chargedBlind(amount, grant, 1000));
      }
    }
  });

  test('a budget buys the discount it was set to buy', () => {
    // 50,000c campaign, $100 gigs, grant 500 bps, every earner on the 700 rung.
    const budget = 50000;
    const [amount, tier, grant] = [10000, 700, 500];
    const perBooking = platformFeeCents(amount, tier) - platformFeeCents(amount, grant);
    expect(Math.floor(budget / chargedBlind(amount, grant, 1000))).toBe(100);  // 100 uses
    expect(Math.floor(budget / chargedFixed(amount, grant, tier))).toBe(250);  // 250 uses
    // Same money, 2.5x the discount actually delivered.
    expect(250 * perBooking).toBe(budget);
    expect(100 * perBooking).toBe(20000);
  });

  test('both fees on the processing floor buys nothing, so nothing is charged', () => {
    // $5 gig: floor = ceil(500*0.029)+30+25 = 70c. 10% and 5% both floor to 70.
    expect(platformFeeCents(500, 1000)).toBe(70);
    expect(platformFeeCents(500, 500)).toBe(70);
    expect(chargedFixed(500, 500, 1000)).toBe(0);
  });
});
