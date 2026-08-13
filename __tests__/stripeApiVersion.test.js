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

const FN_DIR = path.join(__dirname, '..', 'supabase', 'functions');

// stripe@15.12.0's generated apiVersion.js reads '2024-04-10'. Pinned explicitly so the
// value we send equals the value the SDK was built for.
const SDK_MAJOR = 15;
const API_VERSION = '2024-04-10';

// The mobile SDK negotiates its own version for ephemeral keys. @stripe/stripe-react-native
// 0.50.3 expects this, and it is a per-CALL option, not the client's version — changing it
// to match the client would break saved-card management in the payment sheet.
const EPHEMERAL_KEY_VERSION = '2024-06-20';

const files = fs
  .readdirSync(FN_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(FN_DIR, e.name, 'index.ts'))
  .filter((f) => fs.existsSync(f))
  .map((f) => ({ name: path.basename(path.dirname(f)), src: fs.readFileSync(f, 'utf8') }))
  .filter((f) => f.src.includes('new Stripe('));

describe('Stripe API version', () => {
  it('found the functions that construct a Stripe client', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('uses exactly one SDK major across every function', () => {
    const majors = [...new Set(files.flatMap((f) => [...f.src.matchAll(/npm:stripe@(\d+)/g)].map((m) => m[1])))];
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
