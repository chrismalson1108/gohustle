/**
 * Tax Center income — what the year's platform income is actually worth.
 *
 * The figure behind "{year} net profit", the ~27% set-aside prompt and the year-end
 * CSV was computed as `computeEffectivePay(booking, null)`. That helper takes payType
 * from the booking's job embed but hours ONLY from a full job row, so with none to
 * give it every HOURLY gig was valued at its hourly RATE: a 6-hour $25/hr gig counted
 * as $25. Card tips — paid to the earner through stripe-tip — were counted nowhere,
 * while the Income tab told the user card payments were already counted.
 *
 * These tests pin the replacement (`platformIncomeForYear` / `bookingGrossDollars`)
 * against the OLD formula, reproduced inline below, and fail if the screens ever go
 * back to it.
 */
const fs = require('fs');
const path = require('path');

const {
  bookingGrossDollars,
  platformIncomeForYear,
  buildTaxSummaryCSV,
} = require('../shared/taxFormat.js');
const { bookingNetDollars } = require('../shared/pricing.js');

// The shipped-and-wrong valuation, kept here so the discrimination is visible rather
// than asserted: the old computeEffectivePay body with fullJob = null.
const OLD_valuation = (booking) => {
  const payType = booking?.job?.payType;
  const basePay = booking?.counterOffer ?? Number(booking?.job?.pay) ?? 0;
  const hours = Number(undefined) || 1; // fullJob?.estimatedHours with no fullJob
  const effective = payType === 'hourly' ? basePay * hours : basePay;
  return Number.isFinite(effective) ? effective : 0;
};

// A verified 6-hour $25/hr tutoring gig at the 7% beta rate, with a $10 card tip.
const SIX_HOUR_GIG = {
  id: 'b1',
  jobId: 'j1',
  status: 'verified',
  completedAt: '2026-06-04T18:00:00Z',
  counterOffer: null,
  feeBpsQuoted: 700,
  tipAmount: 10,
  amountCentsQuoted: 15000, // pinned by trg_z_pin_booking_amount: 25 x 6
  job: { id: 'j1', title: 'Tutoring', pay: 25, payType: 'hourly', estimatedHours: 6 },
};

describe('bookingGrossDollars', () => {
  test('an hourly booking is worth rate x hours, not the rate', () => {
    expect(bookingGrossDollars(SIX_HOUR_GIG)).toBe(150);
    // The bug being fixed, made explicit: the old formula says $25.
    expect(OLD_valuation(SIX_HOUR_GIG)).toBe(25);
  });

  test('prefers the PINNED amount over pay x hours', () => {
    // A gig whose listing was edited after the booking was struck: the pin is the
    // deal, the current listing is not.
    const repriced = {
      ...SIX_HOUR_GIG,
      amountCentsQuoted: 15000,
      job: { ...SIX_HOUR_GIG.job, pay: 40, estimatedHours: 6 },
    };
    expect(bookingGrossDollars(repriced)).toBe(150);
  });

  test('falls back to the embed hours when the pin is absent (pre-pin rows)', () => {
    const prePin = { ...SIX_HOUR_GIG, amountCentsQuoted: null };
    expect(bookingGrossDollars(prePin)).toBe(150);
    expect(bookingGrossDollars(prePin, { payType: 'hourly', pay: 25, estimatedHours: 6 })).toBe(150);
  });

  test('a counter-offer overrides the list rate, and fixed pay ignores hours', () => {
    const counter = { ...SIX_HOUR_GIG, amountCentsQuoted: null, counterOffer: 30 };
    expect(bookingGrossDollars(counter)).toBe(180);
    const fixed = {
      ...SIX_HOUR_GIG,
      amountCentsQuoted: null,
      counterOffer: null,
      job: { ...SIX_HOUR_GIG.job, payType: 'fixed', pay: 80, estimatedHours: 6 },
    };
    expect(bookingGrossDollars(fixed)).toBe(80);
  });

  test('a booking with nothing usable is worth 0, never NaN', () => {
    expect(bookingGrossDollars({})).toBe(0);
    expect(bookingGrossDollars(null)).toBe(0);
  });
});

