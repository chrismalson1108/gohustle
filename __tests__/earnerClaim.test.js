import { canClaimEarnerPayment, EARNER_CLAIM_GRACE_DAYS } from '../shared/lifecycle';
const fs = require('fs');
const path = require('path');

const NOW = new Date('2026-07-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('H3 earner-claim eligibility (canClaimEarnerPayment)', () => {
  test('grace window is 3 days', () => {
    expect(EARNER_CLAIM_GRACE_DAYS).toBe(3);
  });

  test('eligible: earner done, poster ghosting, past the grace window', () => {
    // confirmed + earnerDone (poster never marked done), scheduled 4 days ago
    expect(canClaimEarnerPayment(
      { status: 'confirmed', earnerDone: true, posterDone: false, startsAt: daysAgo(4) }, NOW,
    )).toBe(true);
    // completed (both done) but poster never verified, scheduled 4 days ago
    expect(canClaimEarnerPayment(
      { status: 'completed', earnerDone: true, startsAt: daysAgo(4) }, NOW,
    )).toBe(true);
  });

  test('not eligible before the grace window elapses', () => {
    expect(canClaimEarnerPayment(
      { status: 'confirmed', earnerDone: true, startsAt: daysAgo(2) }, NOW,
    )).toBe(false);
    // exactly at the boundary (3 days) is eligible; just under is not
    expect(canClaimEarnerPayment({ status: 'completed', earnerDone: true, startsAt: daysAgo(3) }, NOW)).toBe(true);
  });

  test('not eligible without earner_done, or when already finalized', () => {
    expect(canClaimEarnerPayment({ status: 'confirmed', earnerDone: false, startsAt: daysAgo(9) }, NOW)).toBe(false);
    for (const status of ['verified', 'declined', 'cancelled', 'pending']) {
      expect(canClaimEarnerPayment({ status, earnerDone: true, startsAt: daysAgo(9) }, NOW)).toBe(false);
    }
  });

  test('not eligible without a scheduled time, or on bad input', () => {
    expect(canClaimEarnerPayment({ status: 'completed', earnerDone: true, startsAt: null }, NOW)).toBe(false);
    expect(canClaimEarnerPayment(null, NOW)).toBe(false);
    expect(canClaimEarnerPayment(undefined, NOW)).toBe(false);
  });
});

