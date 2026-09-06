// ─────────────────────────────────────────────────────────────────────────────
// The reconciler and the chargeback recorder are two writers of one number, and they
// must agree about what "reversed" means.
//
// `refunded_cents` is raised by TWO paths with different visibility at Stripe:
//
//   REFUND      admin-payment-action calls stripe.refunds.create → charge.amount_refunded
//               moves. Our number and Stripe's number both change.
//   CHARGEBACK  admin-payment-action's `record_reversal` op makes NO Stripe call —
//               deliberately, because Stripe rejects refunds.create on a disputed charge
//               (charge_disputed). A Dispute is not a Refund object, so
//               charge.amount_refunded stays 0 while our number moves.
//
// reconcile-stripe's check #4 compared refunded_cents against amount_refunded alone, so
// the documented remedy for a lost chargeback (RUNBOOK_MONEY §2, "Record chargeback")
// produced a critical `refund_mismatch` on the very next sweep — ours 10000, stripe 0 —
// that no action could clear. Resolving it by hand re-opened it, because the findings
// uniqueness index is partial (`where resolved_at is null`) and a resolved row does not
// conflict. That is the permanent-false-positive shape this repo has now fixed three
// times in this one file (cancelled holds, partial captures, and this).
//
// The other direction was worse and silent: a lost chargeback nobody recorded compared
// 0 against 0 and produced NO finding. The reconciler exists to catch money that left
// without our ledger noticing, and this was precisely that case.
//
// The fix reads the reversal total from Stripe by BOTH mechanisms. These assertions pin
// the two writers together so a future edit to either cannot drift them apart again.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Strip comments before scanning for behaviour. Without this every assertion below
// would pass on the comment block that EXPLAINS the bug, which is the failure mode
// stripeApiVersion.test.js already had to fix once.
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const reconcile = read('supabase', 'functions', 'reconcile-stripe', 'index.ts');
const reconcileCode = code(reconcile);
const admin = code(read('supabase', 'functions', 'admin-payment-action', 'index.ts'));
const runbook = read('RUNBOOK_MONEY.md');

describe('recording a lost chargeback does not open a permanent reconciliation finding', () => {
  test('reconcile-stripe asks Stripe about disputes, not only about refunds', () => {
    // charge.amount_refunded cannot see a dispute. Something has to.
    expect(reconcileCode).toMatch(/disputes\.list\(/);
    expect(reconcileCode).toMatch(/charge\?\.disputed/);
  });

  test('only a LOST dispute counts as money that came back', () => {
    // An open dispute has been withdrawn pending the outcome and our ledger is
    // correctly still 0, so counting it would fire on every live dispute.
    expect(reconcileCode).toMatch(/status\s*===\s*["']lost["']/);
  });

  test('check #4 compares against refunds PLUS lost disputes, not amount_refunded alone', () => {
    // The old code read `const realRefundAtStripe = refundedAtStripe;` and compared
    // that. Pin the combined figure, and pin that the comparison uses it.
    expect(reconcileCode).toMatch(
      /reversedAtStripe\s*=\s*refundedAtStripe\s*\+\s*disputeLostCents/,
    );
    const check = reconcileCode.slice(
      reconcileCode.indexOf('const wasCaptured'),
      reconcileCode.indexOf('money_captured_on_dead_payment'),
    );
    expect(check).toMatch(/Math\.abs\(reversedAtStripe - ourRefunded\)/);
    // And the raw figure is no longer what the comparison runs on.
    expect(check).not.toMatch(/Math\.abs\(refundedAtStripe - ourRefunded\)/);
    expect(check).not.toMatch(/realRefundAtStripe/);
  });

  test('the finding shows the operator both legs of the figure', () => {
    // "ours 10000, stripe 0" with no explanation is what made the old finding
    // unactionable. The dispute leg has to be visible in the row.
    const block = reconcileCode.slice(
      reconcileCode.indexOf('kind: "refund_mismatch"'),
      reconcileCode.indexOf('money_captured_on_dead_payment'),
    );
    expect(block).toMatch(/stripe_disputed_lost/);
    expect(block).toMatch(/disputes:/);
  });

  test('an unreadable dispute is reported as unmeasured, never as a mismatch', () => {
    // A preflight that shrugs turns "I don't know" into "go ahead"; a reconciler that
    // guesses turns it into a false critical. Neither is acceptable.
    expect(reconcileCode).toMatch(/kind: "dispute_unreadable"/);
    expect(reconcileCode).toMatch(/disputesUnreadable/);
  });

  test('payments.refund_source is NOT used as the chargeback signal', () => {
    // It is an in-flight marker that record_refund clears on every exit path, so by
    // the time a chargeback is ledgered it is null again. Reading it here would look
    // correct and reconcile nothing.
    expect(reconcileCode).not.toMatch(/refund_source/);
  });
});

describe('the writer this depends on has not moved', () => {
  test('record_reversal is still ledger-only — no Stripe call', () => {
    const start = admin.indexOf("if (op === 'record_reversal')");
    expect(start).toBeGreaterThan(-1);
    const end = admin.indexOf('refunded_cents: cents', start);
    expect(end).toBeGreaterThan(start);
    const op = admin.slice(start, end);
    expect(op.length).toBeGreaterThan(200);
    expect(op).toMatch(/record_refund/);
    expect(op).toMatch(/p_debit_earner: false/);
    // If this ever starts calling Stripe, amount_refunded WOULD move and the dispute
    // compensation above would double-count.
    expect(op).not.toMatch(/stripe\.refunds\./);
    expect(op).not.toMatch(/await stripe\./);
  });

  test('the runbook still sends the operator down the ledger-only path', () => {
    expect(runbook).toMatch(/Record chargeback/);
    expect(runbook).toMatch(/ledger-only and makes no Stripe call/);
  });
});
