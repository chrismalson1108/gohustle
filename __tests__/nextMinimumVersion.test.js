// ─────────────────────────────────────────────────────────────────────────────
// admin/ and web/ are pinned to an EXACT Next.js version, and it must stay above the
// floor where the App Router advisories are fixed.
//
// On 2026-09-06 both projects pinned next@16.2.9. `npm audit` in each reported NINE
// advisories against `next` itself, every one of them ranged `>=16.0.0 <16.2.11`:
//
//   high      GHSA-m99w-x7hq-7vfj  Denial of Service in App Router using Server Actions
//   high      GHSA-6gpp-xcg3-4w24  Middleware / Proxy bypass in App Router apps
//   high      GHSA-89xv-2m56-2m9x  SSRF in Server Actions on custom servers
//   high      GHSA-p9j2-gv94-2wf4  SSRF in rewrites via attacker-controlled input
//   moderate  GHSA-955p-x3mx-jcvp  Unauthenticated disclosure of Server Function endpoints
//   moderate  GHSA-4c39-4ccg-62r3  Unbounded Server Action payload in the Edge runtime
//   moderate  GHSA-4633-3j49-mh5q  Cache confusion of response bodies (invalid UTF-8)
//   moderate  GHSA-68g3-v927-f742  Cache confusion of response bodies
//   moderate  GHSA-q8wf-6r8g-63ch  DoS in the Image Optimization API using SVGs
//
// The two Server-Action ones are not theoretical here. admin/ has 15 `"use server"`
// modules and one of them — admin/app/login/actions.ts — is invoked BEFORE any session
// exists, by design (it is the login throttle's recording path). So the pre-auth surface
// of admin.gohustlr.com carries the App Router Server-Action runtime, and the console is
// the only path to refunds, escrow release, disputes and safety reports. The proxy-bypass
// one is bounded rather than open — admin/proxy.ts is deliberately UX-only and the real
// enforcement is in admin/lib/guard.ts at the data layer — but "bounded" is the second
// layer doing its job, not a reason to stay on the vulnerable version.
//
// web/ has no server actions (the only `use server` match there is a comment). It is
// pinned anyway: it shares the runtime, and two projects on different Next versions is
// a state nobody audits twice.
//
// ── WHY THE FLOOR IS A FLOOR AND NOT A MATCH ────────────────────────────────
//
// Upgrading is expected; going backwards is the regression this catches — a revert, a
// merge that restores an old package.json, or a "pin it to what the other project has"
// that picks the older of the two.
//
// ── WHY THE LOCKFILE IS CHECKED TOO ─────────────────────────────────────────
//
// package.json alone decides nothing: Vercel installs from package-lock.json. A bump
// written into package.json without regenerating the lock either ships the OLD Next
// (if the lock still satisfies) or breaks the deploy outright (`npm ci` refuses a lock
// that disagrees with the manifest). Both halves are asserted, per project, so a
// half-applied bump fails here instead of on a deploy nobody is watching.
//
// ── HOW TO RAISE THE FLOOR ──────────────────────────────────────────────────
//
//   cd admin && npm install next@<version> && npx tsc --noEmit && npx eslint .
//   cd web   && npm install next@<version> && npx tsc --noEmit && npx eslint .
//
// then raise MINIMUM below to the version whose advisories you actually checked, and
// redeploy BOTH: web ships on push to master, admin does NOT (see CLAUDE.md).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// The floor at which all nine `next` advisories above are fixed. Bumped from nothing to
// 16.2.11 on 2026-09-06, when both projects moved 16.2.9 -> 16.2.12.
const MINIMUM = '16.2.11';

const PROJECTS = ['admin', 'web'];

// Exact pins only. A range ("^16.2.12") would let the lock float to whatever was
// resolvable on the day someone last installed, which is the opposite of a floor you can
// assert. Both projects already pin exactly; this keeps it that way.
const EXACT = /^\d+\.\d+\.\d+$/;

function parse(v) {
  return v.split('.').map(Number);
}

// Plain tuple compare. `semver` is not a dependency of this project and a floor check
// does not need one.
function gte(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

function read(...parts) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8'));
}

describe('next is pinned above the App Router advisory floor', () => {
  test.each(PROJECTS)('%s/package.json pins an exact next >= the floor', (project) => {
    const pkg = read(project, 'package.json');
    const pinned = pkg.dependencies && pkg.dependencies.next;

    expect(pinned).toBeDefined();
    expect(pinned).toMatch(EXACT);

    // Compared as strings so a failure names the version instead of printing
    // "expected true, received false".
    expect(gte(pinned, MINIMUM) ? pinned : `${pinned} (below the ${MINIMUM} floor)`).toBe(pinned);
  });

  test.each(PROJECTS)('%s/package-lock.json resolves the version package.json asks for', (project) => {
    const pinned = read(project, 'package.json').dependencies.next;
    const lock = read(project, 'package-lock.json');

    // The root entry records the manifest npm resolved against; the tree entry records
    // what actually gets installed. Both must be the pin, or the deploy installs
    // something other than what was reviewed.
    expect(lock.packages[''].dependencies.next).toBe(pinned);
    expect(lock.packages['node_modules/next'].version).toBe(pinned);

    // The tarball the integrity hash guards must be the same version, not a stale URL
    // left behind by a hand-edit.
    expect(lock.packages['node_modules/next'].resolved).toContain(`next-${pinned}.tgz`);
  });

  test('admin and web are on the same next version', () => {
    const versions = PROJECTS.map((p) => read(p, 'package.json').dependencies.next);
    expect(new Set(versions).size).toBe(1);
  });

  test("next's own swc/env siblings move with it", () => {
    // next pins @next/env and every @next/swc-* to its OWN exact version. A lockfile
    // spliced or hand-edited without them installs a runtime whose native binary is from
    // a different release, which fails at build time on Vercel and not here.
    for (const project of PROJECTS) {
      const lock = read(project, 'package-lock.json');
      const pinned = lock.packages['node_modules/next'].version;
      const siblings = Object.keys(lock.packages).filter((k) =>
        /^node_modules\/@next\/(env|swc-)/.test(k),
      );
      expect(siblings.length).toBeGreaterThan(0);
      for (const key of siblings) {
        expect(`${project} ${key}=${lock.packages[key].version}`).toBe(
          `${project} ${key}=${pinned}`,
        );
      }
    }
  });
});
