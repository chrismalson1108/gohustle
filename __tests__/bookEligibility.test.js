// ─────────────────────────────────────────────────────────────────────────────
// A gig whose only slot is taken must not be bookable — and the button must not
// say it is.
//
// JobDetailScreen refused a booking in exactly two cases, and neither covered the
// commonest gig on the platform:
//
//     if (hasScheduledSlots && selectableSlots.length === 0) …refuse
//     if (!selectedSlot && selectableSlots.length > 0)       …refuse
//
// PostJob attaches a "Flexible — Contact to Schedule" slot when the poster picks no
// times, and that slot carries NO startsAt. So on a gig whose single flexible slot is
// already taken, hasScheduledSlots is false (nothing is dated) and selectableSlots is
// empty (the one slot is taken): the first guard is skipped for want of a dated slot,
// the second for want of a selectable one, and the booking went through with
// slot_id = null — outside bookings_one_active_per_slot, and permanently unsettleable
// by earner-claim-payment, which returns NO_SCHEDULE without one.
//
// Every case below is expressed against bookingBlockReason, which is now the ONE rule
// the handler and the footer label both read. Reverting shared/filters.js to the old
// two-guard logic fails "the reported bug" cases here.
// ─────────────────────────────────────────────────────────────────────────────
import { bookingBlockReason, selectableSlots } from '../shared/filters.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-06T12:00:00Z');
const future = new Date(NOW + 48 * HOUR).toISOString();
const past = new Date(NOW - 48 * HOUR).toISOString();

const flexible = (over = {}) => ({ id: 's1', label: 'Flexible — Contact to Schedule', taken: false, startsAt: null, ...over });
const job = (slots) => ({ id: 'j1', status: 'open', title: 'Move a couch', slots });

describe('bookingBlockReason', () => {
  test('THE REPORTED BUG: a single taken FLEXIBLE slot is not bookable', () => {
    // Undated and taken — the shape both old guards skipped over.
    expect(bookingBlockReason(job([flexible({ taken: true })]), null, NOW)).toBe('all_slots_taken');
  });

  test('THE REPORTED BUG: and it stays refused even if a slot id is somehow selected', () => {
    expect(bookingBlockReason(job([flexible({ taken: true })]), 's1', NOW)).toBe('all_slots_taken');
  });

  test('a free flexible slot books once selected — the normal one-slot gig', () => {
    expect(bookingBlockReason(job([flexible()]), 's1', NOW)).toBeNull();
  });

  test('every DATED slot in the past reads as expired, not as taken', () => {
    // Different next step for the earner: nobody beat them to it, the listing is over.
    expect(bookingBlockReason(job([flexible({ startsAt: past })]), null, NOW)).toBe('slots_expired');
  });

  test('a taken future slot beside a passed one still reads as taken', () => {
    expect(bookingBlockReason(job([
      flexible({ id: 'a', startsAt: past }),
      flexible({ id: 'b', startsAt: future, taken: true }),
    ]), null, NOW)).toBe('all_slots_taken');
  });

  test('multi-slot: a free slot exists but none is selected', () => {
    expect(bookingBlockReason(job([
      flexible({ id: 'a', taken: true }),
      flexible({ id: 'b', startsAt: future }),
    ]), null, NOW)).toBe('select_slot');
  });

  test('multi-slot: the selected free slot books', () => {
    expect(bookingBlockReason(job([
      flexible({ id: 'a', taken: true }),
      flexible({ id: 'b', startsAt: future }),
    ]), 'b', NOW)).toBeNull();
  });

  test('a selection that went stale under realtime is refused, not booked blind', () => {
    expect(bookingBlockReason(job([
      flexible({ id: 'a', taken: true }),
      flexible({ id: 'b', startsAt: future }),
    ]), 'a', NOW)).toBe('slot_taken');
  });

  test('a gig with NO slots at all stays bookable, matching isJobBookable', () => {
    // Anomalous legacy data — PostJob/EditJob always attach one. Refusing here would
    // break bookings that work today, and the DB guard fails open the same way.
    expect(bookingBlockReason(job([]), null, NOW)).toBeNull();
    expect(bookingBlockReason(job(undefined), null, NOW)).toBeNull();
    expect(bookingBlockReason(null, null, NOW)).toBeNull();
  });
});

describe('selectableSlots', () => {
  test('drops taken slots and past slots, keeps flexible ones', () => {
    const slots = [
      flexible({ id: 'taken', taken: true }),
      flexible({ id: 'past', startsAt: past }),
      flexible({ id: 'future', startsAt: future }),
      flexible({ id: 'flex' }),
    ];
    expect(selectableSlots(job(slots), NOW).map((s) => s.id)).toEqual(['future', 'flex']);
  });
});
