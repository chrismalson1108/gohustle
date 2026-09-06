// ─────────────────────────────────────────────────────────────────────────────
// In-app support, web side — the Supabase reads and the one edge-function call.
//
// WHY THIS EXISTS: the same reason src/lib/support.js exists, one client later.
// Mobile replaced its three `mailto:` links because "NO beta tester's request would
// ever have entered the ticket system: it would land in a personal inbox,
// unassignable, un-triageable, with no status and no record that it was answered."
// Signed-in WEB still had exactly that failure — Settings → Contact support and
// Profile → Contact support were `mailto:mainmail@gohustlr.com`, /contact was linked
// only from the marketing footer, and no web code read support_tickets or
// support_ticket_messages at all.
//
// The email leg does not close the loop either. support-reply sends with
// `reply_to = mainmail@` and a footer inviting a reply, and there is no inbound-mail
// ingestion anywhere in this repo — so a user's reply lands in a mailbox,
// `last_author` never flips, the reopen rule never fires, the console queue and the
// SLA control stay blind, and an agent's photo attachment is a signed URL into the
// private support-photos bucket, inside an app the web user never installed.
//
// The rules for WHICH thread to show (pickActiveTicket / groupTickets / ticketHasUnread)
// and the topic list live in shared/support.js — the same module the app uses. Two
// copies is how the two clients start showing a person different conversations.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "./supabaseClient";

export {
  SUPPORT_CATEGORIES,
  ticketHasUnread,
  pickActiveTicket,
  groupTickets,
} from "@gohustlr/shared";

export interface SupportTicket {
  id: string;
  subject: string | null;
  category: string | null;
  status: string;
  priority: string | null;
  booking_id: string | null;
  job_id: string | null;
  created_at: string;
  last_message_at: string | null;
  user_read_at: string | null;
  archived_at: string | null;
}

export interface SupportMessage {
  id: string;
  author: string;
  body: string | null;
  images: string[] | null;
  created_at: string;
}

export class SupportError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/**
 * File a support ticket. Returns the new ticket id.
 *
 * functions.invoke attaches the session JWT, which is what lets support-submit set
 * support_tickets.user_id — an in-app report arrives already attributed, so the agent
 * can open the reporter's account straight from the ticket.
 */
