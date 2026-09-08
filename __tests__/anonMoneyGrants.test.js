// ─────────────────────────────────────────────────────────────────────────────
// The publishable key must hold NO table grant on a money table.
//
// The anon key ships in the app bundle and on gohustlr.com; anyone can read it out of
// either. Most money tables already have the strong posture — no grant at all, so an
// unauthenticated request is refused by the GRANT before any policy runs. Four did not,
// measured against production on 2026-09-08 with the real key:
//
//   bookings   anon: SELECT, INSERT, UPDATE      payments          anon: SELECT
//   stripe_accounts  anon: SELECT                stripe_customers  anon: SELECT
//
// Nothing leaked — every policy on them is scoped through auth.uid(), which is null for
// anon, so the live probe got 401 / zero rows. The point is what happens on the day a
// policy regresses: on `disputes` the missing grant still refuses the request, and on
// these four it would not.
//
// This asserts the SQL, not the live database, so it holds on a fresh clone and in CI.
// It reads the whole migrations directory in order, so a later `grant ... to anon` that
// re-opens one of these fails here.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const LEGACY = path.join(ROOT, 'supabase');

// The four that were measured OPEN to anon in production on 2026-09-08 and that
// 20260909080000 closes. These are the ones a static test can assert, because closing
// them required a REVOKE that now lives in the SQL.
const REVOKED_HERE = ['bookings', 'payments', 'stripe_accounts', 'stripe_customers'];

// ⚠️ The other money tables are NOT listed above, and that is deliberate rather than an
// omission. `bonus_ledger`, `promo_grants` and `promo_redemptions` were also probed live
// with the real anon key and hold NOTHING — but they hold nothing because they were never
// granted, not because anything revoked them, so there is no statement for a static test
// to find. Demanding a revoke for them would fail on a correct database. Their state is
// enforced by RLS plus the absence of a grant, and by ctl_* coverage, not here.
//
// `jobs` is deliberately readable signed-out. That is the marketplace.

function sqlInOrder() {
  const out = [];
  for (const f of fs.readdirSync(LEGACY).filter((f) => f.endsWith('.sql')).sort()) {
    out.push([`supabase/${f}`, fs.readFileSync(path.join(LEGACY, f), 'utf8')]);
  }
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    out.push([`supabase/migrations/${f}`, fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')]);
  }
  return out;
}

// ⚠️ THE GRANTS ARE NOT IN THIS REPO. Supabase's default privileges hand anon and
// authenticated full DML on every new table in `public`, so a table is exposed by
// DEFAULT and only a REVOKE closes it. A first version of this test replayed
// `grant ... to anon` statements from the migrations, found none, and passed while all
// four tables were wide open — vacuous, and worse than nothing.
//
// So the assertable invariant is the REVOKE, not the grant: every money table must carry
// an explicit revoke of SELECT (at minimum) from anon somewhere in the SQL. That is what
// 20260812040000_grant_rls_parity.sql did for 28 tables, using "is there a policy backing
// this command" as its test — a rule that is not role-aware, which is exactly why anon's
// SELECT survived on these four.
function anonSelectRevoked(table) {
  const all = sqlInOrder().map(([, s]) => s).join('\n');
  // `revoke <privs> on public.<table> from ... anon ...`, where privs is ALL or a list
  // containing SELECT. Comments are stripped so prose about a revoke cannot satisfy it.
  const code = all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
  // The privilege list is letters, commas and whitespace ONLY. A `[\s\S]*?` here spans
  // statement boundaries and happily swallows a SELECT from an earlier revoke, which made
  // the first version of this test pass with the migration deleted.
  const re = new RegExp(
    String.raw`revoke\s+([A-Za-z][A-Za-z,\s]*?)\s+on\s+(?:table\s+)?public\.${table}\s+from\s+([^;]+);`,
    'gi',
  );
  for (const m of code.matchAll(re)) {
    const privs = m[1].toUpperCase();
    const roles = m[2];
    if (!/\bANON\b/i.test(roles)) continue;
    if (/\bALL\b/.test(privs) || /\bSELECT\b/.test(privs)) return true;
  }
  return false;
}

describe('every money table explicitly revokes SELECT from anon', () => {
  it('there is SQL to search — a guard that measures nothing is worse than none', () => {
    expect(sqlInOrder().length).toBeGreaterThan(200);
  });

  it.each(REVOKED_HERE)('%s revokes SELECT from anon', (table) => {
    expect(`${table}: anon SELECT explicitly revoked: ${anonSelectRevoked(table)}`)
      .toBe(`${table}: anon SELECT explicitly revoked: true`);
  });

  it('the revokes are in ONE migration, so the reasoning is in one place', () => {
    const mig = fs.readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql')).sort()
      .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      .find((s2) => REVOKED_HERE.every((t) => new RegExp(`on public\\.${t}\\s+from anon`, 'i').test(s2)));
    expect(`one migration closes all four: ${Boolean(mig)}`).toBe('one migration closes all four: true');
  });
});
