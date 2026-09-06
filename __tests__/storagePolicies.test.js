const fs = require('fs');
const path = require('path');

// Storage RLS is a pure DB privilege change with no JS seam, and it has a sharp
// edge that has now bitten twice: on storage.objects ONE `for select` policy
// governs both downloading an object and LISTING the bucket. A policy written as
//     create policy "x_public_read" on storage.objects
//       for select using (bucket_id = 'x');
// has no `to` clause, so it also applies to `anon` — which silently turns "these
// images are publicly viewable" into "the object index is publicly walkable by
// anyone holding the embedded anon key". That is how the whole user base (user
// ids + profile photos) became harvestable with no account
// (20260725000000_storage_enumeration_lockdown.sql).
//
// Rather than pin the two buckets that were wrong, this reconstructs the FINAL
// effective set of storage.objects policies the way Postgres would — legacy
// supabase/migration_*.sql first, then supabase/migrations/*.sql in timestamp
// order, with each create/drop replaying in sequence so the last definition wins
// — and asserts the invariant: no surviving SELECT policy may be bucket-wide and
// unrestricted. A new bucket added with the same copy-pasted mistake fails here
// instead of in production.
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

// Strip `--` line comments so the prose banners (which quote the very policies
// being removed) can never be mistaken for live SQL.
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

// Replay every create/drop against storage.objects; return the surviving policies.
function finalStoragePolicies() {
  const live = new Map(); // policy name -> { command, using, roles, file }

  for (const file of migrationFilesInApplyOrder()) {
    const sql = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file);

    for (const stmt of sql.split(';')) {
      if (!/storage\.objects/i.test(stmt)) continue;

      const drop = stmt.match(/drop\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+storage\.objects/i);
      if (drop) {
        live.delete(drop[1]);
        continue;
      }

      const create = stmt.match(/create\s+policy\s+"([^"]+)"\s+on\s+storage\.objects([\s\S]*)$/i);
      if (create) {
        const [, name, body] = create;
        const command = (body.match(/\bfor\s+(select|insert|update|delete|all)\b/i) || [, 'all'])[1].toLowerCase();
        const roles = (body.match(/\bto\s+([a-z_,\s]+?)(?=\busing\b|\bwith\s+check\b|$)/i) || [, ''])[1].trim();
        const usingClause = (body.match(/\busing\s*\(([\s\S]*)$/i) || [, ''])[1];
        live.set(name, { command, using: usingClause, roles, file: rel });
      }
    }
  }
  return live;
}

