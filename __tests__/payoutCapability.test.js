// ─────────────────────────────────────────────────────────────────────────────
// Settling asks STRIPE whether the earner can be paid. It used to ask our cache.
//
// stripe_accounts.onboarded going FALSE is always correct — only stripe-connect-status
// writes that, and only after a live retrieve. The defect is it going STALE at false: the
// account is fixed at Stripe, nothing tells us, and both settle paths refuse.
//
// The two refusals are not symmetric with the one at authorization time.
// stripe-create-payment-intent has always re-verified live before BLOCKING A BOOKING,
// which is recoverable — the poster tries again. Refusing to SETTLE is not: the work is
// done, the hold is live, and if nothing clears the flag the authorization voids at ~7
// days leaving the worker unpaid AND the poster uncharged.
//
// Found by the 2026-08-12 payments audit, reproduced against current code 2026-08-14.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const read = (p) => fs.readFileSync(path.join(FN, p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const helper = read('_shared/payoutCapable.ts');
// The capture path is TWO files since 2026-09-09: a poster's reduction became a
// proposal, so the actual Stripe capture moved to _shared/settleEscrow.ts where
// stripe-capture-payment and settle-disputes both call it. Reading only one of them
// would leave every assertion below passing against a file the money no longer
// flows through. Concatenated, so the guards keep their meaning wherever it lives.
const capture = codeOnly(read('_shared/settleEscrow.ts') + '\n' + read('stripe-capture-payment/index.ts'));
const claim = codeOnly(read('earner-claim-payment/index.ts'));

describe('both settle paths verify payout capability against Stripe', () => {
  // ── WHAT GATES A CAPTURE vs WHAT GATES THE CACHE ──────────────────────────
  //
  // A capture is a DESTINATION charge: the platform is merchant of record and the
  // connected account only has to RECEIVE the transfer — the `transfers` capability.
  // `payouts_enabled` is a different thing (does Stripe move that balance to their bank)
  // and goes false for ordinary temporary reasons. Requiring it refused captures Stripe
  // would have accepted: the work was done, the hold was live, and the gig paid $0 until
  // the authorization lapsed, on an account that would have paid out by itself.
  //
  // The cache keeps the STRICTER bar, because stripe_accounts.onboarded is read at ACCEPT
  // time and promoting a paused account there would let bookings be taken for somebody
  // who cannot be paid out.
  it('settling asks for the transfers capability, not for payouts_enabled', () => {
    const h = codeOnly(helper);
    const capable = h.slice(h.indexOf('const transfersActive'), h.indexOf('fullyOnboarded'));
    expect(capable).toMatch(/capabilities\?\.transfers === 'active'/);
    expect(capable).toMatch(/const capable = !!\(acc\.details_submitted && transfersActive\)/);
    expect(capable).not.toMatch(/payouts_enabled/);
  });

  it('but only a fully onboarded account is promoted in the cache', () => {
    const h = codeOnly(helper);
    const promote = h.slice(h.indexOf('const fullyOnboarded'));
    expect(promote).toMatch(/details_submitted && acc\.charges_enabled && acc\.payouts_enabled/);
    // …and the write is gated on THAT, never on the looser capture test.
    expect(promote).toMatch(/if \(fullyOnboarded\)[\s\S]{0,200}onboarded: true/);
  });

  it('the shared helper exists and asks Stripe', () => {
    expect(codeOnly(helper)).toMatch(/stripe\.accounts\.retrieve/);
    // All three still appear — they are the bar for promoting the CACHE. What changed is
    // that the capture no longer waits on the last one; see the two tests above.
    expect(codeOnly(helper)).toMatch(/details_submitted/);
    expect(codeOnly(helper)).toMatch(/charges_enabled/);
    expect(codeOnly(helper)).toMatch(/payouts_enabled/);
  });

  it('it believes a cached YES and only re-checks a cached NO', () => {
    // A stale TRUE is caught downstream by the capture failing, which is loud and
    // immediate. A stale FALSE is silent, so only that direction is worth a round trip.
    const code = codeOnly(helper);
    expect(code).toMatch(/onboarded[\s\S]{0,80}return \{ capable: true/);
  });

  it('it distinguishes "no" from "could not ask"', () => {
    // Folding an unreachable Stripe into a definite refusal would start the clock on a
    // voided hold over a transient API error.
    expect(codeOnly(helper)).toMatch(/unverifiable: true/);
  });

  it('a FAILED stripe_accounts lookup is "could not ask", not "no account"', () => {
    // The helper used to destructure only `data` from the lookup. A transient PostgREST
    // error then arrived as acct === null, which is indistinguishable from "this earner
    // never connected an account" — so both settle callers took the hard-refusal branch
    // and told a solvent earner their payout account was no longer active.
    const code = codeOnly(helper);
    const read = code.indexOf("from('stripe_accounts')");
    expect(read).toBeGreaterThan(-1);
    const decl = code.slice(0, read);
    // The error member is read at all...
    expect(decl).toMatch(/const \{[^}]*error:\s*(\w+)[^}]*\}\s*=\s*await supabase$/m);
    const errVar = decl.match(/const \{[^}]*error:\s*(\w+)[^}]*\}\s*=\s*await supabase$/m)[1];
    // ...and it short-circuits to unverifiable BEFORE the missing-account refusal.
    const guard = new RegExp(`if \\(${errVar}\\) return \\{[^}]*unverifiable: true`);
    expect(guard.test(code)).toBe(true);
    expect(code.search(guard)).toBeLessThan(code.indexOf('if (!accountId) return { capable: false }'));
  });

  for (const [name, src] of [['stripe-capture-payment', capture], ['earner-claim-payment', claim]]) {
    it(`${name} uses the helper rather than reading the flag directly`, () => {
      expect(`${name}: ${/payoutCapable\(/.test(src)}`).toBe(`${name}: true`);
      // The direct cached read is what this replaces.
      expect(`${name}: ${/select\(['"]onboarded['"]\)/.test(src)}`).toBe(`${name}: false`);
    });

    it(`${name} refuses only on a definite no`, () => {
      expect(src).toMatch(/!cap\.capable && !cap\.unverifiable/);
    });

    it(`${name} logs rather than refusing when Stripe is unreachable`, () => {
      const at = src.indexOf('cap.unverifiable');
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 400)).toMatch(/logServerError/);
    });
  }
});

