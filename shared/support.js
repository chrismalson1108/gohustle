// ─────────────────────────────────────────────────────────────────────────────
// Support — the pure half: the topic vocabulary and the rules that decide which
// conversation a person is shown.
//
// This lived only in src/lib/support.js, which is why the WEBSITE had no support
// thread at all: signed-in web sent people to a `mailto:` for a personal inbox, and
// the one form that does reach support-submit (/contact) was linked from the
// marketing footer and nowhere a signed-in user goes. So a web ticket, if one was
// ever filed, could never be READ back — the agent's reply went out by email, there
// is no inbound-mail ingestion anywhere in this repo, and a reply to that email
// lands in a mailbox where `last_author` never moves, the reopen rule never fires,
// and an agent's photo attachment is a signed URL into an app the user never
// installed.
//
// The rules below are not taste, they are load-bearing, and duplicating them is how
// the two clients start showing different threads to the same person. Both clients
// re-export from here; only the Supabase reads live per-client.
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORT_CATEGORIES = [
  { key: 'payment', label: 'Payments & payouts' },
  { key: 'booking', label: 'A gig or booking' },
  { key: 'safety', label: 'Safety or harassment' },
  { key: 'account', label: 'My account' },
  { key: 'bug', label: 'Something is broken' },
  { key: 'other', label: 'Something else' },
];

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
