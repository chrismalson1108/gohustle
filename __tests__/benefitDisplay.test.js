// ─────────────────────────────────────────────────────────────────────────────
// What a promotion actually does to the two money lines a poster is shown.
//
// FOUR values are pinned to a booking at INSERT; the sheets only ever read two of
// them. The server does this (stripe-create-payment-intent):
//
//   poster is charged   amount - poster_discount_cents          -> authorizedCents
//   earner receives     amount - platform_fee_after_credit(amount, bps, fee_credit_cents)
//
// The Verify sheet stated "$X held on your card" from the pre-discount pin and
// "Confirming releases $Y" from a credit-blind earnerNetCents, under the sentence
// "this is the amount you already authorized". The Accept sheets rendered the edge
// function's `amountCents` — also pre-discount — as "held securely" / "Hold $X &
// accept" (web) and "$X held in escrow" (the mobile toast). On a $200 gig at 700 bps
// with a 765c referral credit the earner actually receives $193.65, not the $186.00
// the sheet claimed.
//
// The helpers this guards mirror SQL, so the SQL is parsed off disk here — the same
// discipline pricing.test.js applies to platform_fee_cents. A JS-to-JS comparison
// could never fail.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const {
  platformFeeCents,
  platformFeeAfterCreditCents,
  earnerNetAfterCreditCents,
  earnerNetCents,
  posterChargeCents,
} = require('../shared/pricing.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const bonusSql = read('supabase', 'migrations', '20260806080000_referral_bonus.sql');
const edgeFn = read('supabase', 'functions', 'stripe-create-payment-intent', 'index.ts');

describe('platform_fee_after_credit SQL/JS parity', () => {
  test('the migration still defines the function being mirrored', () => {
    expect(bonusSql).toMatch(/create or replace function public\.platform_fee_after_credit/);
  });

  test('the floor is absolute and computed from the AMOUNT, not from the fee', () => {
    // greatest(floor, fee - credit): a credit reduces OUR margin, never Stripe's cost.
    // A mirror that clamped at zero instead would quote a payout we cannot pay.
    expect(bonusSql).toMatch(/greatest\(\s*[\s\S]{0,400}?ceil\(coalesce\(p_amount_cents, 0\) \* 0\.029\)::integer \+ 30 \+ 25,/);
    expect(bonusSql).toMatch(/public\.platform_fee_cents\(p_amount_cents, p_fee_bps\) - greatest\(0, coalesce\(p_credit_cents, 0\)\)/);
  });

  test('the JS mirror agrees with a literal transcription of that SQL', () => {
    const sqlFeeAfterCredit = (amount, bps, credit) =>
      Math.max(
        Math.ceil(amount * 0.029) + 30 + 25,
        platformFeeCents(amount, bps) - Math.max(0, credit),
      );
    for (const amount of [0, 50, 500, 1999, 2500, 10000, 20000, 100000, 1000000]) {
      for (const bps of [0, 500, 700, 1000, 3000]) {
        for (const credit of [0, 1, 250, 765, 5000, 999999]) {
          expect(platformFeeAfterCreditCents(amount, bps, credit)).toBe(sqlFeeAfterCredit(amount, bps, credit));
        }
      }
    }
  });

  test('the charge mirrors authorizedCents, including Stripe 50c minimum', () => {
    expect(edgeFn).toMatch(/const authorizedCents = Math\.max\(50, amountCents - discountCents\);/);
    expect(posterChargeCents(20000, 765)).toBe(19235);
    expect(posterChargeCents(100, 90)).toBe(50);
  });

  test('the reported scenario: a 765c credit is worth $7.65 to the earner', () => {
    // $200 flat gig pinned at 700 bps with a vested referral credit.
    expect(earnerNetCents(20000, 700)).toBe(18600); // what the sheet used to claim
    expect(earnerNetAfterCreditCents(20000, 700, 765)).toBe(19365); // what is actually paid
    // And a poster discount moves the HOLD, not the payout — the discount comes out
    // of the platform's side (the split invariant in the edge function).
    expect(posterChargeCents(20000, 765)).toBe(19235);
    expect(earnerNetAfterCreditCents(20000, 700, 0)).toBe(18600);
  });
});

describe('the pinned benefits reach the clients that display money', () => {
  test('transformBooking exposes all FOUR pinned inputs, not two', () => {
    const t = codeOnly(read('shared', 'transforms.js'));
    for (const field of ['feeBpsQuoted', 'amountCentsQuoted', 'feeCreditCents', 'posterDiscountCents']) {
      expect(t).toMatch(new RegExp(`${field}:`));
    }
    expect(t).toMatch(/fee_credit_cents/);
    expect(t).toMatch(/poster_discount_cents/);
  });

  test('the edge function returns authorizedCents on BOTH response paths', () => {
    // The replay branch and the fresh-PaymentIntent branch. Returning it from only
    // one leaves the accept sheet wrong exactly when a hold already existed.
    const bodies = edgeFn.match(/return json\(\{[\s\S]*?\}\);/g).filter((b) => b.includes('clientSecret'));
    expect(bodies.length).toBe(2);
    bodies.forEach((b) => expect(b).toMatch(/authorizedCents/));
  });

  test('both accept sheets prefer authorizedCents over the pre-discount pin', () => {
    expect(codeOnly(read('web', 'components', 'AcceptPaymentModal.tsx'))).toMatch(
      /res\.authorizedCents \?\? res\.amountCents/,
    );
    const gigs = codeOnly(read('src', 'screens', 'GigsScreen.js'));
    expect(gigs).toMatch(/authorizedCents \?\? amountCents/);
    // …and the toast quotes that, not the pin.
    expect(gigs).not.toMatch(/\(amountCents \/ 100\)/);
  });
});

describe('the verify sheet states the amounts the server will actually move', () => {
  const web = codeOnly(read('web', 'components', 'CompletionModal.tsx'));

  test('the hold is the pinned amount LESS the poster discount', () => {
    expect(web).toMatch(/posterChargeCents\(/);
    expect(web).toMatch(/posterDiscountCents/);
  });

  test("the payout is net of the fee AFTER the earner's credit", () => {
    expect(web).toMatch(/earnerNetAfterCreditCents\(/);
    expect(web).toMatch(/feeCreditCents/);
    // The credit-blind helper must be gone from this sheet.
    expect(web).not.toMatch(/earnerNetCents\(/);
  });

  test('the "we keep N%" parenthetical is dropped when a benefit is pinned', () => {
    // With a credit we keep less than the rate; with a discount, less again. A
    // percentage printed beside either is a number nobody is charged.
    for (const src of [web, codeOnly(read('src', 'components', 'CompletionModal.js'))]) {
      expect(src).toMatch(/feeText/);
      expect(src).toMatch(/(posterDiscountCents|feeCreditCents)/);
      // effectiveFeeLabel is called ONCE, into that gated variable — not inline in
      // the sentence, which is how the credit-blind label got there in the first place.
      expect((src.match(/effectiveFeeLabel\(/g) || []).length).toBe(1);
    }
  });
});
