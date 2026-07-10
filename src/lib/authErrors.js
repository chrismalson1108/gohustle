// Maps Supabase auth errors to user-facing copy.
//
// The closed-beta signup gate (migration 20260710000000_beta_invite_gate.sql) is a
// SECURITY DEFINER trigger that RAISEs for a non-allowlisted email. GoTrue wraps any
// signup-trigger failure as a generic 500 "Database error saving new user", so the
// specific reason isn't exposed to the client — we detect that shape and show a
// beta-appropriate message instead of a scary raw DB error. The trigger is the
// actual security control; this is only UX.

// Returns a friendly message for a signup error, or the raw message otherwise.
export function betaSignupMessage(error) {
  const raw = (error && (error.message || String(error))) || 'Sign-up failed. Please try again.';
  const status = error && (error.status ?? error.statusCode);
  const looksLikeGate =
    /database error saving new user|not.*allowlist|signup_not_allowlisted|not on the .*beta/i.test(raw) ||
    status === 500;
  if (looksLikeGate) {
    return "We couldn't create your account. GoHustlr is in a closed beta right now — " +
      "make sure you're using the email you were invited with, or contact us to request access.";
  }
  return raw;
}
