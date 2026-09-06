const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The step-up denial has to reach the UI as "stale_mfa", or the prompt never opens.
//
// requireFreshAdmin throws AdminAuthError("stale_mfa"). Its .message is
// "admin auth failed: stale_mfa", so the only clean sentinel is .reason — and every
// caller's UI compares `result.message === "stale_mfa"`.
//
// Four of the five surfaces caught AdminAuthError and returned a flat
// "Not authorized.", discarding the reason. Wiring ReauthPrompt into those screens was
// therefore not enough on its own: the client could never learn that a code would fix
// it, so the action dead-ended anyway. Both halves have to hold, so both are asserted.
//
// The MECHANISM moved: the mapping is now `denyResult` in admin/lib/guard.ts, one
// definition instead of the five hand-rolled copies (and the three other surfaces that
// had it wrong). So the sentinel is asserted where it is now produced, and each surface
// is asserted to route through it — checking for the literal string in every actions.ts
// would fail on correct code, which is how a guard gets deleted rather than fixed.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..', 'admin', 'app', '(console)');
const GUARD = path.join(__dirname, '..', 'admin', 'lib', 'guard.ts');
const SURFACES = [
  'pricing/actions.ts',
  'flags/actions.ts',
  'bookings/actions.ts',
  'team/actions.ts',
  'users/[id]/actions.ts',
];

describe('admin step-up: the reason survives to the client', () => {
  test('denyResult is where the sentinel is produced', () => {
    const src = fs.readFileSync(GUARD, 'utf8');
    // The one definition, and it must emit the bare word the client compares against —
    // AdminAuthError.message is "admin auth failed: stale_mfa", which matches nothing.
    expect(src).toMatch(
      /export function denyResult\(e: AdminAuthError\)[\s\S]{0,200}?e\.reason === "stale_mfa" \? "stale_mfa" :/,
    );
  });

  test.each(SURFACES)('%s propagates stale_mfa rather than flattening it', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // It must guard on AdminAuthError somewhere...
    expect(src).toMatch(/e instanceof AdminAuthError/);
    // ...and hand it to the shared mapping (or, historically, emit the sentinel itself).
    expect(src).toMatch(/denyResult|stale_mfa|e\.reason/);
    // The exact regression: swallowing the reason into a flat denial.
    expect(src).not.toMatch(
      /if \(e instanceof AdminAuthError\) return \{ ok: false, message: "Not authorized\." \};/,
    );
  });

  test('every step-up surface has a UI path that can satisfy it', () => {
    // A guard with no recovery is worse than no guard: it teaches people to remove it.
    for (const rel of SURFACES) {
      // Recurse: the bookings prompt lives in bookings/[id]/InterventionPanel.tsx.
      const walk = (d) =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
      const dir = path.join(ROOT, path.dirname(rel));
      const hasPrompt = walk(dir).some(
        (f) => f.endsWith('.tsx') && /ReauthPrompt/.test(fs.readFileSync(f, 'utf8')));
      expect({ surface: rel, hasPrompt }).toEqual({ surface: rel, hasPrompt: true });
    }
  });
});
