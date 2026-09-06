const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A party-scoped policy must never establish "party" by reading public.jobs inline.
//
// An RLS policy's subquery is evaluated as the QUERYING role, so RLS on the tables it
// reads applies too — the reason private.is_blocked_pair exists at all
// (20260710030000_block_enforcement.sql:18-30). Since 20260726070000 the jobs SELECT
// policy is `poster_id = auth.uid() or not private.is_suspended(jobs.poster_id)`, so a
// suspended poster's jobs row is invisible to everyone else.
//
// Every party policy used to write `... join public.jobs j on j.id = b.job_id where
// (b.earner_id = auth.uid() or j.poster_id = auth.uid())`. For the EARNER on a suspended
// poster's booking that inner join yields nothing, so suspending a poster deleted — from
// the earner's view only — the message thread, the chat photos, the completion photos and
// the dispute. Which is precisely the evidence of the report that caused the suspension.
//
// The fix is private.is_booking_party (20260906041000), a SECURITY DEFINER helper that
// asks the same question as the owner. This test replays every create/drop the way
// Postgres would and fails if the FINAL definition of any party policy has gone back to
// inlining the jobs read. Written against the pre-fix tree it fails on all five policies.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

// Applied order: the hand-run legacy files, then the CLI-tracked timestamped ones.
function migrationFilesInApplyOrder() {
  const legacy = fs
    .readdirSync(LEGACY_DIR)
    .filter((f) => /^migration_.*\.sql$/.test(f))
    .sort()
    .map((f) => path.join(LEGACY_DIR, f));
  const tracked = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort() // filenames are timestamp-prefixed, so lexical === chronological
    .map((f) => path.join(MIG_DIR, f));
  return [...legacy, ...tracked];
}

// Strip `--` line comments: every one of these files opens with a banner that quotes the
// very policy shape it is removing, and a comment must never be read as live SQL.
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

// Replay create/drop policy for one table; return the surviving definitions.
// Keyed by policy name -> { body, file }, where body is everything after `on <table>`.
function finalPolicies(table) {
  const escaped = table.replace('.', '\\.');
  const dropRe = new RegExp(`drop\\s+policy\\s+(?:if\\s+exists\\s+)?"([^"]+)"\\s+on\\s+${escaped}`, 'i');
  const createRe = new RegExp(`create\\s+policy\\s+"([^"]+)"\\s+on\\s+${escaped}([\\s\\S]*)$`, 'i');
  const tableRe = new RegExp(escaped, 'i');

  const live = new Map();
  for (const file of migrationFilesInApplyOrder()) {
    const sql = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file);
    for (const stmt of sql.split(';')) {
      if (!tableRe.test(stmt)) continue;
      const drop = stmt.match(dropRe);
      if (drop) {
        live.delete(drop[1]);
        continue;
      }
      const create = stmt.match(createRe);
      if (create) live.set(create[1], { body: create[2], file: rel });
    }
  }
  return live;
}

// The policies whose whole job is "is this caller a party to the booking".
const PARTY_POLICIES = [
  ['messages_read', 'public.messages'],
  ['messages_insert', 'public.messages'],
  ['disputes_select_parties', 'public.disputes'],
  ['chat_photos_party_read', 'storage.objects'],
  ['completion_party_read', 'storage.objects'],
];

const byTable = new Map();
function policy(name, table) {
  if (!byTable.has(table)) byTable.set(table, finalPolicies(table));
  return byTable.get(table).get(name);
}

describe('party-scoped RLS survives a suspended counterparty', () => {
  test('the replay finds every party policy (guards the parser itself)', () => {
    const missing = PARTY_POLICIES.filter(([name, table]) => !policy(name, table)).map(
      ([name]) => name,
    );
    expect(missing).toEqual([]);
  });

  test.each(PARTY_POLICIES)('%s does not read public.jobs inline', (name, table) => {
    const p = policy(name, table);
    expect(p).toBeDefined();
    // A jobs read inside the policy inherits jobs_select_all, which hides suspended
    // posters — turning a Browse visibility rule into an authorization test it was
    // never meant to be.
    expect(p.body).not.toMatch(/public\.jobs/i);
  });

  test.each(PARTY_POLICIES)('%s establishes party through private.is_booking_party', (name, table) => {
    const p = policy(name, table);
    expect(p).toBeDefined();
    expect(p.body).toMatch(/private\.is_booking_party\s*\(/i);
  });

  test('messages_insert still carries the block and suspended-sender checks', () => {
    // 20260710030000 (blocks) and 20260730150000 (suspended sender) have each been
    // re-derived from this policy once already; a rewrite that drops one is silent.
    const p = policy('messages_insert', 'public.messages');
    expect(p.body).toMatch(/not\s+private\.booking_parties_blocked\s*\(/i);
    expect(p.body).toMatch(/not\s+private\.is_suspended\s*\(\s*auth\.uid\(\)\s*\)/i);
    expect(p.body).toMatch(/sender_id\s*=\s*auth\.uid\(\)/i);
  });

  test('jobs_select_all still hides a suspended poster from Browse', () => {
    // The fix must not "fix" Browse. Hiding the listings is correct and is the one
    // thing 20260726070000 actually set out to do.
    const p = policy('jobs_select_all', 'public.jobs');
    expect(p).toBeDefined();
    expect(p.body).toMatch(/private\.is_suspended\s*\(\s*jobs\.poster_id\s*\)/i);
  });
});

describe('private.is_booking_party is a definer helper, not an RPC oracle', () => {
  // Read lazily: if the migration is gone, that must fail as an assertion about the
  // missing fix, not by taking the whole suite down before the policy tests run.
  const FIX = path.join(MIG_DIR, '20260906041000_party_checks_ignore_suspension.sql');
  const read = () => (fs.existsSync(FIX) ? fs.readFileSync(FIX, 'utf8') : '');

  test('the migration that introduces the helpers is present', () => {
    expect(fs.existsSync(FIX)).toBe(true);
  });

  test.each([['is_booking_party'], ['booking_parties_blocked']])(
    'private.%s runs as the owner',
    (fn) => {
      const src = read();
      const decl = src.match(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+private\\.${fn}\\s*\\([\\s\\S]*?\\$\\$;`, 'i'),
      );
      expect(decl).not.toBeNull();
      expect(decl[0]).toMatch(/security\s+definer/i);
      // `private` is not served by PostgREST, which is what stops a caller-supplied-uid
      // helper becoming a boolean oracle over other people's bookings.
      expect(src).toMatch(new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+private\\.${fn}\\b[\\s\\S]*?from\\s+public,\\s*anon`, 'i'));
      expect(src).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+private\\.${fn}\\b[\\s\\S]*?to\\s+authenticated`, 'i'));
    },
  );

  test('the migration asserts its own effect and rolls the probe back', () => {
    const src = read();
    expect(src).toMatch(/FIX FAILED/);
    expect(src).toMatch(/rolling back/);
  });
});
