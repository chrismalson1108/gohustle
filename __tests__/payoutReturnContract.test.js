// ─────────────────────────────────────────────────────────────────────────────
// Getting the app back from Stripe Connect onboarding spans FOUR files, and the
// contract between them is invisible in any one of them.
//
// Stripe will not redirect to an app scheme — creating an account link with
// return_url `gohustlr://…` fails with `url_invalid` / "Not a valid URL" (verified
// against the live API, 2026-08-14). That single fact is why this is not the one-line
// openBrowserAsync → openAuthSessionAsync swap it looks like, and why the register
// carried it as open for so long. The working shape is a relay:
//
//   stripeClient (mobile only)   sends native: true
//        → stripe-connect-onboard  appends ?native=1 to the https return_url
//        → /stripe/connect-return  sees native=1, redirects to gohustlr://…
//        → openAuthSessionAsync    recognises that scheme and closes the browser
//
// Break any link and the failure is silent and platform-specific: the browser simply
// never dismisses, the user taps Done by hand, and until they do the app keeps telling
// them their bank is not connected. No test, type-check or lint sees it.
//
// The scheme is hardcoded on BOTH ends on purpose. The client only gets to say "this
// came from the app"; if it could name the destination, the return page would be an
// open redirect on our own domain.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const edgeFn = read('supabase', 'functions', 'stripe-connect-onboard', 'index.ts');
const mobileClient = read('src', 'lib', 'stripeClient.js');
const webClient = read('web', 'lib', 'edge.ts');
const returnPage = read('web', 'app', 'stripe', 'connect-return', 'ConnectReturnStatus.tsx');
const screen = read('src', 'screens', 'PayoutSetupScreen.js');
const appJson = JSON.parse(read('app.json'));

// Strip comments before asserting. These files EXPLAIN the contract in prose — including
// quoting the very scheme Stripe rejects — so a naive grep matches the explanation and
// reports a defect that is only a sentence. Assert on code.
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The one scheme every hop must agree on.
const SCHEME = appJson.expo.scheme;

describe('the app can get itself back from Connect onboarding', () => {
  it('app.json still registers the scheme the relay depends on', () => {
    // Without this the OS never hands the redirect to the app and the session hangs.
    expect(SCHEME).toBe('gohustlr');
  });

  it('the MOBILE client asks for the native return', () => {
    const call = mobileClient.slice(mobileClient.indexOf('getPayoutOnboardingUrl'));
    expect(call.slice(0, 300)).toMatch(/native:\s*true/);
  });

  it('the WEB client does NOT — absence is what keeps the browser on https', () => {
    // web/lib/edge.ts is a deliberate mirror of the mobile client, so this is the only
    // thing distinguishing the two callers. If web started sending it, browser users
    // would be bounced at a scheme they cannot open.
    const call = webClient.includes('getPayoutOnboardingUrl')
      ? webClient.slice(webClient.indexOf('getPayoutOnboardingUrl'), webClient.indexOf('getPayoutOnboardingUrl') + 300)
      : '';
    expect(call).not.toMatch(/native:\s*true/);
  });

  it('the edge function marks the return url only when asked', () => {
    expect(edgeFn).toMatch(/native\s*===\s*true/);
    expect(edgeFn).toMatch(/\?native=1/);
    // And it must still be an https page — Stripe rejects a scheme outright.
    expect(edgeFn).toMatch(/\/stripe\/connect-return/);
    expect(codeOnly(edgeFn)).not.toMatch(/return_url[^\n]*gohustlr:\/\//);
  });

  it('the return page bounces to the scheme, hardcoded rather than echoed', () => {
    expect(returnPage).toMatch(new RegExp(`["']${SCHEME}://stripe/connect-return["']`));
    expect(returnPage).toMatch(/native["']?\)\s*===\s*["']1["']/);
    // The destination must NOT come from the query string — that would make our own
    // domain an open redirect.
    expect(returnPage).not.toMatch(/location\.replace\(\s*(params|searchParams|url)\b/);
  });

  it('the screen waits on that exact scheme', () => {
    expect(screen).toMatch(new RegExp(`const PAYOUT_RETURN_URL = '${SCHEME}://stripe/connect-return'`));
    const onboard = screen.slice(0, screen.indexOf('handleManagePayout'));
    expect(onboard).toMatch(/openAuthSessionAsync\(result\.url, PAYOUT_RETURN_URL/);
  });

  it('refresh() still runs after the session ends, however it ended', () => {
    // Dismiss and cancel are ordinary outcomes here — someone who backs out must not be
    // left reading a stale "not connected" screen.
    const onboard = codeOnly(screen.slice(0, screen.indexOf('handleManagePayout')));
    const at = onboard.indexOf('openAuthSessionAsync');
    expect(at).toBeGreaterThan(-1);
    expect(onboard.slice(at, at + 300)).toMatch(/await refresh\(\)/);
  });

  it('leaves the dashboard login link on a plain browser session', () => {
    // handleManagePayout opens an Express DASHBOARD link, which has no return_url and
    // never redirects anywhere. openAuthSessionAsync would wait for a callback that can
    // never arrive, so the plain browser is correct there — not an oversight.
    const manage = screen.slice(screen.indexOf('handleManagePayout'));
    expect(manage).toMatch(/openBrowserAsync/);
    expect(manage.slice(0, 600)).not.toMatch(/openAuthSessionAsync/);
  });
});
