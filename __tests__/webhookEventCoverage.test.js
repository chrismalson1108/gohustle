// ─────────────────────────────────────────────────────────────────────────────
// Every event stripe-webhook handles must be an event Stripe is told to send.
//
// The failure this exists for shipped on 2026-08-12 and was found by hand a day later:
// stripe-webhook gained five correct `payout.*` cases, `stripe_payouts` was created,
// PaymentsScreen grew a Bank deposits section — and the Connect endpoint was subscribed
// to `account.updated` only. The feature was live, correct, and receiving nothing. It
// could not error, because nothing was being delivered to fail. An empty Bank deposits
// section reads to an earner as "no deposits yet", not as "we are not listening".
//
// reconcile-stripe now asserts the subscription against Stripe on every sweep, using two
// constant lists. Constants drift. So this closes the loop from the other side:
//
//   handler `case` labels  ⟷  reconcile-stripe's REQUIRED_* lists  ⟷  Stripe (the control)
//
// Add a case without adding it to the list and this fails. Put an event in the list that
// nothing handles and this fails too — a control demanding a subscription for an event
// nobody reads is the same lie in the other direction.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const handler = fs.readFileSync(path.join(FN, 'stripe-webhook', 'index.ts'), 'utf8');
const control = fs.readFileSync(path.join(FN, 'reconcile-stripe', 'index.ts'), 'utf8');

const handled = [...handler.matchAll(/case '([a-z_]+\.[a-z_.]+)':/g)].map((m) => m[1]);

function listFrom(name) {
  const block = control.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!block) return null;
  return [...block[1].matchAll(/"([a-z_]+\.[a-z_.]+)"/g)].map((m) => m[1]);
}
const required = {
  account: listFrom('REQUIRED_ACCOUNT_EVENTS'),
  connect: listFrom('REQUIRED_CONNECT_EVENTS'),
};

