const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A feature is not finished when the mobile screen works.
//
// Everything this platform does eventually needs a person to see it: a control that
// fires, an error that gets reported, a ticket that reaches a queue, a payment
// somebody has to refund. The admin console is where that happens, and the failure
// mode is silent — a control written and never registered never runs, and a console
// page with no nav entry is a page nobody opens.
//
// These are cheap structural checks against exactly those two silences.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');

describe('every control written is a control that runs', () => {
  // A ctl_* function that is never inserted into `controls` is dead code that looks
  // like coverage: run_all_controls iterates the REGISTRY, not the schema, so an
  // unregistered check reports nothing forever and the board still shows green.
  const migrationDir = path.join(ROOT, 'supabase/migrations');
  const sql = fs.readdirSync(migrationDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(migrationDir, f), 'utf8'))
    .join('\n');

  const defined = new Set([...sql.matchAll(/create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]));
  const registered = new Set([...sql.matchAll(/'(ctl_[a-z0-9_]+)'\s*\)/g)].map((m) => m[1]));

  it('finds controls to check', () => {
    expect(defined.size).toBeGreaterThan(20);
  });

  it('no control function is left unregistered', () => {
    const orphans = [...defined].filter((fn) => !registered.has(fn));
    expect(`unregistered: ${orphans.join(', ') || 'none'}`).toBe('unregistered: none');
  });
});

describe('every admin console page is reachable', () => {
  // A page with no nav entry exists only for whoever remembers the URL. New surfaces
  // (errors, controls, promotions, pricing) were all added this way and each had to be
  // linked by hand.
  //
  // CLAUDE_MD_DRIFT.md recorded four escape hatches in the original version of this
  // block, all four real and all four closed below:
  //   (a) it scanned only admin/app/(console), so a page at admin/app/<x> was never
  //       checked — login, mfa and denied all live there;
  //   (b) it enumerated DIRECTORIES, so route.ts handlers had no coverage at all;
  //   (c) it matched Nav.tsx as raw text, so a COMMENTED-OUT nav entry still counted as
  //       linked — the same prose-instead-of-code failure that made three other guards
  //       in this repo pass on drifted code;
  //   (d) there was no REVERSE check, so Nav.tsx could link a route that does not
  //       exist. That is precisely the /reports 404 adminLinks.test.js was written for,
  //       left uncovered on the nav side.
  const consoleDir = path.join(ROOT, 'admin/app/(console)');
  const appDir = path.join(ROOT, 'admin/app');
  const navRaw = fs.readFileSync(path.join(consoleDir, 'Nav.tsx'), 'utf8');

  // (c) Comments stripped before matching. A commented-out entry is an UNLINKED page.
  const nav = navRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const dirsIn = (d) => fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // Dynamic segments are reached from their parent list, not from the nav.
    .filter((n) => !n.startsWith('[') && !n.startsWith('_') && !n.startsWith('('));

  const pages = dirsIn(consoleDir);

  it('finds pages to check', () => {
    expect(pages.length).toBeGreaterThan(8);
  });

  pages.forEach((p) => {
    it(`/${p} is in the nav`, () => {
      expect(`${p}: ${nav.includes(`"/${p}"`) ? 'linked' : 'ORPHANED — add it to Nav.tsx'}`)
        .toBe(`${p}: linked`);
    });
  });

  // (d) The reverse: every route Nav.tsx links must EXIST. A nav entry pointing at a
  // deleted page is a 404 an operator finds mid-incident.
  it('the nav links no route that does not exist', () => {
    const linked = [...nav.matchAll(/href=\{?["'`]\/([a-z0-9-]+)/gi)].map((m) => m[1]);
    const exists = new Set([...pages, ...dirsIn(appDir)]);
    const dead = [...new Set(linked)].filter((r) => !exists.has(r));
    // Name the route — "nav drifted" is not actionable.
    expect(dead).toEqual([]);
  });

  // (a) Pages OUTSIDE the (console) group are still real surfaces an operator reaches.
  // They are deliberately not in the nav (you cannot navigate to /login from inside),
  // so this asserts only that they are accounted for rather than silently invisible.
  it('accounts for the console pages that live outside the route group', () => {
    const outside = dirsIn(appDir).filter((d) => d !== 'api');
    // These exist and are reached by redirect or by the auth flow, never by the nav.
    const EXPECTED_UNNAVIGATED = ['login', 'mfa', 'denied'];
    const surprises = outside.filter((d) => !EXPECTED_UNNAVIGATED.includes(d));
    expect({ unexpected_top_level_pages: surprises }).toEqual({ unexpected_top_level_pages: [] });
  });

  // (b) route.ts handlers are surfaces too — they serve data, often PII, and none of
  // them appear in a nav. Enumerated so a new one cannot land unnoticed.
  it('accounts for every route handler', () => {
    const handlers = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, `${rel}/${e.name}`);
        else if (e.name === 'route.ts' || e.name === 'route.tsx') handlers.push(rel || '/');
      }
    };
    walk(appDir, '');
    // Each known handler, with what it serves. A new one fails this until it is listed —
    // the point is that somebody looked at it, not that the list is long.
    const KNOWN = {
      '/(console)/users/[id]/export': 'GDPR data export for one user (PII)',
    };
    const unlisted = handlers.filter((h) => !(h in KNOWN));
    expect({ unlisted_route_handlers: unlisted }).toEqual({ unlisted_route_handlers: [] });
  });
});
