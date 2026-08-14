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
export async function submitSupportRequest({
  subject, message, category, email, name, bookingId, jobId, images = [],
}) {
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
      // Optional context so an agent opens the right gig instead of asking "which one?".
      // Verified server-side against this user's own bookings — see support-submit.
      bookingId: bookingId ?? null,
      jobId: jobId ?? null,
      // Attachments on the FIRST message. SupportScreen has always uploaded these to
      // support-photos, but nothing carried the paths any further, so they were
      // silently discarded and the agent opened a thread with no evidence in it.
      // support-submit re-checks that each path is owner-scoped to the caller.
      images: Array.isArray(images) ? images.slice(0, 6) : [],
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

// ─────────────────────────────────────────────────────────────────────────────
// Reading the conversation.
//
// Until 20260806360000 these tables had RLS enabled with NO policies and no grants,
// so support was write-only: a user filed a ticket and could never see the answer
// in the app. The reply arrived by email, outside the product, with no thread and no
// history. That is what makes support feel absent even when someone is answering.
//
// Everything below reads the user's OWN tickets only — enforced by RLS, not by these
// queries. A client-side filter is a convenience; the policy is the guarantee.
// ─────────────────────────────────────────────────────────────────────────────

/** Every ticket this user has, newest activity first. */
export async function fetchMyTickets() {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id, subject, category, status, priority, booking_id, job_id, created_at, last_message_at, user_read_at, archived_at')
    .order('last_message_at', { ascending: false });
  if (error) throw new SupportError('Could not load your support messages.', 'load_failed');
  return data ?? [];
}

/** The messages on one ticket, oldest first (chat order). */
export async function fetchTicketMessages(ticketId) {
  const { data, error } = await supabase
    .from('support_ticket_messages')
    .select('id, author, body, images, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });
  if (error) throw new SupportError('Could not load this conversation.', 'load_failed');
  return data ?? [];
}

/**
 * Reply on an existing ticket. `author` is pinned to 'user' server-side by
 * guard_support_message_write — a client can never post as staff, which is the whole
 * trust boundary: a message rendered with a GoHustlr badge must have come from GoHustlr.
 *
 * A reply to a CLOSED ticket is accepted and REOPENS it (20260806380000). The insert
 * policy carries no status condition — an earlier comment here claimed it refused
 * closed tickets, which was true only before that migration.
 */
export async function replyToTicket(ticketId, { body, images = [] } = {}) {
  const text = String(body ?? '').trim();
  if (!text && images.length === 0) throw new SupportError('Write a message first.', 'empty');
  if (text.length > 5000) throw new SupportError('That message is too long.', 'too_long');
  const { error } = await supabase
    .from('support_ticket_messages')
    // `text`, not `text || null`: support_ticket_messages.body is NOT NULL
    // (20260705040000:32), so a photo-only reply — which the guard above explicitly
    // permits — inserted null and failed every time, surfacing as the generic "Could not
    // send your message". The column is NOT NULL, not NOT-EMPTY; an empty body beside a
    // populated images[] is exactly what a photo-only message is, and the console
    // renderer already guards on `{m.body ? …}`.
    .insert({ ticket_id: ticketId, body: text, images });
  if (error) {
    // No longer special-cases "closed": that branch told the user to start a new
    // conversation, which stopped being true — and became actively wrong advice —
    // when a reply started reopening the thread with its history intact.
    throw new SupportError('Could not send your message. Please try again.', 'send_failed');
  }
}

/**
 * Hide a resolved thread from the inbox. ARCHIVING IS NOT CLOSING: closing is the
 * team saying it is handled and drives the queue and the SLA control; archiving is a
 * display preference that belongs to the user. Replying un-archives automatically,
 * because a thread someone is actively writing in must not be hidden from them.
 */
export async function setTicketArchived(ticketId, archived) {
  const { error } = await supabase
    .from('support_tickets')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', ticketId);
  if (error) throw new SupportError('Could not update this conversation.', 'archive_failed');
}

/**
 * Mark your own ticket resolved. Safe to offer precisely BECAUSE a reply reopens it:
 * the worst case of closing something prematurely is one more message.
 */
export async function resolveTicket(ticketId) {
  const { error } = await supabase
    .from('support_tickets').update({ status: 'closed' }).eq('id', ticketId);
  if (error) throw new SupportError('Could not close this conversation.', 'close_failed');
}

/** Mark the thread read so the Messages badge clears. */
export async function markTicketRead(ticketId) {
  await supabase
    .from('support_tickets')
    .update({ user_read_at: new Date().toISOString() })
    .eq('id', ticketId);
}

/**
 * Unread iff support has said something the user has not seen. Deliberately ignores
 * the user's own messages — your own reply arriving should never light up your inbox.
 */
export function ticketHasUnread(t) {
  if (!t?.last_message_at) return false;
  if (!t.user_read_at) return true;
  return Date.parse(t.last_message_at) > Date.parse(t.user_read_at);
}

/**
 * Which conversation to show.
 *
 * Threads are per topic — forced by the schema, not chosen for taste: `priority` and
 * `booking_id` both live on the ticket, and safety is urgent by definition, so one
 * lifelong thread could not carry a routine question and a safety report without
 * mis-routing one of them.
 *
 * UNREAD WINS over status. Once support can write first, a status-only rule breaks:
 * an agent adding a note to a resolved thread deliberately leaves it 'closed' (so it
 * does not bounce back into their queue), and we would then push "support replied"
 * and open a different thread.
 */
export function pickActiveTicket(tickets = []) {
  return (
    tickets.find(ticketHasUnread)
    ?? tickets.find(t => t.status !== 'closed')
    ?? tickets[0]
    ?? null
  );
}

/**
 * Split the other threads into what still wants the user's attention and what is
 * reference. Anything unread is LIVE whatever its status — burying a message we just
 * sent a push about behind an archive toggle is how it goes unanswered.
 */
export function groupTickets(tickets = [], activeId = null) {
  const others = tickets.filter(t => t.id !== activeId);
  return {
    live: others.filter(t => ticketHasUnread(t) || (t.status !== 'closed' && !t.archived_at)),
    archived: others.filter(t => !ticketHasUnread(t) && (t.status === 'closed' || t.archived_at)),
  };
}
