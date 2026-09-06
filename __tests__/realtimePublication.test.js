// Drift guard: every table a client subscribes to with `postgres_changes` must be a
// MEMBER of the supabase_realtime publication in the tracked SQL.
//
// THE FINDING THIS ENCODES. Supabase's postgres_changes only emits rows for tables in
// that publication. The web app subscribed to `public.notifications` in two places —
// web/lib/notifications.ts (the nav alerts badge) and web/app/(app)/notifications/page.tsx
// (the inbox) — and no statement anywhere in the repo ever added that table. Both channels
// opened a realtime connection and delivered nothing; the badge only moved because
// AppShell re-fetches on every navigation, a workaround whose own comment says the
// channels "can miss updates". 20260906110000 adds the table; this test is what stops the
// next subscription being written against a table nobody publishes.
//
// It fails on the code as it stood before that migration: the replay below produces
// {bookings, jobs, messages, payments} and `notifications` is missing from it.
//
// THREE DOMAIN FACTS ENCODED HERE:
//   1. The publication is defined ONLY in the legacy files (supabase/*.sql), which are
//      applied before supabase/migrations/ — so the replay reads both, legacy first.
//   2. `DROP PUBLICATION` resets the member set, so the statements have to be replayed in
//      order rather than merely collected.
//   3. Comments are stripped first. This repo has had four guards satisfied by the prose
//      explaining them, and 20260906110000's own header quotes every statement below.
//      Rolled-back probe blocks are dropped for the same reason: that migration stages a
//      removal to prove its assertion discriminates, and a replay that believed it would
//      conclude the table is unpublished.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

// Drop `do $$ … $$` blocks that announce themselves as rolled-back probes.
const stripRolledBackProbes = (sql) =>
  sql.replace(/do\s*\$\$[\s\S]*?\$\$\s*;?/gi, (block) => (/rolling back/i.test(block) ? '' : block));

function sqlFiles() {
  const legacy = fs
    .readdirSync(LEGACY_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(LEGACY_DIR, f));
  const tracked = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIG_DIR, f));
  return [...legacy, ...tracked];
}

const tableList = (raw) =>
  raw
    .split(',')
    .map((t) => t.trim().replace(/^public\./i, '').replace(/["';]/g, '').toLowerCase())
    .filter(Boolean);

// Replay every publication statement in apply order and return the resulting member set.
function publicationMembers() {
  const members = new Set();
  const stmt =
    /(drop\s+publication\s+(?:if\s+exists\s+)?supabase_realtime)|(create\s+publication\s+supabase_realtime(?:\s+for\s+table\s+([^;]+))?)|(alter\s+publication\s+supabase_realtime\s+(add|drop)\s+table\s+([^;]+))/gi;
  for (const file of sqlFiles()) {
    const sql = stripRolledBackProbes(stripComments(fs.readFileSync(file, 'utf8')));
    let m;
    stmt.lastIndex = 0;
    while ((m = stmt.exec(sql))) {
      if (m[1]) members.clear();
      else if (m[2]) {
        members.clear();
        tableList(m[3] || '').forEach((t) => members.add(t));
      } else if (m[4]) {
        const verb = m[5].toLowerCase();
        tableList(m[6]).forEach((t) => (verb === 'add' ? members.add(t) : members.delete(t)));
      }
    }
  }
  return members;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Every `.on('postgres_changes', { … table: 'x' … })` in either client.
function subscriptions() {
  const found = [];
  const re = /postgres_changes[\s\S]{0,400}?table:\s*["']([A-Za-z_]+)["']/g;
  for (const dir of [path.join(ROOT, 'src'), path.join(ROOT, 'web'), path.join(ROOT, 'admin')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const text = fs.readFileSync(file, 'utf8');
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) found.push({ file: path.relative(ROOT, file), table: m[1].toLowerCase() });
    }
  }
  return found;
}

describe('supabase_realtime publication vs postgres_changes subscribers', () => {
  const members = publicationMembers();
  const subs = subscriptions();

  it('finds the publication statements at all', () => {
    // If this drops to zero the replay has stopped measuring anything and every other
    // assertion here becomes vacuously true.
    expect([...members].sort()).toEqual(expect.arrayContaining(['bookings', 'jobs', 'messages', 'payments']));
  });

  it('finds the client subscriptions at all', () => {
    expect(subs.length).toBeGreaterThanOrEqual(5);
  });

  it('publishes every table a client subscribes to', () => {
    const missing = subs
      .filter((s) => !members.has(s.table))
      .map((s) => `${s.file} subscribes to public.${s.table}, which no SQL adds to supabase_realtime`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('reports a table nobody publishes as absent', () => {
    // Non-vacuous in the other direction: a replay that returned every table it saw named
    // anywhere would pass the assertion above without measuring anything. `profiles` is
    // written on every rating, XP change and edit, and is deliberately not published.
    expect(members.has('profiles')).toBe(false);
  });

  // NOT asserted, deliberately: `jobs` and `payments` are members with no live subscriber
  // left in either client. That is a stale membership, not a broken feature — an extra
  // member costs replication work but breaks nothing — and turning it into a failure here
  // would make this guard fire for a reason unrelated to the one it exists for.
});
