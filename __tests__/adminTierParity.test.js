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

// ─────────────────────────────────────────────────────────────────────────────
// The THIRD direction: a console action and the EDGE FUNCTION it calls.
//
// The two blocks above hold the console's UI to the console's own guard. Neither could
// see the gap that actually shipped, because it straddles the two deploy targets:
//
//   admin/app/(console)/bookings/actions.ts   run() = requireFreshAdmin("finance")
//   supabase/functions/admin-payment-action   requireAdminCaller(req, 'admin', 300)
//
// A finance operator passed the console guard, got `payment.refund` written to
// admin_audit_log by run()'s audit-before-act, and was then refused by the edge half
// with a bare `forbidden`. Release hold, settle, refund and record-reversal were all
// unreachable for the one tier that exists to perform them.
//
// The root cause was that _shared/adminAuth.ts only knew two of the four tiers and
// tested them with a single `minRole === 'admin'` comparison — which ALSO meant every
// other minRole value degraded to "any active membership passes". Both halves are
// asserted here: the ranking tables must agree, and no edge gate may be stricter than
// the console gate in front of it.
// ─────────────────────────────────────────────────────────────────────────────
describe('console actions and the edge functions behind them agree on tier', () => {
  const EDGE = path.join(__dirname, '..', 'supabase', 'functions');
  const adminAuth = read(path.join(EDGE, '_shared', 'adminAuth.ts'));
  const consoleGuard = read(path.join(__dirname, '..', 'admin', 'lib', 'guard.ts'));

  // `admin: new Set<AdminRole>(["admin"]),` -> ['admin', ['admin']]
  const parseSatisfies = (src, label) => {
    const block = src.match(/SATISFIES[^=]*=\s*\{([\s\S]*?)\n\};/);
    expect(`${label} has a SATISFIES table`).toBe(block ? `${label} has a SATISFIES table` : 'MISSING');
    const out = {};
    for (const m of block[1].matchAll(/(\w+):\s*new Set<AdminRole>\(\[([^\]]*)\]\)/g)) {
      out[m[1]] = m[2].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean).sort();
    }
    return out;
  };

  it('adminAuth.ts ranks the tiers exactly as admin/lib/guard.ts does', () => {
    expect(parseSatisfies(adminAuth, 'adminAuth.ts')).toEqual(parseSatisfies(consoleGuard, 'guard.ts'));
  });

  it('both files know the same four tiers', () => {
    const union = (src) =>
      (src.match(/export type AdminRole\s*=\s*([^;]+);/) || [, ''])[1]
        .split('|').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean).sort();
    expect(union(adminAuth)).toEqual(['admin', 'finance', 'support', 'trust']);
    expect(union(adminAuth)).toEqual(union(consoleGuard));
  });

  it('the tier test is the ranking table, not an equality check on one tier', () => {
    // `minRole === 'admin' && role !== 'admin'` silently admitted ANY active membership
    // for every other value of minRole — including a support agent at a finance gate.
    const code = codeOnly(adminAuth);
    expect(code).toMatch(/if \(!roleSatisfies\(role, minRole\)\)/);
    expect(code).not.toMatch(/minRole === 'admin' && role !== 'admin'/);
  });

  // Each console action file, the tier its guard demands, and the edge functions it calls.
  const CALLERS = [
    { file: path.join(CONSOLE, 'bookings', 'actions.ts'), fn: 'admin-payment-action' },
  ];

  it.each(CALLERS)('$fn is not stricter than the console guard in front of it', ({ file, fn }) => {
    const caller = codeOnly(read(file));
    expect(caller).toMatch(new RegExp(`functions/v1/${fn}`));

    const consoleTier = (caller.match(/require(?:Fresh)?Admin\("(\w+)"\)/) || [])[1];
    expect(`${fn} caller declares a tier`).toBe(
      consoleTier ? `${fn} caller declares a tier` : 'NO TIER FOUND');

    const edge = codeOnly(read(path.join(EDGE, fn, 'index.ts')));
    const edgeTier = (edge.match(/requireAdminCaller\(\s*req,\s*'(\w+)'/) || [])[1];
    expect(`${fn} edge declares a tier`).toBe(
      edgeTier ? `${fn} edge declares a tier` : 'NO TIER FOUND');

    // Whoever the console lets in must satisfy the edge gate, or the action is dead for
    // that tier — after the audit row has already been written.
    const rank = parseSatisfies(adminAuth, 'adminAuth.ts');
    expect(`${fn}: console ${consoleTier} -> edge ${edgeTier}: ${rank[edgeTier].includes(consoleTier)}`)
      .toBe(`${fn}: console ${consoleTier} -> edge ${edgeTier}: true`);
  });
});
