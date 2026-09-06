// ─────────────────────────────────────────────────────────────────────────────
// A partial capture's BOOKKEEPING must survive the function dying after the money
// moved.
//
// stripe-capture-payment does the irreversible thing first and the paperwork after:
// the Stripe capture, then the payments update, then two fee RPCs, then
// return_unused_fee_credit, then credit_earnings, then settle_booking_benefits, then
// the disputes insert. Up to eight awaited round trips sit downstream of the money.
//
// Lose the instance anywhere in that window — an SDK read timeout on the capture
// response, an edge deploy, an eviction — and the capture landed while none of the
// paperwork did. payment_intent.succeeded then marks the row 'captured' and credits
// the earner, and it writes no disputes row, calls no settle_booking_benefits and
// returns no fee credit.
//
// The poster's retry used to make it worse rather than better: everything downstream
// was gated on `capturedGigCents`, which is assigned ONLY inside the
// `payment.status !== 'captured'` block. On the retry that block is skipped, so the
// flag stayed null, the function returned success, and the reduced payout ended up
// with no dispute record anywhere — the /disputes queue, ctl_dispute_open_beyond_sla
// and earner-claim-payment's DISPUTE_OPEN gate all read that table — while the
// earner's unused referral credit was destroyed silently (nothing looks in that
// direction: ctl_credit_stranded_on_dead_booking only checks a credit still 'applied'
// on a declined/cancelled booking).
//
// The fix must NOT be "trust the caller's pct". That gate was added deliberately,
// because a poster POSTing {pct: 0.5, disputeReason: '…'} at their OWN fully-settled
// booking would otherwise fabricate a "50% paid" dispute — which freezes a third
// party's referral bonus (vest_bonuses blocks on any open dispute) and files a false
// entry in the only server-authored dispute log. So the retry has to re-derive the
// FACT from the ledger: earner_amount_cents + fee_cents against the immutable
// amount_cents.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'stripe-capture-payment', 'index.ts'),
  'utf8',
);

// Pull a `const <name> = <expr>;` out of the source so the assertions below run the
// function's OWN arithmetic rather than a copy of it that can drift.
function constExpr(name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(SRC);
  if (!m) throw new Error(`stripe-capture-payment no longer defines ${name}`);
  return m[1];
}

// Evaluate the recovery derivation against a staged payments row.
function deriveFromLedger(payment) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'payment',
    `const settledTotal = ${constExpr('settledTotal')};
     const authorizedTotal = ${constExpr('authorizedTotal')};
     if (!(settledTotal > 0 && authorizedTotal > 0)) return null;
     const observedPct = ${constExpr('observedPct')};
     return { settledTotal, authorizedTotal, observedPct };`,
  );
  return fn(payment);
}

