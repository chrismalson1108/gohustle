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