describe('H3 earner-claim server guards stay in the edge function', () => {
  const fn = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'earner-claim-payment', 'index.ts'), 'utf8',
  );

  test('authorizes the earner and requires earner_done', () => {
    expect(fn).toContain("booking.earner_id !== user.id");
    expect(fn).toContain('NOT_MARKED_DONE');
  });

  test('enforces the grace window and skips disputes/reports', () => {
    expect(fn).toContain('GRACE_DAYS = 3');
    expect(fn).toContain('TOO_EARLY');
    expect(fn).toContain('DISPUTE_OPEN');
    expect(fn).toContain('UNDER_REVIEW');
  });

  test('captures and credits exactly once', () => {
    expect(fn).toContain('paymentIntents.capture');
    expect(fn).toContain('credit_earnings');
  });

  test('reconciles to Stripe amount_received so a concurrent partial capture cannot over-credit', () => {
    // Must not blindly write the full split from a stale local status; Stripe is the
    // source of truth for what was actually captured.
    expect(fn).toContain('amount_received');
    expect(fn).toMatch(/retrieve\(payment\.payment_intent_id\)/);
    // Only capture when Stripe still shows the hold uncaptured.
    expect(fn).toContain('capturedOnStripe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The claim gates measure the CURRENT authorization's age, not the first one ever.
//
// payments is UPSERTed on booking_id when a hold is re-placed, so created_at is the first
// hold ever placed on that booking and never moves, while authorized_at is stamped on each
// new one (20260806150000 exists for exactly this distinction, and the controls already
// switched to coalesce(authorized_at, …)).
//
// earner-claim-payment still read created_at in both gates. On a re-held booking that made
// a fresh authorization look days old — which decides whether the claim is allowed at all
// and whether the near-expiry escape hatch opens. The escape hatch exists because Stripe
// auto-cancels an uncaptured hold at ~7 days; anchoring it to a hold Stripe already
// cancelled is the opposite of what it is for.
// ─────────────────────────────────────────────────────────────────────────────
describe('claim gates anchor on the current hold', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', 'supabase', 'functions', 'earner-claim-payment', 'index.ts'),
    'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('selects authorized_at wherever it selects created_at', () => {
    const selects = [...code.matchAll(/\.select\('([^']*created_at[^']*)'\)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    for (const sel of selects) {
      expect(`${sel.slice(0, 60)}…: ${sel.includes('authorized_at')}`)
        .toBe(`${sel.slice(0, 60)}…: true`);
    }
  });

  it('prefers authorized_at over created_at in both gates', () => {
    // The hold-age hint that feeds the near-expiry escape hatch.
    expect(code).toMatch(/holdRow\?\.authorized_at \?\? holdRow\?\.created_at/);
    // And the belt-and-suspenders grace check.
    expect(code).toMatch(/payment\.authorized_at \?\? payment\.created_at/);
  });

  it('no gate reads created_at on its own any more', () => {
    // A bare `new Date(payment.created_at)` is the bug: it dates the first hold ever
    // placed, not the one that is live.
    expect(code).not.toMatch(/new Date\(payment\.created_at\)/);
    expect(code).not.toMatch(/new Date\(holdRow\.created_at\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A claim that captures NOTHING is a money failure, not a retry hint.
//
// The capture call was wrapped in `catch (_capErr) {}` on the assumption that the only
// thing that throws there is a lost race to a concurrent poster capture. It is not: a
// hold Stripe already voided (the canceled webhook never arrived) and a recovery re-hold
// written 'authorized' at PI creation and never confirmed both throw the same way. The
// error was dropped, the re-retrieve read amount_received = 0, and the function answered
// 502 'Could not release the payment. Please try again.' with NO logServerError — so the
// earner retried daily into the same silence and /errors never showed a worker unpaid on
// work they had done. The sibling stripe-capture-payment lets that same failure reach
// its terminal catch, which logs it fatal.
// ─────────────────────────────────────────────────────────────────────────────
describe('a claim that captures nothing is logged and named', () => {
  const fs3 = require('fs');
  const path3 = require('path');
  const src = fs3.readFileSync(
    path3.join(__dirname, '..', 'supabase', 'functions', 'earner-claim-payment', 'index.ts'),
    'utf8',
  );
  // Comments name the statuses and the codes; assert on the code itself.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The `if (…) { … }` block whose head is `head`, brace-matched. */
  const blockAt = (head) => {
    const start = code.indexOf(head);
    expect(`${head} present: ${start > -1}`).toBe(`${head} present: true`);
    let depth = 0;
    for (let i = code.indexOf('{', start); i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) return code.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated block at ${head}`);
  };

  it('keeps the capture error instead of discarding it', () => {
    const captureBlock = blockAt('if (!capturedOnStripe) {');
    const caught = /catch \((\w+)\)/.exec(captureBlock);
    expect(caught).not.toBeNull();
    // `catch (_capErr)` is the bug in one character: the underscore declares the error
    // deliberately unused, and unused is what made every non-race failure invisible.
    expect(`${caught[1]} discarded: ${caught[1].startsWith('_')}`)
      .toBe(`${caught[1]} discarded: false`);
    // …and it must actually be READ somewhere else, not merely bound.
    const uses = code.split(caught[1]).length - 1;
    expect(`${caught[1]} is read outside its own catch: ${uses > 1}`)
      .toBe(`${caught[1]} is read outside its own catch: true`);
  });

  it('logs to /errors before answering the earner', () => {
    const zero = blockAt('if (capturedCents <= 0) {');
    expect(zero).toContain('logServerError');
    // The ids an operator needs at 2am, plus Stripe's own verdict on the intent.
    for (const key of ['booking_id', 'payment_id', 'payment_intent_id', 'pi_status', 'stripe_code']) {
      expect(`${key} logged: ${zero.includes(key)}`).toBe(`${key} logged: true`);
    }
    // Terminal at Stripe is a FATAL money event — that capture can never succeed, so
    // the hold has to be re-placed by a human. A transient failure is logged, not paged.
    expect(zero).toMatch(/fatal:/);
    expect(zero).toMatch(/'canceled'/);
    expect(zero).toMatch(/'requires_payment_method'/);
  });

  it('names the failure instead of telling the earner to retry forever', () => {
    const zero = blockAt('if (capturedCents <= 0) {');
    // A voided hold and a hold that was never confirmed have different remedies and
    // already have different codes in this codebase (stripe-capture-payment,
    // accept-booking). Reuse them rather than one opaque CAPTURE_FAILED.
    expect(zero).toContain('HOLD_EXPIRED');
    expect(zero).toContain('HOLD_NOT_AUTHORIZED');
    // The old copy instructed the earner to do the one thing that cannot work.
    expect(zero).not.toMatch(/Please try again/);
  });
});
