jest.mock('../src/lib/supabase', () => ({ supabase: {} }));
const {
  formatRecoveryCode, MfaError,
  factorLabel, factorOrigin, preferredFactor,
  APP_FACTOR_NAME, ADMIN_FACTOR_NAME,
} = require('../src/lib/mfa');
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
    //
    // Asserts the PROPERTY — enrolment reaches code generation — rather than the call
    // appearing literally inside verify(). Both call sites now route through
    // showFreshCodes(), so pinning the syntax made a correct refactor look like a
    // regression.
    const i = screen.indexOf('confirmEnrollment(enroll.factorId');
    const afterEnroll = screen.slice(i, i + 400);
    expect(afterEnroll).toMatch(/showFreshCodes\(\)|generateRecoveryCodes\(\)/);
    const helper = screen.slice(screen.indexOf('const showFreshCodes'));
    expect(helper.slice(0, 400)).toMatch(/generateRecoveryCodes\(\)/);
  });

  it('retires the previous code set only AFTER the new one is delivered', () => {
    // Generation used to delete the old set first and then return the new codes, so a
    // lost response left the user with the old codes destroyed and the new ones existing
    // only as hashes they had never seen — zero usable codes, on the one feature whose
    // job is being the way back in.
    const helper = screen.slice(screen.indexOf('const showFreshCodes'));
    const gen = helper.indexOf('generateRecoveryCodes()');
    const show = helper.indexOf('setCodes(');
    const confirm = helper.indexOf('confirmRecoveryCodes()');
    expect(gen).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(gen);
    expect(confirm).toBeGreaterThan(show); // delivered before the old set is retired
  });

  it('reloads status in a finally, so the card cannot still read Off', () => {
    // confirmEnrollment can succeed and code generation fail. 2FA is then genuinely ON;
    // reporting a generic failure while the card said "Off" left the user believing they
    // had neither 2FA nor recovery codes, when they had 2FA and no recovery codes.
    const verify = screen.slice(screen.indexOf('const verify = async'));
    const body = verify.slice(0, verify.indexOf('const regenerate'));
    expect(body).toMatch(/finally\s*\{[\s\S]*?await load\(\)/);
    expect(body).toMatch(/factorOn/);
    expect(body).toMatch(/Two-factor is now ON/);
  });

  it('every enrollment sets an ISSUER, because that is the only string the authenticator shows', () => {
    // friendly_name is stored on OUR side and never leaves it. The authenticator shows
    // the otpauth issuer, and GoTrue falls back to the Site URL's HOST when it is
    // omitted. Measured against production 2026-09-09:
    //   omitted → otpauth://totp/gohustlr.com:you@x.com?…&issuer=gohustlr.com
    //   set     → otpauth://totp/GoHustlr:you@x.com?…&issuer=GoHustlr
    // So the website and the console both filed themselves under "gohustlr.com" while
    // SecurityScreen, MfaChallengeScreen and /team all name the entry "GoHustlr" or
    // "GoHustlr Admin" — a name that was not in the user's authenticator. For an admin
    // holding both factors that is worse than cosmetic: two indistinguishable entries,
    // and a code from the wrong one is rejected as wrong (challengeAndVerify is scoped
    // to the factorId it is handed).
    const sites = [
      ['src/lib/mfa.js', /issuer: 'GoHustlr'/],
      ['web/lib/mfa.ts', /issuer: APP_FACTOR_NAME/],
      ['admin/app/mfa/page.tsx', /issuer: "GoHustlr Admin"/],
    ];
    sites.forEach(([file, re]) => {
      const src = read(file);
      const at = src.indexOf('mfa.enroll(');
      expect(`${file}: enroll found`).toBe(at > -1 ? `${file}: enroll found` : `${file}: NO ENROLL`);
      const call = src.slice(at, at + 400);
      expect(`${file}: ${re.test(call)}`).toBe(`${file}: true`);
    });
  });

  it('the issuer matches the name our own screens tell people to look for', () => {
    // Two surfaces, two names, and they must be DISTINCT — an admin holds both factors
    // permanently, so one shared issuer would make the authenticator list two identical
    // entries and preferredFactor's whole reason for existing would be undone.
    const lib = read('src/lib/mfa.js');
    expect(lib).toMatch(/export const APP_FACTOR_NAME = 'GoHustlr'/);
    expect(lib).toMatch(/export const ADMIN_FACTOR_NAME = 'GoHustlr Admin'/);
    expect(read('admin/app/mfa/page.tsx')).not.toMatch(/issuer: "GoHustlr"[,\s]/);
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

describe('the gate does not unmount the app on every token refresh', () => {
  const ctx = read('src/context/AuthContext.js');

  it('only blanks the gate when the USER changes, not on any auth event', () => {
    // `else setMfaResolved(false)` fired on TOKEN_REFRESHED and on the aal2 upgrade a
    // correct code produces. An unresolved gate renders the loading spinner, which
    // unmounts MainApp — so enrolling 2FA destroyed the screen holding the recovery
    // codes before they could be saved, and every hourly refresh reset navigation.
    expect(ctx).toMatch(/else if \(\(session\.user\.id \?\? null\) !== prevUserId\) setMfaResolved\(false\)/);
    expect(ctx).not.toMatch(/\n\s*else setMfaResolved\(false\);/);
  });

  it('still gates a genuinely new sign-in', () => {
    // prevUserId is null before the first session, so a real sign-in still closes it.
    expect(ctx).toMatch(/const prevUserId = lastUserId\.current/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AN ACCOUNT CAN HOLD TWO VERIFIED FACTORS, AND BOTH SCREENS ASSUMED ONE.
//
// The app and the website enrol as "GoHustlr"; the admin console enrols as "GoHustlr
// Admin". /team deliberately refuses to alert on two factors because two is a legitimate
// permanent steady state for a staff account. Two consequences followed from the screens
// not knowing that:
//
//   • SecurityScreen.turnOff unenrolled `status.factors[0]` and then toasted "Two-factor
//     is off — Your account is password-only again" unconditionally. With a second
//     verified factor, `enabled` recomputes true, the status card reads "On" directly
//     under that toast, and the next sign-in still challenges.
//   • MfaChallengeScreen took `factors.totp.find(f => f.status === 'verified')` — GoTrue's
//     list order — while the copy said "the 6-digit code for GoHustlr". challengeAndVerify
//     is scoped to the factorId it is handed, so an admin whose console factor was listed
//     first typed the code from the entry the screen NAMED and had it rejected, with
//     nothing on screen saying the other entry was the one being asked for.
// ─────────────────────────────────────────────────────────────────────────────
describe('two verified factors are a steady state, not an anomaly', () => {
  it('names an entry the way the authenticator lists it, falling back to the app name', () => {
    expect(factorLabel({ name: 'GoHustlr Admin' })).toBe(ADMIN_FACTOR_NAME);
    expect(factorLabel({ friendly_name: 'GoHustlr Admin' })).toBe(ADMIN_FACTOR_NAME);
    // An unnamed factor is one of ours; guessing "GoHustlr" is better than rendering
    // “null” at the person trying to find it in a list of twenty.
    expect(factorLabel({ name: null })).toBe(APP_FACTOR_NAME);
    expect(factorLabel({ name: '   ' })).toBe(APP_FACTOR_NAME);
    expect(factorLabel(undefined)).toBe(APP_FACTOR_NAME);
  });

  it('says which surface enrolled it, because that is what makes it recognisable', () => {
    expect(factorOrigin({ name: ADMIN_FACTOR_NAME })).toMatch(/admin console/);
    expect(factorOrigin({ name: APP_FACTOR_NAME })).toMatch(/app|website/);
  });

  it("challenges the APP's entry, never whichever GoTrue happened to list first", () => {
    // The case that produced the bug: an invited admin enrols on the console before ever
    // using the app, so the console factor is listed first.
    const admin = { id: 'f_admin', name: ADMIN_FACTOR_NAME };
    const app = { id: 'f_app', name: APP_FACTOR_NAME };
    expect(preferredFactor([admin, app]).id).toBe('f_app');
    expect(preferredFactor([app, admin]).id).toBe('f_app');
    // A console-only account still has to be able to sign in.
    expect(preferredFactor([admin]).id).toBe('f_admin');
    expect(preferredFactor([])).toBeNull();
    expect(preferredFactor(null)).toBeNull();
  });
});

describe('turning one authenticator off does not claim the account is password-only', () => {
  const screen = read('src/screens/SecurityScreen.js');
  const web = read('web/app/(app)/settings/security/page.tsx');

  for (const [name, src] of [['the app', screen], ['the web', web]]) {
    it(`${name} removes a CHOSEN factor, not factors[0]`, () => {
      // factors[0] is GoTrue's list order. On an account with both entries it removes
      // whichever happened to come back first — and the code the user typed only
      // verifies against the factor it was challenged with.
      expect(src).not.toMatch(/status\??\.factors\[0\]/);
      expect(src).toMatch(/preferredFactor\(/);
      const off = src.slice(src.indexOf('const turnOff'));
      const body = off.slice(0, 1400);
      expect(body).toMatch(/disableMfa\(target\.id, code\)/);
    });

    it(`${name} derives the toast from the RELOADED status`, () => {
      // The whole defect in one line: the old code announced "password-only" from having
      // called disableMfa, which answers a different question than "is anything left".
      const off = src.slice(src.indexOf('const turnOff'));
      const body = off.slice(0, 1400);
      const reload = body.search(/(const fresh = await load\(\))/);
      const toast = body.indexOf('showToast(');
      expect(reload).toBeGreaterThan(-1);
      expect(toast).toBeGreaterThan(reload);
      expect(body).toMatch(/left > 0/);
      expect(body).toMatch(/still (ON|on)/);
    });

    it(`${name} lists every verified authenticator by name`, () => {
      // You cannot act on a factor you cannot see, and "two entries" is the explanation
      // for a card that still reads On after you turned one off.
      expect(src).toMatch(/factors\.map\(/);
      expect(src).toMatch(/factorLabel\(f\)/);
      expect(src).toMatch(/factorOrigin\(f\)/);
    });
  }
});

describe('the challenge names the entry it is actually challenging', () => {
  const challenge = read('src/screens/MfaChallengeScreen.js');
  const web = read('web/app/mfa/page.tsx');

  for (const [name, src] of [['the app', challenge], ['the web', web]]) {
    it(`${name} picks the factor deliberately rather than by list order`, () => {
      expect(src).toMatch(/preferredFactor\(/);
      // The old selection, which took whatever GoTrue listed first.
      expect(src).not.toMatch(/\)\s*\.find\(\(f[^)]*\)\s*=>\s*f\.status === ['"]verified['"]\)/);
    });

    it(`${name} puts the entry's own name in the copy instead of hardcoding GoHustlr`, () => {
      // "enter the code for GoHustlr" is actively wrong when the factor being verified is
      // the console's, and a rejection is the only feedback the user gets.
      expect(src).toMatch(/entry\?\.label/);
      expect(src).toMatch(/factorLabel\(/);
    });

    it(`${name} mentions the second entry ONLY when there is one`, () => {
      // Told to everyone, it sends a normal user hunting for a GoHustlr entry they do
      // not have.
      expect(src).toMatch(/count \?\? 0\) > 1|count > 1/);
      expect(src).toMatch(/more than one GoHustlr entry/);
    });

    it(`${name} still fails CLOSED when the factor lookup errors`, () => {
      // The naming lookup must not become a second way into the app. The authoritative
      // path keeps its own listFactors + error check, and the presentational one returns
      // without touching the gate.
      expect(src).toMatch(/if \(!alive \|\| error\) return;/);
      expect(src).toMatch(/listErr/);
    });
  }
});
