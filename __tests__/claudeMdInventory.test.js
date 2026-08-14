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
// WHY THESE CLASSES. "CLAUDE.md must name it" has to be genuinely true, or the guard
// cries wolf and the next session deletes it. The test that decides is whether the doc
// is the ONLY inventory. It is, for:
//
//   1. edge functions — each is a separately deployed unit and the pre-push hook says
//      "deploy each one by hand". You cannot discharge that against a list you do not
//      have, and nothing else in the repo enumerates them.
//   2. mobile screens — CLAUDE.md already keeps a "Key Screens" table, so the doc has
//      committed to being the index; a screen missing from it reads as a screen that
//      does not exist.
//   3. route names — CLAUDE.md's own words: route names are "a wire protocol, not just
//      internal". navigate() takes a route name, and a wrong one fails silently.
//   4. tables — see §4. No generated database.types.ts exists here, so "does a table
//      for this already exist?" has no answer short of 66 CREATE TABLE statements
//      spread over 188 migrations and 32 legacy files.
//
// Deliberately NOT guarded name-by-name, because a second live inventory already holds:
//   · admin console pages — Nav.tsx IS the inventory and adminSurface.test.js already
//     pins every console directory to it, so the console is discoverable from code.
//     CLAUDE.md pointing at Nav.tsx is enough; 17 duplicated rows would just rot.
//   · controls — same argument, and §5 guards what is left over instead: the registry
//     table is the roster and adminSurface.test.js already fails on an unregistered
//     ctl_* function, so what prose owns is the COUNT, and the count is what rotted.
//   · test suites — 60 exist and CLAUDE.md names 17. Naming all 60 cannot fail
//     usefully: a suite runs on every push whether or not the doc names it, and what it
//     protects is legible from opening it. The nine in the "Definition of done" table
//     are there because their obligation is NOT legible that way — the second half of
//     the change lives in a different file from the first — and that is a curated
//     argument a completeness guard would flatten into a directory listing.
//   · components — 34 exist and CLAUDE.md names 23. The hazard here is a WRONG prop
//     list, not an absent name: an unfamiliar component is one `ls src/components`
//     away, but a documented <MessageSheet> missing `visible` renders a modal that
//     never appears, which is exactly what happened. parity.test.js already checks the
//     documented props of the components the doc details against their real signatures,
//     and importIntegrity.test.js catches use-without-import. That rationale is load
//     bearing, so §6 asserts the check it leans on still exists; the remaining eleven
//     are leaf UI (presentational cards, plus input/utility pieces like KeyboardDoneBar,
//     TagInput, StudentVerifyModal, SafetyBar and WorkStatusBar) whose names would add
//     rows to the doc and no checks to this guard.
//
// This proves a name is MENTIONED, not that what is said about it is true. That limit
// is inherent and accepted: 19 functions unnamed is the bigger problem than 19
// descriptions unaudited, and a prose claim cannot be mechanised anyway. §5's count is
// the one exception — a number is the rare prose claim that CAN be recounted.
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

// ─────────────────────────────────────────────────────────────────────────────
// The SQL corpus, shared by §4 and §5.
// ─────────────────────────────────────────────────────────────────────────────
// Reading supabase/migrations/ alone would be wrong, and wrong in the direction that
// matters: jobs, bookings, profiles, payments and messages are created ONLY in
// schema.sql and the legacy supabase/migration_*.sql files. migrations/ holds the
// guards, policies and triggers layered on top of them. An enumerator pointed at
// migrations/ finds 35 of the 66 tables and reports the five a session touches most as
// nonexistent — so the legacy directory is not a nicety here, it is half the schema.
const readSqlDir = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));

const migrationSql = readSqlDir(path.join(ROOT, 'supabase', 'migrations')).join('\n');
const legacySql = readSqlDir(path.join(ROOT, 'supabase')).join('\n'); // non-recursive: the migration_*.sql + schema.sql set
const allSql = `${migrationSql}\n${legacySql}`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tables
// ─────────────────────────────────────────────────────────────────────────────
// The cost of an unnamed table is concrete and has a shape. refund_ledger and tip_ledger
// both make a UNIQUE index the idempotency check — the insert conflict IS the guard —
// and a session that does not know they exist writes the read-then-decide version and
// double-credits somebody. notification_preferences decides whether a push is allowed at
// all. Neither is discoverable by grepping for a name you have not heard.
const tables = [
  ...new Set(
    // The trailing `\(` is load-bearing: it stops `create table auth.foo (` from being
    // recorded as a table called "auth".
    [...allSql.matchAll(/create table (?:if not exists )?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi)].map((m) => m[1]),
  ),
].sort();

// Empty on purpose. A table is where the data actually is; there is no such thing as one
// a session may safely not know about, and the doc already named 46 of them unprompted.
const TABLE_EXEMPT = {};

