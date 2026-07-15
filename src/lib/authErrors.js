// Maps Supabase auth errors to user-facing copy.
//
// The signup allowlist gate (migration 20260710000000_beta_invite_gate.sql) is a
// SECURITY DEFINER trigger that RAISEs for a non-allowlisted email. Signups are OPEN
// now (the '*' allowlist row), so the gate rejects no one and a generic GoTrue 500
// "Database error saving new user" means a real transient failure, NOT an invite
// gate — so we must NOT show closed-beta copy for it. We only surface invite-only
// messaging for an explicit allowlist-rejection shape, in case the beta is re-closed.

// Returns a friendly message for a signup error, or the raw message otherwise.
export function betaSignupMessage(error) {
  const raw = (error && (error.message || String(error))) || 'Sign-up failed. Please try again.';
  const status = error && (error.status ?? error.statusCode);
  // Explicit allowlist-rejection shapes only (kept for a future re-close). The bare
  // generic-500 / "database error saving new user" shape is intentionally NOT treated
  // as a gate while the beta is open — it now signals a real error, not an invite wall.
  const looksLikeGate =
    /not.*allowlist|signup_not_allowlisted|not on the .*beta/i.test(raw);
  if (looksLikeGate) {
    return "We couldn't create your account. GoHustlr is invite-only right now — " +
      "make sure you're using the email you were invited with, or contact us to request access.";
  }
  // Generic server error during signup (transient GoTrue/DB 500, mailer hiccup, etc.).
  if (status === 500 || /database error saving new user/i.test(raw)) {
    return "We couldn't create your account — please try again in a moment.";
  }
  return raw;
}
