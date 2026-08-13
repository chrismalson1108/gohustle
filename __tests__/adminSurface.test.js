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
  const consoleDir = path.join(ROOT, 'admin/app/(console)');
  const nav = fs.readFileSync(path.join(consoleDir, 'Nav.tsx'), 'utf8');

  const pages = fs.readdirSync(consoleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // Dynamic segments are reached from their parent list, not from the nav.
    .filter((n) => !n.startsWith('[') && !n.startsWith('_'));

  it('finds pages to check', () => {
    expect(pages.length).toBeGreaterThan(8);
  });

  pages.forEach((p) => {
    it(`/${p} is in the nav`, () => {
      expect(`${p}: ${nav.includes(`"/${p}"`) ? 'linked' : 'ORPHANED — add it to Nav.tsx'}`)
        .toBe(`${p}: linked`);
    });
  });
});
