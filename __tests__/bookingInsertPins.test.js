const fs = require('fs');
const path = require('path');

// guard_bookings_write's UPDATE branch pins a set of columns to old.* — it treats
// them as server-owned. Its INSERT branch pinned only a few of them, so everything
// else was whatever the client PUT in the row.
//
// The expensive one was started_at. Two independent controls refuse to release a
// poster's escrow hold once it is set (trg_guard_started_booking_cancel, and
// stripe-cancel-payment's 409), and neither asks WHEN it was set — so an earner who
// stamped it while creating the booking left the poster unable to cancel or release
// their own hold for the ~7 days until Stripe expired it.
//
// Asserting "started_at is pinned" alone would be worth little: the bug is that the
// two branches disagree about which columns are server-owned. This asserts the whole
// set on INSERT, so the next column added to the UPDATE pin-list without a matching
// INSERT pin fails here.
const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

function migrationFilesInApplyOrder() {
  const legacy = fs
    .readdirSync(LEGACY_DIR)
    .filter((f) => /^migration_.*\.sql$/.test(f))
    .sort()
    .map((f) => path.join(LEGACY_DIR, f));
  const tracked = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIG_DIR, f));
  return [...legacy, ...tracked];
}

function finalGuardBody() {
  let body = null;
  for (const file of migrationFilesInApplyOrder()) {
    const sql = fs.readFileSync(file, 'utf8');
    const marker = 'create or replace function public.guard_bookings_write';
    let from = 0;
    for (;;) {
      const i = sql.indexOf(marker, from);
      if (i < 0) break;
      const end = sql.indexOf('$$;', i);
      if (end < 0) break;
      body = sql.slice(i, end + 3);
      from = end + 3;
    }
  }
  return body;
}

// The INSERT branch only. It ends at its own `return new;` — NOT at the first
// `end if;`, which belongs to the nested self-booking/slot checks and would cut the
// branch off before the starts_at derivation.
function insertBranch(body) {
  const start = body.indexOf("if tg_op = 'INSERT' then");
  if (start < 0) return null;
  const rest = body.slice(start);
  const stop = rest.indexOf('return new;');
  return stop < 0 ? rest : rest.slice(0, stop);
}

describe('guard_bookings_write INSERT branch pins server-owned columns', () => {
  const body = finalGuardBody();

  test('a definition exists in the applied sequence', () => {
    expect(body).not.toBeNull();
  });

  // Columns a client must never be able to set while CREATING a booking.
  const SERVER_OWNED = [
    'started_at',
    'tip_amount',
    'completion_photos',
    'before_photos',
    'cancellation_fee',
    'poster_rating',
    'poster_review',
    'amendment_status',
    'amendment_note',
    'status',
    'earner_done',
    'poster_done',
    'earner_rating',
  ];

  test.each(SERVER_OWNED)('INSERT assigns new.%s rather than trusting the client', (col) => {
    const branch = insertBranch(body);
    expect(branch).not.toBeNull();
    expect(branch).toMatch(new RegExp(`new\\.${col}\\s*:=`));
  });

  test('starts_at is still DERIVED from the poster-owned slot, not assigned blindly', () => {
    // Distinct from the pins above: starts_at anchors the ghosting-claim gate, so it
    // must come from job_slots, not from a constant and not from the client.
    const branch = insertBranch(body);
    expect(branch).toContain('select s.starts_at into new.starts_at');
  });

  test('the self-booking check survives', () => {
    expect(insertBranch(body)).toContain('You cannot book your own gig');
  });
});
