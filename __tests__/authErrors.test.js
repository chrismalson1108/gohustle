import { betaSignupMessage } from '../src/lib/authErrors';

describe('betaSignupMessage (H1 closed-beta gate UX)', () => {
  test('maps the generic GoTrue trigger failure to beta copy', () => {
    const msg = betaSignupMessage({ message: 'Database error saving new user', status: 500 });
    expect(msg).toMatch(/closed beta/i);
    expect(msg).toMatch(/invited with/i);
  });

  test('maps a leaked allowlist message to beta copy', () => {
    expect(betaSignupMessage({ message: 'signup_not_allowlisted' })).toMatch(/closed beta/i);
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
