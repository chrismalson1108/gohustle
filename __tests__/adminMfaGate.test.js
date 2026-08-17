// ─────────────────────────────────────────────────────────────────────────────
// The admin console's TOTP gate must hold the same four properties the app and web
// screens already hold. It held none of them until 2026-08-17.
//
// 1. FAIL CLOSED ON AN UNREADABLE FACTOR LIST. listFactors() is a network call that
//    returns { data: null, error } rather than throwing. The console dropped the error,
//    so a request that merely failed produced "no factors" and fell through to enroll()
//    — handing whoever holds the password a brand-new authenticator and aal2 the moment
//    they verify it. Nothing else stopped it: the app enrols as friendlyName 'GoHustlr'
//    and the console as 'GoHustlr Admin', so the uniqueness constraint that would have
//    collided does not. web/app/mfa/page.tsx carries this guard with a comment recording
//    that the same bug made airplane mode a 2FA bypass on mobile.
//
// 2. AN EXIT. Every redirect here is router.replace(), which writes no history entry, so
//    Back lands on /login with the session still live and signing in returns you to the
//    gate. Without a sign-out an admin who cannot produce a code is in a closed loop.
//
// 3. RECOVERY CODES AT ENROLMENT. CLAUDE.md: "Recovery codes are generated AT
//    enrollment, not offered later — 2FA without a way back in turns a lost phone into a
//    lost account." The console enrolled a factor and stopped, so every admin who
//    enrolled through it had zero codes.
//
// 4. SAY WHAT IS BEING CHALLENGED. The console and the app share one auth project, so a
//    factor may have been enrolled on either — and if on neither, that is a compromised
//    password, not a forgotten setup. Only the enrolment time lets the person tell those
//    apart.
//
// These are shape assertions on a client component; the server-side halves they depend
// on are proved elsewhere (the aal2 gate on generate_mfa_recovery_codes in
// 20260813070000, the count-before-record throttle in 20260814040000).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// This file's own header names every symbol it asserts on, and so does the page's.
// Matching against prose is how an assertion ends up testing its own explanation.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const admin = codeOnly(read('admin', 'app', 'mfa', 'page.tsx'));
const web = codeOnly(read('web', 'app', 'mfa', 'page.tsx'));
const mobile = codeOnly(read('src', 'screens', 'MfaChallengeScreen.js'));

