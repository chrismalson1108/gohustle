const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// No SECURITY DEFINER function in `public` may be callable with the embedded anon
// key — with exactly one deliberate exception.
//
// 20260726080000_revoke_anon_execute_definer_fns.sql established that rule and
// verified it against production. But it enforced it with a one-time SWEEP, not a
// change to the schema's default privileges: stock Supabase keeps granting EXECUTE
// on every new function in `public` to `anon`, and Postgres keeps granting its own
// built-in EXECUTE default to PUBLIC. So the clock restarts for each function
// written afterwards, and the natural thing to write —
//     grant execute on function public.f(text) to authenticated;
// with no matching revoke — ships an anon-callable definer RPC. Two did:
// resolve_category_slug(text) (2026-08-05) and the 4-arg capped_override_bps
// (2026-08-14, where adding a defaulted parameter created a NEW function rather
// than replacing the revoked 3-arg one). Both were closed by 20260906081000.
//
// A sweep fixes today. This is what makes tomorrow's function fail loudly: it
// replays the whole privilege history off disk the way Postgres would apply it —
// legacy schema.sql + migration_*.sql first, then the timestamped migrations in
// order — and fails naming any definer function left executable by anon.
//
// The model, and why each rule is the way it is:
//   · a function's identity is (name, argument count) — a close-enough stand-in for
//     Postgres's (name, argument types), and coarse enough to stay readable while
//     still separating capped_override_bps/3 from capped_override_bps/4, which is
//     precisely the distinction the second bug turned on;
//   · a NEW signature inherits Supabase's default grant, so it starts anon-executable;
//   · `create or replace` of a signature that already exists preserves its ACL, which
//     is why the many definer functions rewritten after 2026-07-26 are not findings;
//   · `revoke ... from anon` alone does NOT close a function — PUBLIC's built-in
//     EXECUTE default lets anon straight back in, which is the incomplete verb that
//     20260702000000 and 20260726080000 each fixed one half of. Both roles must be
//     revoked;
//   · the 2026-07-26 sweep is applied at its position in the sequence.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const SWEEP = '20260726080000_revoke_anon_execute_definer_fns.sql';

// The one definer function that is MEANT to answer without a session: a gig share
// link is opened by a friend who has no account (20260806200000:133). Adding to this
// list is a deliberate decision to publish an unauthenticated endpoint.
const ANON_ALLOWED = new Set(['view_gig_share/1']);

function filesInApplyOrder() {
  const legacy = fs
    .readdirSync(LEGACY_DIR)
    .filter((f) => /^(schema|migration_.*)\.sql$/.test(f))
    .sort()
    .map((f) => path.join(LEGACY_DIR, f));
  const tracked = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort() // filenames are timestamp-prefixed, so lexical === chronological
    .map((f) => path.join(MIG_DIR, f));
  return [...legacy, ...tracked];
}

// Strip `--` comments (the prose banners quote the very grants being discussed) and
// every dollar-quoted body. Dropping bodies is what keeps a DO block's staged probe
// function, or a `revoke` hidden in an `execute '...'` string, from being read as a
// live statement — only the function HEADER, which sits before `as $$`, is needed.
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, ' ');
}

// Balanced-paren scan from the '(' at `open`.
function matchParens(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

// Top-level commas only, so numeric(10,2) and text[] count as one argument.
function argCount(argList) {
  const s = argList.trim();
  if (!s) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) n += 1;
  }
  return n;
}

