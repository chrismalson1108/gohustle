// ─────────────────────────────────────────────────────────────────────────────
// Every Stripe client speaks ONE API version, and it is written down.
//
// Before 2026-08-13 four versions were live at once and nobody could have told you so:
//
//   16 functions  new Stripe(key)                  → stripe@15's default, 2024-04-10
//   reconcile     new Stripe(key, '2024-06-20')    → on stripe@14, built for 2023-10-16
//   ephemeral key '2024-06-20'                     → stripe@16's default
//   webhooks      2026-05-27.dahlia                → the account default
//
// The dangerous one was the 16. An UNPINNED client takes whatever version its SDK
// happens to default to, so `npm:stripe@15` → `npm:stripe@16` silently moves every
// charge, capture, refund and payout onto a different API version — no diff to review,
// no error, and the first symptom is a field that changed shape in production.
//
// So the pin is not bureaucracy. It converts an SDK upgrade from a silent behaviour
// change into a failing test, which is the same trade `pricing.test.js` makes by parsing
// the fee migration instead of trusting a comment.
//
// ── HOW TO CHANGE THE VERSION DELIBERATELY ──────────────────────────────────
//
// Look up the new SDK's own default (it is generated, one line):
//   curl -s https://cdn.jsdelivr.net/npm/stripe@<version>/cjs/apiVersion.js
// Set SDK_MAJOR and API_VERSION below to match, update every function, and exercise the
// money paths. Do not update this file alone — that is the failure it exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Strip comments before scanning. Without this the guard matched `new Stripe(stripeKey)`
// inside a comment EXPLAINING the old unpinned form, and reported the fixed file as
// broken — a guard that fires on correct code is a guard someone deletes.
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const FN_DIR = path.join(__dirname, '..', 'supabase', 'functions');

// stripe@22.5.0's generated apiVersion.js reads '2026-07-29.dahlia'. Pinned explicitly so
// the value we send equals the value the SDK was built for.
//
// Upgraded from stripe@15 / 2024-04-10 on 2026-08-13. The account (and therefore every
// webhook payload) was already on the dahlia train at 2026-05-27.dahlia, so the SERVER was
// two years behind the events it was receiving. Same train now.
const SDK_MAJOR = 22;
const API_VERSION = '2026-07-29.dahlia';

// The ephemeral-key version is a per-CALL option, NOT the client's version, and it is
// deliberately left alone. Two corrections to what this comment used to claim:
//
//   1. I wrote that @stripe/stripe-react-native 0.50.3 "expects" 2024-06-20. That is
//      FALSE. ios/Podfile.lock resolves it to stripe-ios 24.19.0, whose
//      STPAPIClient.swift:254 hardcodes `APIVersion = "2020-08-27"`. The value here
//      matches neither the mobile SDK nor the server.
//   2. It works anyway: stripe-node's EphemeralKeys validator only requires a
//      Stripe-Version header to be PRESENT — no allowlist, no floor — identical in v15
//      and v22. So the SDK upgrade cannot break it.
//
// The value is therefore pinned as OBSERVED-WORKING, not as justified. Do not "fix" it
// to match the client on the strength of this comment; changing it is untested and the
// blast radius is saved-card management in the payment sheet. Tracked in OPEN_WORK.md.
const EPHEMERAL_KEY_VERSION = '2024-06-20';

// The admin console is a THIRD deploy target with its own package.json, and it was
// missed: `stripe: ^18.0.0` plus an unpinned `new Stripe(key)` meant the console spoke
// Basil while every money path spoke Dahlia — and the caret would move it again on any
// install, with no diff to review. Same rule, same guard.
const ADMIN_SITES = [path.join(__dirname, '..', 'admin', 'lib', 'deleteUser.ts')]
  .filter((f) => fs.existsSync(f))
  .map((f) => ({ name: `admin/${path.basename(f)}`, src: code(fs.readFileSync(f, 'utf8')) }));

const files = fs
  .readdirSync(FN_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(FN_DIR, e.name, 'index.ts'))
  .filter((f) => fs.existsSync(f))
  .map((f) => ({ name: path.basename(path.dirname(f)), src: code(fs.readFileSync(f, 'utf8')) }))
  .filter((f) => f.src.includes('new Stripe('))
  .concat(ADMIN_SITES);

describe('Stripe API version', () => {
  it('found the functions that construct a Stripe client', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('admin/package.json pins the same SDK major, without a caret', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'package.json'), 'utf8'));
    const dep = pkg.dependencies?.stripe ?? '';
    // An exact version, not ^ or ~: a range re-resolves on every install and moves the
    // API version silently.
    expect(`admin stripe dep: ${dep}`).toBe(`admin stripe dep: ${require(
      path.join(__dirname, '..', 'admin', 'node_modules', 'stripe', 'package.json'),
    ).version}`);
    expect(dep.startsWith(String(SDK_MAJOR) + '.')).toBe(true);
  });

  it('uses exactly one SDK major across every function', () => {
    // _shared modules count too: a type-only `import type Stripe from 'npm:stripe@15'`
    // in connectStatus.ts made every consumer fail with a type-IDENTITY error that
    // reads like a breaking change and is not one. Catch the specifier, not the symptom.
    const shared = fs.readdirSync(path.join(FN_DIR, '_shared'))
      .filter((n) => n.endsWith('.ts'))
      .map((n) => fs.readFileSync(path.join(FN_DIR, '_shared', n), 'utf8'));
    const majors = [...new Set([...files.map((f) => f.src), ...shared]
      .flatMap((src) => [...src.matchAll(/npm:stripe@(\d+)/g)].map((m) => m[1])))];
    expect(majors).toEqual([String(SDK_MAJOR)]);
  });

  for (const f of files) {
    it(`${f.name} pins the client explicitly`, () => {
      // Match each `new Stripe(...)` construction and require a version inside it.
      const ctors = [...f.src.matchAll(/new Stripe\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0]);
      expect(ctors.length).toBeGreaterThan(0);
      const unpinned = ctors.filter((c) => !c.includes('apiVersion'));
      expect(`${f.name}: ${unpinned.length} unpinned client(s)`).toBe(`${f.name}: 0 unpinned client(s)`);
      const wrong = ctors.filter((c) => !c.includes(`apiVersion: '${API_VERSION}'`));
      expect(`${f.name}: ${wrong.length} client(s) on the wrong version`)
        .toBe(`${f.name}: 0 client(s) on the wrong version`);
    });
  }

  it('leaves the ephemeral-key version alone — it belongs to the mobile SDK', () => {
    const withEphemeral = files.filter((f) => f.src.includes('ephemeralKeys.create'));
    expect(withEphemeral.length).toBeGreaterThan(0);
    for (const f of withEphemeral) {
      expect(`${f.name}:${f.src.includes(`{ apiVersion: '${EPHEMERAL_KEY_VERSION}' }`)}`)
        .toBe(`${f.name}:true`);
    }
  });
});
