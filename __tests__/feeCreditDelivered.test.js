// ─────────────────────────────────────────────────────────────────────────────
// The value an applied fee credit DELIVERED has one definition, and both money paths
// ask for it.
//
// 20260814130000 taught record_refund to hand a fee credit back in proportion to what a
// refund destroyed, and derived the delivered figure with its own expression:
//
//   platform_fee_cents(amount_cents + poster_discount_cents, safe_fee_bps(fee_bps))
//     - fee_cents
//
// stripe-capture-payment had already computed the same quantity, correctly, a few lines
// after a partial capture. The two disagreed on both shapes the capture path can produce:
//
//   * a POSTER DISCOUNT — fee_cents is written net of it (index.ts:252), the left-hand
//     term is not, so the refund path's figure is exactly poster_discount_cents too high;
//   * a PARTIAL CAPTURE — fee_cents is scaled to what settled while amount_cents stays
//     the full authorization, so the left-hand term prices the whole gig against a fee
//     for part of it.
//
// return_unused_fee_credit returns `applied - delivered` and gives back nothing when that
// is negative, so an inflated figure does not over-return: it silently under-returns, and
// on those shapes usually returns zero. The earner quietly loses a vested referral credit.
//
// The old probe only staged a full, undiscounted capture, which is the one case where the
// two expressions agree — so nothing failed. This guards the shape of the fix rather than
// one arithmetic case: ONE definition (public.fee_credit_delivered_cents), called by both,
// with a probe that stages the two shapes that used to be invisible.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const migrationFiles = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

function latestDefining(fnName) {
  const files = migrationFiles.filter((f) =>
    new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
      fs.readFileSync(path.join(MIG, f), 'utf8'),
    ),
  );
  if (!files.length) throw new Error(`no migration defines public.${fnName}`);
  return {
    file: files[files.length - 1],
    body: fs.readFileSync(path.join(MIG, files[files.length - 1]), 'utf8'),
  };
}

// The capture path is TWO files since 2026-09-09: a poster's reduction became a
// proposal, so the actual Stripe capture moved to _shared/settleEscrow.ts where
// stripe-capture-payment and settle-disputes both call it. Reading only one of them
// would leave every assertion below passing against a file the money no longer
// flows through. Concatenated, so the guards keep their meaning wherever it lives.
const capture = read('supabase', 'functions', '_shared', 'settleEscrow.ts')
  + '\n' + read('supabase', 'functions', 'stripe-capture-payment', 'index.ts');

describe('the delivered value of a fee credit has one definition', () => {
  it('a migration defines public.fee_credit_delivered_cents', () => {
    const { body } = latestDefining('fee_credit_delivered_cents');
    expect(body).toMatch(/create or replace function public\.fee_credit_delivered_cents\(p_payment_id uuid\)/i);
    // service_role only: both callers are service-role paths, and it reads a payment row.
    expect(body).toMatch(/grant execute on function public\.fee_credit_delivered_cents\(uuid\) to service_role/i);
    expect(body).toMatch(
      /revoke execute on function public\.fee_credit_delivered_cents\(uuid\) from public, anon, authenticated/i,
    );
  });

  it('nets the poster discount off the no-credit fee, not just off fee_cents', () => {
    const { body } = latestDefining('fee_credit_delivered_cents');
    const fn = body.slice(
      body.indexOf('create or replace function public.fee_credit_delivered_cents'),
      body.indexOf('comment on function public.fee_credit_delivered_cents'),
    );
    // The discount is funded out of the platform's share, so it comes off BOTH sides.
    expect(fn.replace(/\s+/g, ' ')).toMatch(
      /v_no_credit_full := greatest\(0, public\.platform_fee_cents\(v_gig, v_bps\) - v_disc\)/i,
    );
  });

  it('scales to what was CAPTURED and re-floors there, because 30c+25c does not scale', () => {
    const { body } = latestDefining('fee_credit_delivered_cents');
    const fn = body
      .slice(body.indexOf('create or replace function public.fee_credit_delivered_cents'))
      .replace(/\s+/g, ' ');
    // captured = earner_amount_cents + fee_cents; amount_cents stays the authorization.
    expect(fn).toMatch(/v_captured := coalesce\(p\.earner_amount_cents, 0\) \+ coalesce\(p\.fee_cents, 0\)/i);
    expect(fn).toMatch(/v_captured::numeric \/ p\.amount_cents::numeric/i);
    expect(fn).toMatch(/public\.platform_fee_cents\(v_captured, 0\)/i);
  });

  it('record_refund asks for the figure instead of re-deriving it', () => {
    const { body } = latestDefining('record_refund');
    const start = body.indexOf('create or replace function public.record_refund');
    // Stop at the function terminator: the probe below deliberately evaluates the OLD
    // expression, and reading past $function$ would find it there.
    const fn = body
      .slice(start, body.indexOf('$function$;', start))
      .replace(/\s+/g, ' ');
    expect(fn).toMatch(/v_credit := public\.fee_credit_delivered_cents\(p_payment_id\)/i);
    // THE REGRESSION: the inline expression, which is what got the two shapes wrong.
    expect(fn).not.toMatch(
      /platform_fee_cents\( coalesce\(amount_cents, 0\) \+ coalesce\(poster_discount_cents, 0\)/i,
    );
    // Still proportional to the surviving share of the capture.
    expect(fn).toMatch(/1 - v_new::numeric \/ v_captured/);
  });

  it('stripe-capture-payment asks for the same figure instead of keeping a second copy', () => {
    // The identifier is deliberately loose: the call moved inside returnUnusedFeeCredit,
    // which two branches reach (the partial capture, and the recovery path that re-runs
    // the bookkeeping after a capture died mid-sequence). Pinning it to `payment.id`
    // would fail that extraction while the property this guards — one definition of the
    // delivered figure, shared with record_refund — is exactly what the extraction keeps.
    expect(capture).toMatch(/rpc\('fee_credit_delivered_cents', \{\s*p_payment_id: [\w.]+,?\s*\}\)/);
    // ONE call site for it, reached by both branches, rather than a second copy per branch.
    expect(capture.match(/rpc\('fee_credit_delivered_cents'/g)).toHaveLength(1);
    expect(capture.match(/await returnUnusedFeeCredit\(/g).length).toBeGreaterThanOrEqual(2);
    // The inline copy is gone — that copy is what the refund path drifted from.
    expect(capture).not.toMatch(/noCreditAtCapture/);
    expect(capture).not.toMatch(/const noCreditFull/);
    // and it still feeds return_unused_fee_credit, which is idempotent on this number.
    expect(capture).toMatch(/rpc\('return_unused_fee_credit'/);
  });

  it('the probe stages the two shapes the old one could not see', () => {
    const { body } = latestDefining('fee_credit_delivered_cents');
    const probe = body.slice(body.lastIndexOf('do $$'));
    // A partial capture: captured (9655 + 345) is less than the 20000c authorization.
    expect(probe).toMatch(/20000, 345, 9655/);
    // A poster discount, on a payment whose fee_cents is already net of it.
    expect(probe).toMatch(/poster_discount_cents = 305/);
    // And the case the old probe DID cover, asserted unchanged.
    expect(probe).toMatch(/full undiscounted capture/i);
    // It must actually compare against the OLD expression, or it proves nothing.
    expect(probe.replace(/\s+/g, ' ')).toMatch(/delivered_old/);
  });
});