describe('every table is discoverable from CLAUDE.md', () => {
  it('finds tables to check', () => {
    expect(tables.length).toBeGreaterThan(50);
  });

  // Same reasoning as the control count in §5: CLAUDE.md quotes these figures to argue
  // how much of the schema a migrations-only grep misses, and a figure nobody recounts
  // is a figure that drifts. Any phrasing is fine; the numbers in it have to be current.
  it('every number CLAUDE.md gives for tables matches the corpus', () => {
    const stated = [...claude.matchAll(/(\d+)\s+tables\b/g)].map((m) => Number(m[1]));
    expect(`stated: ${stated.join(', ') || 'NONE — CLAUDE.md must say how many tables there are'}`)
      .toBe(`stated: ${stated.map(() => tables.length).join(', ') || 'x'}`);
    expect(stated.length).toBeGreaterThan(0);
  });

  it('the migrations-only figure CLAUDE.md quotes is current', () => {
    const inMigrations = new Set(
      [...migrationSql.matchAll(/create table (?:if not exists )?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi)].map((m) => m[1]),
    );
    const stated = [...claude.matchAll(/(\d+) of the \d+ tables/g)].map((m) => Number(m[1]));
    expect(`migrations-only: ${stated.join(', ') || 'unstated'}`)
      .toBe(`migrations-only: ${stated.map(() => inMigrations.size).join(', ') || 'unstated'}`);
  });

  it('reads the legacy files, not just migrations/', () => {
    // Fails loudly if someone "tidies" the corpus down to migrations/ — at which point
    // this whole section would pass while checking nothing about the core schema.
    ['jobs', 'bookings', 'profiles', 'payments', 'messages'].forEach((t) => {
      expect(`${t}: ${tables.includes(t) ? 'enumerated' : 'MISSING — the legacy supabase/*.sql files are not being read'}`)
        .toBe(`${t}: enumerated`);
    });
  });

  it('no table has ever been dropped', () => {
    // Not a schema opinion — an admission about this enumerator. It replays every
    // CREATE and models no DROP, so the first `drop table` would leave it demanding a
    // CLAUDE.md line for a table that no longer exists. Teach it about drops here
    // before removing the row from the doc.
    // Comments stripped first: a migration that EXPLAINS why it did not drop something
    // would otherwise fail a docs test for a sentence. Same trap as the parity guards.
    const dropSrc = allSql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
    const drops = [...dropSrc.matchAll(/drop table[^;]{0,60}/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim());
    expect(`drops: ${drops.join(' | ') || 'none'}`).toBe('drops: none');
  });

  tables.filter((t) => !TABLE_EXEMPT[t]).forEach((table) => {
    it(`${table} is named`, () => {
      expect(`${table}: ${namesIt(table) ? 'documented' : 'UNDOCUMENTED — add a line to ## Supabase Schema Notes in CLAUDE.md'}`)
        .toBe(`${table}: documented`);
    });
  });
});
checkAllowlist(TABLE_EXEMPT, tables, 'table');

// The reverse direction — "CLAUDE.md never names a table that does not exist" — is
// deliberately absent, and not by oversight. The doc names columns, triggers, RPCs,
// storage buckets and app_flags keys in the same backticked snake_case, so any
// heuristic that tried to pick table names out of prose would fail on `earner_done`,
// `fee_bps_at` or `completion-photos`. A check that cries wolf gets deleted, and
// deleting it would take the forward direction with it.

// ─────────────────────────────────────────────────────────────────────────────
// 5. Controls — the count, not the roster
// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE.md is NOT asked to name the 53 controls individually. That is a decision, not
// a gap: the registry table is the roster, /controls renders it, every in-database key
// is mechanically its function minus the `ctl_` prefix, and adminSurface.test.js already
// fails if a ctl_* function is defined without a registry row. A control cannot go
// missing quietly, so 53 prose rows would be a third copy of a list that is already
// complete — the same reason the admin console's pages are pointed at rather than
// duplicated.
//
// What prose owns, and code does not, is the COUNT — the one line that tells a reader
// whether the section describing this system was written against the system as it is.
// It has rotted twice: the doc said 47 while 51 functions existed, and then said "51
// registered, 49 in-database" while the registry held 53 and 51. Both were written in
// good faith by someone reading these same files, which is the argument for recounting
// it here rather than asking anyone to recount it again.
const ctlFns = new Set(
  [...migrationSql.matchAll(/create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]),
);

// key -> isExternal. `external` is a column on the insert, so its presence in the column
// list is what marks the row; both external rows carry fn_name 'external:reconcile-stripe'
// and are dispatched over HTTP instead of by run_all_controls.
const registry = new Map();
for (const stmt of migrationSql.matchAll(/insert into public\.controls\s*\(([^)]*)\)\s*values([\s\S]*?);\s*\n/g)) {
  const isExternal = stmt[1].split(',').map((c) => c.trim()).includes('external');
  for (const row of stmt[2].matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)) registry.set(row[1], isExternal);
}
const externalKeys = [...registry].filter(([, ext]) => ext).map(([k]) => k).sort();
const internalKeys = [...registry].filter(([, ext]) => !ext).map(([k]) => k).sort();