describe('the retry after a mid-flight death re-derives what was settled', () => {
  test('the recovery branch exists and keys on an already-captured row', () => {
    // The whole finding in one assertion: something must run when the capture block
    // did NOT. Before the fix, `payment.status === 'captured'` reached only the
    // skip-the-block test and nothing downstream.
    expect(SRC).toMatch(
      /if \(capturedGigCents === null && payment\.status === 'captured'\) \{/,
    );
  });

  test('it reads the ledger, not the caller', () => {
    // The immutable authorization vs. what was actually collected.
    expect(constExpr('settledTotal')).toBe(
      '(payment.earner_amount_cents ?? 0) + (payment.fee_cents ?? 0)',
    );
    expect(constExpr('authorizedTotal')).toBe('payment.amount_cents || 0');
    // `pct` from the request body must not appear in the derivation.
    expect(constExpr('observedPct')).not.toMatch(/capturePct|pct\b/);
  });

  test('a half-settled row is recognised as a partial capture', () => {
    // $100 authorized, 50% captured at 700 bps: 5000c collected, 350c fee, 4650c net.
    const d = deriveFromLedger({ amount_cents: 10000, fee_cents: 350, earner_amount_cents: 4650 });
    expect(d.settledTotal).toBe(5000);
    expect(d.observedPct).toBeCloseTo(0.5, 6);
  });

  test('a fully-settled row is NOT — this is the anti-fabrication property', () => {
    // The poster who re-posts {pct: 0.5} at a booking that was captured in full must
    // still record nothing. The ledger says the whole amount was taken.
    const d = deriveFromLedger({ amount_cents: 10000, fee_cents: 700, earner_amount_cents: 9300 });
    expect(d.observedPct).toBe(1);
  });

  test('the ratio is clamped — a ledger claiming more than was authorized cannot exceed 1', () => {
    const d = deriveFromLedger({ amount_cents: 10000, fee_cents: 700, earner_amount_cents: 9999 });
    expect(d.observedPct).toBe(1);
  });
});

describe('the dispute record is authorised by the ledger, not by the request', () => {
  test('the gate requires BOTH the caller asking and the money having moved that way', () => {
    // capturePctFinal alone would let a poster fabricate one; settledPct alone would
    // file a dispute for an external partial capture nobody reported. Both.
    expect(SRC).toMatch(
      /if \(capturedGigCents !== null && capturePctFinal < 1 && settledPct < 1\) \{/,
    );
  });

  test('pct_paid is written from what was settled, never from the request', () => {
    expect(SRC).toMatch(/pct_paid: Math\.round\(settledPct \* 100\)/);
    expect(SRC).not.toMatch(/pct_paid: Math\.round\(capturePctFinal \* 100\)/);
  });

  test('settledPct defaults to a full settlement and is only narrowed by evidence', () => {
    expect(SRC).toMatch(/let settledPct = 1;/);
    // Exactly two places may narrow it: the partial capture branch, and the recovery
    // derivation. Anything else is the caller's pct leaking back in.
    const assignments = SRC.match(/^\s*settledPct = .+;$/gm) ?? [];
    expect(assignments).toHaveLength(2);
    expect(assignments.map((a) => a.trim())).toEqual([
      'settledPct = capturePct;',
      'settledPct = observedPct;',
    ]);
  });
});

describe('the unused fee credit is returnable more than once', () => {
  test('it is a named helper, not inline in the partial branch', () => {
    // Inline, it was reachable exactly once — on the first attempt and never again.
    expect(SRC).toMatch(/async function returnUnusedFeeCredit\(/);
  });

  test('it has two call sites: the capture branch and the recovery branch', () => {
    const calls = SRC.match(/await returnUnusedFeeCredit\(supabase, \{/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  test('the RPC itself is called from exactly one place, so the two agree', () => {
    // The delivered figure is what makes return_unused_fee_credit idempotent. Two
    // copies of that arithmetic is how a retry hands back a second slice.
    const rpcCalls = SRC.match(/rpc\('return_unused_fee_credit'/g) ?? [];
    expect(rpcCalls).toHaveLength(1);
  });

  test('the recovery path only returns credit when the settlement was short', () => {
    expect(SRC).toMatch(/if \(creditCents > 0 && settledTotal < authorizedTotal\) \{/);
  });
});

describe('the promo budget is settled on the recovery path too', () => {
  test('capturedGigCents is what gates settle_booking_benefits, and recovery assigns it', () => {
    expect(SRC).toMatch(/if \(capturedGigCents !== null\) \{\n\s*const \{ error: settleErr \} = await supabase\.rpc\('settle_booking_benefits'/);
    // Assigned in three places now: the full default, the partial narrowing, and the
    // recovery re-derivation.
    const assignments = SRC.match(/^\s*capturedGigCents = .+;$/gm) ?? [];
    expect(assignments).toHaveLength(3);
  });

  test('the recovery path scales the poster discount the same way the partial branch does', () => {
    // One gig figure charged to the campaign, however it is reached.
    expect(SRC).toMatch(/capturedGigCents = captureCents \+ Math\.round\(discountCents \* capturePct\);/);
    expect(SRC).toMatch(/capturedGigCents = settledTotal \+ Math\.round\(discountCents \* observedPct\);/);
  });
});
