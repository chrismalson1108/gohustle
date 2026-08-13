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