describe('CLAUDE.md states the control count, and the count is right', () => {
  // Reported first because everything below is only as trustworthy as this parse. A
  // regex that swallowed a stray tuple out of a `why` string would inflate the count and
  // then assert the inflated number into the doc; a bijection cannot survive that.
  it('the registry parses cleanly (internal key <-> ctl_ function, 1:1)', () => {
    const keysWithoutFn = internalKeys.filter((k) => !ctlFns.has(`ctl_${k}`));
    const fnsWithoutKey = [...ctlFns].filter((fn) => !internalKeys.includes(fn.slice(4)));
    expect(`unmatched keys: ${keysWithoutFn.join(', ') || 'none'} / unmatched fns: ${fnsWithoutKey.join(', ') || 'none'}`)
      .toBe('unmatched keys: none / unmatched fns: none');
  });

  it('finds controls to check', () => {
    expect(registry.size).toBeGreaterThan(40);
    expect(externalKeys.length).toBeGreaterThan(0);
  });

  it('every number CLAUDE.md gives for controls matches the registry', () => {
    // Any phrasing is fine — this looks for "<n> controls" anywhere, so the doc is free
    // to reword. What it may not do is state two different totals in two places, which
    // is precisely how the last pair of numbers came to disagree.
    const stated = [...claude.matchAll(/(\d+)\s+`?controls`?\b/g)].map((m) => Number(m[1]));
    expect(`stated totals: ${stated.join(', ') || 'NONE — CLAUDE.md must say how many controls are registered'}`)
      .toBe(`stated totals: ${stated.map(() => registry.size).join(', ') || 'x'}`);
    expect(stated.length).toBeGreaterThan(0);
  });

  it('any in-database/external split CLAUDE.md gives matches the registry', () => {
    // Optional claims, checked if made. run_all_controls iterates
    // `where enabled and not external`, so the in-database figure is the non-external one.
    const inDb = [...claude.matchAll(/(\d+)\s+run in-database/g)].map((m) => Number(m[1]));
    const ext = [...claude.matchAll(/(\d+)\s+(?:are|is)\s+`external`/g)].map((m) => Number(m[1]));
    expect(`in-database: ${inDb.join(', ') || 'unstated'}`)
      .toBe(`in-database: ${inDb.map(() => internalKeys.length).join(', ') || 'unstated'}`);
    expect(`external: ${ext.join(', ') || 'unstated'}`)
      .toBe(`external: ${ext.map(() => externalKeys.length).join(', ') || 'unstated'}`);
  });

  // The two external rows ARE named individually, because they are the exception to the
  // sentence above them: run_all_controls filters them out, so "the sweep runs the
  // registry" is false for exactly these. That single-word difference already caused the
  // console's "Run sweep now" to skip both while reporting success.
  externalKeys.forEach((key) => {
    it(`external control ${key} is named`, () => {
      expect(`${key}: ${namesIt(key) ? 'documented' : 'UNDOCUMENTED — external controls do not run in the sweep, so CLAUDE.md must name them'}`)
        .toBe(`${key}: documented`);
    });
  });

  it('CLAUDE.md points at where the roster actually lives', () => {
    // The whole reason the roster is not copied out. If these stop being true the
    // decision above stops being defensible and the controls belong in a list.
    ['`controls`', 'run_all_controls', '/controls', 'adminSurface.test.js'].forEach((anchor) => {
      expect(`${anchor}: ${claude.includes(anchor) ? 'present' : 'MISSING — without it the roster is unfindable'}`)
        .toBe(`${anchor}: present`);
    });
  });
});

describe('CLAUDE.md never cites a control that does not exist', () => {
  const cited = [...new Set([...claude.matchAll(/\b(ctl_[a-z0-9_]+)\b/g)].map((m) => m[1]))];

  it('finds control names to check', () => {
    expect(cited.length).toBeGreaterThan(0);
  });

  cited.forEach((fn) => {
    it(`${fn} still exists`, () => {
      expect(`${fn}: ${ctlFns.has(fn) ? 'exists' : 'MISSING — renamed or deleted, fix CLAUDE.md'}`)
        .toBe(`${fn}: exists`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The components rationale has to keep being true
// ─────────────────────────────────────────────────────────────────────────────
// The header declines to guard component names on the grounds that parity.test.js
// already checks documented props against real signatures — which is the check that
// matters, since the failure that actually shipped was a documented <MessageSheet>
// missing `visible`, not an undocumented component. If that check is ever removed the
// rationale is hollow and components should be guarded here instead. Asserting the
// argument's own premise is cheaper than rediscovering that it lapsed.
describe('the reason components are not guarded here still holds', () => {
  it('parity.test.js still checks documented component props', () => {
    const parity = fs.readFileSync(path.join(__dirname, 'parity.test.js'), 'utf8');
    expect(parity).toMatch(/documented component props exist on the component/);
  });
});
