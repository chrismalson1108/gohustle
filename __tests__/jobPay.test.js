import { MIN_JOB_PAY, MAX_JOB_PAY, validateJobPay } from '../shared/constants.js';

// The pay floor is enforced in four places (PostJob, EditJob, counter-offer, and
// server-side in stripe-create-payment-intent). All four route through this one
// validator so mobile and web can never drift into telling users different rules —
// these tests pin the contract they all depend on.
describe('validateJobPay', () => {
  test('accepts values at or above the floor', () => {
    expect(validateJobPay(MIN_JOB_PAY)).toBeNull();
    expect(validateJobPay(String(MIN_JOB_PAY))).toBeNull();
    expect(validateJobPay('25.50')).toBeNull();
    expect(validateJobPay(MAX_JOB_PAY)).toBeNull();
  });

  test('rejects anything below the floor, including the old "> 0" cases', () => {
    // These all passed the previous `pay > 0` rule and must now fail.
    expect(validateJobPay(9.99)).toMatch(/at least \$10/);
    expect(validateJobPay('5')).toMatch(/at least \$10/);
    expect(validateJobPay('0.01')).toMatch(/at least \$10/);
  });

  test('rejects zero and negatives', () => {
    expect(validateJobPay(0)).not.toBeNull();
    expect(validateJobPay('-5')).not.toBeNull();
  });

  test('rejects values above the ceiling', () => {
    expect(validateJobPay(MAX_JOB_PAY + 0.01)).toMatch(/more than/);
    expect(validateJobPay('99999')).toMatch(/more than/);
  });

  test('rejects junk that parseFloat would otherwise turn into null on insert', () => {
    expect(validateJobPay('')).not.toBeNull();
    expect(validateJobPay('.')).not.toBeNull();
    expect(validateJobPay('abc')).not.toBeNull();
    expect(validateJobPay(undefined)).not.toBeNull();
    expect(validateJobPay(null)).not.toBeNull();
    expect(validateJobPay(NaN)).not.toBeNull();
    expect(validateJobPay(Infinity)).not.toBeNull();
  });

  test('the floor is $10 and applies to the RATE, so a 1-hour hourly gig also clears it', () => {
    expect(MIN_JOB_PAY).toBe(10);
    // An hourly gig is stored as a rate; 1 hour at the floor is still the floor.
    expect(validateJobPay(MIN_JOB_PAY)).toBeNull();
    expect(validateJobPay(MIN_JOB_PAY - 0.01)).not.toBeNull();
  });
});
