import { betaSignupMessage } from '../src/lib/authErrors';

describe('betaSignupMessage (open-beta signup UX)', () => {
  test('maps a generic GoTrue 500 to neutral retry copy, NOT invite-only copy', () => {
    const msg = betaSignupMessage({ message: 'Database error saving new user', status: 500 });
    expect(msg).toMatch(/try again/i);
    expect(msg).not.toMatch(/invite|invited with/i);
  });

  test('maps an explicit allowlist-rejection message to invite-only copy', () => {
    expect(betaSignupMessage({ message: 'signup_not_allowlisted' })).toMatch(/invite-only/i);
  });

  test('passes through unrelated auth errors unchanged', () => {
    const msg = betaSignupMessage({ message: 'Password should be at least 6 characters.', status: 422 });
    expect(msg).toBe('Password should be at least 6 characters.');
  });

  test('handles missing/empty error input', () => {
    expect(betaSignupMessage(null)).toMatch(/failed/i);
    expect(betaSignupMessage(undefined)).toMatch(/failed/i);
  });
});
