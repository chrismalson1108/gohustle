// ─────────────────────────────────────────────────────────────────────────────
// Blocking and suspension must cover every write that REACHES the counterparty,
// not only messaging.
//
// 20260710030000 (blocks) and 20260726070000 / 20260730150000 (suspension) enforced
// both controls on messages and on new bookings, and nowhere else — private.is_blocked_pair
// and private.is_suspended were referenced by three objects in the entire schema. Two
// other writes land in front of the same booking counterparty, i.e. in front of the
// person who most likely just filed the report that caused the suspension:
//
//   * a row in `reviews`, which is PUBLIC and, per RUNBOOK_SAFETY §2.3, cannot be
//     redacted afterwards;
//   * bookings.amendment_note (plus review_text / earner_rating / payment_method), all
//     poster-authored and all rendered in the earner's My Jobs, the note with a push
//     notification behind it.
//
// This is a DRIFT guard, not a re-statement of the migration: it locates the NEWEST
// definition of each object across supabase/migrations and asserts on that, so a later
// migration that recreates either one without the checks fails here rather than silently
// re-opening the channel. Both objects have already been recreated many times — the
// policy four times, the guard eleven — which is exactly how a clause goes missing.
//
// Proved to discriminate: with 20260906055000 removed from the directory, the newest
// definitions are 20260624220000 (policy) and 20260730140000 (guard), and every
// assertion below fails.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 14-digit timestamp prefix, so lexical order IS apply order

/** The last migration that defines `needle`, and its text — the definition that wins. */
function newestDefining(needle) {
  for (let i = FILES.length - 1; i >= 0; i--) {
    const body = fs.readFileSync(path.join(DIR, FILES[i]), 'utf8');
    if (body.toLowerCase().includes(needle)) return { file: FILES[i], body };
  }
  return null;
}

/** Text between the first `from` and the following `to` (exclusive), else ''. */
function slice(body, from, to) {
  const a = body.indexOf(from);
  if (a < 0) return '';
  const b = body.indexOf(to, a + from.length);
  return body.slice(a, b < 0 ? body.length : b);
}

describe('reviews cannot be published across a block or by a suspended account', () => {
  const found = newestDefining('create policy "reviews_insert_auth"');

  test('a migration defines the policy at all', () => {
    expect(found).not.toBeNull();
  });

  test('the newest reviews_insert_auth consults BOTH controls', () => {
    const policy = slice(found.body, 'create policy "reviews_insert_auth"', '\n);');
    // Bidirectional for blocks — matching messages_insert. A one-way rule would make
    // blocking a race: whoever blocks first keeps their review and silences the other's.
    expect(policy).toContain('not private.is_blocked_pair');
    // Suspension checks the ACTOR only; refusing the counterparty would punish the
    // person who was harassed and suppress the warning the community wants.
    expect(policy).toContain('not private.is_suspended(auth.uid())');
    // The party/role condition it already had must survive — this policy is what binds
    // reviews.role to the direction of the booking.
    expect(policy).toContain("b.status = 'verified'");
    expect(policy).toContain('auth.uid() = reviewer_id');
  });

  test('the helpers stay in the non-exposed private schema', () => {
    const policy = slice(found.body, 'create policy "reviews_insert_auth"', '\n);');
    // public.* would be reachable as /rest/v1/rpc/… with caller-controlled arguments —
    // a boolean oracle over the block graph and over who is suspended.
    expect(policy).not.toContain('public.is_blocked_pair');
    expect(policy).not.toContain('public.is_suspended');
    // An inline subquery over public.blocks would be evaluated as the querying role and
    // filtered by blocks-RLS (owner-scoped SELECT), so it would fail to stop the blocked
    // party while looking correct.
    expect(policy).not.toMatch(/from\s+public\.blocks/i);
  });
});

describe('a blocked or suspended poster cannot push text onto the earner’s screen', () => {
  const found = newestDefining('create or replace function public.guard_bookings_write');
  const posterBranch = found
    ? slice(found.body, 'if auth.uid() = poster then', 'if auth.uid() = old.earner_id then')
    : '';

  test('a migration defines the guard at all, with a poster branch', () => {
    expect(found).not.toBeNull();
    expect(posterBranch).not.toBe('');
  });

  test('the poster branch pins every poster-authored column the earner reads', () => {
    // amendment_note renders as a card in My Jobs with a "Change proposed" push behind
    // it; the other three render in the verified block of the same screen.
    for (const col of ['amendment_note', 'amendment_status', 'review_text', 'earner_rating', 'payment_method']) {
      expect(posterBranch).toContain(`new.${col}`);
    }
    const pin = slice(posterBranch, 'private.is_suspended(auth.uid())', 'end if;');
    expect(pin).toContain('new.amendment_note   := old.amendment_note');
    expect(pin).toContain('new.review_text      := old.review_text');
    expect(pin).toContain('new.earner_rating    := old.earner_rating');
    expect(pin).toContain('new.payment_method   := old.payment_method');
  });

  test('the pin is conditional on a block or a suspension, in the poster branch', () => {
    expect(posterBranch).toContain('private.is_suspended(auth.uid())');
    expect(posterBranch).toContain('private.is_blocked_pair(old.earner_id, poster)');
    // old.earner_id, never new.earner_id: the branch pins earner_id to old two lines
    // earlier precisely because a client may send anything, and reading the client's
    // value here would let a poster aim the block check at a stranger.
    expect(posterBranch).not.toContain('private.is_blocked_pair(new.earner_id');
  });

  test('pinned, not raised — the block stays silent', () => {
    // A raise would tell a blocked poster they are blocked. 20260710030000 goes out of
    // its way to keep the block silent; this must not undo that.
    const pin = slice(posterBranch, 'private.is_suspended(auth.uid())', 'end if;');
    expect(pin).not.toMatch(/raise\s+exception/i);
  });

  test('the poster keeps every lifecycle power — this closes a text channel, not settlement', () => {
    // Suspension must never strand an escrow hold on someone else's card or withhold
    // money already earned, so decline / cancel / complete / verify stay reachable.
    expect(posterBranch).toContain("(old.status = 'pending'   and new.status in ('declined','cancelled'))");
    expect(posterBranch).toContain("(old.status = 'confirmed' and new.status = 'cancelled')");
    expect(posterBranch).toContain("old.status = 'completed' and new.status = 'verified'");
  });
});