// A SELECT policy is safe if it narrows beyond "this bucket": it either scopes to
// the caller's own folder / a party check (auth.uid(), foldername, a subquery), or
// it is at minimum restricted away from anon via `to authenticated`.
function isRestricted({ using, roles }) {
  const scoped = /auth\.uid\(\)|foldername|exists\s*\(|select\s/i.test(using);
  const nonAnonRole = /\bauthenticated\b|\bservice_role\b/i.test(roles) && !/\banon\b/i.test(roles);
  return scoped || nonAnonRole;
}

describe('storage.objects RLS — no bucket is anonymously enumerable', () => {
  const live = finalStoragePolicies();

  test('the migration replay actually found policies (guards the parser itself)', () => {
    expect(live.size).toBeGreaterThan(0);
    expect([...live.values()].some((p) => p.command === 'select')).toBe(true);
  });

  test('every surviving SELECT policy is owner-scoped or non-anon', () => {
    const offenders = [...live.entries()]
      .filter(([, p]) => p.command === 'select' || p.command === 'all')
      .filter(([, p]) => !isRestricted(p))
      .map(([name, p]) => `${name} (${p.file}) USING(${p.using.trim().slice(0, 80)})`);

    // Anything listed here lets an unauthenticated caller walk the bucket index.
    expect(offenders).toEqual([]);
  });

  // 20260806360000 put the POSTER's dispute evidence in this bucket, on the stated
  // premise that "completion_party_read already lets EITHER booking party read it —
  // so the earner can see what they are accused of". It did not: the party branch
  // only ever unnested bookings.completion_photos/before_photos, and a dispute photo
  // lives under the poster's own folder in disputes.photos. The one person who could
  // not open the evidence was the person it was used against.
  test('the final completion_party_read reaches dispute evidence, not only the booking arrays', () => {
    const p = live.get('completion_party_read');
    expect(p).toBeDefined();
    expect(p.command).toBe('select');
    // The branch added by 20260905004000.
    expect(p.using).toMatch(/public\.disputes/i);
    // ...and the proof-of-work branch it was originally written for survives.
    expect(p.using).toMatch(/completion_photos/i);
  });

  test('the three buckets fixed in 20260725000000 are owner-scoped in the final state', () => {
    for (const name of ['avatars_owner_list', 'job_photos_owner_list', 'certificates_owner_list']) {
      const p = live.get(name);
      expect(p).toBeDefined();
      expect(p.command).toBe('select');
      expect(p.using).toMatch(/foldername\(name\)\)\[1\]\s*=\s*auth\.uid\(\)/i);
    }
    // ...and the unrestricted originals are gone.
    expect(live.has('avatars_public_read')).toBe(false);
    expect(live.has('job_photos_public_read')).toBe(false);
    expect(live.has('certificates_public_read')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deleting an account must clear every bucket that account can write to — from
// EITHER deletion path — and a data-access export must list every one of them.
//
// delete-account's BUCKETS list is hand-maintained and drifted: support-photos was
// missing, so a departing user's own support uploads survived their deletion —
// screenshots people attach to a ticket, which they attach precisely BECAUSE something
// went wrong. It was found by writing the CLAUDE.md inventory guard, not by anyone
// re-reading the list, which is the argument for asserting it instead of listing it.
//
// Then it drifted again in the two places this test was not looking: the console's port
// (admin/lib/deleteUser.ts) and the GDPR export route both kept the old six-bucket list,
// so an account deleted by an admin kept its support screenshots and a data-access
// request came back quietly incomplete. Reading only the edge function is how the same
// omission recurred one directory over, so all three lists are read here.
//
// Buckets are read from the migrations that create them, so a NEW user-writable bucket
// fails this until it is either cleared on deletion or explicitly excused.
// ─────────────────────────────────────────────────────────────────────────────
describe('account deletion clears every bucket the user can write to', () => {
  // Every hand-maintained copy of the list, and what it is for.
  const LISTS = [
    ['supabase/functions/delete-account/index.ts (self-service deletion)',
      path.join(ROOT, 'supabase', 'functions', 'delete-account', 'index.ts')],
    ['admin/lib/deleteUser.ts (console deletion)',
      path.join(ROOT, 'admin', 'lib', 'deleteUser.ts')],
    ['admin/app/(console)/users/[id]/export/route.ts (GDPR export)',
      path.join(ROOT, 'admin', 'app', '(console)', 'users', '[id]', 'export', 'route.ts')],
  ];

  // Buckets deliberately NOT cleared, each with the reason it is someone else's record.
  const EXCUSED = {
    // Nothing today. Add with a reason, never to silence a failure.
  };

  const allSql = [LEGACY_DIR, MIG_DIR]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.sql')).map((f) => path.join(d, f)))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  // storage.buckets rows created anywhere in the schema.
  const created = new Set(
    [...allSql.matchAll(/insert into storage\.buckets[\s\S]{0,200}?values\s*\(\s*'([a-z0-9-]+)'/gi)]
      .map((m) => m[1]),
  );

  // Quotes differ between the Deno function (single) and the console (double).
  const bucketsIn = (file) => new Set(
    (fs.readFileSync(file, 'utf8').match(/const BUCKETS = \[([\s\S]*?)\];/) ?? [, ''])[1]
      .match(/["']([a-z0-9-]+)["']/g)?.map((s) => s.replace(/["']/g, '')) ?? [],
  );

  it('found buckets on both sides', () => {
    expect(created.size).toBeGreaterThan(3);
    for (const [, file] of LISTS) expect(bucketsIn(file).size).toBeGreaterThan(3);
  });

  it.each(LISTS)('%s covers every created bucket, or excuses it with a reason', (_name, file) => {
    const cleared = bucketsIn(file);
    const missing = [...created].filter((b) => !cleared.has(b) && !EXCUSED[b]);
    // Name the bucket — "coverage drifted" is not actionable.
    expect(missing).toEqual([]);
  });

  it.each(LISTS)('%s names no bucket that does not exist', (_name, file) => {
    const phantom = [...bucketsIn(file)].filter((b) => !created.has(b));
    expect(phantom).toEqual([]);
  });

  it('the three lists agree with each other', () => {
    // They are three copies of one fact. A future bucket added to one of them and not
    // the others fails here even before the created-vs-cleared check can catch it.
    const sets = LISTS.map(([name, file]) => [name, [...bucketsIn(file)].sort()]);
    const [, first] = sets[0];
    for (const [name, list] of sets.slice(1)) {
      expect(`${name}: ${list.join(',')}`).toBe(`${name}: ${first.join(',')}`);
    }
  });
});
