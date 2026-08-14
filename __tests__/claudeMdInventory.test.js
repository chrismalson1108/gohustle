const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE.md is the one document guaranteed to be read at the start of every session.
// docIndex.test.js already makes that true for the repo's OTHER documents; this makes
// it true for the repo's own deployable surfaces.
//
// The gap when this guard was written (re-measured, not taken from CLAUDE_MD_DRIFT.md —
// that register warns it contains at least one false finding of its own): 19 of 32 edge
// functions, 9 of 32 mobile screens and all 5 stack-root route names were named nowhere.
// An omission is not merely untidy here — the doc is what a session searches, so a
// surface it does not name is a surface that gets re-derived or re-broken. Eight of
// the missing functions move money or gate auth.
//
// WHY ONLY THREE CLASSES. "CLAUDE.md must name it" has to be genuinely true, or the
// guard cries wolf and the next session deletes it. It is true for:
//
//   1. edge functions — each is a separately deployed unit and the pre-push hook says
//      "deploy each one by hand". You cannot discharge that against a list you do not
//      have, and nothing else in the repo enumerates them.
//   2. mobile screens — CLAUDE.md already keeps a "Key Screens" table, so the doc has
//      committed to being the index; a screen missing from it reads as a screen that
//      does not exist.
//   3. route names — CLAUDE.md's own words: route names are "a wire protocol, not just
//      internal". navigate() takes a route name, and a wrong one fails silently.
//
// Deliberately NOT guarded here, because the obligation is weaker or already held:
//   · admin console pages — Nav.tsx IS the inventory and adminSurface.test.js already
//     pins every console directory to it, so the console is discoverable from code.
//     CLAUDE.md pointing at Nav.tsx is enough; 17 duplicated rows would just rot.
//   · test suites — a guard's obligation is legible from opening the guard, and the
//     suite runs on every push whether or not the doc names it.
//   · components — src/components is browsable and a wrong prop list is the real
//     hazard there, which parity.test.js already checks against the signatures.
//
// This proves a name is MENTIONED, not that what is said about it is true. That limit
// is inherent and accepted: 19 functions unnamed is the bigger problem than 19
// descriptions unaudited, and a prose claim cannot be mechanised anyway.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

// Substring matching would let `PublicProfileScreen` satisfy `ProfileScreen`, so every
// lookup below is bounded. Kebab and CamelCase need different neighbours.
const namesIt = (needle) =>
  new RegExp(`(^|[^A-Za-z0-9_-])${needle}([^A-Za-z0-9_-]|$)`).test(claude);

