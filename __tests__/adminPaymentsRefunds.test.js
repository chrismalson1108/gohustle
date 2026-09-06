// /payments is the one finance-tier page that lists money, and until now it could not
// see a refund at all.
//
// The mechanism is a gap between two facts that live in different files:
//
//   * `payments.status` is CHECK-constrained to authorized/captured/cancelled/failed
//     (supabase/migration_stripe.sql), and no later migration widens it.
//   * `record_refund` (20260814130000) writes refunded_cents / earner_refunded_cents /
//     refunded_at / refund_reason and deliberately does NOT touch `status`.
//
// So a $60 charge refunded in full last week is still `captured`, and the list — which
// selected no refund column and derived "Captured" as earner_amount_cents + fee_cents —
// rendered it as a live green collection for the whole $60. The status chips could not
// find it either: there is no status value to filter on. The dashboard's "Refunded
// all-time" tile links straight here, so the number and the rows it supposedly
// comprises disagreed with each other.
//
// This pins both halves: the arithmetic (a pure module, so it can be asserted rather
// than eyeballed) and the wiring on the page that consumes it.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const money = require(path.join(root, 'admin', 'lib', 'money.ts'));
const pageSrc = fs.readFileSync(
  path.join(root, 'admin', 'app', '(console)', 'payments', 'page.tsx'),
  'utf8',
);

describe('collected-vs-refunded arithmetic', () => {
  // The shape record_refund leaves behind on a $60 gig at the 7% pinned rate.
  const captured = { earner_amount_cents: 5580, fee_cents: 420 };

  test('captured is earner + fee, never amount_cents (the untouched authorization)', () => {
    expect(money.capturedCents(captured)).toBe(6000);
  });

  test('an un-refunded row collects the whole captured total', () => {
    expect(money.netCollectedCents({ ...captured, refunded_cents: 0 })).toBe(6000);
    // A row predating the column, or one PostgREST did not return, must not
    // silently become a negative or NaN dollar figure.
    expect(money.netCollectedCents(captured)).toBe(6000);
    expect(money.refundedCents(captured)).toBe(0);
  });

  test('a FULL refund collects nothing — the case that used to read as $60.00', () => {
    expect(money.netCollectedCents({ ...captured, refunded_cents: 6000 })).toBe(0);
  });

  test('a partial refund collects the remainder', () => {
    expect(money.netCollectedCents({ ...captured, refunded_cents: 2000 })).toBe(4000);
  });

  test('an over-refund clamps at zero rather than printing negative money', () => {
    // record_refund refuses this, so it can only arrive by hand-patching. Print $0.00.
    expect(money.netCollectedCents({ ...captured, refunded_cents: 9999 })).toBe(0);
  });
});

describe('the payments list actually reads the refund', () => {
  test('it selects refunded_cents', () => {
    // Without this column on the row, every guard below is decoration: the page
    // cannot distinguish a refunded charge from a live one no matter what it renders.
    expect(pageSrc).toMatch(/\.select\(\s*[\s\S]*?refunded_cents/);
  });

  test('it renders a Refunded column', () => {
    expect(pageSrc).toMatch(/<th[^>]*>Refunded<\/th>/);
  });

  test('the collected figure is netted, not the raw captured total', () => {
    expect(pageSrc).toContain('netCollectedCents(p)');
    // The old inline sum is what overstated a refunded row; it must not survive
    // as the value of the Captured cell.
    expect(pageSrc).not.toMatch(/\(p\.earner_amount_cents \?\? 0\) \+ \(p\.fee_cents \?\? 0\)/);
  });
});

describe('refunded is filterable, and only as a pseudo-status', () => {
  test('the chips offer it', () => {
    expect(pageSrc).toMatch(/const FILTERS = \[[^\]]*REFUNDED_FILTER/);
    expect(pageSrc).toMatch(/const REFUNDED_FILTER = "refunded"/);
  });

  test('it filters on refunded_cents, never on status', () => {
    // .eq("status", "refunded") would match zero rows forever and report "no refunds"
    // — the same silence the missing column produced, wearing a filter chip.
    expect(pageSrc).toMatch(/statusFilter === REFUNDED_FILTER\) payQ = payQ\.gt\("refunded_cents", 0\)/);
  });

  test('and the reason it must be a pseudo-status still holds in SQL', () => {
    const stripeSql = fs.readFileSync(path.join(root, 'supabase', 'migration_stripe.sql'), 'utf8');
    const domain = stripeSql.match(/check \(status in \(([^)]*)\)\)/);
    expect(domain).not.toBeNull();
    expect(domain[1]).not.toContain('refunded');

    // If a future migration ever widens the domain, this fails and the pseudo-filter
    // above can become a plain .eq() — that is the point of asserting it here.
    const widened = fs
      .readdirSync(path.join(root, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .some((f) =>
        /payments[\s\S]{0,200}?check \(status in \([^)]*refunded/.test(
          fs.readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8'),
        ),
      );
    expect(widened).toBe(false);
  });

  test('it uses the same key the app already uses for the same pseudo-status', () => {
    // src/lib/payments.js reached this conclusion first — its STATUS_FILTERS carries a
    // 'refunded' entry matching on refundedCents > 0, above a comment saying "Refunded is
    // not a status on the row at all". The user-facing ledger has been honest about
    // refunds the whole time; only the console was not. Keep the two spelled the same,
    // so an operator and the person they are helping filter for the same word.
    jest.mock('../src/lib/supabase', () => ({ supabase: {} }), { virtual: true });
    const { STATUS_FILTERS } = require(path.join(root, 'src', 'lib', 'payments.js'));
    const appKey = STATUS_FILTERS.find((f) => f.key === 'refunded');
    expect(appKey).toBeTruthy();
    expect(pageSrc).toContain('const REFUNDED_FILTER = "' + appKey.key + '"');
  });

  test('record_refund still leaves status alone — the premise of the whole fix', () => {
    const sql = fs.readFileSync(
      path.join(root, 'supabase', 'migrations', '20260814130000_refund_returns_the_fee_credit.sql'),
      'utf8',
    );
    const body = sql.slice(sql.indexOf('create or replace function public.record_refund'));
    const updates = body.match(/update public\.payments[\s\S]*?where id = p_payment_id;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).not.toMatch(/\bset[\s\S]*\bstatus\s*=/);
  });
});
