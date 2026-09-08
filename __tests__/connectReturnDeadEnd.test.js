// ─────────────────────────────────────────────────────────────────────────────
// The Stripe onboarding return page must not hand a desktop browser a dead button.
//
// Reported from a real run on 2026-09-08: an earner finished Connect onboarding in a
// DESKTOP browser, was shown "Head back to the app / Open Hustlr", tapped it, and
// nothing happened. Nothing could happen — `gohustlr://` resolves only where the app is
// installed, and on a Mac the navigation fails silently. No error, no fallback, no way
// forward.
//
// The cause was one branch doing two jobs. `noWebSession` is true for BOTH:
//   * a mobile user in an in-app browser, whose session lives in AsyncStorage, and
//   * anybody in a normal browser who is not signed in to gohustlr.com
// and only the first should ever be told to go back to the app.
//
// `?native=1` — set by stripe-connect-onboard when the PHONE starts the flow — is the
// discriminator, and it was already being read one component up for the auto-redirect.
// It just wasn't reaching the card.
//
// This asserts the SHAPE that keeps the two apart, because the failure is silent: a
// regression here renders a perfectly good-looking screen whose only button does nothing.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CARD = 'web/app/stripe/connect-return/PayoutStatusCard.tsx';
const STATUS = 'web/app/stripe/connect-return/ConnectReturnStatus.tsx';

describe('the Connect return page tells a desktop browser something it can act on', () => {
  const card = codeOnly(read(CARD));
  const status = codeOnly(read(STATUS));

  it('the fetching half reads ?native=1 and passes it down', () => {
    // It already read the flag for the auto-redirect; the bug was that it kept it.
    expect(status).toMatch(/get\("native"\) === "1"/);
    expect(status).toMatch(/isNative=\{isNative\}/);
  });

  it('the app-return screen requires BOTH no session AND native', () => {
    expect(card).toMatch(/if \(noWebSession && isNative\)/);
  });

  it('a non-native visitor with no session gets a different screen', () => {
    // Two distinct branches, not one. The bare `if (noWebSession)` must come AFTER the
    // native one, or it swallows every mobile user.
    const nativeAt = card.indexOf('if (noWebSession && isNative)');
    const plainAt = card.indexOf('if (noWebSession) {');
    expect(`native branch exists: ${nativeAt > -1}`).toBe('native branch exists: true');
    expect(`plain branch exists: ${plainAt > -1}`).toBe('plain branch exists: true');
    expect(`native branch comes first: ${nativeAt < plainAt}`).toBe('native branch comes first: true');
  });

  it('the non-native screen offers sign-in, not the app scheme', () => {
    const plain = card.slice(card.indexOf('if (noWebSession) {'), card.indexOf('if (!status && !failed)'));
    expect(plain).toMatch(/\/login\?next=\/profile\/payouts/);
    expect(`non-native branch offers gohustlr://: ${/gohustlr:\/\//.test(plain)}`)
      .toBe('non-native branch offers gohustlr://: false');
  });

  it('the app-return screen says what to do when the deep link does nothing', () => {
    // The scheme can fail even on a phone — app uninstalled, or the OS declines it. A
    // button that silently does nothing is the whole defect; there must be a next step.
    const native = read(CARD).slice(
      read(CARD).indexOf('if (noWebSession && isNative)'),
      read(CARD).indexOf('if (noWebSession) {'),
    );
    expect(native).toMatch(/Nothing happened\?/i);
  });
});
