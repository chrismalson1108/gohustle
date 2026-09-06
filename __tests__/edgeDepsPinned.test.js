// ─────────────────────────────────────────────────────────────────────────────
// Every edge function names an EXACT dependency version, because nothing else does.
//
// All 32 functions imported `npm:@supabase/supabase-js@2` and `npm:stripe@22` — floating
// majors — and `deno.lock` is gitignored, so no resolution travels with the code. Each
// `supabase functions deploy <name>` is a separate resolution at a separate moment, and
// the functions are deployed BY HAND, one at a time, on whatever day each was last
// touched. So the fleet runs whatever minor was newest when each function happened to
// ship: a fix to stripe-capture-payment picks up a new supabase-js while accept-booking
// and stripe-cancel-payment, deployed weeks earlier, keep the old one.
//
// The local check does not see it either. `deno check --node-modules-dir=none` resolves
// through Deno's GLOBAL cache, so it type-checks against whatever the developer's machine
// happens to hold — green locally, a different library in production. When it broke, it
// would break in ONE function, with no diff anywhere that explains it.
//
// Measured 2026-09-06: the specifier `npm:@supabase/supabase-js@2` resolved to 2.112.3
// while the app's own lockfile held 2.108.1 and the console's 2.110.0.
//
// This is the same trade stripeApiVersion.test.js makes for the wire API version, and it
// is NOT the same pin: that guard fixes the version we SEND and asserts only a stripe
// MAJOR, so the library underneath it drifted exactly as supabase-js did.
//
// ── CHANGING A VERSION ───────────────────────────────────────────────────────
// Edit every import site (they must agree — this test enforces that too), then
// `deno check --node-modules-dir=none` each function you touched.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN_DIR = path.join(__dirname, '..', 'supabase', 'functions');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && p.endsWith('.ts') ? [p] : [];
  });
}

// Module specifiers only. A bare `https://…` string elsewhere in a function is an API
// endpoint (Resend, Expo push, Anthropic) and has nothing to do with dependency
// resolution — a guard that flagged those would be deleted within the week.
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const files = walk(FN_DIR).map((p) => ({
  name: path.relative(FN_DIR, p),
  src: fs.readFileSync(p, 'utf8'),
}));

const REMOTE = /^(npm:|jsr:|https?:)/;
// npm:@scope/name@1.2.3 · npm:name@1.2.3 · jsr:@scope/name@1.2.3 — a full x.y.z, with an
// optional prerelease tag. `@2` and `@2.112` both fail: only the third component makes
// the resolution reproducible.
const PINNED = /^(?:npm|jsr):(@[^/@]+\/)?[^@/]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const remoteSpecifiers = [];
for (const f of files) {
  for (const m of f.src.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2];
    if (REMOTE.test(spec)) remoteSpecifiers.push({ file: f.name, spec });
  }
}

describe('edge function dependencies are pinned to an exact version', () => {
  it('found the import sites', () => {
    // Sanity: if the scanner stops matching, everything below passes vacuously.
    expect(remoteSpecifiers.length).toBeGreaterThan(40);
  });

  it('no specifier floats on a major or minor range', () => {
    const floating = remoteSpecifiers
      .filter((s) => !PINNED.test(s.spec))
      .map((s) => `${s.file} → ${s.spec}`);
    expect(floating).toEqual([]);
  });

  it('every function agrees on the version of a given package', () => {
    // One function on a different minor is the drift this whole file is about; pinning
    // each site independently would let it happen inside the repo instead of at deploy.
    const byPkg = new Map();
    for (const { spec } of remoteSpecifiers) {
      const at = spec.lastIndexOf('@');
      const pkg = spec.slice(0, at);
      if (!byPkg.has(pkg)) byPkg.set(pkg, new Set());
      byPkg.get(pkg).add(spec.slice(at + 1));
    }
    const split = [...byPkg.entries()]
      .filter(([, versions]) => versions.size > 1)
      .map(([pkg, versions]) => `${pkg}: ${[...versions].sort().join(', ')}`);
    expect(split).toEqual([]);
  });

  it('no remote import bypasses npm:/jsr: for a raw URL', () => {
    // A https:// module specifier has no version semantics we can check at all, and
    // deno.land/std URLs are how a function ends up frozen on a two-year-old std lib.
    const urls = remoteSpecifiers
      .filter((s) => /^https?:/.test(s.spec))
      .map((s) => `${s.file} → ${s.spec}`);
    expect(urls).toEqual([]);
  });
});