describe('a booking blocked by payout setup names the state, and reaches the earner', () => {
  const pi = codeOnly(read('stripe-create-payment-intent/index.ts'));
  const push = codeOnly(read('send-push/index.ts'));

  // One sentence — "The earner hasn't set up their payout account yet" — was returned for
  // four different states: never started, started and unfinished, finished but under
  // Stripe review, and Stripe unreachable. It is true of the first only, and the poster
  // acts on it: they decline, or they wait for something that is not going to happen.
  it('distinguishes the four states rather than collapsing them', () => {
    expect(pi).toMatch(/'never_started' \| 'unfinished' \| 'restricted' \| 'unknown'/);
    expect(pi).toMatch(/acc\.details_submitted \? 'restricted' : 'unfinished'/);
    // A failed Stripe call is "we could not ask", never a definite claim about somebody
    // else's account.
    expect(pi).toMatch(/catch \(_\) \{[\s\S]{0,200}payoutReason = 'unknown'/);
    expect(pi).toMatch(/reason: payoutReason/);
  });

  it('tells the EARNER, who is the only person who can fix it', () => {
    const block = pi.slice(pi.indexOf("if (payoutReason !== 'unknown')"));
    expect(block).toMatch(/from\('notifications'\)\.insert/);
    expect(block).toMatch(/user_id: booking\.earner_id/);
    // …and out of the app, not only into an inbox they have to open the app to see.
    expect(block).toMatch(/rpc\('dispatch_notification'/);
  });

  it('the dispatch whitelist admits the type, and reads the right preference category', () => {
    expect(push).toMatch(/DISPATCHABLE = new Set\(\['dispute', 'booking'\]\)/);
    // A dispute is money and a blocked booking is a booking — the recipient's own
    // per-category preferences decide delivery either way.
    expect(push).toMatch(/n\.type === 'dispute'/);
  });
});
