// ─────────────────────────────────────────────────────────────────────────────
// Settling asks STRIPE whether the earner can be paid. It used to ask our cache.
//
// stripe_accounts.onboarded going FALSE is always correct — only stripe-connect-status
// writes that, and only after a live retrieve. The defect is it going STALE at false: the
// account is fixed at Stripe, nothing tells us, and both settle paths refuse.
//
// The two refusals are not symmetric with the one at authorization time.
// stripe-create-payment-intent has always re-verified live before BLOCKING A BOOKING,
// which is recoverable — the poster tries again. Refusing to SETTLE is not: the work is
// done, the hold is live, and if nothing clears the flag the authorization voids at ~7
// days leaving the worker unpaid AND the poster uncharged.
//
// Found by the 2026-08-12 payments audit, reproduced against current code 2026-08-14.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const read = (p) => fs.readFileSync(path.join(FN, p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const helper = read('_shared/payoutCapable.ts');
const capture = codeOnly(read('stripe-capture-payment/index.ts'));
const claim = codeOnly(read('earner-claim-payment/index.ts'));

describe('both settle paths verify payout capability against Stripe', () => {
  it('the shared helper exists and asks Stripe', () => {
    expect(codeOnly(helper)).toMatch(/stripe\.accounts\.retrieve/);
    // The full triple — details_submitted alone does not mean money can move.
    expect(codeOnly(helper)).toMatch(/details_submitted/);
    expect(codeOnly(helper)).toMatch(/charges_enabled/);
    expect(codeOnly(helper)).toMatch(/payouts_enabled/);
  });

  it('it believes a cached YES and only re-checks a cached NO', () => {
    // A stale TRUE is caught downstream by the capture failing, which is loud and
    // immediate. A stale FALSE is silent, so only that direction is worth a round trip.
    const code = codeOnly(helper);
    expect(code).toMatch(/onboarded[\s\S]{0,80}return \{ capable: true/);
  });

  it('it distinguishes "no" from "could not ask"', () => {
    // Folding an unreachable Stripe into a definite refusal would start the clock on a
    // voided hold over a transient API error.
    expect(codeOnly(helper)).toMatch(/unverifiable: true/);
  });

  for (const [name, src] of [['stripe-capture-payment', capture], ['earner-claim-payment', claim]]) {
    it(`${name} uses the helper rather than reading the flag directly`, () => {
      expect(`${name}: ${/payoutCapable\(/.test(src)}`).toBe(`${name}: true`);
      // The direct cached read is what this replaces.
      expect(`${name}: ${/select\(['"]onboarded['"]\)/.test(src)}`).toBe(`${name}: false`);
    });

    it(`${name} refuses only on a definite no`, () => {
      expect(src).toMatch(/!cap\.capable && !cap\.unverifiable/);
    });

    it(`${name} logs rather than refusing when Stripe is unreachable`, () => {
      const at = src.indexOf('cap.unverifiable');
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 400)).toMatch(/logServerError/);
    });
  }
});
