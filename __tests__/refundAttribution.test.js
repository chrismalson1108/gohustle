// ─────────────────────────────────────────────────────────────────────────────
// What the earner lost is RECORDED, not re-derived — and the refund key does not move.
//
// Three separate places used to re-derive the earner's share of a refund as
//   round(refunded_cents * earner_amount_cents / (earner_amount_cents + fee_cents))
// and that formula stopped being true when the chargeback split landed: a LOST
// CHARGEBACK calls record_refund with p_debit_earner => false, raising refunded_cents
// and debiting nothing. The client then showed an earner a $55.80 loss they never took,
// on money already sitting in their bank, and ctl_earnings_total_drift was about to open
// a permanent unresolvable HIGH finding against them for the same reason.
//
// The lesson is not "fix the formula" — it is that a figure with a conditional branch
// cannot be kept in sync across three languages by comment. It is written down once.
//
// Separately: Stripe's idempotency key was built from our own refunded_cents, which
// MOVES the instant attempt 1 commits. The console aborts at 20s and record_refund
// commits in about one, so the likely retry built a DIFFERENT key and Stripe issued a
// second real refund — the poster paid twice, the earner reverse-transferred twice.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const allMigrations = fs
  .readdirSync(MIG)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8'))
  .join('\n');

function latestDefining(fnName) {
  const files = fs
    .readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(MIG, f), 'utf8'),
      ),
    );
  return fs.readFileSync(path.join(MIG, files[files.length - 1]), 'utf8');
}

const payments = read('src', 'lib', 'payments.js');
const admin = read('supabase', 'functions', 'admin-payment-action', 'index.ts');
const webhook = read('supabase', 'functions', 'stripe-webhook', 'index.ts');
const panel = read('admin', 'app', '(console)', 'bookings', '[id]', 'InterventionPanel.tsx');

