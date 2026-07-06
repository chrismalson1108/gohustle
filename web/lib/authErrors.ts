// Maps Supabase/GoTrue auth errors to branded, non-leaky user-facing copy.
// Keyed on GoTrue's stable `code` with a message-regex fallback for the codes it
// omits. Keeps raw server strings (and account-existence hints) out of the UI, and
// gives every auth surface one consistent voice. Mirror any additions in the
// mobile app (src/lib/authErrors.js) if that file is added there too.

interface AuthLikeError {
  message?: string;
  code?: string;
}

export function friendlyAuthError(error: AuthLikeError | null | undefined): string {
  const code = error?.code ?? "";
  const msg = error?.message ?? "";
  const m = (re: RegExp) => re.test(msg);

  if (code === "invalid_credentials" || m(/invalid login credentials/i))
    return "That email and password don't match. Check them and try again.";
  if (code === "email_not_confirmed" || m(/email not confirmed/i))
    return "Please confirm your email first — check your inbox for the link.";
  if (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit" ||
    m(/rate limit|for security purposes|only request this after/i)
  )
    return "Too many attempts — please wait a minute and try again.";
  if (code === "weak_password" || m(/password.*(weak|breach|pwned|at least|characters)/i))
    return "That password is too weak or has appeared in a data breach. Choose a stronger one — mix in length, numbers, and symbols.";
  if (code === "same_password" || m(/should be different/i))
    return "Your new password must be different from your current one.";
  if (code === "validation_failed")
    return "Please double-check what you entered and try again.";
  if (m(/network|failed to fetch|timed out|timeout/i))
    return "Network trouble — check your connection and try again.";
  return "Something went wrong — please try again.";
}
