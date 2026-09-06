// ─────────────────────────────────────────────────────────────────────────────
// A push token can only be deleted by someone who still holds a session.
//
// AuthContext's SIGNED_OUT branch called unregisterPushToken(prevUserId) to stop a
// device receiving an expired account's notifications, under a comment saying that is
// what it did. It never did: auth-js `_removeSession()` clears the stored session and
// THEN emits SIGNED_OUT, and supabase-js's `_getAccessToken()` falls back to the anon
// key when getSession() comes back empty — so the DELETE went out unauthenticated,
// `auth.uid()` was null, `push_tokens_delete_own` matched zero rows, and PostgREST
// answered 204. Nothing failed; nothing happened either.
//
// signOut() does work, and its own comment says why: it AWAITS the delete BEFORE
// revoking. That ordering is the whole mechanism, so it is pinned here.
//
// The case that actually mattered — an account whose sessions were revoked because it
// was suspended — has no client left to ask, so the console does it with the service
// role. Without that, "Sign this user out of all devices" left every one of those
// devices receiving the account's booking and message pushes forever, since a row is
// otherwise evicted only when another account signs in on the same device or the app
// is uninstalled.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CTX = codeOnly(read('src/context/AuthContext.js'));

describe('the client only deletes a token while it still has a session', () => {
  it('does not attempt the delete on a natural expiry', () => {
    // Two mentions in code: the import, and the one call inside signOut().
    const hits = CTX.match(/unregisterPushToken/g) || [];
    expect(hits.length).toBe(2);
  });

  it('leaves the surviving call inside signOut, after the session still exists', () => {
    const call = CTX.lastIndexOf('unregisterPushToken(');
    const signOutAt = CTX.indexOf('const signOut = async');
    expect(signOutAt).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(signOutAt);
  });

  it('still awaits that delete BEFORE revoking, which is why it works at all', () => {
    const signOut = CTX.slice(CTX.indexOf('const signOut = async'));
    const del = signOut.indexOf('await unregisterPushToken(');
    const revoke = signOut.indexOf("supabase.auth.signOut({ scope: 'local' })");
    expect(del).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(del);
  });

  it('still clears the cache on expiry — that half was never broken', () => {
    // The next account on a shared device must not see the previous user's bookings.
    expect(CTX).toMatch(/if \(prevUserId\) cacheClear\(\)/);
  });
});

describe('the console clears the devices it claims to sign out', () => {
  const ACTIONS = codeOnly(read('admin/app/(console)/users/[id]/actions.ts'));

  const bodyOf = (name) => {
    const i = ACTIONS.indexOf(`export async function ${name}(`);
    if (i === -1) return '';
    const next = ACTIONS.indexOf('export async function ', i + 10);
    return ACTIONS.slice(i, next === -1 ? ACTIONS.length : next);
  };

  it('deletes with the service role, which is the only client that can', () => {
    const helper = ACTIONS.slice(ACTIONS.indexOf('async function clearPushTokens'));
    expect(helper.slice(0, 500)).toMatch(/ctx\.service[\s\S]{0,80}from\("push_tokens"\)[\s\S]{0,60}\.delete\(\)/);
    expect(helper.slice(0, 500)).toMatch(/\.eq\("user_id", userId\)/);
  });

  ['forceSignOut', 'suspendUser'].forEach((fn) => {
    it(`${fn} clears the target's push tokens`, () => {
      const b = bodyOf(fn);
      expect(`${fn}: found`).toBe(b.length > 50 ? `${fn}: found` : `${fn}: MISSING`);
      expect(b).toMatch(/clearPushTokens\(ctx, userId\)/);
    });

    it(`${fn} records the outcome rather than only the intent`, () => {
      // run() audits the intent BEFORE the mutation; the returned facts are the second
      // row. A cleanup nobody can count afterwards is a cleanup nobody can verify.
      expect(bodyOf(fn)).toMatch(/push_tokens_cleared/);
    });
  });

  it('never fails a suspension on a push-token hiccup', () => {
    // The ban is the safety-critical half. clearPushTokens returns the error as a
    // value; if it ever throws, a failed delete would abort a suspension.
    const helper = ACTIONS.slice(ACTIONS.indexOf('async function clearPushTokens'));
    expect(helper.slice(0, 500)).toMatch(/if \(error\) return `error: \$\{error\.message\}`/);
    expect(helper.slice(0, 500)).not.toMatch(/throw new Error/);
  });
});