describe('webhook event coverage', () => {
  it('parsed both sides', () => {
    expect(handled.length).toBeGreaterThan(5);
    expect(required.account).not.toBeNull();
    expect(required.connect).not.toBeNull();
  });

  it('every handled event is one the control requires a subscription for', () => {
    const all = new Set([...(required.account ?? []), ...(required.connect ?? [])]);
    const unwatched = [...new Set(handled)].filter((e) => !all.has(e));
    // Name them: "coverage drifted" is useless, the event name is actionable.
    expect(unwatched).toEqual([]);
  });

  it('the control requires no event that nothing handles', () => {
    const h = new Set(handled);
    const phantom = [...(required.account ?? []), ...(required.connect ?? [])].filter((e) => !h.has(e));
    expect(phantom).toEqual([]);
  });

  it('routes connected-account events to the CONNECT destination', () => {
    // account.updated and payout.* only arrive on the connected-account destination.
    // Listing them under the account destination would make the control assert the
    // wrong endpoint and pass while the real one is empty — the original bug, re-armed.
    const connectOnly = handled.filter((e) => e.startsWith('payout.') || e === 'account.updated');
    const misfiled = connectOnly.filter((e) => (required.account ?? []).includes(e));
    expect(misfiled).toEqual([]);
    for (const e of connectOnly) expect(required.connect).toContain(e);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one handler that moves money must be as careful as the two that don't.
//
// payment_intent.succeeded marked the row captured with NO status predicate and credited
// straight off earner_amount_cents, never reading pi.amount_received — while its two
// siblings (payment_failed, canceled) both carried status predicates AND comments
// explaining exactly why a stale redelivery must not overwrite a settled row.
//
// The full split is written at AUTHORIZATION, so every row carries a full-value split
// from the moment the hold is placed. Capture that PaymentIntent for less anywhere but
// our own capture function — the Stripe Dashboard being the obvious way — and the earner
// was credited the full figure regardless of what Stripe collected, then earnings_credited
// latched so it could not be re-run.
//
// RUNBOOK_MONEY.md had been instructing operators around it ("do not capture from the
// Stripe Dashboard… fix that first") rather than the code refusing to get it wrong.
// ─────────────────────────────────────────────────────────────────────────────
describe('payment_intent.succeeded settles against what Stripe actually collected', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
  // The handler body: from its case label to the next case label.
  const body = src.slice(
    src.indexOf("case 'payment_intent.succeeded':"),
    src.indexOf("case 'payment_intent.payment_failed':"),
  );

  it('found the handler', () => {
    expect(body.length).toBeGreaterThan(200);
  });

  it('reads amount_received rather than trusting the stored split', () => {
    expect(body).toMatch(/amount_received/);
  });

  it('guards the status transition, like its siblings do', () => {
    // A stale or redelivered succeeded must not resurrect a cancelled or failed row.
    expect(body).toMatch(/\.in\(\s*['"]status['"],\s*\[[^\]]*['"]authorized['"]/);
  });

  it('never rewrites a split that has already been paid out on', () => {
    expect(body).toMatch(/earnings_credited['"]?\s*,\s*false|eq\(['"]earnings_credited['"],\s*false\)/);
  });

  it('still credits the earner exactly once', () => {
    expect(body).toMatch(/credit_earnings/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One admin refund must not silence every future chargeback on that payment.
//
// `refund_source` is written once (admin-payment-action) and NEVER cleared — nothing in
// supabase/, admin/, src/, or any pg_proc resets it. recordReversal tested it and
// early-returned, and that function is shared by charge.refunded AND
// charge.dispute.created. So after a single admin refund, every later CHARGEBACK on that
// payment filed no `disputes` row, permanently.
//
// What went dark with it: the /disputes console page reads only that table, so no human
// saw it; ctl_external_reversal_not_ledgered INNER JOINs it; dispute_open_beyond_sla
// counts its rows; and earner-claim-payment's DISPUTE_OPEN gate would settle a booking
// with a live chargeback against it.
//
// The exemption is legitimate for REFUNDS — an admin refund is a remediation, and filing
// a dispute for it re-blocked the very booking being fixed. It is incoherent for a
// chargeback, which only a cardholder can cause.
// ─────────────────────────────────────────────────────────────────────────────
describe('the admin-refund exemption cannot silence a chargeback', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = strip(src.slice(src.indexOf('async function recordReversal'), src.indexOf('Deno.serve(')));

  it('found recordReversal', () => {
    expect(fn.length).toBeGreaterThan(200);
  });

  it('gates the refund_source exemption on the event being a REFUND', () => {
    const line = fn.split('\n').find((l) => l.includes('refund_source') && l.includes("'admin'"));
    expect(line).toBeDefined();
    // The PROPERTY, not one spelling of it: every read of refund_source must sit
    // inside a refund-only scope. Written as `kind === 'refund' && …` originally and
    // as an `if (kind === 'refund') { … }` block since 20260814010000 added the second
    // (self-clearing) test alongside it — both satisfy this, a bare exemption does not.
    // The exemption itself, not the SELECT that fetches the column.
    const at = fn.indexOf("refund_source === 'admin'");
    expect(at).toBeGreaterThan(-1);
    expect(fn.slice(0, at)).toMatch(/kind === ['"]refund['"][\s\S]{0,600}$/);
  });

  it('never exempts a chargeback from being recorded', () => {
    // The inverse, stated directly: a cardholder dispute has no admin-remediation
    // reading, so nothing may return early for one before the disputes insert.
    const insertAt = fn.indexOf(".from('disputes').insert");
    expect(insertAt).toBeGreaterThan(-1);
    const beforeInsert = fn.slice(0, insertAt);
    expect(beforeInsert).not.toMatch(/kind === ['"]chargeback['"][\s\S]{0,200}return/);
  });

  it('both call sites declare which kind of reversal they are', () => {
    const body = strip(src);
    // Match the argument list rather than the kind's position in it — the refund call
    // gained a trailing amount_refunded argument, and asserting "kind is last" made a
    // correct change look like a regression.
    const calls = [...body.matchAll(/await recordReversal\(\s*([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBe(2);
    expect(calls.filter((a) => /'chargeback'/.test(a)).length).toBe(1);
    expect(calls.filter((a) => /'refund'/.test(a)).length).toBe(1);
  });
});
