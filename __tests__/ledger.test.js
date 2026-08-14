// The ledger restates money the user will reconcile against a bank statement, so
// the arithmetic gets the same treatment as the pricing module: asserted, not
// eyeballed. Every case here is one a user would notice and file a ticket about.
// The module reaches Supabase for fetchLedger(); the pure math below does not.
jest.mock('../src/lib/supabase', () => ({ supabase: {} }));
const { paymentState, summarize, byMonth, ledgerCsv } = require('../src/lib/payments');

// Mirror of toEntry()'s output shape — the module's own fetch path needs Supabase,
// so the pure functions are exercised directly on the normalized shape they consume.
const entry = (o = {}) => ({
  id: o.id ?? 'p1',
  bookingId: 'b1',
  side: o.side ?? 'earner',
  title: o.title ?? 'Lawn mowing',
  status: o.status ?? 'captured',
  at: o.at ?? '2026-08-04T12:00:00Z',
  authorizedAt: o.authorizedAt ?? '2026-08-01T12:00:00Z',
  capturedAt: o.capturedAt ?? null,
  cancelledAt: null,
  grossCents: o.grossCents ?? 6000,
  feeCents: o.feeCents ?? 600,
  feeBps: o.feeBps ?? 1000,
  feeLabel: o.feeLabel ?? '10%',
  tipCents: o.tipCents ?? 0,
  refundedCents: o.refundedCents ?? 0,
  refundedAt: null,
  refundReason: null,
  discountCents: o.discountCents ?? 0,
  feeCreditCents: 0,
  netCents: o.netCents ?? 5400,
  settled: (o.status ?? 'captured') === 'captured',
  pending: (o.status ?? 'captured') === 'authorized',
});

describe('paymentState', () => {
  // The same row means opposite things to the two parties. Showing an earner the
  // poster's wording ("Charged") would be actively misleading about whose money
  // moved which way.
  it('never shows one side the other side\'s wording', () => {
    expect(paymentState('captured', 'earner').label).toBe('Released');
    expect(paymentState('captured', 'poster').label).toBe('Charged');
    expect(paymentState('authorized', 'earner').label).toBe('In escrow');
    expect(paymentState('authorized', 'poster').label).toBe('On hold');
  });

  it('states plainly that a declined card charged nothing', () => {
    // The failure mode this guards: a user seeing "failed" and assuming they were
    // charged anyway, then filing a chargeback against a charge that never existed.
    expect(paymentState('failed', 'poster').label).toBe('Card declined');
    expect(paymentState('failed', 'poster').note).toMatch(/nothing was charged/i);
    expect(paymentState('cancelled', 'poster').note).toMatch(/never charged/i);
  });

  it('degrades to something readable for an unknown status', () => {
    expect(paymentState('weird_new_status', 'earner').label).toBe('weird_new_status');
    expect(paymentState('captured', 'nonsense').label).toBe('captured');
  });
});

describe('summarize', () => {
  const rows = [
    entry({ id: 'a', status: 'captured', netCents: 5400, feeCents: 600 }),
    entry({ id: 'b', status: 'authorized', netCents: 9000, feeCents: 1000 }),
    entry({ id: 'c', status: 'cancelled', netCents: 0, feeCents: 0 }),
    entry({ id: 'd', side: 'poster', status: 'captured', netCents: 6000 }),
  ];

  it('separates settled money from money still in escrow', () => {
    // These are different questions — "what have I been paid" vs "what am I owed" —
    // and a single blended total answers neither.
    const s = summarize(rows, 'earner', 2026);
    expect(s.settledCents).toBe(5400);
    expect(s.heldCents).toBe(9000);
    expect(s.count).toBe(1);
  });

  it('never counts the other side\'s money', () => {
    expect(summarize(rows, 'poster', 2026).settledCents).toBe(6000);
  });

  it('only counts fees actually taken from settled payouts', () => {
    // A fee on an escrowed payment has not been charged yet; counting it would
    // overstate what the platform has taken.
    expect(summarize(rows, 'earner', 2026).feesCents).toBe(600);
  });

  it('scopes to the requested year', () => {
    const old = entry({ id: 'z', at: '2025-03-02T00:00:00Z', netCents: 1234 });
    expect(summarize([...rows, old], 'earner', 2026).settledCents).toBe(5400);
    expect(summarize([...rows, old], 'earner', 2025).settledCents).toBe(1234);
  });
});