export async function submitSupportRequest({
  subject,
  message,
  category,
  email,
  name,
  bookingId,
  jobId,
  images = [],
}: {
  subject?: string;
  message: string;
  category?: string | null;
  email?: string | null;
  name?: string | null;
  bookingId?: string | null;
  jobId?: string | null;
  images?: string[];
}): Promise<string | null> {
  const body = String(message ?? "").trim();
  if (!body) throw new SupportError("Please describe your issue.", "empty");
  if (body.length > 5000) throw new SupportError("That message is too long.", "too_long");

  // Resolve the reply-to from the SESSION, not from a form field — a user must not
  // be able to file a ticket under someone else's address from inside the app.
  // getSession() reads the locally-cached session; getUser() would round-trip to the
  // auth server, and contacting support is disproportionately something people do on
  // a bad connection.
  let addr = String(email ?? "").trim();
  if (!addr) {
    const { data } = await supabase.auth.getSession();
    addr = data?.session?.user?.email ?? "";
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    throw new SupportError(
      "We couldn't find an email address for your account. Check your connection and try again.",
      "invalid_email",
    );
  }

  const { data, error } = await supabase.functions.invoke("support-submit", {
    body: {
      email: addr,
      name: name ?? null,
      subject: String(subject ?? "").trim() || "Support request",
      category: category ?? null,
      message: body,
      // Optional context so an agent opens the right gig instead of asking "which
      // one?". Verified server-side against this user's own bookings.
      bookingId: bookingId ?? null,
      jobId: jobId ?? null,
      // Attachments on the FIRST message; support-submit re-checks each path is
      // owner-scoped to the caller.
      images: Array.isArray(images) ? images.slice(0, 6) : [],
    },
  });

  if (error) {
    // FunctionsHttpError carries the response; pull the server's own copy out of it
    // so the user sees "Too many requests" rather than a generic failure.
    let payload: { message?: string; error?: string } | null = null;
    try {
      payload = (await (error as { context?: { json?: () => Promise<unknown> } }).context?.json?.()) as {
        message?: string;
        error?: string;
      };
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    throw new SupportError(
      payload?.message || "Could not send your message. Please try again.",
      payload?.error || "request_failed",
    );
  }
  const res = data as { error?: string; message?: string; ticketId?: string } | null;
  if (res?.error) throw new SupportError(res.message || "Could not send your message.", res.error);
  return res?.ticketId ?? null;
}

// Everything below reads the user's OWN tickets only — enforced by RLS, not by these
// queries. A client-side filter is a convenience; the policy is the guarantee.

/** Every ticket this user has, newest activity first. */
export async function fetchMyTickets(): Promise<SupportTicket[]> {
  const { data, error } = await supabase
    .from("support_tickets")
    .select(
      "id, subject, category, status, priority, booking_id, job_id, created_at, last_message_at, user_read_at, archived_at",
    )
    .order("last_message_at", { ascending: false });
  if (error) throw new SupportError("Could not load your support messages.", "load_failed");
  return (data ?? []) as unknown as SupportTicket[];
}

/** The messages on one ticket, oldest first (chat order). */
export async function fetchTicketMessages(ticketId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase
    .from("support_ticket_messages")
    .select("id, author, body, images, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new SupportError("Could not load this conversation.", "load_failed");
  return (data ?? []) as unknown as SupportMessage[];
}

/**
 * Reply on an existing ticket. `author` is pinned to 'user' server-side by
 * guard_support_message_write — a client can never post as staff, which is the whole
 * trust boundary: a message rendered with a GoHustlr badge must have come from us.
 *
 * A reply to a CLOSED ticket is accepted and REOPENS it (20260806380000), and
 * un-archives it. That is the behaviour an emailed reply can never have.
 */
export async function replyToTicket(
  ticketId: string,
  { body, images = [] }: { body?: string; images?: string[] } = {},
): Promise<void> {
  const text = String(body ?? "").trim();
  if (!text && images.length === 0) throw new SupportError("Write a message first.", "empty");
  if (text.length > 5000) throw new SupportError("That message is too long.", "too_long");
  // `text`, not `text || null`: support_ticket_messages.body is NOT NULL, so a
  // photo-only reply — which the guard explicitly permits — would insert null and
  // fail every time.
  const { error } = await supabase
    .from("support_ticket_messages")
    .insert({ ticket_id: ticketId, body: text, images });
  if (error) throw new SupportError("Could not send your message. Please try again.", "send_failed");
}

/**
 * Hide a resolved thread from the inbox. ARCHIVING IS NOT CLOSING: closing is the
 * team saying it is handled and drives the queue and the SLA control; archiving is a
 * display preference that belongs to the user.
 */
export async function setTicketArchived(ticketId: string, archived: boolean): Promise<void> {
  const { error } = await supabase
    .from("support_tickets")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", ticketId);
  if (error) throw new SupportError("Could not update this conversation.", "archive_failed");
}

/**
 * Mark your own ticket resolved. Safe to offer precisely BECAUSE a reply reopens it:
 * the worst case of closing something prematurely is one more message.
 */
export async function resolveTicket(ticketId: string): Promise<void> {
  const { error } = await supabase.from("support_tickets").update({ status: "closed" }).eq("id", ticketId);
  if (error) throw new SupportError("Could not close this conversation.", "close_failed");
}

/** Mark the thread read so the unread dot clears. */
export async function markTicketRead(ticketId: string): Promise<void> {
  await supabase
    .from("support_tickets")
    .update({ user_read_at: new Date().toISOString() })
    .eq("id", ticketId);
}
