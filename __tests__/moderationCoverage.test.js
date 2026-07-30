const fs = require('fs');
const path = require('path');

// Every user-authored string that reaches another user's screen is supposed to
// pass public.contains_prohibited. jobs.location did not — at any layer — and it
// is free text (LocationPicker commits whatever is typed; its autocomplete is a
// suggestion, not a constraint) rendered on the Browse card, the gig header, the
// location filter chips and the Market Insights rollup. So it was a free slot for
// a slur or an off-platform phone number, sitting between two fields that were
// filtered.
//
// Pinning "location is checked" alone would be worth little — the next column
// added to jobs would repeat the bug. This reconstructs the FINAL effective body
// of guard_prohibited_content the way Postgres would (last definition wins across
// legacy supabase/migration_*.sql then supabase/migrations/*.sql in timestamp
// order) and asserts the whole expected column set, so a new free-text column
// that nobody wired into the backstop fails here rather than in the feed.
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

// The body of the LAST `create or replace function public.guard_prohibited_content`
// across the whole applied sequence.
function finalGuardBody() {
  let body = null;
  for (const file of migrationFilesInApplyOrder()) {
    const sql = fs.readFileSync(file, 'utf8');
    const marker = 'create or replace function public.guard_prohibited_content()';
    let from = 0;
    for (;;) {
      const i = sql.indexOf(marker, from);
      if (i < 0) break;
      const end = sql.indexOf('$$;', i);
      if (end < 0) break;
      body = { sql: sql.slice(i, end + 3), file: path.basename(file) };
      from = end + 3;
    }
  }
  return body;
}

// The branch of the guard handling one table, so a column checked for a DIFFERENT
// table can't be mistaken for coverage of this one.
function branchFor(body, table) {
  const start = body.indexOf(`TG_TABLE_NAME = '${table}'`);
  if (start < 0) return null;
  const rest = body.slice(start);
  const next = rest.indexOf("elsif TG_TABLE_NAME", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('server-side moderation backstop coverage', () => {
  const guard = finalGuardBody();

  test('a definition of guard_prohibited_content exists in the applied sequence', () => {
    expect(guard).not.toBeNull();
  });

  test('the service_role bypass survives — losing it filters admin and edge writes', () => {
    // A previous rewrite of this trigger silently dropped this line, which would
    // have subjected every admin-console and edge-function write to the keyword
    // filter. It is the single most important line in the function.
    expect(guard.sql).toMatch(/auth\.role\(\)[^;]*=\s*'service_role'/);
  });

  // Every free-text jobs column a browsing user can see.
  const JOB_TEXT_COLUMNS = ['title', 'description', 'category', 'location', 'tags', 'hazards'];

  test.each(JOB_TEXT_COLUMNS)('jobs.%s passes through contains_prohibited', (col) => {
    const branch = branchFor(guard.sql, 'jobs');
    expect(branch).not.toBeNull();
    expect(branch).toContain(`new.${col}`);
  });

  // Fields on other tables that were wired up in earlier rounds; kept here so a
  // future rewrite that drops one is caught.
  const OTHER_COVERAGE = [
    ['messages', 'text'],
    ['reviews', 'text'],
    ['profiles', 'name'],
    ['profiles', 'username'],
    ['profiles', 'bio'],
    ['bookings', 'application_note'],
  ];

  test.each(OTHER_COVERAGE)('%s.%s stays covered', (table, col) => {
    const branch = branchFor(guard.sql, table);
    expect(branch).not.toBeNull();
    expect(branch).toContain(`new.${col}`);
  });
});