describe('the earner clawback is recorded, not recomputed', () => {
  it('payments carries earner_refunded_cents', () => {
    expect(allMigrations).toMatch(/add column if not exists earner_refunded_cents/i);
  });

  it('record_refund accumulates the ACTUAL debited figure, and zero on a chargeback', () => {
    const sql = latestDefining('record_refund').replace(/\s+/g, ' ');
    expect(sql).toMatch(/earner_refunded_cents = coalesce\(earner_refunded_cents, 0\) \+ v_earner_share/);
    // The non-debiting branch must record 0, not the proportional figure.
    expect(sql).toMatch(/else v_earner_share := 0;/);
    // And the debit itself stays gated on the same flag.
    expect(sql).toMatch(/if p_debit_earner and v_earner_share > 0 then perform public\.debit_earnings/);
  });

  it('the client READS the column instead of re-deriving it', () => {
    expect(payments).toMatch(/earner_refunded_cents/);
    // The select must actually fetch it, or the fallback silently takes over and the
    // chargeback bug comes straight back.
    const select = payments.slice(payments.indexOf(".select(\n"), payments.indexOf('.in(\'booking_id\''));
    expect(select).toMatch(/earner_refunded_cents/);
  });

  it('ctl_earnings_total_drift sums the recorded figure', () => {
    const sql = latestDefining('ctl_earnings_total_drift').replace(/\s+/g, ' ');
    expect(sql).toMatch(/sum\(coalesce\(p\.earner_refunded_cents, 0\)\)/);
    // The proportional reconstruction must be gone from the clawed CTE.
    expect(sql).not.toMatch(/clawed as \([\s\S]*?round\(coalesce\(p\.refunded_cents/);
  });
});

describe('a refund cannot be issued twice by retrying', () => {
  it('the Stripe idempotency key is keyed on the request, not on refunded_cents', () => {
    expect(admin).toMatch(/idempotencyKey: requestId/);
    expect(admin).toMatch(/refund_\$\{pay\.payment_intent_id\}_\$\{requestId\}/);
  });

  it('the console mints one id per attempt and rotates it only on success', () => {
    expect(panel).toMatch(/requestIdRef/);
    expect(panel).toMatch(/fd\.set\("requestId", requestIdRef\.current\)/);
    // Rotation must sit inside the success branch. If it rotated unconditionally, a
    // retry would build a new key and Stripe would refund again — the exact bug.
    const okBranch = panel.match(/if \(r\.ok\) \{[^}]*\}/);
    expect(okBranch).not.toBeNull();
    expect(okBranch[0]).toMatch(/requestIdRef\.current = crypto\.randomUUID\(\)/);
  });

  it('the refund cap consults Stripe, not only our ledger', () => {
    // An external Dashboard refund never moves refunded_cents, so capping on it alone
    // offers the whole capture as refundable on exactly the payment the reversal
    // control is firing about.
    expect(admin).toMatch(/amount_refunded/);
    expect(admin).toMatch(/Math\.max\(ourRefunded, stripeRefunded\)/);
    // And it must FAIL CLOSED when Stripe cannot be read.
    expect(admin).toMatch(/stripe_unreadable/);
  });
});

describe('the in-flight refund marker cannot stick forever', () => {
  it('record_refund clears it on every exit path', () => {
    const sql = latestDefining('record_refund');
    // Three writes: the over-refund refusal, the replay, and the success path. Two of
    // those used to `return` above the clear.
    const clears = sql.match(/refund_source = null, refund_source_at = null/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/refund_source\s*= null,\s*refund_source_at = null/);
  });

  it('admin-payment-action releases it when the action throws', () => {
    const tail = admin.slice(admin.lastIndexOf('} catch (err)'));
    expect(tail).toMatch(/refund_source: null, refund_source_at: null/);
  });

  it('the webhook time-bounds the marker rather than trusting it forever', () => {
    // inFlight || alreadyLedgered is an OR: a wrongly-true inFlight wins outright and
    // the correct alreadyLedgered value is discarded. So inFlight must be able to expire.
    expect(webhook).toMatch(/MARKER_TTL_MS/);
    expect(webhook).toMatch(/refund_source === 'admin' && markerFresh/);
    // A row with no timestamp must be treated as STALE (fail open) — filing a dispute
    // row a human can dismiss beats hiding a real reversal from every detector.
    expect(webhook).toMatch(/: false;/);
    // And it must select the column, or markerFresh is always false for the wrong reason.
    expect(webhook).toMatch(/select\('id, booking_id, refund_source, refund_source_at, refunded_cents'\)/);
  });
});

describe('the reversal control does not instruct an operator into a second refund', () => {
  it('the remedy no longer offers Refund as an equivalent option', () => {
    const sql = latestDefining('ctl_external_reversal_not_ledgered');
    const remedy = sql.slice(sql.indexOf("'remedy'"), sql.indexOf("'remedy'") + 1200);
    expect(remedy).toMatch(/Do NOT press Refund/);
    // The old string promised a debit that the chargeback op has not performed since
    // 20260813160000.
    expect(remedy).not.toMatch(/Record chargeback \(or Refund\), so record_refund writes refunded_cents and debits the earner/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The settle lever exists, because the app already tells people it does.
//
// A gig posted with the "Flexible — Contact to Schedule" slot carries no starts_at. So
// shared/lifecycle returns false, EarnScreen renders no Claim button, and
// earner-claim-payment refuses with NO_SCHEDULE telling the worker to contact support to
// settle it. Support had no way to settle anything: the console offered release (nobody
// pays), refund (poster pays, then unpaid) and record-chargeback. No capture.
//
// So the worker did the job, the poster never verified, and the hold voided at ~7 days
// with nobody charged and nobody paid — while both the app copy and RUNBOOK_MONEY promised
// support could fix it.
// ─────────────────────────────────────────────────────────────────────────────
describe('support can settle a booking the app cannot', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const R = path2.join(__dirname, '..');
  const rd = (...p) => fs2.readFileSync(path2.join(R, ...p), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const fn = strip(rd('supabase', 'functions', 'admin-payment-action', 'index.ts'));
  const actions = strip(rd('admin', 'app', '(console)', 'bookings', 'actions.ts'));
  const panel = strip(rd('admin', 'app', '(console)', 'bookings', '[id]', 'InterventionPanel.tsx'));

  it('the edge function accepts a settle op', () => {
    expect(fn).toMatch(/op !== 'settle'/);
    expect(fn).toMatch(/if \(op === 'settle'\)/);
  });

  it('it captures in FULL and reconciles to what Stripe collected', () => {
    const branch = fn.slice(fn.indexOf("if (op === 'settle')"));
    // No amount argument: a reduced settlement is a dispute outcome and belongs to the
    // poster's Verify sheet, which records who asked for it.
    expect(branch).toMatch(/paymentIntents\.capture\(pay\.payment_intent_id\)/);
    expect(branch).toMatch(/amount_received/);
    // And it must credit the earner — capturing without crediting is the worse bug.
    expect(branch.slice(0, 2000)).toMatch(/credit_earnings/);
  });

  it('it only settles an open hold', () => {
    const branch = fn.slice(fn.indexOf("if (op === 'settle')"));
    expect(branch.slice(0, 400)).toMatch(/pay\.status !== 'authorized'/);
  });

  it('the console exposes it', () => {
    expect(actions).toMatch(/export async function settleHold/);
    expect(actions).toMatch(/op: "settle"/);
    expect(panel).toMatch(/settleHold/);
  });
});
