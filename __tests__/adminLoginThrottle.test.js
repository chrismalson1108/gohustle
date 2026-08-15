// ─────────────────────────────────────────────────────────────────────────────
// A throttle nothing calls is not a throttle.
//
// `admin_login_blocked(email, ip)` and `admin_login_attempts` were created by
// 20260806090000_admin_roles.sql, granted to service_role, and then never called by
// anything. For two months CLAUDE.md documented "5 failures per account / 15 min, or 20
// per IP" that was not enforced anywhere, and `ctl_admin_login_bruteforce` counted rows
// in a table nothing wrote to — so it could only ever report zero. A control that cannot
// fire reads exactly like a system with no attacks.
//
// Found by the 2026-08-12 payments audit, which sat unmerged on a branch for three days.
//
// This asserts the wiring, because the SQL half was always fine and that is precisely
// what made it invisible: every test of the function itself would have passed.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const actions = read('admin', 'app', 'login', 'actions.ts');
const page = read('admin', 'app', 'login', 'page.tsx');

describe('the admin login throttle has callers', () => {
  it('a server action calls the throttle RPC', () => {
    // Must be server-side: the RPC and table are granted to service_role only, so a
    // browser client cannot reach either.
    expect(actions).toMatch(/"use server"/);
    expect(codeOnly(actions)).toMatch(/rpc\(\s*["']admin_login_blocked["']/);
  });

  it('the login page checks BEFORE attempting the sign-in', () => {
    const body = codeOnly(page);
    const check = body.indexOf('loginBlocked');
    const signIn = body.indexOf('signInWithPassword');
    expect(check).toBeGreaterThan(-1);
    expect(signIn).toBeGreaterThan(-1);
    // Checking after the attempt would let every guess through.
    expect(check).toBeLessThan(signIn);
  });

  it('every attempt is recorded, including the failures', () => {
    // The recording is the half that makes ctl_admin_login_bruteforce work. Failures are
    // the ones that matter — a brute force is a run of them.
    expect(codeOnly(actions)).toMatch(/from\(\s*["']admin_login_attempts["']\s*\)\s*\.insert/);
    const body = codeOnly(page);
    expect(body).toMatch(/recordLoginAttempt\(\s*email\s*,\s*!err\s*\)/);
    // Recorded before the error branch returns, or a failed sign-in writes nothing.
    expect(body.indexOf('recordLoginAttempt')).toBeLessThan(body.indexOf('Sign-in failed.'));
  });

  it('a blocked attempt is indistinguishable from a wrong password', () => {
    // Saying "too many attempts" confirms the account exists AND that a limit was hit —
    // two facts an attacker did not have. So assert the real property: every failure path
    // sets the SAME string. (Matching prose instead of code bit four other guards in this
    // repo today; here it also bit the regex — "loginBlocked" contains "locked".)
    const messages = [...codeOnly(page).matchAll(/setError\((["'`])([^"'`]*)\1\)/g)].map((m) => m[2]);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Sign-in failed.');
  });

  it('fails OPEN when the throttle itself errors', () => {
    // This is the door people come through during an incident. A throttle that locks
    // every admin out when the database hiccups is worse than one that misses a window.
    const fn = actions.slice(actions.indexOf('loginBlocked'), actions.indexOf('recordLoginAttempt'));
    expect(codeOnly(fn)).toMatch(/if \(error\) return false;/);
  });
});
