// ─────────────────────────────────────────────────────────────────────────────
// A step-up refusal must land somewhere a code can be entered.
//
// `_shared/stepUp.ts` answers 403 `MFA_REQUIRED` on the two payout functions, with a
// comment claiming "the app keys on this to route to the code prompt rather than
// showing a dead-end error". Nothing did. `grep -rn MFA_REQUIRED src web` returned
// exactly one hit — the line that wrote it — so both clients turned the refusal into a
// toast reading "Enter your authenticator code to change payout details." on a screen
// with no code field and no link to one. Retrying produced the same toast, and the only
// honest conclusion available to the user was that payouts were broken.
//
// This is the same shape `stepUpCoverage.test.js` guards in the admin console: a
// step-up with no recovery path is worse than no step-up, because the person it stops
// is the legitimate one. So both directions are asserted here — the server's code is a
// contract, and every client that can receive it must be able to finish the action.
//
// Discriminating by construction: every assertion below reads a string or a call that
// did not exist anywhere in src/ or web/ before this change.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Comments MENTION the code — this suite's own fix wrote several of them. Only real
// code counts, or a file could satisfy the guard with an apology in a comment.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const STEP_UP = read('supabase/functions/_shared/stepUp.ts');
const MOBILE_SCREEN = codeOnly(read('src/screens/PayoutSetupScreen.js'));
const WEB_PAGE = codeOnly(read('web/app/(app)/profile/payouts/page.tsx'));
const MOBILE_CTX = codeOnly(read('src/context/AuthContext.js'));
const WEB_CTX = codeOnly(read('web/lib/auth.tsx'));

describe('the server still refuses payout actions with a recoverable code', () => {
  it('answers MFA_REQUIRED rather than a generic 403', () => {
    expect(codeOnly(STEP_UP)).toMatch(/error:\s*'MFA_REQUIRED'/);
    expect(codeOnly(STEP_UP)).toMatch(/status:\s*403/);
  });

  it('only refuses a session that is not aal2, and only when a factor exists', () => {
    // The no-factor branch returning ok is what stops this locking someone out of
    // their own bank details for declining an optional feature.
    expect(codeOnly(STEP_UP)).toMatch(/if \(hasFactor !== true\) return \{ ok: true \}/);
    expect(codeOnly(STEP_UP)).toMatch(/aalFromToken\(token\) !== 'aal2'/);
  });
});

describe('both payout surfaces can act on that refusal', () => {
  const SURFACES = [
    { name: 'src/screens/PayoutSetupScreen.js', src: MOBILE_SCREEN },
    { name: 'web/app/(app)/profile/payouts/page.tsx', src: WEB_PAGE },
  ];

  SURFACES.forEach(({ name, src }) => {
    it(`${name} recognises the code the server actually sends`, () => {
      // The MESSAGE is prose and may be reworded; the CODE is the contract. Keying on
      // the message would break silently the first time the copy changed.
      expect(src).toMatch(/MFA_REQUIRED/);
      expect(src).toMatch(/\.code !== ["']MFA_REQUIRED["']|\.code === ["']MFA_REQUIRED["']/);
    });

    it(`${name} opens the challenge gate instead of only showing a toast`, () => {
      expect(src).toMatch(/requireMfaChallenge\(\)/);
    });

    it(`${name} does not fall through to the generic error as well`, () => {
      // Showing "Payout setup unavailable" AND routing to the prompt is the dead end
      // wearing a fix: the user reads the failure, not the instruction. The generic
      // toast must be guarded by the step-up branch.
      expect(src).toMatch(/if \(!handledStepUp\(/);
    });
  });
});

describe('opening the gate reaches a screen with a code field', () => {
  it('mobile exposes requireMfaChallenge and it sets the pending flag', () => {
    expect(MOBILE_CTX).toMatch(/const requireMfaChallenge = \(\) => \{ setMfaPending\(true\); setMfaResolved\(true\); \}/);
    // Exported on the context value, or the screen's call is a TypeError at runtime.
    expect(MOBILE_CTX).toMatch(/^\s*requireMfaChallenge,$/m);
  });

  it('mobile renders the challenge screen off that same flag', () => {
    // needsMfaChallenge is `!!session && mfaPending`, and RootNavigator holds on it —
    // asserted in mfa.test.js. This is the half that connects the two.
    expect(MOBILE_CTX).toMatch(/needsMfaChallenge: !!session && mfaPending/);
  });

  it('web exposes requireMfaChallenge and it sets the pending flag', () => {
    expect(WEB_CTX).toMatch(/const requireMfaChallenge = \(\) => \{ setMfaPending\(true\); setMfaResolved\(true\); \}/);
    expect(WEB_CTX).toMatch(/^\s*requireMfaChallenge,$/m);
    expect(WEB_CTX).toMatch(/requireMfaChallenge: \(\) => void;/);
  });

  it('web routes to /mfa off that same flag', () => {
    const layout = codeOnly(read('web/app/(app)/layout.tsx'));
    expect(layout).toMatch(/needsMfaChallenge\) router\.replace\("\/mfa"\)/);
  });

  it('setting mfaResolved alongside it keeps the app off the loading gate', () => {
    // clearMfaPending sets both for this reason; so must its opposite, or the web
    // layout's gateResolving stays true and the user gets a spinner, not a prompt.
    [MOBILE_CTX, WEB_CTX].forEach((ctx) => {
      const i = ctx.indexOf('const requireMfaChallenge');
      expect(ctx.slice(i, i + 200)).toMatch(/setMfaResolved\(true\)/);
    });
  });
});

describe('the refusal survives the transport that carries it', () => {
  // Both wrappers must copy the server's `error` onto err.code. Without it the clients
  // see only a message string and the branch above can never be true.
  it('mobile stripeClient puts the server code on the Error', () => {
    expect(codeOnly(read('src/lib/stripeClient.js'))).toMatch(/err\.code = data\.error/);
  });
  it('web edge wrapper does the same', () => {
    expect(codeOnly(read('web/lib/edge.ts'))).toMatch(/err\.code = data\.error/);
  });
});