// An allowlist entry is a claim that the omission is deliberate, so it carries a reason
// and it must still describe something real — a stale exemption is drift wearing the
// costume of a decision.
const checkAllowlist = (allow, onDisk, label) => {
  describe(`${label} allowlist is honest`, () => {
    Object.entries(allow).forEach(([name, reason]) => {
      it(`${name}'s exemption is justified and current`, () => {
        expect(typeof reason === 'string' && reason.length > 10).toBe(true);
        expect(`${name}: ${onDisk.includes(name) ? 'on disk' : 'GONE — drop the stale exemption'}`)
          .toBe(`${name}: on disk`);
      });
    });
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Edge functions
// ─────────────────────────────────────────────────────────────────────────────
const FN_DIR = path.join(ROOT, 'supabase', 'functions');
const fns = fs
  .readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared') // _shared is a module dir, not deployable
  .map((d) => d.name)
  .sort();

// Empty on purpose. Every deployable function is worth one row — they are hand-deployed
// and there are ~32 of them, not hundreds. Add an entry only with a reason that would
// survive being read out loud to whoever has to deploy it.
const EDGE_EXEMPT = {};

describe('every edge function is discoverable from CLAUDE.md', () => {
  it('finds functions to check', () => {
    expect(fns.length).toBeGreaterThan(20);
  });

  fns.filter((fn) => !EDGE_EXEMPT[fn]).forEach((fn) => {
    it(`${fn} is named`, () => {
      expect(`${fn}: ${namesIt(fn) ? 'documented' : 'UNDOCUMENTED — add it to the edge function table in CLAUDE.md'}`)
        .toBe(`${fn}: documented`);
    });
  });
});
checkAllowlist(EDGE_EXEMPT, fns, 'edge function');

describe('CLAUDE.md never cites an edge function path that does not exist', () => {
  const cited = [...new Set([...claude.matchAll(/supabase\/functions\/([a-z0-9-]+)/g)].map((m) => m[1]))];

  it('finds citations to check', () => {
    expect(cited.length).toBeGreaterThan(0);
  });

  cited.forEach((fn) => {
    it(`supabase/functions/${fn} resolves`, () => {
      const exists = fn === '_shared' || fs.existsSync(path.join(FN_DIR, fn));
      expect(`${fn}: ${exists ? 'exists' : 'MISSING — renamed or deleted, fix CLAUDE.md'}`)
        .toBe(`${fn}: exists`);
    });
  });
});

// Two companions, because naming a function is not enough to deploy it safely.
describe('the two edge-deploy facts CLAUDE.md cannot omit', () => {
  // supabase/config.toml is the ONLY record of which functions are reached without a
  // Supabase JWT. Its own comment: without the entry, "the next plain `supabase
  // functions deploy` re-enables JWT verification and silently kills the alerting
  // channel". CLAUDE.md tells sessions to deploy each function by hand, so it has to
  // tell them where that list is.
  const toml = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const noJwt = [...toml.matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);

  it('finds verify_jwt entries to check', () => {
    expect(noJwt.length).toBeGreaterThan(3);
  });

  noJwt.forEach((fn) => {
    it(`${fn} (verify_jwt = false) is a real function`, () => {
      expect(fns).toContain(fn);
    });
  });

  it('CLAUDE.md points at the verify_jwt registry', () => {
    expect(claude).toMatch(/supabase\/config\.toml/);
  });

  // _shared/logError.ts landed after the "just console.error" instruction was written
  // and supersedes it: it writes edge failures into the same client_errors table the
  // console renders at /errors. A money function written to the older instruction fails
  // invisibly, which is the exact bug logError.ts was created to fix.
  it('CLAUDE.md names the edge error sink', () => {
    expect(fs.existsSync(path.join(FN_DIR, '_shared', 'logError.ts'))).toBe(true);
    expect(claude).toMatch(/logServerError|_shared\/logError\.ts/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Mobile screens
// ─────────────────────────────────────────────────────────────────────────────
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(path.join(dir, e.name))
      : e.name.endsWith('Screen.js')
        ? [e.name.replace(/\.js$/, '')]
        : [],
  );
const screens = walk(path.join(ROOT, 'src', 'screens')).sort();

// Empty on purpose. A screen is a destination a user can be standing on; there is no
// such thing as one a session may safely not know about.
const SCREEN_EXEMPT = {};

describe('every mobile screen is discoverable from CLAUDE.md', () => {
  it('finds screens to check', () => {
    expect(screens.length).toBeGreaterThan(20);
  });

  screens.filter((s) => !SCREEN_EXEMPT[s]).forEach((screen) => {
    it(`${screen} is named`, () => {
      expect(`${screen}: ${namesIt(screen) ? 'documented' : 'UNDOCUMENTED — add it to the Key Screens table in CLAUDE.md'}`)
        .toBe(`${screen}: documented`);
    });
  });
});
checkAllowlist(SCREEN_EXEMPT, screens, 'screen');

describe('CLAUDE.md never names a screen that does not exist', () => {
  // The other direction of the same drift: a renamed or deleted screen leaves the doc
  // sending sessions to a file that is not there.
  const cited = [...new Set([...claude.matchAll(/\b([A-Z][A-Za-z]*Screen)\b/g)].map((m) => m[1]))];

  it('finds screen names to check', () => {
    expect(cited.length).toBeGreaterThan(10);
  });

  cited.forEach((name) => {
    it(`${name} still exists`, () => {
      expect(`${name}: ${screens.includes(name) ? 'exists' : 'MISSING — renamed or deleted, fix CLAUDE.md'}`)
        .toBe(`${name}: exists`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Route names
// ─────────────────────────────────────────────────────────────────────────────
// The fence under "## Navigation" is the map a session copies navigate() targets from.
// It was written with the five stack roots as HomeScreen/EarnScreen/… — the COMPONENT
// names — while the real routes are HomeMain/EarnMain/…, which FloatingTabBar.js keys
// its show/hide behaviour off (HUB_ROUTES) and which PostJobScreen and PayoutSetupScreen
// both navigate to. navigate('ProfileScreen') matches nothing and fails silently.
const app = fs.readFileSync(path.join(ROOT, 'App.js'), 'utf8');
const routes = [...new Set([...app.matchAll(/<(?:Stack|Tab)\.Screen\s+name="([A-Za-z]+)"/g)].map((m) => m[1]))].sort();

const navSection = claude.split(/^## Navigation$/m)[1] || '';
const fence = navSection.split('```')[1] || '';

// Empty on purpose. A registered route absent from the fence is a navigate() target
// nobody can find; the fence is small enough to hold all of them.
const ROUTE_EXEMPT = {};

describe('every registered route is in the CLAUDE.md navigation tree', () => {
  it('finds the navigation fence', () => {
    expect(fence.length).toBeGreaterThan(200);
  });

  it('finds routes to check', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  routes.filter((r) => !ROUTE_EXEMPT[r]).forEach((route) => {
    it(`route ${route} appears in the nav tree`, () => {
      const found = new RegExp(`\\b${route}\\b`).test(fence);
      expect(`${route}: ${found ? 'mapped' : 'MISSING — add it to the ## Navigation fence in CLAUDE.md'}`)
        .toBe(`${route}: mapped`);
    });
  });
});
checkAllowlist(ROUTE_EXEMPT, routes, 'route');