function replay() {
  const live = new Map(); // "name/argc" -> { definer, trigger, anon, pub, createdIn }

  for (const file of filesInApplyOrder()) {
    const rel = path.relative(ROOT, file);
    const sql = stripNoise(fs.readFileSync(file, 'utf8')).toLowerCase();

    // ── create [or replace] function ──
    const create = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/g;
    let c;
    while ((c = create.exec(sql))) {
      const paren = matchParens(sql, create.lastIndex - 1);
      if (!paren) continue;
      const key = `${c[1]}/${argCount(paren.inner)}`;
      // Bodies are gone, so the statement's own `;` ends the header.
      const header = sql.slice(paren.end, paren.end + 800).split(';')[0];
      const prev = live.get(key);
      live.set(key, {
        definer: /security\s+definer/.test(header),
        trigger: /returns\s+trigger/.test(header),
        anon: prev ? prev.anon : true, // a new signature arrives with the default grant
        pub: prev ? prev.pub : true, // ...and with Postgres's built-in PUBLIC default
        createdIn: prev ? prev.createdIn : rel,
        lastTouchedIn: rel,
      });
    }

    // ── grant / revoke execute ──
    const acl = /(grant|revoke)\s+execute\s+on\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/g;
    let a;
    while ((a = acl.exec(sql))) {
      const paren = matchParens(sql, acl.lastIndex - 1);
      if (!paren) continue;
      const roles = (sql.slice(paren.end, paren.end + 250).match(/^\s*(?:from|to)\s+([^;]*);/) || [, ''])[1];
      const entry = live.get(`${a[2]}/${argCount(paren.inner)}`);
      if (!entry) continue;
      const granting = a[1] === 'grant';
      if (/\banon\b/.test(roles)) entry.anon = granting;
      if (/\bpublic\b/.test(roles)) entry.pub = granting;
    }

    // ── drop function ──
    const drop = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/g;
    let d;
    while ((d = drop.exec(sql))) {
      const paren = matchParens(sql, drop.lastIndex - 1);
      if (paren) live.delete(`${d[1]}/${argCount(paren.inner)}`);
    }

    // ── the 2026-07-26 blanket sweep, applied where it actually ran ──
    if (path.basename(file) === SWEEP) {
      for (const v of live.values()) if (v.definer) v.anon = false;
    }
  }

  return live;
}

describe('the anon EXECUTE surface of SECURITY DEFINER functions', () => {
  const live = replay();
  const definer = [...live.entries()].filter(([, v]) => v.definer && !v.trigger);

  test('the replay actually found the definer surface', () => {
    // A parser that silently matched nothing would make every assertion below vacuous.
    expect(definer.length).toBeGreaterThan(100);
    expect(live.has('resolve_category_slug/1')).toBe(true);
    expect(live.has('view_gig_share/1')).toBe(true);
  });

  test('no definer function is callable by anon, except the one that is meant to be', () => {
    // anon reaches a function through its own grant OR through PUBLIC's default; a
    // revoke that names only one role leaves the other door open.
    const reachable = definer
      .filter(([key, v]) => (v.anon || v.pub) && !ANON_ALLOWED.has(key))
      .map(([key, v]) => `${key} (created in ${path.basename(v.createdIn)})`)
      .sort();

    // Written as an equality so the failure names the function and the file that
    // introduced it, which is the whole point — the next one must be obvious.
    expect(reachable).toEqual([]);
  });

  test('the deliberate exception is still deliberate', () => {
    // If a future sweep takes view_gig_share with it, every share link already in
    // someone's messages stops resolving. That is a louder failure than a leak.
    const share = live.get('view_gig_share/1');
    expect(share.definer).toBe(true);
    expect(share.anon).toBe(true);
  });

  test('the two that drifted are closed by the migration that closed them', () => {
    // Pinned by name: these are the functions the 2026-09-06 audit found sitting on
    // the post-sweep default, and a revert of that migration must fail here.
    const fix = fs.readFileSync(
      path.join(MIG_DIR, '20260906081000_two_definer_rpcs_added_after_the_sweep_kept_anons_execute.sql'),
      'utf8',
    ).toLowerCase();
    expect(fix).toContain('revoke execute on function public.resolve_category_slug(text) from public, anon;');
    expect(fix).toContain(
      'revoke execute on function public.capped_override_bps(integer, integer, integer, integer) from public, anon;',
    );
    // The callers that must keep working — the assistant under a user token, the
    // console Categories page under the service client.
    expect(fix).toContain(
      'grant execute on function public.resolve_category_slug(text) to authenticated, service_role;',
    );
  });

  test('the generator cannot reintroduce the gap on a fresh database', () => {
    // 20260805000000_dynamic_categories.sql is GENERATED (CLAUDE.md: never hand-edit
    // it). A rebuild from scripts/gen-categories-migration.js that still emitted a
    // bare grant would ship the same hole to the next fresh database, and the replay
    // above would keep passing because the standalone revoke migration follows it.
    const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-categories-migration.js'), 'utf8').toLowerCase();
    expect(gen).toContain('revoke execute on function public.resolve_category_slug(text) from public, anon;');
  });
});
