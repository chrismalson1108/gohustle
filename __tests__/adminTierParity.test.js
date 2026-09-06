// ─────────────────────────────────────────────────────────────────────────────
// The UI may hide only what the guard also refuses — never the reverse.
//
// ROLE_PERMISSION_MATRIX states the rule in that direction, and three console pages had
// it backwards: they gated their controls on `ctx.role === "admin"` while the server
// actions behind those controls accept a LOWER tier. The tiers existed, the guards were
// right, and the people holding them could not act.
//
//   /moderation   resolveReport/reopenReport are requireAdmin("trust")
//   /disputes     setDisputeStatus is requireAdmin("trust")
//   /bookings/:id every intervention is requireFreshAdmin("finance")
//
// `trust` exists precisely because resolveReport used to need full admin while
// earner-claim-payment refuses to settle a booking with an open report or dispute
// (guard.ts:14-16) — so a trust operator who can read the queue and not clear it
// re-creates the money-harm control the tier was created to remove. The finance case is
// the same shape over refunds and escrow.
//
// So this walks every `(console)` page, finds each control component it renders with an
// authority prop, and requires that prop to be computed from the SAME minimum tier the
// sibling actions file enforces. A page that hides an action from someone the guard
// would have let through fails here.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const CONSOLE = path.join(__dirname, '..', 'admin', 'app', '(console)');
const read = (p) => fs.readFileSync(p, 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Every page.tsx under (console), with the actions.ts that serves its directory.
const pages = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === 'page.tsx') pages.push(full);
  }
})(CONSOLE);

// The actions file a page's controls call: its own directory, then upwards to the
// section root (bookings/[id]/page.tsx calls ../actions.ts).
function actionsFor(pageFile) {
  let dir = path.dirname(pageFile);
  while (dir.startsWith(CONSOLE)) {
    const candidate = path.join(dir, 'actions.ts');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

// The LOWEST tier any mutation in that file accepts — the one the UI must not undercut.
const RANKED = ['support', 'trust', 'finance', 'admin'];
function lowestTier(actionsSrc) {
  const found = [...codeOnly(actionsSrc).matchAll(/require(?:Fresh)?Admin\(\s*"(\w+)"/g)].map((m) => m[1]);
  if (!found.length) return null;
  return found.reduce((lo, r) => (RANKED.indexOf(r) < RANKED.indexOf(lo) ? r : lo), 'admin');
}

describe('no page hides an action from a role the guard admits', () => {
  // Props whose whole job is "may this operator act". A page passing one of these must
  // derive it from a predicate, not from an equality test against the top tier.
  const AUTHORITY_PROP = /\b(isAdmin|canResolve|canIntervene|canAct)\s*=\s*\{([^}]+)\}/g;

  pages.forEach((pageFile) => {
    const rel = path.relative(path.join(CONSOLE, '..', '..', '..'), pageFile);
    const src = codeOnly(read(pageFile));
    const actions = actionsFor(pageFile);
    const min = actions ? lowestTier(read(actions)) : null;

    const props = [...src.matchAll(AUTHORITY_PROP)];
    if (!props.length || !min) return;

    it(`${rel}: authority props match the tier its actions accept (${min})`, () => {
      const wrong = props
        .map((m) => ({ prop: m[1], value: m[2].trim() }))
        // `roleSatisfies(ctx.role, "<min>")` is the only correct source. An
        // equality test is only correct when the action really is admin-only, and
        // then it is still the equality test that says so — which is why it is
        // accepted exactly when min === 'admin'.
        .filter(({ value }) => {
          if (new RegExp(`roleSatisfies\\(\\s*ctx\\.role\\s*,\\s*"${min}"`).test(value)) return false;
          if (min === 'admin' && /ctx\.role === "admin"/.test(value)) return false;
          // A boolean computed earlier in the page: accept only if that binding is
          // itself roleSatisfies(..., min).
          const named = value.match(/^[A-Za-z_$][\w$]*$/);
          if (named) {
            const decl = src.match(
              new RegExp(`const\\s+${named[0]}\\s*=\\s*roleSatisfies\\(\\s*ctx\\.role\\s*,\\s*"${min}"`),
            );
            if (decl) return false;
          }
          return true;
        });
      expect({ page: rel, min_tier: min, mismatched: wrong }).toEqual({
        page: rel,
        min_tier: min,
        mismatched: [],
      });
    });
  });
});

describe('the three that were wrong are wired to their own tier', () => {
  const modPage = codeOnly(read(path.join(CONSOLE, 'moderation', 'page.tsx')));
  const dispPage = codeOnly(read(path.join(CONSOLE, 'disputes', 'page.tsx')));
  const bookPage = codeOnly(read(path.join(CONSOLE, 'bookings', '[id]', 'page.tsx')));

  it('/moderation computes resolve authority from the trust predicate', () => {
    expect(modPage).toMatch(/const canResolve = roleSatisfies\(ctx\.role, "trust"\)/);
    expect(modPage).toMatch(/canResolve=\{canResolve\}/);
    expect(modPage).not.toMatch(/isAdmin=/);
  });

  it('/disputes does the same', () => {
    expect(dispPage).toMatch(/const canResolve = roleSatisfies\(ctx\.role, "trust"\)/);
    expect(dispPage).toMatch(/canResolve=\{canResolve\}/);
    expect(dispPage).not.toMatch(/isAdmin=/);
  });

  it('/bookings/:id computes intervention authority from the finance predicate', () => {
    expect(bookPage).toMatch(/canIntervene=\{roleSatisfies\(ctx\.role, "finance"\)\}/);
    expect(bookPage).not.toMatch(/isAdmin=/);
  });

  it('the control components read the renamed prop, not a stale isAdmin', () => {
    ['moderation/ResolveControls.tsx', 'disputes/DisputeControls.tsx'].forEach((rel) => {
      const src = codeOnly(read(path.join(CONSOLE, ...rel.split('/'))));
      expect(`${rel}: ${/canResolve/.test(src)}`).toBe(`${rel}: true`);
      expect(`${rel}: ${/isAdmin/.test(src)}`).toBe(`${rel}: false`);
    });
    const panel = codeOnly(read(path.join(CONSOLE, 'bookings', '[id]', 'InterventionPanel.tsx')));
    expect(panel).toMatch(/canIntervene/);
    expect(panel).not.toMatch(/isAdmin/);
  });

  it('a denied dispute row no longer says "admin only", which was never the rule', () => {
    // trust and finance are PEERS of each other and neither is admin, so naming admin
    // told a finance operator to go find the wrong person.
    // codeOnly: the comment above the branch quotes the old string on purpose.
    const ctrl = codeOnly(read(path.join(CONSOLE, 'disputes', 'DisputeControls.tsx')));
    expect(ctrl).not.toMatch(/· admin only/);
  });
});
