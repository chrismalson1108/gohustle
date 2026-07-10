// Booking-lifecycle metadata + derived-count helpers, shared by both apps.
// Status flow: pending → confirmed → completed → verified (↘ declined / cancelled).
// `ion` is an Ionicons name (mobile); web maps these to its own icon set.

export const BOOKING_STATUS = {
  pending:   { label: 'Awaiting Confirmation', ion: 'time',             color: '#D97706', bg: '#FEF3C7' },
  confirmed: { label: 'Confirmed',             ion: 'checkmark-circle', color: '#059669', bg: '#D1FAE5' },
  completed: { label: 'Pending Verification',  ion: 'sync',             color: '#4F46E5', bg: '#EDE9FE' },
  verified:  { label: 'Completed & Paid',      ion: 'shield-checkmark', color: '#059669', bg: '#D1FAE5' },
  declined:  { label: 'Declined',              ion: 'close-circle',     color: '#DC2626', bg: '#FEE2E2' },
  cancelled: { label: 'Cancelled',             ion: 'ban',              color: '#9CA3AF', bg: '#F3F4F6' },
};

export function statusMeta(status) {
  return BOOKING_STATUS[status] || BOOKING_STATUS.pending;
}

// Earner tab badge: bookings needing the earner's attention (accepted/paid).
export function earnBadgeCount(bookings) {
  return (bookings || []).filter(b => b.status === 'confirmed' || b.status === 'verified').length;
}

// Poster tab badge: bookings needing the poster's action (new requests / to verify).
export function profileBadgeCount(posterBookings) {
  return (posterBookings || []).filter(b => b.status === 'pending' || b.status === 'completed').length;
}

// Mutual-completion rule: a booking only advances to "completed" once BOTH sides
// mark done. Given a booking and which side is acting, compute the next status.
export function nextStatusOnDone(booking, side /* 'earner' | 'poster' */) {
  const otherDone = side === 'earner' ? booking.posterDone : booking.earnerDone;
  return otherDone ? 'completed' : booking.status;
}

// H3 (poster-ghosting-hold-expiry): grace window, in days past the gig's scheduled
// time, after which an earner who did + marked the work done may claim settlement of
// their OWN completed work when the poster never confirms/verifies. Kept < the ~7-day
// Stripe authorization-hold expiry so a capture still succeeds. MUST match the value
// hard-coded in the earner-claim-payment edge function.
export const EARNER_CLAIM_GRACE_DAYS = 3;

// Whether the "Claim your payment" escalation should be offered to the earner. Pure
// and testable; the server (earner-claim-payment) re-checks every condition
// authoritatively AND additionally rejects on an open dispute / unresolved report /
// disabled payout account — none of which the client is trusted to evaluate.
export function canClaimEarnerPayment(booking, now = new Date(), graceDays = EARNER_CLAIM_GRACE_DAYS) {
  if (!booking) return false;
  if (!booking.earnerDone) return false;                                   // earner did + marked the work
  if (!['confirmed', 'completed'].includes(booking.status)) return false;  // not finalized/cancelled/declined
  const sched = booking.startsAt ? new Date(booking.startsAt) : null;
  if (!sched || isNaN(sched.getTime())) return false;                      // need a scheduled time to anchor grace
  const deadline = new Date(sched.getTime() + graceDays * 24 * 60 * 60 * 1000);
  const at = now instanceof Date ? now : new Date(now);
  return at.getTime() >= deadline.getTime();
}
