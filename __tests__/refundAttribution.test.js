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

  // ───────────────────────────────────────────────────────────────────────────
  // Recording it is only half the contract. The recorded figure has to be APPLIED.
  //
  // record_refund writes earner_refunded_cents unconditionally and then calls
  // debit_earnings, discarding the boolean — and debit_earnings refuses outright on a
  // payment whose earnings_credited is false, which is the whole state
  // ctl_earner_credit_missing exists for. So a refund landing before the credit recorded
  // a clawback nothing took, and credit_earnings then credited earner_amount_cents in
  // FULL. On a $60 capture refunded by half the earner's dashboard read $55.80 for a
  // position of $27.90, forever, and ctl_earnings_total_drift opened a HIGH that nothing
  // could auto-resolve. Fixed by 20260906040000: the credit withholds what was already
  // clawed back.
  // ───────────────────────────────────────────────────────────────────────────
  it('credit_earnings honours a clawback recorded before the credit landed', () => {
    const sql = latestDefining('credit_earnings').replace(/\s+/g, ' ');
    // Read under the SAME claim UPDATE, so a refund cannot commit between the two reads.
    expect(sql).toMatch(
      /returning coalesce\(earner_amount_cents, 0\), coalesce\(earner_refunded_cents, 0\) into v_amount, v_clawed/,
    );
    // And credit the difference, floored — a negative credit would be a silent debit
    // against unrelated earnings.
    expect(sql).toMatch(/v_net := greatest\(0, v_amount - coalesce\(v_clawed, 0\)\)/);
    expect(sql).toMatch(/v_dollars := v_net::numeric \/ 100/);
    // The gross form is the line that shipped wrong. If it comes back, so does the bug.
    expect(sql).not.toMatch(/v_dollars := v_amount::numeric \/ 100/);
  });

  it('the claim itself is untouched, so capture and webhook still credit once', () => {
    // Netting must not have loosened the conditional flip that makes this exactly-once.
    const sql = latestDefining('credit_earnings').replace(/\s+/g, ' ');
    expect(sql).toMatch(
      /set earnings_credited = true where id = p_payment_id and coalesce\(earnings_credited, false\) = false and status = 'captured' and coalesce\(earner_amount_cents, 0\) > 0/,
    );
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

  // ───────────────────────────────────────────────────────────────────────────
  // …and it does not aim that remedy at a reversed TIP.
  //
  // stripe-webhook's tip fallback used to fall through and file a disputes row carrying
  // the TIP's charge id, in this control's exact template, on the GIG's booking. The
  // control then reported the gig's captured, never-refunded payment as unledgered and
  // printed "Record chargeback" — which writes refunded_cents onto a charge nobody
  // refunded, misstating the poster's receipt and making vest_bonuses void any referral
  // bonus sourced from that booking. The writer is fixed; rows written before that are
  // indistinguishable by shape (the reason carries a charge/dispute id, payments stores
  // the PaymentIntent id), so the control still REPORTS them — a suppressed reversal is
  // the worse failure — and changes only what it tells the operator to do.
  // ───────────────────────────────────────────────────────────────────────────
  it('names the reversed-tip case and withholds the destructive instruction there', () => {
    const sql = latestDefining('ctl_external_reversal_not_ledgered');
    expect(sql).toMatch(/tip_ledger/);
    expect(sql).toMatch(/LIKELY A REVERSED TIP/);
    const tipArm = sql.slice(sql.indexOf('LIKELY A REVERSED TIP'));
    const arm = tipArm.slice(0, tipArm.indexOf('end'));
    expect(arm).toMatch(/Do NOT press Record chargeback/);
    // The imperative itself must be absent from this arm, not merely caveated.
    expect(arm).not.toMatch(/Use admin console -> booking -> Record chargeback/);
  });

  it('the tip hint changes the wording only — never which rows are returned', () => {
    // A heuristic that SUPPRESSED would trade a false positive for a false negative on a
    // money control. tip_ledger may appear in the projection and in a hint CTE, and must
    // not appear in the WHERE that selects findings.
    const sql = latestDefining('ctl_external_reversal_not_ledgered');
    const from = sql.lastIndexOf('where p.status');
    expect(from).toBeGreaterThan(-1);
    // Bounded by the end of the function body — the probe below it stages tip rows on
    // purpose and is not part of the predicate.
    const where = sql.slice(from, sql.indexOf('$function$', from));
    expect(where).not.toMatch(/tip/i);
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
    // No amount_to_capture: a reduced settlement is a dispute outcome and belongs to
    // the poster's Verify sheet, which records who asked for it. The options object is
    // permitted — it carries `expand: ['latest_charge']`, which is how this op learns
    // the fee Stripe actually applied instead of trusting the mutable fee_cents column
    // (see settleFeeFromStripe.test.js).
    const call = /paymentIntents\.capture\(pay\.payment_intent_id[\s\S]*?\);/.exec(branch);
    expect(call).not.toBeNull();
    expect(call[0]).not.toMatch(/amount_to_capture/);
    expect(branch).toMatch(/amount_received/);
    // And it must credit the earner — capturing without crediting is the worse bug.
    expect(branch.slice(0, 4000)).toMatch(/credit_earnings/);
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

// ─────────────────────────────────────────────────────────────────────────────
// A chargeback finding must carry its figure.
//
// ctl_external_reversal_not_ledgered pulls the reversed amount out of the dispute row's
// machine template, and there are TWO templates:
//
//   refund      Stripe refund on charge ch_… (usd 40.00 refunded)
//   chargeback  Stripe chargeback du_… (fraudulent, usd 100.00)
//
// The extraction anchored on ' refunded)', so it only ever matched the first. Every
// CHARGEBACK finding therefore carried reversal_cents null and unledgered_cents null —
// a critical money finding that did not say how much money. Verified against a REAL
// Stripe chargeback on 2026-09-08: du_… for usd 100.00 reported NULL, and the amount was
// in the reason string the whole time.
//
// The control still FIRED (the WHERE has an arm for a null reversal against a zero
// refunded_cents), so nothing was ever missed. This is about the operator being told.
// ─────────────────────────────────────────────────────────────────────────────
describe('the external-reversal control reads both templates', () => {
  const fs = require('fs');
  const path = require('path');
  const MIG = path.join(__dirname, '..', 'supabase/migrations');
  const body = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8'))
    .filter((s) => /create or replace function public\.ctl_external_reversal_not_ledgered/i.test(s))
    .pop();

  it('the control is resolvable', () => expect(body).toBeTruthy());

  it('extracts the amount from the refund template', () => {
    expect(body).toMatch(/refunded\\\)'/);
  });

  it('falls back to the chargeback template rather than reporting NULL', () => {
    // 'Stripe chargeback du_… (fraudulent, usd 100.00)' — the figure is last, after 'usd'.
    expect(body).toMatch(/usd \(\[0-9\]\+\\\.\[0-9\]\{2\}\)\\\)\$/);
    expect(body).toMatch(/coalesce\(\s*\n?\s*substring\(dd\.reason/);
  });

  it('both anchored template patterns are still what admit a row', () => {
    // The anchors are the only thing separating stripe-webhook's template from a poster's
    // typed note, which lands in the same column verbatim.
    expect(body).toMatch(/\^Stripe refund on charge \(ch\|py\)_/);
    expect(body).toMatch(/\^Stripe chargeback \(dp\|du\)_/);
  });
});