describe('platformIncomeForYear', () => {
  test('nets each gig at its OWN pinned rate and adds card tips', () => {
    const { earnings, tips, total } = platformIncomeForYear({
      bookings: [SIX_HOUR_GIG],
      year: 2026,
    });
    expect(earnings).toBeCloseTo(bookingNetDollars(150, 700), 6);
    expect(earnings).toBeCloseTo(139.5, 2);
    expect(tips).toBe(10);
    expect(total).toBeCloseTo(149.5, 2);

    // What the screen used to report for the same booking, for the record.
    const shipped = bookingNetDollars(OLD_valuation(SIX_HOUR_GIG), 700);
    expect(shipped).toBeLessThan(total / 5);
  });

  test('two bookings struck at different rates are netted at their own rates', () => {
    const founding = {
      ...SIX_HOUR_GIG,
      id: 'b2',
      feeBpsQuoted: 1000,
      tipAmount: 0,
      amountCentsQuoted: 10000,
    };
    const { earnings } = platformIncomeForYear({ bookings: [SIX_HOUR_GIG, founding], year: 2026 });
    expect(earnings).toBeCloseTo(bookingNetDollars(150, 700) + bookingNetDollars(100, 1000), 6);
  });

  test('scopes to the year and to verified bookings only', () => {
    const lastYear = { ...SIX_HOUR_GIG, id: 'b3', completedAt: '2025-12-31T23:00:00Z' };
    const unverified = { ...SIX_HOUR_GIG, id: 'b4', status: 'completed' };
    const noDate = { ...SIX_HOUR_GIG, id: 'b5', completedAt: null };
    const { total } = platformIncomeForYear({
      bookings: [SIX_HOUR_GIG, lastYear, unverified, noDate],
      year: 2026,
    });
    expect(total).toBeCloseTo(149.5, 2);
  });

  test('no bookings is zero, not NaN', () => {
    expect(platformIncomeForYear({ bookings: [], year: 2026 })).toEqual({ earnings: 0, tips: 0, total: 0 });
    expect(platformIncomeForYear()).toEqual({ earnings: 0, tips: 0, total: 0 });
  });
});

describe('buildTaxSummaryCSV carries card tips as their own line', () => {
  const csvFor = (tipIncome) =>
    buildTaxSummaryCSV({ year: 2026, stripeIncome: 139.5, tipIncome, income: [], expenses: [] });

  test('tips are listed separately and included in gross income', () => {
    const lines = csvFor(10).split('\n');
    expect(lines).toContain(',Platform (card via Stripe),,139.50');
    expect(lines).toContain(',Platform tips (card),,10.00');
    expect(lines).toContain(',,Gross income,149.50');
    expect(lines).toContain(',,NET PROFIT,149.50');
  });

  test('no tips means no tip row, and the old call shape is unchanged', () => {
    expect(csvFor(0)).not.toContain('Platform tips');
    expect(csvFor(0)).toBe(
      buildTaxSummaryCSV({ year: 2026, stripeIncome: 139.5, income: [], expenses: [] }),
    );
  });
});

describe('the Tax Center screens use the pinned valuation', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // Both screens describe the old formula in a comment so the next reader knows why
  // it changed; strip line comments so that prose is not mistaken for the call.
  const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '');
  const SCREENS = ['src/screens/ExpensesScreen.js', 'web/app/(app)/profile/taxes/page.tsx'];

  test.each(SCREENS)('%s computes platform income with platformIncomeForYear', (file) => {
    expect(code(file)).toMatch(/platformIncomeForYear\(/);
    // The old call, verbatim: computeEffectivePay with no full job row.
    expect(code(file)).not.toMatch(/computeEffectivePay\(\s*b\s*[,)]/);
  });

  test.each(SCREENS)('%s passes card tips to the year-end CSV', (file) => {
    expect(read(file)).toMatch(/tipIncome:\s*platformTips/);
  });

  test.each(['src/context/JobsContext.js', 'web/lib/jobs.tsx'])(
    '%s: computeEffectivePay reads hours from the booking embed too',
    (file) => {
      expect(read(file)).toContain(
        'Number(fullJob?.estimatedHours ?? booking?.job?.estimatedHours) || 1',
      );
    },
  );
});
