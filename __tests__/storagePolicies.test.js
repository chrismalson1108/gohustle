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
// Deleting an account must clear every bucket that account can write to.
//
// delete-account's BUCKETS list is hand-maintained and drifted: support-photos was
// missing, so a departing user's own support uploads survived their deletion —
// screenshots people attach to a ticket, which they attach precisely BECAUSE something
// went wrong. It was found by writing the CLAUDE.md inventory guard, not by anyone
// re-reading the list, which is the argument for asserting it instead of listing it.
//
// Buckets are read from the migrations that create them, so a NEW user-writable bucket
// fails this until it is either cleared on deletion or explicitly excused.
// ─────────────────────────────────────────────────────────────────────────────
describe('account deletion clears every bucket the user can write to', () => {
  const fnSrc = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'delete-account', 'index.ts'),
    'utf8',
  );

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

  const cleared = new Set(
    (fnSrc.match(/const BUCKETS = \[([\s\S]*?)\];/) ?? [, ''])[1]
      .match(/'([a-z0-9-]+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [],
  );

  it('found buckets on both sides', () => {
    expect(created.size).toBeGreaterThan(3);
    expect(cleared.size).toBeGreaterThan(3);
  });

  it('every created bucket is cleared on deletion, or excused with a reason', () => {
    const missing = [...created].filter((b) => !cleared.has(b) && !EXCUSED[b]);
    // Name the bucket — "coverage drifted" is not actionable.
    expect(missing).toEqual([]);
  });

  it('clears no bucket that does not exist', () => {
    const phantom = [...cleared].filter((b) => !created.has(b));
    expect(phantom).toEqual([]);
  });
});
