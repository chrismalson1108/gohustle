jest.mock('../src/lib/supabase', () => ({ supabase: {} }));
const { formatRecoveryCode, MfaError } = require('../src/lib/mfa');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Two-factor is only worth anything if the sign-in gate actually holds. A password
// sign-in on an account WITH a verified factor returns a real session at aal1, and
// every other gate in RootNavigator would let it straight through — so these assert
// the wiring, not just the helpers.
// ─────────────────────────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('formatRecoveryCode', () => {
  it('normalizes what people actually type', () => {
    // Read off a screenshot at a stressful moment: lowercase, spaces, missing dash.
    expect(formatRecoveryCode('abcd efgh')).toBe('ABCD-EFGH');
    expect(formatRecoveryCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(formatRecoveryCode('ABCD-EFGH')).toBe('ABCD-EFGH');
  });
  it('does not insert a dash before there is anything to separate', () => {
    expect(formatRecoveryCode('AB')).toBe('AB');
    expect(formatRecoveryCode('ABCD')).toBe('ABCD');
  });
  it('caps at 8 characters so a paste cannot overflow the field', () => {
    expect(formatRecoveryCode('ABCDEFGHIJKL')).toBe('ABCD-EFGH');
  });
  it('drops characters the alphabet never produces', () => {
    expect(formatRecoveryCode('a!b@c#d$e%f^g&h*')).toBe('ABCD-EFGH');
  });
});

describe('the sign-in gate is actually wired', () => {
  const app = read('App.js');
  const ctx = read('src/context/AuthContext.js');

  it('holds the app on a challenge before letting a session through', () => {
    expect(app).toMatch(/if \(needsMfaChallenge\) return <MfaChallengeScreen \/>;/);
  });

  it('challenges BEFORE onboarding and terms', () => {
    // Proving who you are comes before anything else the app asks of you — and an
    // onboarding form is a lot of account detail to expose at aal1.
    const mfa = app.indexOf('needsMfaChallenge) return');
    const onb = app.indexOf('!onboardingDone) return');
    const terms = app.indexOf('needsTermsAcceptance) return');
    expect(mfa).toBeGreaterThan(-1);
    expect(mfa).toBeLessThan(onb);
    expect(mfa).toBeLessThan(terms);
  });

  it('waits for the AAL check before rendering anything', () => {
    // Without mfaResolved in the gate, a 2FA account flashes MainApp for a frame.
    expect(app).toMatch(/gateResolving\s*=\s*loading \|\| \(!!session && \(!onboardingResolved \|\| !mfaResolved\)\)/);
  });

  it('derives the gate from BOTH aal levels, not just the presence of a factor', () => {
    // nextLevel==='aal2' alone is true even after verifying; currentLevel==='aal1'
    // alone is true for accounts with no factor at all. It takes both.
    expect(ctx).toMatch(/nextLevel === 'aal2' && data\.currentLevel === 'aal1'/);
  });

  it('fails OPEN on a network error rather than locking the owner out', () => {
    const i = ctx.indexOf('getAuthenticatorAssuranceLevel');
    expect(ctx.slice(i, i + 900)).toMatch(/catch[\s\S]{0,400}setMfaPending\(false\)/);
  });
});

describe('enrollment is built for a phone, not a laptop', () => {
  const screen = read('src/screens/SecurityScreen.js');

  it('leads with the otpauth deep link, which is the only route that works one-screen', () => {
    expect(screen).toMatch(/Linking\.openURL\(enroll\.uri\)/);
    expect(screen).toMatch(/Open my authenticator app/);
  });

  it('checks the link can be opened before sending the user nowhere', () => {
    expect(screen).toMatch(/canOpenURL/);
  });

  it('offers the secret as a fallback without a native clipboard module', () => {
    // A clipboard dependency is native code and would cost a store build; the OS's
    // own long-press → Copy needs only a selectable field.
    expect(screen).toMatch(/selectTextOnFocus/);
  });

  it('generates recovery codes as part of enrollment, not as an optional extra', () => {
    // 2FA without a way back in turns a lost phone into a lost account.
    const i = screen.indexOf('confirmEnrollment(enroll.factorId');
    expect(screen.slice(i, i + 400)).toMatch(/generateRecoveryCodes\(\)/);
  });

  it('tells the truth about the logo', () => {
    // An otpauth URI carries issuer/label/secret and no image; authenticators show
    // icons from their own catalogues. Claiming otherwise sets up a "did it work?"
    // support ticket.
    expect(screen).toMatch(/built-in list|their own icons/i);
  });
});

describe('the lost-phone path exists', () => {
  const challenge = read('src/screens/MfaChallengeScreen.js');
  it('offers recovery from the challenge screen itself', () => {
    expect(challenge).toMatch(/I've lost my phone/);
    expect(challenge).toMatch(/redeemRecoveryCode/);
  });
  it('gives one message for every failure so codes cannot be probed', () => {
    const i = challenge.indexOf('submitRecovery');
    expect(challenge.slice(i, i + 700)).toMatch(/Each code works once/);
  });
  it('always leaves a way out', () => {
    expect(challenge).toMatch(/signOut/);
  });
});

describe('the gate clears after a correct code', () => {
  const ctx = read('src/context/AuthContext.js');

  it('re-resolves on the SESSION, not the user id', () => {
    // Verifying issues a NEW session at aal2 for the SAME user. Keyed on user id the
    // effect never re-ran, mfaResolved stayed false, and the app hung on the loading
    // gate forever — immediately after entering a correct code.
    const i = ctx.indexOf('getAuthenticatorAssuranceLevel');
    const after = ctx.slice(i, i + 1400);
    expect(after).toMatch(/\}, \[session\?\.access_token\]\)/);
    expect(after).not.toMatch(/\}, \[session\?\.user\?\.id\]\)/);
  });

  it('clears the loading gate as well as the challenge', () => {
    // Clearing mfaPending alone leaves gateResolving true if mfaResolved is false.
    expect(ctx).toMatch(/clearMfaPending = \(\) => \{ setMfaPending\(false\); setMfaResolved\(true\); \}/);
  });
});

describe('the challenge cannot be bypassed by breaking the network', () => {
  const challenge = read('src/screens/MfaChallengeScreen.js');

  it('checks the error from listFactors instead of discarding it', () => {
    // listFactors() is a network call that returns { data: null, error } on failure.
    // Discarding the error made `factor` undefined, which took the "no factor after
    // all" branch and cleared the gate — so airplane mode let a password-only session
    // straight into the app.
    expect(challenge).toMatch(/const \{ data: factors, error: listErr \}/);
    expect(challenge).toMatch(/if \(listErr\)/);
  });

  it('leaves the gate CLOSED when the lookup fails', () => {
    // The failure branch must return before reaching clearMfaPending().
    const i = challenge.indexOf('if (listErr)');
    const j = challenge.indexOf('clearMfaPending()', i);
    const between = challenge.slice(i, j);
    expect(between).toMatch(/return;/);
  });
});
