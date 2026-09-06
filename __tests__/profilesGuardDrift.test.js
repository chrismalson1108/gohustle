const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// guard_profiles_write is a DENYLIST on a table that keeps growing columns, and that
// is a shape which fails silently every time someone adds one.
//
// It has now been written nine times. Twice the rewrite was itself the fix for
// a column the previous copy had missed: created_at (20260722020000 — a backdated
// signup skipped the open-beta age attestation) and deleted_at (20260906044000 — an
// owner could self-set the erasure tombstone, opening a HIGH ctl_tombstone_leaks_pii
// finding that pages the on-call, and pre-stamping the timestamp a real later erasure
// keeps via `coalesce(deleted_at, now())`).
//
// UPDATE on public.profiles is granted table-wide to `authenticated` and
// profiles_update_own is USING-only — 20260812040000_grant_rls_parity:131 asserts that
// privilege must persist — so this trigger is the ONLY thing between an owner and every
// server-owned column on their row. A rewrite that copies an older body, or a new pin
// added without carrying the old ones forward, re-opens whichever hole it drops, and
// nothing errors: the write just quietly lands.
//
// So the pin list is asserted here rather than trusted to a comment, the same way
// supportGuardDrift.test.js asserts the `app.support_reopen` exemption.
// ─────────────────────────────────────────────────────────────────────────────
const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

// The SHIPPED body only — sliced to the first `$$;` after the header, so a pre-fix body
// staged inside a self-check probe further down the same file cannot satisfy an assertion
// the real definition fails.
function shippedBody(sql, fnName) {
  const start = sql.toLowerCase().indexOf(`create or replace function public.${fnName}`);
  if (start < 0) return '';
  const end = sql.indexOf('\n$$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end);
}

function newestDefining(fnName) {
  const hits = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(DIR, f), 'utf8'),
      ),
    )
    .sort();
  if (!hits.length) return null;
  const file = hits[hits.length - 1];
  return { file, sql: fs.readFileSync(path.join(DIR, file), 'utf8') };
}

// The pin list a rewrite must carry forward. Each one is a column the server owns and
// the person the row belongs to must not be able to write.
const PINNED = [
  // trust badges and self-rating
  'verified',
  'id_verification_status',
  'rating',
  'review_count',
  'poster_rating',
  'poster_review_count',
  // money the client must never be able to state
  'earnings_today',
  'earnings_week',
  'earnings_total',
  'earnings_period_date',
  // moderation state, admin-only
  'suspended_at',
  'suspension_reason',
  // the age-floor cutoff input, and the displayed "joined" signal
  'created_at',
  'member_since',
  // the erasure tombstone — server-written by tombstone_profile() only
  'deleted_at',
];

describe('profiles guard drift', () => {
  it('the profiles guard is defined somewhere', () => {
    expect(newestDefining('guard_profiles_write')).not.toBeNull();
  });

  it('the newest profiles guard pins every server-owned column', () => {
    const { sql, file } = newestDefining('guard_profiles_write');
    const body = shippedBody(sql, 'guard_profiles_write');
    const missing = PINNED.filter(
      (col) => !new RegExp(`new\\.${col}\\s*:=\\s*old\\.${col}\\b`).test(body),
    );
    // Name the file, because the failure is "someone copied an older body forward".
    expect(`${file}: ${missing.join(', ')}`).toBe(`${file}: `);
  });

  it('still pins deleted_at specifically — self-erasure pages the on-call', () => {
    // Called out on its own: nothing in the app reads deleted_at, so losing this pin
    // produces no visible symptom at all until a HIGH control fires on an account that
    // never asked to be erased.
    const { sql } = newestDefining('guard_profiles_write');
    const body = shippedBody(sql, 'guard_profiles_write');
    expect(body).toMatch(/new\.deleted_at\s*:=\s*old\.deleted_at/);
  });

  it('keeps date_of_birth write-once and onboarding_done one-way', () => {
    // These two are conditional pins, not flat ones — a rewrite that "simplifies" them
    // into unconditional assignments would block the legitimate first-time backfill.
    const { sql } = newestDefining('guard_profiles_write');
    const body = shippedBody(sql, 'guard_profiles_write');
    expect(body).toMatch(/if\s+old\.date_of_birth\s+is\s+not\s+null\s+then/i);
    expect(body).toMatch(/new\.date_of_birth\s*:=\s*old\.date_of_birth/);
    expect(body).toMatch(/if\s+old\.onboarding_done\s+then/i);
  });

  it('leaves the service_role and recompute paths as early returns', () => {
    // tombstone_profile(), the console and the earnings recompute all write pinned
    // columns legitimately. Losing either exemption breaks account deletion, which
    // fails CLOSED in delete-account and blocks erasure entirely.
    const { sql } = newestDefining('guard_profiles_write');
    const body = shippedBody(sql, 'guard_profiles_write');
    expect(body).toMatch(/current_setting\(\s*'app\.recompute'\s*,\s*true\s*\)\s*=\s*'on'/);
    expect(body).toMatch(/auth\.role\(\)[^\n]*=\s*'service_role'/);
  });

  it('the erasure tombstone is still written only by a service-role function', () => {
    // The other half of the same mechanism: the pin is only meaningful while
    // tombstone_profile stays out of reach of authenticated callers.
    const tomb = newestDefining('tombstone_profile');
    expect(tomb).not.toBeNull();
    expect(tomb.sql).toMatch(
      /revoke execute on function public\.tombstone_profile\(uuid\) from public, anon, authenticated/i,
    );
    expect(tomb.sql).toMatch(
      /grant execute on function public\.tombstone_profile\(uuid\) to service_role/i,
    );
  });
});
