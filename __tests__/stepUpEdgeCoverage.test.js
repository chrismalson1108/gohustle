const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The two-factor gate is CLIENT-SIDE, so every irreversible or money-redirecting
// edge function has to enforce it for itself.
//
// A password sign-in on an account with a verified TOTP factor returns a REAL
// session at aal1 — AuthContext.js and web/app/mfa merely decline to render past
// it. AuthContext's own comment says the gate "fails open on a network error (the
// server still refuses anything needing aal2)", and that sentence is only true of
// the functions that actually call requireStepUp.
//
// delete-account did not. It validated the JWT with getUser() and nothing else, then
// tombstoned the profile, replaced the auth email, banned the row for a hundred years
// and revoked every session — irreversibly, from a phished password alone, on an
// account whose owner enrolled 2FA precisely so that a password would not be enough.
// The typed-username confirmation is client-side and the function parses no body, so
// a bare POST with a Bearer token was the whole attack.
//
// This pins the roster. A new destructive function that forgets the call fails here
// instead of being noticed after someone's account is gone.
// ─────────────────────────────────────────────────────────────────────────────
const FN_DIR = path.join(__dirname, '..', 'supabase', 'functions');

// Each entry says WHY it is on the list — the reason is the review, not the name.
const MUST_STEP_UP = {
  'stripe-payout-login-link':
    'mints an Express dashboard link, where the bank account can be changed',
  'stripe-connect-onboard':
    'starts/resumes Connect onboarding, which is where the payout destination is set',
  'delete-account':
    'irreversibly tombstones the profile and permanently bans the auth row',
};

const read = (fn) => fs.readFileSync(path.join(FN_DIR, fn, 'index.ts'), 'utf8');

describe('every irreversible or money-redirecting edge function enforces step-up itself', () => {
  it('the roster names functions that exist', () => {
    for (const fn of Object.keys(MUST_STEP_UP)) {
      expect(fs.existsSync(path.join(FN_DIR, fn, 'index.ts'))).toBe(true);
    }
  });

  it.each(Object.entries(MUST_STEP_UP))('%s calls requireStepUp — %s', (fn) => {
    const src = read(fn);
    expect(src).toMatch(/from '\.\.\/_shared\/stepUp\.ts'/);
    // Called, not merely imported.
    expect(src).toMatch(/await\s+requireStepUp\s*\(/);
    // And the refusal is returned rather than logged and stepped over.
    expect(src).toMatch(/if\s*\(!step\.ok\)/);
  });

  it('the check runs before anything irreversible in delete-account', () => {
    const src = read('delete-account');
    const stepAt = src.indexOf('await requireStepUp(');
    expect(stepAt).toBeGreaterThan(-1);
    // The destructive tail: nothing may precede the gate.
    for (const marker of ["rpc('tombstone_profile'", 'updateUserById(', '.remove(']) {
      expect(src.indexOf(marker)).toBeGreaterThan(stepAt);
    }
  });

  it('the shared module still fails closed when it cannot tell', () => {
    // If this ever returns ok on a lookup error, every caller above silently
    // degrades to "no step-up" for exactly the accounts it knows least about.
    const shared = fs.readFileSync(path.join(FN_DIR, '_shared', 'stepUp.ts'), 'utf8');
    expect(shared).toMatch(/if \(error\)[\s\S]{0,240}ok: false/);
    expect(shared).toMatch(/mfa_check_unavailable/);
  });
});

// The refusal has to be explicable, or a correct denial reads as a broken app.
describe('both clients explain a step-up refusal instead of saying "try again"', () => {
  const CLIENTS = [
    path.join(__dirname, '..', 'src', 'screens', 'ProfileSettingsScreen.js'),
    path.join(__dirname, '..', 'web', 'app', '(app)', 'profile', 'settings', 'page.tsx'),
  ];

  it.each(CLIENTS)('%s surfaces the step-up codes', (file) => {
    const src = fs.readFileSync(file, 'utf8');
    // The whitelist that decides whether the server's message is shown verbatim.
    const list = /const DELETE_REFUSALS\s*=\s*\[([\s\S]*?)\]/.exec(src);
    expect(list).not.toBeNull();
    for (const code of [
      'UNSETTLED_BOOKINGS', 'UNDER_REVIEW', 'REVIEW_CHECK_FAILED',
      'SETTLEMENT_CHECK_FAILED', 'MFA_REQUIRED', 'mfa_check_unavailable',
    ]) {
      expect(list[1]).toContain(code);
    }
  });
});
