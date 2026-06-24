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