describe('byMonth', () => {
  it('buckets by calendar month, preserving order', () => {
    const groups = byMonth([
      entry({ id: '1', at: '2026-08-04T12:00:00Z' }),
      entry({ id: '2', at: '2026-08-01T12:00:00Z' }),
      entry({ id: '3', at: '2026-07-30T12:00:00Z' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].data.map((e) => e.id)).toEqual(['1', '2']);
    expect(groups[1].data.map((e) => e.id)).toEqual(['3']);
  });
});

describe('ledgerCsv', () => {
  it('exports only the requested side', () => {
    const csv = ledgerCsv([entry({ id: 'a' }), entry({ id: 'b', side: 'poster' })], 'earner');
    expect(csv.split('\n')).toHaveLength(2); // header + one row
  });

  it('discloses the rate that was pinned to THAT booking', () => {
    // Restating a past transaction at today's rate misstates what the person
    // actually received — the disclosure trap called out in CLAUDE.md.
    const csv = ledgerCsv([entry({ feeBps: 500, feeLabel: '5%' })], 'earner');
    expect(csv).toContain('"5%"');
  });

  it('neutralizes a gig title that looks like a spreadsheet formula', () => {
    // Gig titles are user-authored and this CSV is opened in Excel/Sheets. An
    // untreated leading "=" is a live formula, which is a real exfiltration path.
    const csv = ledgerCsv([entry({ title: '=HYPERLINK("http://evil","click")' })], 'earner');
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });

  it('escapes embedded quotes rather than breaking the row', () => {
    const csv = ledgerCsv([entry({ title: 'Bob\'s "big" move' })], 'earner');
    expect(csv).toContain('"Bob\'s ""big"" move"');
  });
});

const { rangeBounds, filterEntries, stats, monthlyTotals, STATUS_FILTERS } = require('../src/lib/payments');

describe('rangeBounds', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  it('bounds a tax year on both sides', () => {
    // "This year" that leaks December of last year into a 1099 total is a real
    // problem, not a rounding one.
    const { start, end } = rangeBounds('ytd', now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0);
    expect(end.getFullYear()).toBe(2027);
  });
  it('bounds last year on both sides', () => {
    const { start, end } = rangeBounds('last', now);
    expect(start.getFullYear()).toBe(2025);
    expect(end.getFullYear()).toBe(2026);
  });
  it('leaves all-time unbounded', () => {
    expect(rangeBounds('all', now)).toEqual({ start: null, end: null });
  });
});

describe('filterEntries', () => {
  const rows = [
    entry({ id: 'a', at: '2026-08-10T00:00:00Z', status: 'captured', title: 'Lawn mowing' }),
    entry({ id: 'b', at: '2026-08-09T00:00:00Z', status: 'authorized', title: 'Moving help' }),
    entry({ id: 'c', at: '2026-01-05T00:00:00Z', status: 'captured', refundedCents: 500, title: 'Tutoring' }),
    entry({ id: 'd', at: '2025-06-01T00:00:00Z', status: 'captured', title: 'Errands' }),
    entry({ id: 'e', at: '2026-08-01T00:00:00Z', status: 'failed', title: 'Dog walking' }),
    entry({ id: 'f', at: '2026-08-02T00:00:00Z', side: 'poster', title: 'Cleaning' }),
  ];
  const ids = (o) => filterEntries(rows, o).map((e) => e.id);

  it('never mixes the two sides', () => {
    expect(ids({ side: 'earner', range: 'all' })).not.toContain('f');
    expect(ids({ side: 'poster', range: 'all' })).toEqual(['f']);
  });

  it('excludes prior years from a this-year view', () => {
    expect(ids({ side: 'earner', range: 'ytd' })).not.toContain('d');
  });

  it('finds refunds, which are not a status on the row', () => {
    // refunded is a non-zero refunded_cents on a CAPTURED payment; filtering by
    // status alone would never surface it.
    expect(ids({ side: 'earner', range: 'all', status: 'refunded' })).toEqual(['c']);
  });

  it('separates declined from cancelled', () => {
    // A declined card and a released hold are different events with different
    // remedies; collapsing them would misinform.
    expect(ids({ side: 'earner', range: 'all', status: 'failed' })).toEqual(['e']);
  });

  it('treats a refunded payment as not plainly completed', () => {
    expect(ids({ side: 'earner', range: 'all', status: 'settled' })).not.toContain('c');
  });

  it('searches titles case-insensitively', () => {
    expect(ids({ side: 'earner', range: 'all', query: 'LAWN' })).toEqual(['a']);
  });

  it('composes range and status rather than one overriding the other', () => {
    expect(ids({ side: 'earner', range: 'ytd', status: 'held' })).toEqual(['b']);
  });

  it('exposes a filter for every status the ledger can produce', () => {
    ['captured', 'authorized', 'failed', 'cancelled'].forEach((st) => {
      const hit = STATUS_FILTERS.some((f) => f.match && f.match(entry({ status: st })));
      expect(hit).toBe(true);
    });
  });
});

describe('stats', () => {
  const rows = [
    entry({ id: 'a', status: 'captured', grossCents: 6000, netCents: 5400, feeCents: 600, tipCents: 500 }),
    entry({ id: 'b', status: 'captured', grossCents: 4000, netCents: 3600, feeCents: 400 }),
    entry({ id: 'c', status: 'authorized', netCents: 9000, feeCents: 1000 }),
    entry({ id: 'd', status: 'cancelled', netCents: 0, grossCents: 0 }),
  ];

  it('averages over completed work only', () => {
    // A cancelled booking is not a $0 job — including it would drag the average
    // down and misrepresent what the work actually pays.
    expect(stats(rows).avgCents).toBe(4500);
    expect(stats(rows).settledCount).toBe(2);
  });

  it('keeps escrow out of the earned total', () => {
    expect(stats(rows).netCents).toBe(9000);
    expect(stats(rows).heldCents).toBe(9000);
  });

  it('only counts fees actually taken', () => {
    expect(stats(rows).feesCents).toBe(1000);
  });

  it('reports zeroes rather than NaN on an empty set', () => {
    const s = stats([]);
    expect(s.avgCents).toBe(0);
    expect(s.netCents).toBe(0);
    expect(Number.isNaN(s.avgCents)).toBe(false);
  });
});

describe('monthlyTotals', () => {
  const now = new Date('2026-08-12T00:00:00Z');
  it('keeps empty months instead of collapsing them', () => {
    // A gap is information — dropping it would silently re-space the chart and
    // imply steady work across a month with none.
    const t = monthlyTotals([entry({ at: '2026-08-04T00:00:00Z', netCents: 5000 })], 6, now);
    expect(t).toHaveLength(6);
    expect(t[5].cents).toBe(5000);
    expect(t[0].cents).toBe(0);
  });
  it('ignores money that has not settled', () => {
    const t = monthlyTotals([entry({ at: '2026-08-04T00:00:00Z', status: 'authorized', netCents: 9000 })], 6, now);
    expect(t[5].cents).toBe(0);
  });
});

const { payoutState, PAYOUT_STATE } = require('../src/lib/payments');

describe('payoutState', () => {
  // The bank leg. These are the words an anxious person reads, so they have to be
  // unambiguous about whether the money is THERE or merely COMING.
  it('distinguishes arrived from on-its-way', () => {
    expect(payoutState('paid').label).toBe('In your bank');
    expect(payoutState('paid').verb).toBe('Arrived');
    expect(payoutState('in_transit').verb).toBe('Expected');
    expect(payoutState('pending').verb).toBe('Expected');
  });

  it('never presents a failed payout as neutral', () => {
    // An earner told "paid" whose money never lands needs to see that plainly —
    // ctl_payout_failed pages on the same condition.
    expect(payoutState('failed').tone).toBe('bad');
    expect(payoutState('failed').label).toBe('Failed');
  });

  it('degrades readably for a status Stripe adds later', () => {
    expect(payoutState('some_new_status').label).toBe('some_new_status');
    expect(payoutState(undefined).label).toBe('unknown');
  });

  it('covers every status the webhook can write', () => {
    // The handler upserts payout.status verbatim from Stripe; these are the values
    // Stripe documents for Payout.status.
    ['paid', 'pending', 'in_transit', 'failed', 'canceled'].forEach((s) => {
      expect(PAYOUT_STATE[s]).toBeDefined();
    });
  });
});

const payments = require('../src/lib/payments');

describe('tips are read in the unit they are stored in', () => {
  // bookings.tip_amount is numeric(_,2) — DOLLARS — and PostgREST hands numerics back
  // as STRINGS. The ledger ran it through a cents() helper that returns 0 for anything
  // that is not already a number, so every tip an earner received showed as $0.00 on
  // their own statement. tip_ledger.amount_cents is the integer-cents column; this one
  // is not, and the two are easy to confuse.
  const toCents = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };

  it('a $3.00 tip is 300 cents, not 0 and not 3', () => {
    expect(toCents('3.00')).toBe(300);
    expect(toCents(3)).toBe(300);
  });

  it('handles the string form PostgREST actually returns', () => {
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('0.05')).toBe(5);
  });

  it('treats missing or malformed values as no tip rather than NaN', () => {
    [null, undefined, '', 'abc'].forEach((v) => expect(toCents(v)).toBe(0));
  });

  it('the module uses this conversion, not the raw cents() helper', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/lib/payments.js'), 'utf8');
    expect(src).toMatch(/const tip = dollarsToCents\(b\.tip_amount\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A partial capture must not bill the poster for the hold.
//
// stripe-capture-payment deliberately never overwrites amount_cents — it is the
// immutable audit record that makes a capture retry idempotent. So on a dispute
// resolved below 100% the row reads: amount_cents = the full hold, fee_cents and
// earner_amount_cents = the reduced split, refunded_cents = 0 (nothing was taken,
// so nothing is refunded). Reading amount_cents there overstates what the poster
// actually paid, on the one booking they are guaranteed to scrutinize.
// ─────────────────────────────────────────────────────────────────────────────
const { settledGrossCents } = require('../src/lib/payments');

describe('settledGrossCents', () => {
  // $100 gig at 7%: fee 700, earner 9300. Dispute pays 60% → Stripe charges $60.
  const partial = {
    status: 'captured',
    amount_cents: 10000,      // the hold, untouched by design
    fee_cents: 420,           // round(700 * 0.6)
    earner_amount_cents: 5580, // 6000 - 420
    refunded_cents: 0,
  };

  it('reports what Stripe charged, not the authorized hold', () => {
    expect(settledGrossCents(partial)).toBe(6000);
    // The bug this replaces would have returned the hold.
    expect(settledGrossCents(partial)).not.toBe(partial.amount_cents);
  });

  it('is identical to amount_cents on a full capture', () => {
    // The full branch sets earner = amount - fee, so the split sums back exactly.
    expect(settledGrossCents({
      status: 'captured', amount_cents: 10000, fee_cents: 700,
      earner_amount_cents: 9300, refunded_cents: 0,
    })).toBe(10000);
  });

  it('shows the hold while a payment is still only authorized', () => {
    // Nothing has moved yet; the hold IS the honest number to show.
    expect(settledGrossCents({
      status: 'authorized', amount_cents: 10000,
      fee_cents: null, earner_amount_cents: null,
    })).toBe(10000);
  });

  it('falls back to the hold rather than showing $0 for a legacy split-less row', () => {
    expect(settledGrossCents({
      status: 'captured', amount_cents: 10000,
      fee_cents: null, earner_amount_cents: null,
    })).toBe(10000);
  });

  it('survives a null row without throwing', () => {
    expect(settledGrossCents(null)).toBe(0);
  });
});

// The invariant lives in the edge function too — if someone ever makes the capture
// path overwrite amount_cents, deriving from the split silently becomes wrong in the
// other direction. Pin the comment that documents the contract.
it('stripe-capture-payment still treats amount_cents as immutable', () => {
  const fn = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'supabase/functions/stripe-capture-payment/index.ts'), 'utf8');
  expect(fn).toMatch(/amount_cents is never overwritten/);
  // No update statement may set it. The lookbehind is load-bearing: a bare
  // /amount_cents:/ also matches `earner_amount_cents:`, which the capture path
  // writes on purpose — a guard that fires on the correct code gets deleted.
  expect(fn).not.toMatch(/update\(\{[^}]*(?<![_a-zA-Z])amount_cents:/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// A receipt's line items must SUM to the total it prints.
//
// They did not. Every promotion benefit is already baked into the persisted columns —
// amount_cents is net of the poster discount, fee_cents is net of the fee credit — and
// the receipt rendered those columns AND a separate "Discount −$X" / "Fee credit +$Y"
// line, applying each benefit a second time.
//
// A poster with a $3.55 discount saw "Gig total $96.45 / Discount − $3.55 / Total
// charged $96.45": the items said the discount came off, the total said it did not. An
// earner with a $3 referral credit saw items summing to $99 above a $96 payout.
//
// That is the disclosure class CLAUDE.md singles out, on the one screen where a person
// checks whether their incentive actually worked — so every incentive the platform ships
// was misreported at the exact moment it mattered.
//
// The old test fixture pinned feeCreditCents to 0 and never exercised the line
// composition at all, which is why it shipped.
// ─────────────────────────────────────────────────────────────────────────────
const { receiptLines } = require('../src/lib/payments');

describe('receipt line items sum to the printed total', () => {
  const sum = (r) => r.lines.reduce((n, l) => n + l.cents, 0);

  const cases = [
    ['earner, plain', { side: 'earner', grossCents: 10000, feeCents: 700, feeBps: 700, netCents: 9300 }],
    ['earner, referral fee credit', { side: 'earner', grossCents: 10000, feeCents: 400, feeCreditCents: 300, feeBps: 700, netCents: 9600 }],
    ['earner, tip', { side: 'earner', grossCents: 10000, feeCents: 700, feeBps: 700, tipCents: 500, netCents: 9800 }],
    ['earner, partial refund', { side: 'earner', grossCents: 10000, feeCents: 700, feeBps: 700, refundedCents: 2000, netCents: 7300 }],
    ['earner, 0-bps promo (fee is the floor)', { side: 'earner', grossCents: 10000, feeCents: 345, feeBps: 0, netCents: 9655 }],
    ['poster, plain', { side: 'poster', grossCents: 10000, feeBps: 700, netCents: 10000 }],
    ['poster, discount', { side: 'poster', grossCents: 9645, discountCents: 355, feeBps: 700, netCents: 9645 }],
    ['poster, discount + tip', { side: 'poster', grossCents: 9645, discountCents: 355, tipCents: 500, feeBps: 700, netCents: 10145 }],
    ['poster, refund', { side: 'poster', grossCents: 10000, feeBps: 700, refundedCents: 2500, netCents: 7500 }],
  ];

  for (const [name, entry] of cases) {
    it(`${name}: items add up`, () => {
      const r = receiptLines(entry);
      expect(`${name}: ${sum(r)}`).toBe(`${name}: ${r.totalCents}`);
    });
  }

  it('states the gig at its full value, not net of the poster discount', () => {
    // "Gig total $96.45" on a $100 gig understates the work — and for the EARNER it is
    // simply wrong, since a poster-side discount never touches their side.
    const r = receiptLines({ side: 'poster', grossCents: 9645, discountCents: 355, feeBps: 700, netCents: 9645 });
    expect(r.lines.find((l) => l.key === 'gross').cents).toBe(10000);
  });

  it('never prints a percentage beside a fee the floor set', () => {
    // The active 0-bps promotion makes this reachable TODAY: platform_fee_cents floors
    // at Stripe cost, so the old code rendered "Platform fee (0%) − $3.45".
    const r = receiptLines({ side: 'earner', grossCents: 10000, feeCents: 345, feeBps: 0, netCents: 9655 });
    expect(r.lines.find((l) => l.key === 'fee').label).toBe('Platform fee');
  });

  it('still shows the fee credit rather than hiding it', () => {
    // Correctness must not cost the earner the evidence their referral worked.
    const r = receiptLines({ side: 'earner', grossCents: 10000, feeCents: 400, feeCreditCents: 300, feeBps: 700, netCents: 9600 });
    expect(r.lines.find((l) => l.key === 'credit')?.cents).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deleting an account must not delete the counterparty's financial records.
//
// PROVEN on a staged row: profiles → jobs → bookings → payments is CASCADE at every
// link, so a poster's erasure took every earner's booking AND payment from 1 to 0. And
// delete-account only blocks UNSETTLED bookings, so what cascaded was precisely the
// completed, PAID work — the earner's 1099 evidence, destroyed by a counterparty.
//
// The account is therefore TOMBSTONED, not deleted. The subtle part, and the reason this
// test exists: profiles_id_fkey cascades FROM auth.users, so calling
// auth.admin.deleteUser after scrubbing the profile destroys the very records the scrub
// was protecting. The auth row must be neutralised instead.
// ─────────────────────────────────────────────────────────────────────────────
describe('account deletion preserves the counterparty record', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'supabase/functions/delete-account/index.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('scrubs the profile', () => {
    expect(code).toMatch(/tombstone_profile/);
  });

  it('never calls auth.admin.deleteUser', () => {
    // The whole defect: that one call cascades through the profile to jobs, bookings and
    // payments. Scrubbing first does not save them.
    expect(code).not.toMatch(/deleteUser\(/);
  });

  it('neutralises the auth row instead', () => {
    expect(code).toMatch(/updateUserById/);
    expect(code).toMatch(/ban_duration/);
    expect(code).toMatch(/removed\.invalid/);
  });

  it('refuses to proceed if the scrub failed', () => {
    // Fail closed: continuing would delete the counterparty's records, which is the
    // exact harm this exists to prevent.
    expect(code).toMatch(/tombErr/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A refund is not the same size on both sides.
//
// The poster gets the whole refund back. The earner never held the platform fee, so
// record_refund debits only their proportional share of the capture:
//
//   round(p_cents * earner_amount_cents / (earner_amount_cents + fee_cents))
//
// The ledger subtracted the FULL refund from the earner's side, so Transactions said
// the earner lost $30.00 on a $30 refund while debit_earnings had taken $27.90 — and
// the earnings dashboard was the correct one. Two surfaces, one event, two numbers.
//
// The formula lives in two languages, so this pins them together off disk — the same
// guard pricing.test.js applies to the fee and categories.test.js to the slug.
// ─────────────────────────────────────────────────────────────────────────────
describe('a partial refund costs the earner only their share', () => {
  const { earnerRefundShareCents } = require('../src/lib/payments');
  const fs = require('fs');
  const path = require('path');

  const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
  // The live definition is the last migration to define it.
  const sql = fs
    .readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8'))
    .filter((s) => /create or replace function public\.record_refund\b/i.test(s))
    .pop();

  it('found record_refund in the migrations', () => {
    expect(sql).toBeDefined();
  });

  it('SQL still apportions the debit by the earner share', () => {
    // If this changes shape, the JS below is no longer a mirror of anything.
    expect(sql.replace(/\s+/g, ' ')).toMatch(
      /round\(\s*p_cents::numeric \* coalesce\(earner_amount_cents, 0\) \/ nullif\(v_captured, 0\)\s*\)::integer/,
    );
    // v_captured is earner + fee, i.e. what was actually collected.
    expect(sql.replace(/\s+/g, ' ')).toMatch(
      /coalesce\(earner_amount_cents, 0\) \+ coalesce\(fee_cents, 0\).{0,40}into v_captured/,
    );
  });

  it('JS matches the SQL on the case that shipped wrong', () => {
    // $60 captured: earner $55.80, fee $4.20. A $30 refund.
    expect(earnerRefundShareCents(3000, 5580, 420)).toBe(2790);
    // Not the whole refund, which is what the ledger used to subtract.
    expect(earnerRefundShareCents(3000, 5580, 420)).not.toBe(3000);
  });

  it('a full refund still costs the earner their whole payout', () => {
    expect(earnerRefundShareCents(6000, 5580, 420)).toBe(5580);
  });

  it('rounds half up, as round() does in Postgres', () => {
    // 100 * 55 / 110 = 50 exactly; 101 * 55 / 110 = 50.5 → 51.
    expect(earnerRefundShareCents(100, 55, 55)).toBe(50);
    expect(earnerRefundShareCents(101, 55, 55)).toBe(51);
  });

  it('falls back to the whole refund when there is no captured total', () => {
    // A legacy/malformed row must not report the earner losing nothing.
    expect(earnerRefundShareCents(3000, 0, 0)).toBe(3000);
  });

  it('the earner receipt lines still sum to the payout', () => {
    // earner_amount 5580, $30 refunded → share 2790, payout 2790.
    const r = receiptLines({
      side: 'earner', grossCents: 6000, feeCents: 420, feeBps: 700,
      refundedCents: 3000, refundShareCents: 2790, netCents: 2790,
    });
    expect(r.lines.reduce((a, l) => a + l.cents, 0)).toBe(r.totalCents);
    const refundLine = r.lines.find((l) => l.key === 'refund');
    expect(refundLine.cents).toBe(-2790);
    // The poster got more back than this — say so rather than implying otherwise.
    expect(refundLine.label).toBe('Your share of the refund');
  });

  it('the poster is still shown the whole refund', () => {
    const r = receiptLines({
      side: 'poster', grossCents: 6000, refundedCents: 3000, refundShareCents: 3000, netCents: 3000,
    });
    expect(r.lines.find((l) => l.key === 'refund').cents).toBe(-3000);
    expect(r.lines.reduce((a, l) => a + l.cents, 0)).toBe(r.totalCents);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A failed read must never render as a confirmed empty state.
//
// PaymentsScreen's own catch says it: "'no transactions' and 'we could not load your
// transactions' must never look the same, or a user concludes their money vanished."
// Two paths broke that rule anyway.
//
//  • fetchLedger ran both booking queries and then took `.data ?? []` without ever
//    checking `.error`, so a failed read produced an empty statement rather than the
//    error card the screen already has. (The payments query has always thrown.)
//  • The screen resolved a payouts failure to [], which renders "No bank deposits yet"
//    — to an earner, that reads as "we never sent you money".
// ─────────────────────────────────────────────────────────────────────────────
describe('a failed load never looks like an empty statement', () => {
  const fs = require('fs');
  const path = require('path');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'payments.js'), 'utf8');
  const screen = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'screens', 'PaymentsScreen.js'), 'utf8',
  );

  it('fetchLedger throws on either booking query failing', () => {
    const fn = lib.slice(lib.indexOf('export async function fetchLedger'));
    expect(fn).toMatch(/if \(asEarner\.error\) throw asEarner\.error;/);
    expect(fn).toMatch(/if \(asPoster\.error\) throw asPoster\.error;/);
    // Both checks must precede the `?? []` that would otherwise swallow them.
    expect(fn.indexOf('asEarner.error')).toBeLessThan(fn.indexOf('asEarner.data ??'));
    expect(fn.indexOf('asPoster.error')).toBeLessThan(fn.indexOf('asPoster.data ??'));
  });

  it('a payouts failure is its own state, not an empty list', () => {
    expect(screen).toMatch(/catch\(\(\) => setPayouts\('error'\)\)/);
    expect(screen).not.toMatch(/catch\(\(\) => setPayouts\(\[\]\)\)/);
  });

  it('and the payouts sheet renders that state before the empty case', () => {
    const at = screen.indexOf("payouts === 'error'");
    const empty = screen.indexOf('payouts.length === 0');
    expect(at).toBeGreaterThan(-1);
    // Order matters: 'error'.length === 0 is false, but relying on that is a trap for
    // whoever edits this next.
    expect(at).toBeLessThan(empty);
    expect(screen).toMatch(/Could not load your bank deposits/);
  });
});
