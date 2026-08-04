import { supabase } from './supabase';

// In-app support intake.
//
// WHY THIS EXISTS: the mobile app's only support path was three `mailto:` links
// (ProfileScreen, SettingsScreen, PayoutSetupScreen). support-submit — and the
// whole support_tickets queue the admin console is built around — was reachable
// only from web/app/contact. TestFlight is the beta channel, so in practice NO
// beta tester's request would ever have entered the ticket system: it would land
// in a personal inbox, unassignable, un-triageable, with no status and no record
// that it was answered.
//
// support-submit ties the ticket to the signed-in user when a JWT is present, so
// an in-app report arrives already attributed — the admin can open the reporter's
// account straight from the ticket.

export const SUPPORT_CATEGORIES = [
  { key: 'payment', label: 'Payments & payouts' },
  { key: 'booking', label: 'A gig or booking' },
  { key: 'safety', label: 'Safety or harassment' },
  { key: 'account', label: 'My account' },
  { key: 'bug', label: 'Something is broken' },
  { key: 'other', label: 'Something else' },
];

export class SupportError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * File a support ticket. Returns the new ticket id.
 *
 * @param {object} p
 * @param {string} p.subject   short one-line summary
 * @param {string} p.message   the body (<= 5000 chars, enforced server-side too)
 * @param {string} [p.category] one of SUPPORT_CATEGORIES[].key
 * @param {string} [p.email]   defaults to the signed-in user's email
 * @param {string} [p.name]    defaults to the signed-in user's profile name
 */
export async function submitSupportRequest({ subject, message, category, email, name }) {
  const body = String(message ?? '').trim();
  if (!body) throw new SupportError('Please describe your issue.', 'empty');
  if (body.length > 5000) throw new SupportError('That message is too long.', 'too_long');

  // Resolve the reply-to address from the session when the caller didn't pass one.
  // support-submit requires a valid email even for authenticated callers.
  let addr = String(email ?? '').trim();
  if (!addr) {
    // getSession() reads the locally-cached session; getUser() would round-trip to
    // the auth server. Contacting support is disproportionately something people do
    // ON A BAD CONNECTION, and a failed round-trip here produced "We need a valid
    // email to reply to." — naming something the sheet gives them no field to supply.
    const { data } = await supabase.auth.getSession();
    addr = data?.session?.user?.email ?? '';
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    throw new SupportError(
      "We couldn't find an email address for your account. Check your connection and try again.",
      'invalid_email',
    );
  }

  // functions.invoke attaches the session JWT automatically, which is what lets
  // support-submit attribute the ticket to this user.
  const { data, error } = await supabase.functions.invoke('support-submit', {
    body: {
      email: addr,
      name: name ?? null,
      subject: String(subject ?? '').trim() || 'Support request',
      category: category ?? null,
      message: body,
    },
  });

  if (error) {
    // FunctionsHttpError carries the response; pull the server's own copy out of it
    // so the user sees "Too many requests" rather than a generic failure.
    let payload = null;
    try {
      payload = await error.context?.json?.();
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    throw new SupportError(
      payload?.message || 'Could not send your message. Please try again.',
      payload?.error || 'request_failed',
    );
  }
  if (data?.error) throw new SupportError(data.message || 'Could not send your message.', data.error);
  return data?.ticketId ?? null;
}