describe('an unreadable factor list cannot become a fresh authenticator', () => {
  it('the console captures the listFactors error', () => {
    expect(admin).toMatch(/listFactors\(\)/);
    expect(admin).toMatch(/error:\s*listErr/);
  });

  it('and refuses BEFORE reaching enroll()', () => {
    const guardAt = admin.search(/if\s*\(listErr\)/);
    const enrollAt = admin.search(/supabase\.auth\.mfa\.enroll/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(enrollAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(enrollAt);
    // The guard must terminate the function, not just set a message and continue.
    const branch = admin.slice(guardAt, enrollAt);
    expect(branch).toMatch(/return;/);
  });

  it('web keeps the same guard, so the two cannot drift apart again', () => {
    expect(web).toMatch(/error:\s*listErr/);
    expect(web).toMatch(/if\s*\(listErr\)/);
  });
});

describe('nobody is trapped on the gate', () => {
  it('the console offers a sign-out that clears the server cookie', () => {
    // A client-only signOut leaves the cookie the server guard reads, so the same
    // redirect fires again. /denied uses the server action for this reason.
    expect(admin).toMatch(/import \{ signOutAction \}/);
    expect(admin).toMatch(/<form action=\{signOutAction\}/);
  });

  it('it is reachable from the challenge, not only from a happy path', () => {
    // Rendered whenever the screen is not showing freshly-minted recovery codes —
    // the one state where leaving would destroy something the user has not saved.
    expect(admin).toMatch(/mode !== "codes"[\s\S]{0,200}?signOutAction/);
  });

  it('the app and web screens still have theirs', () => {
    expect(mobile).toMatch(/signOut\(\)/);
    expect(web).toMatch(/signOut\(\)/);
  });
});

describe('enrolling through the console mints a way back in', () => {
  it('recovery codes are generated on the enroll path', () => {
    expect(admin).toMatch(/generate_mfa_recovery_codes/);
  });

  it('generation happens AFTER verify, which is when the session is aal2', () => {
    // generate_mfa_recovery_codes requires aal2 whenever a verified factor exists
    // (20260813070000). Calling it before verify would fail closed every time.
    const verifyAt = admin.search(/supabase\.auth\.mfa\.verify\(/);
    const genAt = admin.search(/generate_mfa_recovery_codes/);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(genAt);
  });

  it('the codes are shown and confirmed, not silently minted', () => {
    // confirm_mfa_recovery_codes retires the PREVIOUS batch. Calling it before the new
    // codes are on screen is what destroys a working set for one nobody has seen.
    expect(admin).toMatch(/confirm_mfa_recovery_codes/);
    const genAt = admin.search(/generate_mfa_recovery_codes/);
    const confirmAt = admin.search(/confirm_mfa_recovery_codes/);
    expect(genAt).toBeLessThan(confirmAt);
    expect(admin).toMatch(/setCodes\(/);
  });

  it('a generation failure is stated rather than swallowed', () => {
    // Signing in must not be blocked — the factor is verified and the session is good.
    // But continuing silently is how the console filled up with admins who had no
    // recovery path and did not know it.
    expect(admin).toMatch(/genErr/);
    expect(admin).toMatch(/recovery codes could not be created/i);
  });

  it('a lost authenticator can be redeemed here, as on web and mobile', () => {
    expect(admin).toMatch(/redeem_mfa_recovery_code/);
    // Redemption removes the factor server-side while this session still caches it, so
    // the gate would re-prompt and burn a second code without a refresh.
    const redeemAt = admin.search(/redeem_mfa_recovery_code/);
    expect(admin.slice(redeemAt)).toMatch(/refreshSession\(\)/);
  });

  it('one message covers wrong / used / rate-limited', () => {
    // Distinguishing them tells someone probing which codes exist.
    expect(admin).toMatch(/Each code works once/);
    expect(admin).not.toMatch(/no such code|already used|too many tries/i);
  });
});

describe('the challenge says what it is challenging', () => {
  it('it surfaces when the factor was enrolled', () => {
    expect(admin).toMatch(/verified\.created_at/);
    expect(admin).toMatch(/enrolledAt/);
  });

  it('and tells the reader what an unrecognised date means', () => {
    // The pending-membership status exists because /mfa enrols a factor for whoever
    // knows the password. This sentence is the only place the person being challenged
    // is told that.
    expect(admin).toMatch(/If that wasn't you/);
    expect(admin).toMatch(/same login/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A console session must not live forever.
//
// AAL2 proves the factor was satisfied at SOME point. Supabase rotates the refresh token
// indefinitely, so without a cap a session holding the service-role key stays live for
// as long as the laptop it was opened on. Step-up already time-boxes money and privilege
// actions to five minutes; this bounds the session itself.
//
// RE-VERIFICATION, NOT SIGN-OUT. Signing someone out mid-task loses their place and
// teaches them to resent the control; six digits costs seconds and keeps them where they
// were. Enforced in the guard rather than by a browser timer — a client-side timeout
// looks like security and is defeated by a client that ignores it.
// ─────────────────────────────────────────────────────────────────────────────
describe('the console session expires into a re-verification', () => {
  const fs5 = require('fs');
  const path5 = require('path');
  const R5 = path5.join(__dirname, '..');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const guard = strip(fs5.readFileSync(path5.join(R5, 'admin', 'lib', 'guard.ts'), 'utf8'));
  const gate = strip(fs5.readFileSync(path5.join(R5, 'admin', 'app', 'mfa', 'page.tsx'), 'utf8'));

  // requireFreshAdmin is declared ABOVE requireAdmin in guard.ts, so slicing between the
  // two names in source order returns an empty string and every assertion inside it
  // passes vacuously. Take requireAdmin's body up to whatever is exported next.
  const requireAdminBody = () => {
    const from = guard.indexOf('export async function requireAdmin(');
    expect(from).toBeGreaterThan(-1);
    const next = guard.indexOf('\nexport ', from + 1);
    const body = guard.slice(from, next === -1 ? undefined : next);
    expect(body.length).toBeGreaterThan(200);
    return body;
  };

  it('the cap is twelve hours and stated once', () => {
    expect(guard).toMatch(/export const SESSION_MAX_AGE_SECONDS = 12 \* 60 \* 60;/);
  });

  it('requireAdmin enforces it on every request', () => {
    // Not requireFreshAdmin — that guards individual actions. This has to sit on the
    // base guard or a session that never touches money is never re-checked at all.
    const base = requireAdminBody();
    expect(base).toMatch(/mfaAgeSeconds\(session\?\.access_token\)/);
    expect(base).toMatch(/SESSION_MAX_AGE_SECONDS/);
  });

  it('fails closed on an unreadable amr', () => {
    const base = requireAdminBody();
    // `sessionAge === null` must DENY. Treating an unparseable claim as fresh would make
    // the cap skippable by anything that perturbs the token.
    expect(base).toMatch(/sessionAge === null \|\| sessionAge > SESSION_MAX_AGE_SECONDS/);
  });

  it('an expired session re-verifies instead of landing on /denied', () => {
    // stale_mfa previously fell through to the catch-all. A correct, current admin would
    // have been told they are not authorized.
    expect(guard).toMatch(/if \(e\.reason === "stale_mfa"\) redirect\("\/mfa\?reauth=1"\)/);
    const wrapper = guard.slice(guard.indexOf('export async function requireAdminPage'));
    expect(wrapper.indexOf('stale_mfa')).toBeLessThan(wrapper.indexOf('/denied'));
  });

  it('the gate challenges an already-aal2 session when asked to', () => {
    // Without this the two bounce off each other forever: /mfa short-circuits aal2 back
    // to "/", the guard rejects the stale amr, redirect, repeat.
    expect(gate).toMatch(/const reauth = /);
    expect(gate).toMatch(/has\("reauth"\)/);
    expect(gate).toMatch(/aal\.currentLevel === "aal2" && !reauth/);
  });

  it('does not read the flag with useSearchParams', () => {
    // This route is statically rendered; useSearchParams there demands a Suspense
    // boundary and fails the build. bootstrap runs in an effect, so window is present.
    expect(gate).not.toMatch(/useSearchParams/);
  });

  it('leaves the five-minute step-up window alone', () => {
    // They answer different questions — "is this still the same day?" versus "is the
    // person at the keyboard right now the one who passed the factor?". Collapsing them
    // would either nag every five minutes or leave money actions open for twelve hours.
    expect(guard).toMatch(/maxAgeSeconds = 300/);
  });
});
